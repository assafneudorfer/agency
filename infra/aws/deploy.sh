#!/usr/bin/env bash
# Deploys Agency to AWS with Cloudflare DNS.
#
#   ./deploy.sh            create or update the stack (asks for anything it needs)
#   ./deploy.sh update     pull the latest code on the server and rebuild
#   ./deploy.sh destroy    delete everything this script created
#
# Secrets (Claude API key, Cloudflare token, admin password) are read from the environment or
# typed at a hidden prompt. They are never written to files by this script, never passed on a
# command line, and only reach AWS as an encrypted SSM SecureString. Terraform state does hold
# them (and the generated database password), so terraform.tfstate is kept private (mode 600).
set -euo pipefail
umask 077

cd "$(dirname "$0")"
SETTINGS=agency.auto.tfvars
ACTION=${1:-deploy}

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() {
	printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
	exit 1
}

for tool in terraform aws curl; do
	command -v "$tool" >/dev/null || fail "$tool is not installed"
done

# Asks for a value unless the variable is already set. Usage: ask VAR "Question" [default] [secret]
ask() {
	local var=$1 question=$2 default=${3:-} secret=${4:-}
	[ -n "${!var:-}" ] && return
	local value=""
	while [ -z "$value" ]; do
		if [ -n "$secret" ]; then
			read -rsp "$question: " value
			echo
		else
			read -rp "$question${default:+ [$default]}: " value
			value=${value:-$default}
		fi
	done
	printf -v "$var" '%s' "$value"
}

# Sends an HTTP request whose auth header comes from stdin, so secrets never appear in `ps`.
request_with_header() {
	local header=$1 url=$2
	printf '%s\n' "$header" | curl -sS -H @- "$url"
}

check_aws() {
	info "Checking AWS credentials"
	local identity
	identity=$(aws sts get-caller-identity --query '[Account,Arn]' --output text) ||
		fail "AWS CLI is not signed in. Run 'aws configure' or 'aws sso login' first."
	echo "    Account and identity: $identity"
}

tf_secret_vars() {
	ask ANTHROPIC_API_KEY "Claude API key (sk-ant-...)" "" secret
	ask CLOUDFLARE_API_TOKEN "Cloudflare API token (Zone > DNS > Edit)" "" secret
	ask ADMIN_PASSWORD "Admin password for the Agency sign-in (10+ characters)" "" secret
	[ ${#ADMIN_PASSWORD} -ge 10 ] || fail "The admin password must be at least 10 characters"
	export CLOUDFLARE_API_TOKEN
	export TF_VAR_cloudflare_dns_api_token=$CLOUDFLARE_API_TOKEN
	export TF_VAR_anthropic_api_key=$ANTHROPIC_API_KEY
	export TF_VAR_admin_password=$ADMIN_PASSWORD
}

write_settings() {
	if [ -f "$SETTINGS" ]; then
		info "Using settings in $SETTINGS (delete it to start over)"
		return
	fi
	info "First run: a few questions (saved to $SETTINGS, no secrets in it)"
	ask BASE_DOMAIN "Domain for Agency, e.g. agency.example.com"
	ask ADMIN_EMAIL "Admin email (sign-in and Let's Encrypt)"
	ask AWS_REGION_CHOICE "AWS region" "${AWS_REGION:-us-east-1}"
	ask SIZE "Instance size: small (t3.medium, for testing) or standard (t3.xlarge)" "small"
	ask REPO_REF "Git branch to deploy" "claude/project-thread-qpk7ed"

	info "Looking up the Cloudflare zone for $BASE_DOMAIN"
	local zone_id="" candidate=$BASE_DOMAIN response
	while [ -z "$zone_id" ] && [[ $candidate == *.* ]]; do
		response=$(request_with_header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
			"https://api.cloudflare.com/client/v4/zones?name=$candidate")
		zone_id=$(printf '%s' "$response" | grep -o '"id":"[0-9a-f]\{32\}"' | head -1 | cut -d'"' -f4 || true)
		[ -n "$zone_id" ] || candidate=${candidate#*.}
	done
	[ -n "$zone_id" ] || fail "No Cloudflare zone found for $BASE_DOMAIN that this token can see"
	echo "    Zone $candidate ($zone_id)"

	local instance_type=t3.medium sandbox_memory=1500m sandbox_cpus=1 volume=40
	if [ "$SIZE" = "standard" ]; then
		instance_type=t3.xlarge sandbox_memory=3g sandbox_cpus=2 volume=100
	fi
	cat >"$SETTINGS" <<EOF
aws_region         = "$AWS_REGION_CHOICE"
base_domain        = "$BASE_DOMAIN"
cloudflare_zone_id = "$zone_id"
acme_email         = "$ADMIN_EMAIL"
admin_email        = "$ADMIN_EMAIL"
repo_ref           = "$REPO_REF"
instance_type      = "$instance_type"
volume_size_gb     = $volume
sandbox_memory     = "$sandbox_memory"
sandbox_cpus       = "$sandbox_cpus"
EOF
}

verify_keys() {
	info "Checking the Claude API key"
	local status
	status=$(printf 'x-api-key: %s\n' "$ANTHROPIC_API_KEY" |
		curl -sS -o /dev/null -w '%{http_code}' -H @- -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/models)
	[ "$status" = "200" ] || fail "The Claude API rejected the key (HTTP $status)"

	info "Checking the Cloudflare token"
	request_with_header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
		"https://api.cloudflare.com/client/v4/user/tokens/verify" | grep -q '"status":"active"' ||
		fail "The Cloudflare token is not active"
}

wait_until_up() {
	local url=$1
	info "Waiting for $url (first boot builds the images; about 10 to 20 minutes on a small instance)"
	for _ in $(seq 1 90); do
		if curl -fsS -o /dev/null --max-time 5 "$url/healthz" 2>/dev/null; then
			info "Agency is up: $url"
			return
		fi
		sleep 20
	done
	echo "Not up yet. Check progress with: $(terraform output -raw shell), then: sudo tail -f /var/log/cloud-init-output.log"
}

region() {
	grep -E '^aws_region' "$SETTINGS" | cut -d'"' -f2
}

case "$ACTION" in
deploy)
	check_aws
	tf_secret_vars
	write_settings
	verify_keys
	info "Initializing Terraform"
	terraform init -input=false -upgrade >/dev/null
	info "Planning"
	terraform plan -input=false -out=agency.tfplan
	read -rp "Apply this plan? [y/N] " confirm
	[ "$confirm" = "y" ] || [ "$confirm" = "Y" ] || fail "Cancelled"
	terraform apply -input=false agency.tfplan
	rm -f agency.tfplan
	chmod 600 terraform.tfstate* 2>/dev/null || true
	wait_until_up "$(terraform output -raw url)"
	echo "Sign in with $(grep -E '^admin_email' "$SETTINGS" | cut -d'"' -f2) and the admin password you typed."
	;;
update)
	check_aws
	info "Running agency-deploy on the server"
	aws ssm send-command --region "$(region)" --instance-ids "$(terraform output -raw instance_id)" \
		--document-name AWS-RunShellScript --parameters 'commands=["/usr/local/bin/agency-deploy"]' \
		--query Command.CommandId --output text
	echo "Started. Follow it in the AWS console under Systems Manager > Run Command."
	;;
destroy)
	check_aws
	tf_secret_vars
	read -rp "Delete the Agency server, its data and DNS records? Type the domain to confirm: " confirm
	[ "$confirm" = "$(grep -E '^base_domain' "$SETTINGS" | cut -d'"' -f2)" ] || fail "Cancelled"
	terraform destroy -input=false -auto-approve
	;;
*)
	fail "Unknown command '$ACTION'. Use deploy, update or destroy."
	;;
esac

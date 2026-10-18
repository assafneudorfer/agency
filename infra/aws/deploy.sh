#!/usr/bin/env bash
# Deploys Agency to AWS. The first run asks how to set it up:
#   1. Cloudflare DNS + a Claude API key (keys you paste in, stored encrypted in AWS SSM)
#   2. All on AWS: Route 53 DNS + Claude on Amazon Bedrock (no keys at all; the server's IAM role)
#
#   ./deploy.sh            create or update the stack (asks for anything it needs)
#   ./deploy.sh update     pull the latest code on the server and rebuild
#   ./deploy.sh use-aws    move a Cloudflare + Claude API key deployment to all on AWS
#   ./deploy.sh profile    change how Agency runs (one server, a bigger server, or a cluster on AWS)
#   ./deploy.sh costs      what the current setup costs a month, and what the other profiles would
#   ./deploy.sh stop       stop the server to save money (data, address and DNS stay)
#   ./deploy.sh start      start it again; the stack comes back on its own
#   ./deploy.sh status     show whether the server is running
#   ./deploy.sh backup     back up all databases now (also runs every night on the server)
#   ./deploy.sh destroy    delete everything this script created
#
# Secrets (Claude API key, Cloudflare token, admin password; on all-AWS only the password) are read from the environment or
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

# Reads a value from the settings file, or prints the default.
setting() {
	local value=""
	[ -f "$SETTINGS" ] && value=$(grep -E "^$1 " "$SETTINGS" | sed -E 's/^[^=]*= *"?([^"]*)"?.*/\1/' || true)
	printf '%s' "${value:-${2:-}}"
}

# Picks the setup: from the settings file, else asks. Sets DNS_PROVIDER and LLM_PROVIDER.
choose_mode() {
	if [ -f "$SETTINGS" ]; then
		DNS_PROVIDER=$(setting dns_provider cloudflare)
		LLM_PROVIDER=$(setting llm_provider anthropic)
		return
	fi
	echo "How should Agency run?"
	echo "  1) Cloudflare DNS + Claude API key (you paste a Cloudflare token and an Anthropic key)"
	echo "  2) All on AWS: Route 53 DNS + Claude on Amazon Bedrock (no keys; uses the server's IAM role)"
	ask MODE "Choose 1 or 2" "1"
	case "$MODE" in
	1) DNS_PROVIDER=cloudflare LLM_PROVIDER=anthropic ;;
	2) DNS_PROVIDER=route53 LLM_PROVIDER=bedrock ;;
	*) fail "Choose 1 or 2" ;;
	esac
}

check_aws() {
	info "Checking AWS credentials"
	local identity
	identity=$(aws sts get-caller-identity --query '[Account,Arn]' --output text) ||
		fail "AWS CLI is not signed in. Run 'aws configure' or 'aws sso login' first."
	echo "    Account and identity: $identity"
}

# True while Terraform still manages Cloudflare records, for example on a server moving to Route 53.
has_cloudflare_records() {
	[ -f terraform.tfstate ] && grep -q '"type": "cloudflare_dns_record"' terraform.tfstate
}

tf_secret_vars() {
	if [ "$LLM_PROVIDER" = "anthropic" ]; then
		ask ANTHROPIC_API_KEY "Claude API key (sk-ant-...)" "" secret
		export TF_VAR_anthropic_api_key=$ANTHROPIC_API_KEY
	fi
	if [ "$DNS_PROVIDER" = "cloudflare" ] || has_cloudflare_records; then
		[ "$DNS_PROVIDER" = "cloudflare" ] || [ -n "${CLOUDFLARE_API_TOKEN:-}" ] ||
			info "Cloudflare token needed once more, to remove the old Cloudflare records"
		ask CLOUDFLARE_API_TOKEN "Cloudflare API token (Zone > DNS > Edit)" "" secret
		export CLOUDFLARE_API_TOKEN
		export TF_VAR_cloudflare_dns_api_token=$CLOUDFLARE_API_TOKEN
	fi
	ask ADMIN_PASSWORD "Admin password for the Agency sign-in (10+ characters)" "" secret
	[ ${#ADMIN_PASSWORD} -ge 10 ] || fail "The admin password must be at least 10 characters"
	export TF_VAR_admin_password=$ADMIN_PASSWORD
}

# Prints the Cloudflare zone id for $1 (or a parent domain), or fails.
find_cloudflare_zone() {
	local zone_id="" candidate=$1 response
	while [ -z "$zone_id" ] && [[ $candidate == *.* ]]; do
		response=$(request_with_header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
			"https://api.cloudflare.com/client/v4/zones?name=$candidate")
		zone_id=$(printf '%s' "$response" | grep -o '"id":"[0-9a-f]\{32\}"' | head -1 | cut -d'"' -f4 || true)
		[ -n "$zone_id" ] || candidate=${candidate#*.}
	done
	[ -n "$zone_id" ] || fail "No Cloudflare zone found for $1 that this token can see"
	echo "    Zone $candidate ($zone_id)" >&2
	printf '%s' "$zone_id"
}

# Prints the id of the public Route 53 hosted zone for $1 (or a parent domain), or nothing.
find_route53_zone() {
	local candidate=$1 found
	while [[ $candidate == *.* ]]; do
		found=$(aws route53 list-hosted-zones-by-name --dns-name "$candidate" --max-items 1 \
			--query "HostedZones[?Name=='$candidate.' && !Config.PrivateZone].Id | [0]" --output text)
		if [ -n "$found" ] && [ "$found" != "None" ]; then
			echo "    Hosted zone $candidate (${found##*/})" >&2
			printf '%s' "${found##*/}"
			return
		fi
		candidate=${candidate#*.}
	done
}

# Finds or creates the Route 53 hosted zone for $1 and prints its id.
route53_zone() {
	local zone_id zone_name
	zone_id=$(find_route53_zone "$1")
	if [ -n "$zone_id" ]; then
		printf '%s' "$zone_id"
		return
	fi
	echo "    No Route 53 hosted zone found for $1." >&2
	# Default: the registered domain, for example example.com for agency.example.com.
	ask ZONE_NAME "Domain to create a Route 53 hosted zone for" "$(printf '%s' "$1" | awk -F. '{print $(NF-1)"."$NF}')" >&2
	zone_name=$ZONE_NAME
	info "Creating a Route 53 hosted zone for $zone_name (about \$0.50 a month)" >&2
	zone_id=$(aws route53 create-hosted-zone --name "$zone_name" --caller-reference "agency-$(date +%s)" \
		--query HostedZone.Id --output text)
	printf '%s' "${zone_id##*/}"
}

# Default Bedrock model for a region: the cross-region inference profile that serves it.
bedrock_default_model() {
	local prefix=global
	case "$1" in
	us-*) prefix=us ;;
	eu-*) prefix=eu ;;
	ap-southeast-2 | ap-southeast-4) prefix=au ;;
	esac
	printf 'amazon-bedrock/%s.anthropic.claude-opus-4-8' "$prefix"
}

# Profiles size Agency by how the organization uses it, not by head count: how many apps get built at
# the same time, and how much the published ones are relied on. Prices are on-demand us-east-1.
choose_profile() {
	echo
	echo "How will your organization use Agency? (change it later with ./deploy.sh profile)"
	echo "  1) Try it out: one small server runs everything. About 2 apps built at the same"
	echo "     time and a handful of light published apps.                   about \$37 a month"
	echo "  2) Team: one larger server runs everything. About 4 apps built at the same time"
	echo "     and a dozen published apps.                                  about \$133 a month"
	echo "  3) Organization: a small server for the platform; every app's dev environment on"
	echo "     AWS Fargate, running only while someone builds; published apps packed onto shared"
	echo "     apps servers, and another server starts when they're full. No limit on how many"
	echo "     build at once.           about \$37 a month + 2 to 6 cents an hour per app being"
	echo "                              built + about \$36 a month per apps server (~14 apps each)"
	echo "  4) Custom: choose the server size and where dev environments and published apps run"
	ask PROFILE "Choose 1, 2, 3 or 4" "1"
	case "$PROFILE" in
	1) PROFILE=try SIZE=small SANDBOX_RUNTIME=docker APP_RUNTIME=docker ;;
	2) PROFILE=team SIZE=standard SANDBOX_RUNTIME=docker APP_RUNTIME=docker ;;
	3) PROFILE=organization SIZE=small SANDBOX_RUNTIME=fargate APP_RUNTIME=ec2 ;;
	4)
		PROFILE=custom
		ask SIZE "Server size: small (t3.medium, 4 GB) or standard (t3.xlarge, 16 GB)" "small"
		ask SANDBOX_RUNTIME "Dev environments: docker (on the server) or fargate (sleep when idle, pay per hour)" "docker"
		ask APP_RUNTIME "Published apps: docker (on the server), ec2 (shared apps servers that scale out) or fargate (each on its own)" "docker"
		;;
	*) fail "Choose 1, 2, 3 or 4" ;;
	esac
	case "$SIZE $SANDBOX_RUNTIME $APP_RUNTIME" in
	small\ * | standard\ *) ;;
	*) fail "Server size must be small or standard" ;;
	esac
	[ "$SANDBOX_RUNTIME" = docker ] || [ "$SANDBOX_RUNTIME" = fargate ] || fail "Dev environments: choose docker or fargate"
	case "$APP_RUNTIME" in
	docker | ec2 | fargate) ;;
	*) fail "Published apps: choose docker, ec2 or fargate" ;;
	esac
}

# Terraform settings for the chosen profile. On Fargate a dev environment gets its own 1 vCPU and 3 GB,
# so the server's per-sandbox limits only matter for sandboxes on the server.
profile_settings() {
	local instance_type=t3.medium sandbox_memory=1500m sandbox_cpus=1 volume=40
	if [ "$SIZE" = "standard" ]; then
		instance_type=t3.xlarge sandbox_memory=3g sandbox_cpus=2 volume=100
	fi
	# A disk can grow but not shrink.
	local current_volume
	current_volume=$(setting volume_size_gb 0)
	[ "$current_volume" -gt "$volume" ] 2>/dev/null && volume=$current_volume
	cat <<EOF
# profile: $PROFILE
instance_type      = "$instance_type"
volume_size_gb     = $volume
sandbox_memory     = "$sandbox_memory"
sandbox_cpus       = "$sandbox_cpus"
sandbox_runtime    = "$SANDBOX_RUNTIME"
app_runtime        = "$APP_RUNTIME"
EOF
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
	ask REPO_REF "Git branch to deploy" "main"
	choose_profile
	local dns_settings model=""
	if [ "$DNS_PROVIDER" = "route53" ]; then
		info "Looking up the Route 53 hosted zone for $BASE_DOMAIN"
		dns_settings="route53_zone_id    = \"$(route53_zone "$BASE_DOMAIN")\""
	else
		info "Looking up the Cloudflare zone for $BASE_DOMAIN"
		dns_settings="cloudflare_zone_id = \"$(find_cloudflare_zone "$BASE_DOMAIN")\""
	fi
	if [ "$LLM_PROVIDER" = "bedrock" ]; then
		ask MODEL "Claude model on Bedrock" "$(bedrock_default_model "$AWS_REGION_CHOICE")"
		model=$MODEL
	fi

	cat >"$SETTINGS" <<EOF
aws_region         = "$AWS_REGION_CHOICE"
base_domain        = "$BASE_DOMAIN"
dns_provider       = "$DNS_PROVIDER"
llm_provider       = "$LLM_PROVIDER"
$dns_settings
agency_model       = "$model"
acme_email         = "$ADMIN_EMAIL"
admin_email        = "$ADMIN_EMAIL"
repo_ref           = "$REPO_REF"
EOF
	profile_settings >>"$SETTINGS"
}

verify_keys() {
	if [ "$LLM_PROVIDER" = "bedrock" ]; then
		verify_bedrock
	else
		verify_claude_key
	fi
	if [ "$DNS_PROVIDER" = "cloudflare" ]; then
		verify_cloudflare_token
	elif ! has_cloudflare_records; then
		# A new server: its certificate needs Route 53 to answer for the domain from the start.
		# A server moving over keeps its certificate, so it only gets the reminder after the switch.
		verify_delegation wait
	fi
}

# One tiny request with your own AWS sign-in. The first call to a Claude model also turns on the
# model for the account, which the server's role is not allowed to do.
verify_bedrock() {
	local model region output
	model=$(setting agency_model)
	model=${model#amazon-bedrock/}
	region=$(region)
	info "Checking Claude on Bedrock ($model in $region)"
	if ! output=$(aws bedrock-runtime converse --region "$region" --model-id "$model" \
		--messages '[{"role":"user","content":[{"text":"Say ok"}]}]' --inference-config maxTokens=5 \
		--query 'output.message.content[0].text' --output text 2>&1); then
		echo "$output" >&2
		fail "Bedrock refused the request. In the AWS console open Amazon Bedrock > Model catalog, pick the Claude model in $region, and submit Anthropic's one-time use case form if it asks; then run ./deploy.sh again. To pick another model, change agency_model in $SETTINGS."
	fi
}

verify_claude_key() {
	info "Checking the Claude API key"
	local status
	status=$(printf 'x-api-key: %s\n' "$ANTHROPIC_API_KEY" |
		curl -sS -o /dev/null -w '%{http_code}' -H @- -H 'anthropic-version: 2023-06-01' https://api.anthropic.com/v1/models)
	[ "$status" = "200" ] || fail "The Claude API rejected the key (HTTP $status)"
}

# Let's Encrypt only sees Route 53 once the registrar points the domain at it. With "wait", waits for
# that; otherwise only says what to change.
verify_delegation() {
	local mode=${1:-remind} zone_id zone servers
	zone_id=$(setting route53_zone_id)
	zone=$(aws route53 get-hosted-zone --id "$zone_id" --query HostedZone.Name --output text)
	zone=${zone%.}
	servers=$(aws route53 get-hosted-zone --id "$zone_id" --query 'DelegationSet.NameServers' --output text | tr '\t' '\n')
	info "Checking that $zone is served by Route 53"
	for attempt in $(seq 1 120); do
		if curl -fsS "https://dns.google/resolve?name=$zone&type=NS" | grep -qiF "$(printf '%s' "$servers" | head -1)"; then
			echo "    Delegated to Route 53"
			return
		fi
		if [ "$attempt" = 1 ]; then
			echo "    $zone does not point at Route 53 yet. At your domain registrar, set its name servers to:"
			printf '%s\n' "$servers" | sed 's/^/      /'
			echo "    (If the domain already has DNS records elsewhere, such as email, copy them into the hosted zone first.)"
			[ "$mode" = "wait" ] || return 0
			echo "    Waiting for the change to show up; this can take from minutes to a few hours. Ctrl+C stops, and"
			echo "    ./deploy.sh picks up from here when you run it again."
		fi
		sleep 30
	done
	fail "$zone still does not point at Route 53. Run ./deploy.sh again once the registrar change is live."
}

verify_cloudflare_token() {
	info "Checking the Cloudflare token"
	request_with_header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
		"https://api.cloudflare.com/client/v4/user/tokens/verify" | grep -q '"status":"active"' ||
		fail "The Cloudflare token is not active"
}

wait_until_up() {
	local url=$1
	info "Waiting for $url (the first boot builds the images, about 10 to 20 minutes on a small instance; a restart takes a minute or two)"
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
	setting aws_region
}

instance_state() {
	aws ec2 describe-instances --region "$(region)" --instance-ids "$(terraform output -raw instance_id)" \
		--query 'Reservations[0].Instances[0].State.Name' --output text
}

deploy() {
	choose_mode
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
	echo "Sign in with $(setting admin_email) and the admin password you typed."
	ses_notice
}

# Email goes out through Amazon SES in the all-AWS setup. A new account starts in SES's sandbox, where
# email reaches only addresses verified in SES, so app owners wouldn't get their emails.
ses_notice() {
	[ "$(setting dns_provider cloudflare)" = route53 ] || return 0
	[ "$(aws sesv2 get-account --region "$(region)" --query ProductionAccessEnabled --output text 2>/dev/null)" = False ] || return 0
	echo
	echo "Email: Agency sends email (such as \"your app was taken offline\") through Amazon SES, which this"
	echo "AWS account uses in its sandbox: email reaches only addresses verified in SES. To email everyone,"
	echo "request production access in the SES console (Account dashboard > Request production access),"
	echo "or set an SMTP server in Agency under Settings > Email."
}

update() {
	info "Running agency-deploy on the server"
	aws ssm send-command --region "$(region)" --instance-ids "$(terraform output -raw instance_id)" \
		--document-name AWS-RunShellScript \
		--parameters 'commands=["/usr/local/bin/agency-deploy","/opt/agency-src/infra/aws/host/setup.sh"]' \
		--query Command.CommandId --output text
	echo "Started. Follow it in the AWS console under Systems Manager > Run Command."
}

# Moves a running Cloudflare + Claude API key deployment to Route 53 and Bedrock. Data, address and
# certificate stay. Route 53 gets the records first, and the Cloudflare ones go only once the registrar
# points the domain at Route 53, so the site stays reachable throughout. Safe to run again if stopped.
use_aws() {
	[ -f "$SETTINGS" ] || fail "Nothing deployed yet. Run ./deploy.sh and choose option 2."
	if [ "$(setting dns_provider cloudflare)" = "cloudflare" ]; then
		local base_domain zone_id
		base_domain=$(setting base_domain)
		info "Looking up the Route 53 hosted zone for $base_domain"
		zone_id=$(route53_zone "$base_domain")
		ask MODEL "Claude model on Bedrock" "$(bedrock_default_model "$(region)")"
		sed -i.bak -E '/^(dns_provider|llm_provider|cloudflare_zone_id|route53_zone_id|agency_model) /d' "$SETTINGS"
		rm -f "$SETTINGS.bak"
		cat >>"$SETTINGS" <<EOF
dns_provider       = "route53"
llm_provider       = "bedrock"
route53_zone_id    = "$zone_id"
agency_model       = "$MODEL"
EOF
	elif ! has_cloudflare_records; then
		fail "This deployment already runs all on AWS."
	fi
	choose_mode
	tf_secret_vars
	verify_bedrock
	terraform init -input=false -upgrade >/dev/null
	info "Adding the records to Route 53 (Cloudflare keeps serving them until the switch)"
	terraform apply -target=aws_route53_record.platform -target=aws_route53_record.apps
	verify_delegation wait
	deploy
	update
}

# Changes the profile of a running deployment. Moving to the cluster keeps everything: the platform moves
# each published app with the version it had, and each app's workspace the first time someone opens it.
# Moving back from the cluster to the server, or published apps between ec2 and fargate, isn't supported yet.
change_profile() {
	[ -f "$SETTINGS" ] || fail "Nothing deployed yet. Run ./deploy.sh first."
	echo "Now: $(setting instance_type), dev environments on $(setting sandbox_runtime docker), published apps on $(setting app_runtime docker)."
	choose_profile
	[ "$(setting sandbox_runtime docker)" = fargate ] && [ "$SANDBOX_RUNTIME" = docker ] &&
		fail "Dev environments already run on Fargate; moving them back to the server isn't supported yet."
	local apps_now
	apps_now=$(setting app_runtime docker)
	[ "$apps_now" != docker ] && [ "$APP_RUNTIME" != "$apps_now" ] &&
		fail "Published apps already run on $apps_now; moving them elsewhere isn't supported yet."
	local settings
	settings=$(profile_settings)
	sed -i.bak -E '/^(# profile:|instance_type|volume_size_gb|sandbox_memory|sandbox_cpus|sandbox_runtime|app_runtime) /d' "$SETTINGS"
	rm -f "$SETTINGS.bak"
	printf '%s\n' "$settings" >>"$SETTINGS"
	deploy
	update
}

# Rough monthly costs, on-demand us-east-1 list prices (other regions differ by up to about 30%).
costs() {
	[ -f "$SETTINGS" ] || fail "Nothing deployed yet. Run ./deploy.sh first."
	local instance_type volume server
	instance_type=$(setting instance_type t3.medium)
	volume=$(setting volume_size_gb 40)
	case "$instance_type" in
	t3.medium) server=30.37 ;;
	t3.large) server=60.74 ;;
	t3.xlarge) server=121.47 ;;
	t3.2xlarge) server=242.94 ;;
	*) server=0 ;;
	esac
	awk -v server="$server" -v type="$instance_type" -v volume="$volume" \
		-v sandboxes="$(setting sandbox_runtime docker)" -v apps="$(setting app_runtime docker)" -v spot="$(setting sandbox_spot true)" 'BEGIN {
		disk = volume * 0.08; ip = 3.65
		printf "%-34s $%7.2f a month\n", "Server " type ", always on:", server
		printf "%-34s $%7.2f a month\n", "Disk " volume " GB and public IP:", disk + ip
		printf "%-34s $%7.2f a month (about)\n", "Backups (S3) and logs:", 1
		if (server == 0) print "  (unknown instance type: check its price at aws.amazon.com/ec2/pricing)"
		printf "%-34s $%7.2f a month, or $%.2f while stopped\n", "Fixed total:", server + disk + ip + 1, disk + ip
		if (sandboxes == "fargate") {
			hour = (spot == "false") ? 0.0405 + 3 * 0.00445 + 0.005 : 0.0122 + 3 * 0.00134 + 0.005
			printf "Each app being built (Fargate%s, 1 vCPU, 3 GB): $%.3f an hour while it is awake\n", (spot == "false") ? "" : " Spot", hour
			printf "  e.g. 10 people building 3 hours a day, 21 days:  $%.2f a month\n", hour * 10 * 3 * 21
			printf "Workspaces on EFS: $0.30 per GB a month (an app is usually under 50 MB)\n"
		} else {
			print "Dev environments run on the server: no extra cost."
		}
		if (apps == "ec2") {
			pool = 30.37 + 30 * 0.08 + ip
			printf "Each apps server (t3.medium, 30 GB, public IP): $%.2f a month. It holds about 14 small published\n", pool
			printf "  apps; another starts when they are full (up to apps_servers_max, default 4).\n"
			printf "  e.g. 8 published apps: one server, $%.2f a month ($%.2f an app); 20 apps: two, $%.2f.\n", pool, pool / 8, 2 * pool
		} else if (apps == "fargate") {
			app = 730 * (0.25 * 0.04048 + 0.5 * 0.004445 + 0.005)
			printf "Each published app (Fargate, 0.25 vCPU, 0.5 GB, always on): $%.2f a month; more while it scales out\n", app
		} else {
			print "Published apps run on the server: no extra cost."
		}
		print "Claude usage is billed separately (Anthropic, or Amazon Bedrock on this AWS bill)."
	}'
}

# Tasks the platform started in the cluster are not in Terraform's state. Sandboxes stop with the
# server (no platform is left to put them to sleep); services go before a destroy.
stop_sandboxes() {
	local cluster
	cluster=$(terraform output -raw cluster 2>/dev/null || true)
	[ -n "$cluster" ] && [ "$cluster" != "null" ] || return 0
	for task in $(aws ecs list-tasks --region "$(region)" --cluster "$cluster" --desired-status RUNNING --query 'taskArns[]' --output text); do
		aws ecs stop-task --region "$(region)" --cluster "$cluster" --task "$task" --reason "Server stopped" >/dev/null
	done
}

# Published apps in the cluster can't be reached while the server is stopped, so they stop with it:
# each service goes to zero tasks with its autoscaling paused, and the apps servers' group may shrink to
# none (ECS drains and removes them once they're empty). start_apps undoes both.
app_services() {
	aws ecs list-services --region "$(region)" --cluster "$1" --query 'serviceArns[]' --output text | tr '\t' '\n' | sed -n 's|.*/||p'
}

stop_apps() {
	local cluster group
	cluster=$(terraform output -raw cluster 2>/dev/null || true)
	[ -n "$cluster" ] && [ "$cluster" != "null" ] || return 0
	info "Stopping published apps in the cluster"
	for service in $(app_services "$cluster"); do
		aws application-autoscaling register-scalable-target --region "$(region)" --service-namespace ecs \
			--resource-id "service/$cluster/$service" --scalable-dimension ecs:service:DesiredCount --min-capacity 0 \
			--suspended-state DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=true >/dev/null 2>&1 || true
		aws ecs update-service --region "$(region)" --cluster "$cluster" --service "$service" --desired-count 0 >/dev/null
	done
	group=$(terraform output -raw apps_servers 2>/dev/null || true)
	if [ -n "$group" ] && [ "$group" != "null" ]; then
		aws autoscaling update-auto-scaling-group --region "$(region)" --auto-scaling-group-name "$group" --min-size 0 --desired-capacity 0
	fi
}

start_apps() {
	local cluster group
	cluster=$(terraform output -raw cluster 2>/dev/null || true)
	[ -n "$cluster" ] && [ "$cluster" != "null" ] || return 0
	info "Starting published apps in the cluster"
	group=$(terraform output -raw apps_servers 2>/dev/null || true)
	if [ -n "$group" ] && [ "$group" != "null" ]; then
		aws autoscaling update-auto-scaling-group --region "$(region)" --auto-scaling-group-name "$group" --min-size 1
	fi
	for service in $(app_services "$cluster"); do
		aws ecs update-service --region "$(region)" --cluster "$cluster" --service "$service" --desired-count 1 >/dev/null
		aws application-autoscaling register-scalable-target --region "$(region)" --service-namespace ecs \
			--resource-id "service/$cluster/$service" --scalable-dimension ecs:service:DesiredCount --min-capacity 1 \
			--suspended-state DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=false >/dev/null 2>&1 || true
	done
}

delete_app_services() {
	local cluster
	cluster=$(terraform output -raw cluster 2>/dev/null || true)
	[ -n "$cluster" ] && [ "$cluster" != "null" ] || return 0
	info "Deleting published apps and dev environments in the cluster"
	for service in $(app_services "$cluster"); do
		# Removes the app's scaling policy and its CloudWatch alarms too.
		aws application-autoscaling deregister-scalable-target --region "$(region)" --service-namespace ecs \
			--resource-id "service/$cluster/$service" --scalable-dimension ecs:service:DesiredCount >/dev/null 2>&1 || true
		aws ecs delete-service --region "$(region)" --cluster "$cluster" --service "$service" --force >/dev/null
	done
	stop_sandboxes
	# Task definitions the platform registered (one family per app and per sandbox).
	local definitions
	definitions=$(aws ecs list-task-definitions --region "$(region)" --family-prefix "$cluster-" --query 'taskDefinitionArns[]' --output text | tr '\t' '\n' | grep -E ":task-definition/$cluster-(app|sandbox)-" || true)
	for definition in $definitions; do
		aws ecs deregister-task-definition --region "$(region)" --task-definition "$definition" >/dev/null 2>&1 || true
	done
	# Deleting takes up to 10 at a time; a failure here leaves only free, inactive entries behind.
	printf '%s\n' $definitions | xargs -r -n 10 aws ecs delete-task-definitions --region "$(region)" --task-definitions >/dev/null 2>&1 || true
}

case "$ACTION" in
deploy)
	check_aws
	deploy
	;;
update)
	check_aws
	update
	;;
use-aws)
	check_aws
	use_aws
	;;
profile)
	check_aws
	change_profile
	;;
costs)
	costs
	;;
stop)
	check_aws
	info "Stopping the server (disk, Elastic IP and DNS records are kept)"
	stop_apps
	stop_sandboxes
	aws ec2 stop-instances --region "$(region)" --instance-ids "$(terraform output -raw instance_id)" >/dev/null
	aws ec2 wait instance-stopped --region "$(region)" --instance-ids "$(terraform output -raw instance_id)"
	info "Stopped. Start it again with: ./deploy.sh start"
	;;
start)
	check_aws
	start_apps
	info "Starting the server"
	aws ec2 start-instances --region "$(region)" --instance-ids "$(terraform output -raw instance_id)" >/dev/null
	aws ec2 wait instance-running --region "$(region)" --instance-ids "$(terraform output -raw instance_id)"
	wait_until_up "$(terraform output -raw url)"
	;;
status)
	check_aws
	echo "Server: $(instance_state)"
	if curl -fsS -o /dev/null --max-time 5 "$(terraform output -raw url)/healthz" 2>/dev/null; then
		echo "Site:   up at $(terraform output -raw url)"
	else
		echo "Site:   not answering"
	fi
	;;
backup)
	check_aws
	info "Backing up all databases on the server"
	aws ssm send-command --region "$(region)" --instance-ids "$(terraform output -raw instance_id)" \
		--document-name AWS-RunShellScript --parameters 'commands=["/usr/local/bin/agency-backup"]' \
		--query Command.CommandId --output text
	echo "Started. Backups land in $(terraform output -raw backup_bucket 2>/dev/null || echo 'the backup bucket')/postgres/."
	;;
destroy)
	check_aws
	choose_mode
	tf_secret_vars
	read -rp "Delete the Agency server, its data, backups and DNS records? Type the domain to confirm: " confirm
	[ "$confirm" = "$(setting base_domain)" ] || fail "Cancelled"
	delete_app_services
	terraform destroy -input=false -auto-approve
	;;
*)
	fail "Unknown command '$ACTION'. Use deploy, update, use-aws, profile, costs, stop, start, status, backup or destroy."
	;;
esac

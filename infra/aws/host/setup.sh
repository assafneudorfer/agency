#!/usr/bin/env bash
# Installs host-level pieces that live outside docker compose. Safe to run again; agency-deploy
# runs it after every update.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

install -m 0755 "$HERE/agency-backup" /usr/local/bin/agency-backup

cat > /etc/systemd/system/agency-backup.service <<'UNIT'
[Unit]
Description=Back up Agency databases
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/agency-backup
UNIT

# Persistent: a run missed while the server was stopped happens soon after it starts again.
cat > /etc/systemd/system/agency-backup.timer <<'UNIT'
[Unit]
Description=Back up Agency databases every night

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

install -m 0755 "$HERE/agency-aws-credentials" /usr/local/bin/agency-aws-credentials

# All-AWS setup: short-lived Route 53 and Bedrock credentials, refreshed before Docker starts and every 15 minutes.
cat > /etc/systemd/system/agency-aws-credentials.service <<'UNIT'
[Unit]
Description=Refresh Agency's AWS credentials (Route 53, Bedrock, Fargate apps)
Wants=network-online.target
After=network-online.target
Before=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/agency-aws-credentials

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/agency-aws-credentials.timer <<'UNIT'
[Unit]
Description=Refresh Agency's AWS credentials every 15 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now agency-backup.timer >/dev/null
# Published apps on Fargate reach their databases at this server's private address.
if grep -q '^AGENCY_APP_RUNTIME=fargate' /opt/agency-src/.env 2>/dev/null; then
	imds_token=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
	private_ip=$(curl -fsS -H "X-aws-ec2-metadata-token: $imds_token" http://169.254.169.254/latest/meta-data/local-ipv4)
	sed -i '/^AGENCY_HOST_PRIVATE_IP=/d' /opt/agency-src/.env
	echo "AGENCY_HOST_PRIVATE_IP=$private_ip" >>/opt/agency-src/.env
fi
if grep -qE '^AGENCY_(DNS|BEDROCK|APPS)_ROLE_ARN=.' /opt/agency-src/.env 2>/dev/null; then
	had_dns=$([ -f /var/lib/agency/aws/dns/credentials.json ] && echo yes || true)
	systemctl enable agency-aws-credentials.service >/dev/null
	systemctl enable --now agency-aws-credentials.timer >/dev/null
	/usr/local/bin/agency-aws-credentials
	echo "AWS credentials refreshed every 15 minutes"
	# Traefik asks for its certificate as it starts, so a Traefik that started before its first
	# Route 53 credentials (a server switched over to Route 53) gets a restart to ask again.
	if [ -z "$had_dns" ] && [ -f /var/lib/agency/aws/dns/credentials.json ] &&
		[ -n "$(cd /opt/agency-src && docker compose ps -q traefik 2>/dev/null)" ]; then
		(cd /opt/agency-src && docker compose restart traefik >/dev/null)
	fi
fi
echo "Backups scheduled: $(systemctl list-timers agency-backup.timer --no-legend | awk '{print $1, $2, $3}')"

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

systemctl daemon-reload
systemctl enable --now agency-backup.timer >/dev/null
echo "Backups scheduled: $(systemctl list-timers agency-backup.timer --no-legend | awk '{print $1, $2, $3}')"

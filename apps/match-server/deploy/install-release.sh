#!/usr/bin/env bash
# Runs on the VM (as root) from deploy.sh: installs /tmp/ofa-deploy/server.js as release <sha>, switches to it,
# and rolls back when /health does not report it. KEY=VALUE lines on stdin update /etc/ofa-match.env (secrets).
set -euo pipefail
SHA="${1:?release sha}"
while IFS= read -r line; do
	[ -z "$line" ] && continue
	key="${line%%=*}"
	if grep -q "^$key=" /etc/ofa-match.env; then sed -i "s|^$key=.*|$line|" /etc/ofa-match.env; else echo "$line" >> /etc/ofa-match.env; fi
done
sed -i "s|^RELEASE=.*|RELEASE=$SHA|" /etc/ofa-match.env
install -d -m 0755 "/opt/ofa-match/releases/$SHA"
install -m 0644 /tmp/ofa-deploy/server.js "/opt/ofa-match/releases/$SHA/server.js"
install -m 0644 /tmp/ofa-deploy/ofa-match.service /etc/systemd/system/ofa-match.service
prev=$(readlink /opt/ofa-match/current || true)
ln -sfn "/opt/ofa-match/releases/$SHA" /opt/ofa-match/current
systemctl daemon-reload
systemctl restart ofa-match
for _ in $(seq 1 20); do
	if curl -fs http://127.0.0.1:8080/health | grep -q "\"release\":\"$SHA\""; then
		echo "live: $SHA"
		# Keep the five newest releases.
		ls -1dt /opt/ofa-match/releases/* | tail -n +6 | xargs -r rm -rf
		exit 0
	fi
	sleep 0.5
done
echo "health check failed; rolling back to ${prev:-nothing}" >&2
journalctl -u ofa-match -n 20 --no-pager >&2 || true
if [ -n "$prev" ]; then ln -sfn "$prev" /opt/ofa-match/current; systemctl restart ofa-match; fi
exit 1

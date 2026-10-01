#!/usr/bin/env bash
# Prepares an Ubuntu 24.04 VM for the match server (docs/match-server-oracle.md §4). Idempotent: safe to rerun.
# Run as root on the VM:  sudo bash provision.sh <public host name>   e.g. 138.2.124.85.sslip.io or match.example.com
set -euo pipefail
HOST="${1:?usage: provision.sh <public host name>}"
BUN_VERSION=1.3.12

# Oracle Ubuntu images reject everything but SSH in iptables; open 80 (ACME) and 443 before the final REJECT.
for port in 80 443; do
	if ! iptables -C INPUT -m state --state NEW -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
		n=$(iptables -L INPUT --line-numbers | awk '/REJECT/{print $1; exit}')
		iptables -I INPUT "${n:-1}" -m state --state NEW -p tcp --dport "$port" -j ACCEPT
	fi
done
command -v netfilter-persistent >/dev/null && netfilter-persistent save

# Caddy from Ubuntu's own archive (the upstream apt repo's signing key had expired, 2026-10).
rm -f /etc/apt/sources.list.d/caddy-stable.list
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy unzip curl unattended-upgrades fail2ban >/dev/null
# SSH is open to the internet for CI deploys (key-only auth); fail2ban bans brute-force sources.
systemctl enable --now fail2ban >/dev/null 2>&1

# Bun, pinned to the CI version, system-wide.
if [ "$(/usr/local/bin/bun --version 2>/dev/null)" != "$BUN_VERSION" ]; then
	curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash -s "bun-v$BUN_VERSION" >/dev/null 2>&1
	ln -sf /opt/bun/bin/bun /usr/local/bin/bun
fi

id ofa >/dev/null 2>&1 || useradd --system --home /opt/ofa-match --shell /usr/sbin/nologin ofa
install -d -o ofa -g ofa -m 0750 /opt/ofa-match /opt/ofa-match/data
install -d -o root -g root -m 0755 /opt/ofa-match/releases

# Secrets and settings: written once with placeholders; deploy.sh fills the secrets.
if [ ! -f /etc/ofa-match.env ]; then
	cat > /etc/ofa-match.env <<ENV
HOST=127.0.0.1
PORT=8080
DATA_DIR=/opt/ofa-match/data
WORKER_ORIGIN=https://one-finger-royale.akswnd55.workers.dev
ALLOWED_ORIGINS=https://one-finger-royale.akswnd55.workers.dev
TICKET_SECRET=
INTERNAL_SECRET=
RELEASE=none
ENV
fi
chown root:ofa /etc/ofa-match.env
chmod 0640 /etc/ofa-match.env

printf '%s {\n\treverse_proxy 127.0.0.1:8080\n}\n' "$HOST" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

install -m 0644 "$(dirname "$0")/ofa-match.service" /etc/systemd/system/ofa-match.service
systemctl daemon-reload
systemctl enable ofa-match >/dev/null
echo "provisioned for $HOST"

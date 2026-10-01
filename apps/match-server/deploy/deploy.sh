#!/usr/bin/env bash
# Builds the match server and ships it to the VM (docs/match-server-oracle.md §10).
#   apps/match-server/deploy/deploy.sh ubuntu@138.2.124.85 [ssh key]
# TICKET_SECRET / INTERNAL_SECRET in the environment, when set, are written into /etc/ofa-match.env.
set -euo pipefail
TARGET="${1:?usage: deploy.sh <user@host> [ssh key]}"
KEY="${2:-$HOME/.ssh/ofa_match}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD)$(git -C "$ROOT" diff --quiet HEAD || echo -dirty)"
OUT="$ROOT/apps/match-server/dist/$SHA"

(cd "$ROOT/apps/match-server" && bun build src/main.ts --target=bun --outfile "$OUT/server.js" >/dev/null)
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$TARGET" "mkdir -p /tmp/ofa-deploy"
scp -q -i "$KEY" "$OUT/server.js" "$ROOT/apps/match-server/deploy/ofa-match.service" "$ROOT/apps/match-server/deploy/install-release.sh" "$TARGET:/tmp/ofa-deploy/"
# Secrets travel on stdin, never on a command line or in a file left on disk.
{
	if [ -n "${TICKET_SECRET:-}" ]; then echo "TICKET_SECRET=$TICKET_SECRET"; fi
	if [ -n "${INTERNAL_SECRET:-}" ]; then echo "INTERNAL_SECRET=$INTERNAL_SECRET"; fi
} | ssh -i "$KEY" "$TARGET" "sudo bash /tmp/ofa-deploy/install-release.sh '$SHA'"

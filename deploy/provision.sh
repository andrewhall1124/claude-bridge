#!/usr/bin/env bash
# Provision a Hetzner Cloud VPS for Bridge in one shot.
#
# Creates (if missing) an admin SSH key and an optional cloud firewall, renders
# deploy/cloud-init.yaml with your secrets, and boots a server that bootstraps
# itself (Node, Tailscale, clone, build, systemd). The only step left afterwards
# is the interactive `claude login` — the script prints how.
#
# Prereqs:
#   - hcloud authenticated:  hcloud context create bridge   (paste API token)
#   - env:  TS_AUTHKEY=tskey-...          (ephemeral/reusable Tailscale auth key)
#   - optional env:  DEPLOY_PUBKEY="ssh-ed25519 AAAA..."   (CI deploy public key)
#   - an admin SSH public key on disk (default ~/.ssh/id_ed25519.pub)
#
# Usage:
#   TS_AUTHKEY=tskey-... ./deploy/provision.sh
set -euo pipefail

SERVER_NAME="${SERVER_NAME:-bridge}"
SERVER_TYPE="${SERVER_TYPE:-cx22}"          # 2 vCPU / 4 GB shared x86, ~€3.79/mo
IMAGE="${IMAGE:-ubuntu-24.04}"
LOCATION="${LOCATION:-nbg1}"                 # Nuremberg; or fsn1/hel1/ash/hil
REPO_URL="${REPO_URL:-https://github.com/andrewhall1124/claude-bridge.git}"
ADMIN_KEY_NAME="${ADMIN_KEY_NAME:-bridge-admin}"
ADMIN_PUBKEY_FILE="${ADMIN_PUBKEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
FIREWALL_NAME="${FIREWALL_NAME:-bridge-fw}"

DEPLOY_PUBKEY="${DEPLOY_PUBKEY:-}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

command -v hcloud >/dev/null || die "hcloud not found (brew install hcloud)"
hcloud server list >/dev/null 2>&1 || die "hcloud not authenticated — run: hcloud context create bridge"
[ -n "${TS_AUTHKEY:-}" ] || die "TS_AUTHKEY env var is required (Tailscale auth key)"
[ -f "$ADMIN_PUBKEY_FILE" ] || die "admin pubkey not found at $ADMIN_PUBKEY_FILE (set ADMIN_PUBKEY_FILE)"

if hcloud server describe "$SERVER_NAME" >/dev/null 2>&1; then
  die "a server named '$SERVER_NAME' already exists — delete it or set SERVER_NAME"
fi

# --- Admin SSH key (idempotent) ---
if ! hcloud ssh-key describe "$ADMIN_KEY_NAME" >/dev/null 2>&1; then
  echo "==> Uploading admin SSH key '$ADMIN_KEY_NAME'"
  hcloud ssh-key create --name "$ADMIN_KEY_NAME" --public-key-from-file "$ADMIN_PUBKEY_FILE"
fi

# --- Cloud firewall: inbound 22 (admin) + 41641/udp (direct Tailscale) only ---
if ! hcloud firewall describe "$FIREWALL_NAME" >/dev/null 2>&1; then
  echo "==> Creating firewall '$FIREWALL_NAME'"
  hcloud firewall create --name "$FIREWALL_NAME"
  hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol tcp --port 22 \
    --source-ips 0.0.0.0/0 --source-ips ::/0
  hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol udp --port 41641 \
    --source-ips 0.0.0.0/0 --source-ips ::/0
fi

# --- Render cloud-init with secrets (temp file, removed on exit) ---
rendered="$(mktemp -t bridge-cloud-init.XXXXXX)"
trap 'rm -f "$rendered"' EXIT
sed \
  -e "s|__TS_AUTHKEY__|${TS_AUTHKEY}|g" \
  -e "s|__DEPLOY_PUBKEY__|${DEPLOY_PUBKEY}|g" \
  -e "s|__REPO_URL__|${REPO_URL}|g" \
  "$here/cloud-init.yaml" > "$rendered"

echo "==> Creating server '$SERVER_NAME' ($SERVER_TYPE, $IMAGE, $LOCATION)"
hcloud server create \
  --name "$SERVER_NAME" \
  --type "$SERVER_TYPE" \
  --image "$IMAGE" \
  --location "$LOCATION" \
  --ssh-key "$ADMIN_KEY_NAME" \
  --firewall "$FIREWALL_NAME" \
  --user-data-from-file "$rendered"

echo
echo "==> Server created. Bootstrap runs on first boot (~2-4 min)."
echo "    Watch it:   ssh root@\$(hcloud server ip $SERVER_NAME) tail -f /var/log/bridge-bootstrap.log"
echo "    Then, over Tailscale:"
echo "      ssh bridge@bridge.<your-tailnet>.ts.net"
echo "      cd /srv/claude-bridge && npx claude login && sudo systemctl start bridge"

# Deploying Bridge to a Hetzner VPS

Bridge is a single-user app whose **only** access control is your Tailscale network and
whose billing depends on Claude credentials stored on the box. So it wants a real VPS —
not an ephemeral PaaS. This runbook gets you to **push-to-`main` → live in ~30s**, with
nothing exposed to the public internet.

- One-time **provisioning** (~20 min) — sections 1–6.
- Ongoing **deploys** — automatic via `.github/workflows/deploy.yml`.

---

## 0. Pieces

| Piece | Role |
|-------|------|
| Hetzner Cloud VPS (Ubuntu) | runs the Node server under `systemd` |
| Tailscale on the VPS | the entire security boundary; the app binds to the tailnet IP |
| `deploy/bridge.service` | systemd unit (in this repo) |
| `deploy/deploy.sh` | pull + `npm ci` + build + restart (in this repo) |
| GitHub Actions | joins the tailnet, SSHes in, runs `deploy.sh` on push to `main` |

---

## Fast path: automated provisioning (`hcloud`)

If you have the [`hcloud` CLI](https://github.com/hetznercloud/cli) (`brew install hcloud`),
`deploy/provision.sh` + `deploy/cloud-init.yaml` create and bootstrap the box in one
command — Node, Tailscale, clone, build, systemd, firewall, and (optionally) the CI
deploy key — leaving only the interactive `claude login`.

```bash
hcloud context create bridge        # paste a Read&Write API token from the Hetzner console

export TS_AUTHKEY=tskey-...          # ephemeral/reusable Tailscale auth key
export DEPLOY_PUBKEY="$(cat bridge-deploy.pub)"   # optional: bakes in the CI deploy key
./deploy/provision.sh               # creates server 'bridge' (cx22, ubuntu-24.04, nbg1)
```

Then, over Tailscale:

```bash
ssh bridge@bridge.<your-tailnet>.ts.net
claude login && sudo systemctl restart bridge   # restart (not start) — that's the NOPASSWD-allowed command
```

Overridable via env: `SERVER_NAME`, `SERVER_TYPE`, `IMAGE`, `LOCATION`, `REPO_URL`,
`ADMIN_PUBKEY_FILE`. The Tailscale auth key is written into the server's user-data, so
use a **short-lived / single-use** key. The manual walkthrough below is the same steps,
done by hand.

---

## 1. Provision the box (manual)

- Create a Hetzner Cloud server. **cax11** (2 vCPU / 4 GB ARM, ~€3.79/mo) is the cheapest
  good fit: `better-sqlite3` compiles a native addon and the Agent SDK spawns Claude Code
  processes, so avoid 512 MB–1 GB boxes. (x86 equivalent: `cpx22`. ARM is fine — Node 20,
  Tailscale, and the native addon all build on arm64.)
- Image: **Ubuntu 24.04**. Add your personal SSH key during creation so you can log in.

```bash
ssh root@<hetzner-public-ip>
```

Install Node 20+, git, and build tools (the native addon needs a compiler + python):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git build-essential python3
```

## 2. Tailscale (the security boundary)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
tailscale ip -4          # note the 100.x.y.z address
tailscale status         # note the MagicDNS name, e.g. bridge.<tailnet>.ts.net
```

## 3. Firewall — tailnet only

Belt-and-suspenders alongside binding to the tailnet IP:

```bash
ufw allow in on tailscale0          # allow everything over the tailnet
ufw allow in on tailscale0 to any port 22   # (SSH over tailnet for CI)
ufw deny 8787                       # block the app port on public interfaces
ufw --force enable
```

Once Tailscale SSH/login works, you can also close public SSH (port 22 on eth0).

## 4. Create the service user, clone, configure

```bash
adduser --system --group --home /srv/claude-bridge bridge
# Give it a login shell + sudo for the restart only (see §6).
usermod -s /bin/bash bridge

su - bridge
git clone https://github.com/andrewhall1124/claude-bridge.git /srv/claude-bridge
cd /srv/claude-bridge
npm ci
```

**Authenticate Claude as the `bridge` user** (subscription billing — do NOT set
`ANTHROPIC_API_KEY`). The Agent SDK bundles the Claude Code binary but doesn't put it on
PATH, so symlink it first:

```bash
ln -sf "$(find /srv/claude-bridge/node_modules/@anthropic-ai -maxdepth 2 -name claude -type f | head -1)" \
  /usr/local/bin/claude    # run with sudo; the fast path does this automatically
claude login
```

Create `.env` (binds to the tailnet IP):

```bash
cp .env.example .env
# Edit: set BIND_ADDRESS=<100.x.y.z from `tailscale ip -4`>, PORT, DEFAULT_MODEL, REPOS, etc.
```

First build so `web/dist` exists before the service starts:

```bash
npm run build
exit   # back to root for systemd setup
```

## 5. systemd service

```bash
cp /srv/claude-bridge/deploy/bridge.service /etc/systemd/system/bridge.service
# Edit WorkingDirectory / User if you changed them.
systemctl daemon-reload
systemctl enable --now bridge
systemctl status bridge          # should be active (running)
journalctl -u bridge -f          # live logs
```

Open the app from a tailnet device: `http://<MagicDNS-name>:8787`.

## 6. Let the deploy user restart the service without a password

`deploy.sh` ends with `sudo systemctl restart bridge`. Grant exactly that, nothing more:

```bash
echo 'bridge ALL=(root) NOPASSWD: /usr/bin/systemctl restart bridge' \
  > /etc/sudoers.d/bridge-deploy
chmod 440 /etc/sudoers.d/bridge-deploy
visudo -cf /etc/sudoers.d/bridge-deploy   # validate
```

---

## 7. Wire up CI/CD

The workflow joins your tailnet as an ephemeral node, SSHes to the box with a deploy key,
and runs `deploy/deploy.sh`.

### a. Deploy SSH key

On your laptop:

```bash
ssh-keygen -t ed25519 -f bridge-deploy -C "github-actions-deploy" -N ""
```

Add the **public** key to the box:

```bash
# as the bridge user on the VPS:
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "<contents of bridge-deploy.pub>" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### b. Tailscale OAuth client + tag

1. In the Tailscale admin **ACL editor**, allow the tag and let CI reach the box:
   ```jsonc
   "tagOwners": { "tag:ci-cd": ["autogroup:admin"] },
   // If your ACLs are locked down (not default allow-all), also permit:
   //   tag:ci-cd  ->  the bridge host on tcp:22
   ```
2. **Settings → OAuth clients → Generate**, scope **Devices: write (auth keys)**,
   assign tag `tag:ci-cd`. Save the client ID and secret.

### c. GitHub repo secrets & variables

**Settings → Secrets and variables → Actions**

Secrets:
| Name | Value |
|------|-------|
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID |
| `TS_OAUTH_SECRET` | Tailscale OAuth client secret |
| `DEPLOY_SSH_KEY` | contents of the **private** `bridge-deploy` key |

Variables:
| Name | Value |
|------|-------|
| `DEPLOY_HOST` | VPS MagicDNS name (e.g. `bridge.<tailnet>.ts.net`) or `100.x.y.z` |
| `DEPLOY_USER` | `bridge` |

### d. Deploy

Push to `main` (or run **Actions → Deploy → Run workflow**). The job:

```
Connect to Tailscale → SSH to the box → git reset --hard origin/main
  → npm ci → npm run build → sudo systemctl restart bridge
```

Watch progress in the Actions tab; confirm on the box with `journalctl -u bridge -f`.

---

## Notes & troubleshooting

- **Billing:** never set `ANTHROPIC_API_KEY` if you want subscription billing. The app
  deletes it from the agent env when no key is configured.
- **`claude login` expiry:** credentials live in the `bridge` user's home and persist
  across deploys (deploys only touch the repo). If sessions start failing auth, re-run
  `claude login` as `bridge`.
- **Restart fails in CI with a sudo password prompt:** the sudoers drop-in (§6) is missing
  or the path doesn't match (`which systemctl` — adjust if not `/usr/bin/systemctl`).
- **`npm ci` fails compiling `better-sqlite3`:** `build-essential` / `python3` missing.
- **Brief downtime on restart** is expected and fine for a single user. For zero-downtime
  you'd run two instances behind a proxy — overkill here.
- **Rollback:** `git -C /srv/claude-bridge reset --hard <good-sha> && npm ci && npm run build
  && sudo systemctl restart bridge`, or revert the commit and push.

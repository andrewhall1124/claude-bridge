# Bridge

A personal, single-user web app that drives **Claude Code** against repos living on a
VPS — usable from your phone and your laptop, reachable only over your private
**Tailscale** network. It bridges your devices to Claude Code running under *your own*
Claude subscription.

How it works:

- **Chat** — send a message and watch Claude work in real time: streamed replies, live
  "thinking…" / "working…" progress, and approve/reject prompts when it wants to edit or
  run. Sessions persist and resume, and the same session can be opened from either device.
  Drag files into the chat or paste an image — they're uploaded server-side (under
  `data/uploads/`) and referenced by path in your message so the agent reads them (images
  included, via Claude Code's Read tool).
- **Code** — a separate tab with a file tree, read-only file viewer, and a diff of
  uncommitted changes you can commit or discard.

It wraps Claude Code with a tunable default persona (a system prompt + each repo's
`CLAUDE.md`). The selected repo, session, and tab live in the URL, so a refresh (or a
bookmark/deep link) restores exactly where you were.

> Codename "Bridge". Single user, no accounts, no sign-up — **access control is the
> tailnet**. This is for the owner's own use with the owner's own subscription; it is not
> a product for third parties.

---

## Architecture

```
  Phone (PWA)  ──┐
                 ├── Tailscale (private) ──► VPS
  Laptop (PWA) ──┘                            │
                                              ├── Bridge server (Node / TypeScript)
                                              │     ├── HTTP API + static PWA   (Fastify)
                                              │     ├── WebSocket (live stream + approvals)
                                              │     ├── Session manager (Claude Agent SDK)
                                              │     └── SQLite (sessions, transcripts, settings)
                                              │
                                              ├── Claude Agent SDK ──► Claude Code engine
                                              │     (authenticated via your CLI login)
                                              └── Repos on disk (e.g. /srv/repos/<name>)
```

One Node process serves both the API/WebSocket and the built PWA. One language end to end.

### Tech stack

| Layer        | Choice |
|--------------|--------|
| Runtime      | Node.js 20+ (TypeScript throughout) |
| Agent engine | [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — bundles the Claude Code binary (no separate install) |
| Server       | [Fastify](https://fastify.dev) + [`ws`](https://github.com/websockets/ws) |
| Database     | SQLite via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (single file, zero ops) |
| Client       | React + Vite, built to static files, served by the Node process; installable PWA |
| Diffs        | `git` on disk, rendered client-side with [`diff2html`](https://diff2html.xyz) |

Exact versions are pinned in the `package.json` files.

---

## Prerequisites

- **Node.js 20+** and **npm** on the VPS.
- **git** on the VPS (used for status/diff/commit/discard).
- A **Claude subscription** (Pro/Max) — see authentication below.
- **Tailscale** installed on the VPS and on your phone/laptop, all on the same tailnet.

---

## Setup

```bash
git clone https://github.com/andrewhall1124/claude-bridge.git
cd claude-bridge
npm install
```

### 1. Authenticate Claude (subscription billing)

Run the Claude Code login flow **once, as the user the server runs as**, so subscription
credentials are stored on the box. The Agent SDK bundles the Claude Code binary but
doesn't put it on PATH, so point at it directly (or symlink it):

```bash
# the bundled binary lives under the installed SDK's platform package:
"$(find node_modules/@anthropic-ai -maxdepth 2 -name claude -type f | head -1)" login
```

The Agent SDK then authenticates through those stored credentials.

> **Billing — important.** Leave `ANTHROPIC_API_KEY` **unset** to bill usage against your
> subscription. Setting it overrides the subscription and switches to pay-as-you-go
> API-key billing — that's the documented escape hatch (see
> [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
> Anthropic announced (then paused) a change moving programmatic Agent SDK usage onto a
> separate credit pool; for now subscription usage still applies. The API-key fallback is
> wired so the app keeps working if that policy changes.

### 2. Configure

Either copy `config.example.json` → `config.json`, or copy `.env.example` → `.env`
(env vars take precedence over `config.json`). Minimum: a bind address, a port, and your
repos.

`config.json`:

```json
{
  "port": 8787,
  "bindAddress": "100.x.y.z",
  "dbPath": "./data/bridge.sqlite",
  "defaultModel": "opus",
  "defaultPermissionMode": "default",
  "repos": [
    { "id": "web", "name": "My Web App", "path": "/srv/repos/web" },
    { "id": "api", "name": "API Service", "path": "/srv/repos/api" }
  ]
}
```

Repos can also come from the `REPOS="id:Name:/path,..."` env var, or by scanning a
directory with `REPOS_DIR=/srv/repos` (each subdirectory becomes a repo). Drop a
`CLAUDE.md` at each repo root for project-specific context — the engine picks it up
automatically.

You can also **add repos from the UI** (the "+ Add" button in the sidebar's Repos
section), in three modes: register an **existing** directory on the VPS, create a **new**
one (`git init`), or **clone** a remote repo (`git clone <url>` into a destination path).
UI-added repos persist in the database; removing a repo only unregisters it (files on disk
are kept). Config-defined repos are re-synced on every boot.

### 3. Bind to Tailscale only

Set `bindAddress` to the VPS's **tailnet IP** (`100.x.y.z`) or its MagicDNS hostname —
**never** `0.0.0.0` on a public interface. The tailnet is the entire security boundary;
there is no app-level login or TLS.

Also firewall the port on all public interfaces, e.g. with `ufw`:

```bash
sudo ufw deny <PORT>                      # block everywhere by default
sudo ufw allow in on tailscale0 to any port <PORT>   # allow only over the tailnet
```

The server prints a warning if it is bound to `0.0.0.0`.

---

## Running

**Production (single process serves API + WebSocket + built PWA):**

```bash
npm start          # builds the web client, then starts the server
```

Then open the app from your phone/laptop at the VPS's MagicDNS hostname:

```
http://bridge.<your-tailnet>.ts.net:8787
```

On first visit, use your browser's "Add to Home Screen" to install the PWA.

**Development (hot-reloading client + server):**

```bash
npm run dev:server   # Fastify with tsx watch on :8787
npm run dev:web      # Vite dev server on :5173 (proxies /api and /ws to :8787)
```

Open `http://localhost:5173` while developing.

**Type-check everything:**

```bash
npm run typecheck
```

### Run as a service

A minimal `systemd` unit (adjust paths/user):

```ini
[Unit]
Description=Bridge (Claude Code wrapper)
After=network-online.target tailscaled.service

[Service]
WorkingDirectory=/srv/claude-bridge
ExecStart=/usr/bin/npm start
Restart=on-failure
User=bridge
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Deploy to a VPS (with CI/CD)

For a full Hetzner + Tailscale + systemd setup and **push-to-`main` → live**
continuous deployment over the tailnet, see **[docs/DEPLOY.md](./docs/DEPLOY.md)**.
The pieces live in `deploy/` (`bridge.service`, `deploy.sh`) and
`.github/workflows/deploy.yml`.

---

## Configuration reference

| `config.json` key       | Env var                   | Default               | Meaning |
|-------------------------|---------------------------|-----------------------|---------|
| `port`                  | `PORT`                     | `8787`                | Listen port |
| `bindAddress`           | `BIND_ADDRESS`             | `127.0.0.1`           | Tailscale IP/hostname to bind |
| `dbPath`                | `DB_PATH`                  | `./data/bridge.sqlite`| SQLite file |
| `anthropicApiKey`       | `ANTHROPIC_API_KEY`        | unset                 | **Unset = subscription billing.** Set = API-key billing |
| `defaultModel`          | `DEFAULT_MODEL`            | `sonnet`              | SDK alias: `opus` / `sonnet` / `haiku`, or an exact id |
| `defaultPermissionMode` | `DEFAULT_PERMISSION_MODE`  | `default`             | `default` / `acceptEdits` / `plan` / `bypassPermissions` (⚠ runs everything unprompted) |
| `repos`                 | `REPOS` / `REPOS_DIR`      | —                     | Repo registry |

The default **system prompt**, **model**, and **permission mode** are also editable live
in the Settings tab (stored in SQLite, seeded from config on first boot).

---

## How it works

- **Sessions** use the Agent SDK with the working directory set to the selected repo. The
  SDK session id is persisted so a session can be **resumed** later (this powers opening a
  session from a second device and resuming after the app was closed). Every SDK message
  (assistant text, tool calls/results, result) is streamed to all subscribed WebSocket
  clients and appended to the SQLite transcript as it arrives. Sessions can be renamed or
  deleted from the sidebar (delete tears down the live agent and removes its transcript).
- **Transcript UI:** assistant prose stays primary; **thinking** and runs of consecutive
  **tool calls** collapse into single expandable rows (a "💭 thinking" row and a
  "🛠 working · N steps" row), each openable to see the full reasoning or every tool's
  input/output. A live "Thinking… / Running <tool>… / Working…" indicator shows progress
  even when there's no output yet.
- **Permissions:** chat sessions pass a `canUseTool` approval callback. When Claude wants
  to write/edit/run, the server emits an `approval_request` over the WebSocket and waits;
  the client shows Approve/Reject. Each session has a **permission-mode selector** in the
  chat header (and a live badge showing the current mode) — `default`, `acceptEdits`,
  `plan`, or `bypassPermissions`. Changing it applies to the running session immediately
  and is reported back over the WebSocket, so you can always see (and confirm) which mode
  is in effect. In `bypassPermissions` no approval prompts appear and tools run unprompted.
- **Questions:** when Claude uses the `AskUserQuestion` tool, Bridge renders a proper
  question picker (each question's options as single- or multi-select, plus an "Other"
  free-text field) instead of a generic approve/reject. Your selection is delivered back
  to the model as the tool's answer.
- **Code page:** an IDE-style file tree with per-type file icons, a syntax-highlighted
  file viewer with line numbers, hover-to-highlight a symbol's occurrences, and
  click-a-symbol to **find usages** repo-wide (whole-word `git grep`) with clickable
  jump-to-line results. A separate Diff tab shows uncommitted changes with commit/discard.
- **Deploy page:** configure Railway right in the app — **Settings → Railway** (token +
  default environment), or via `RAILWAY_API_TOKEN` / `RAILWAY_ENVIRONMENT`. The token is
  stored server-side and never sent back to the browser. When configured, the Deploy
  tab is scoped to the selected repo (like Chat/Code). Link a repo to one of your Railway
  projects once, then the page shows every service in that project with its latest
  deployment's status (color-coded), commit subject/SHA, and time — auto-refreshing every
  10s. Read-only; the token stays server-side and is never sent to the browser. The
  repo→project mapping is stored on the repo; `RAILWAY_ENVIRONMENT` (default `production`)
  sets the environment shown.
- **Path safety:** all repo file/diff/commit/discard/usages operations are scoped to the
  repo root and reject any path that escapes it.

> Find-usages is a fast textual (whole-word) search, not a semantic/LSP reference search —
> it won't distinguish a variable from an unrelated same-named symbol. A real
> go-to-references would require a per-language language server.

### Model & persona

- One tunable **default system prompt** (Settings), applied to every session via the
  SDK `systemPrompt` (appended to the Claude Code preset, so tool behavior and `CLAUDE.md`
  pickup are preserved).
- Per-repo `CLAUDE.md` for project-specific context.
- Default model via SDK aliases (`opus`/`sonnet`/`haiku`) so it doesn't go stale; an exact
  id override is allowed.

### SDK interface choice

This implementation uses the Agent SDK's **`query()` async generator with a streaming
input** (an async iterable of user messages), which gives clean multi-turn chat, live
streaming, `canUseTool` approvals, `resume`, and `interrupt`. (The doc's "V2 session"
preview was the alternative; `query()` is stable and covers every requirement here.)

---

## Acceptance criteria (v1)

1. From a phone on the tailnet, send a prompt against a repo and watch Claude stream live. ✅
2. When Claude tries to edit a file, you get an Approve/Reject prompt that gates the write. ✅
3. After a turn, view the diff of changed files and commit or discard them. ✅
4. The same app on the laptop at the same URL works identically. ✅
5. The server is unreachable from the public internet (bound to Tailscale only). ✅ *(operator-enforced via `bindAddress` + firewall)*
6. Usage draws from the subscription when `ANTHROPIC_API_KEY` is unset. ✅

Multi-repo support, a session list with resume, persisted reopenable transcripts,
multi-device access, a settings UI, per-session permission modes, and interrupt are all
included. (An earlier fire-and-forget job queue was removed in favor of the focused
chat + code-review surface.)

---

## Project layout

```
claude-bridge/
├── server/                 # Fastify + Agent SDK backend (TypeScript, run with tsx)
│   └── src/
│       ├── index.ts        # entry: init DB, build server, attach WS, listen
│       ├── config.ts       # config.json + env loader
│       ├── db.ts           # SQLite schema + helpers
│       ├── protocol.ts     # shared REST/WS types
│       ├── bus.ts          # in-process pub/sub for live events
│       ├── agent/          # session manager (query(), approvals, resume, interrupt)
│       ├── git/            # status/diff/commit/discard with path-escape guards
│       ├── http/           # REST routes + static PWA serving
│       └── ws/             # WebSocket hub
├── web/                    # React + Vite PWA (built to web/dist, served by the server)
├── config.example.json
└── .env.example
```

## License

MIT — see [LICENSE](./LICENSE).

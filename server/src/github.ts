// GitHub auth via the OAuth device flow, driven from the Settings UI.
//
// We reuse the GitHub CLI's public client_id (the same app `gh auth login`
// uses), so there's nothing to register. On success we wire the token into
// whatever git/gh use to push: the gh CLI if it's installed, otherwise git's
// credential store. The token is never sent to the browser — status only ever
// exposes the logged-in username.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import type { GitHubDevicePoll, GitHubDeviceStart, GitHubAuthStatus } from "./protocol.js";

const CLIENT_ID = "178c6fc778ccc68e1d6a"; // GitHub CLI's public OAuth client id
const SCOPES = "repo read:org gist workflow";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const GIT_CREDENTIALS = join(homedir(), ".git-credentials");
const UA = "claude-bridge";

interface Pending {
  deviceCode: string;
  interval: number; // seconds
  expiresAt: number; // epoch ms
}
let pending: Pending | null = null;

// ---- device flow ----------------------------------------------------------

export async function startDeviceFlow(): Promise<GitHubDeviceStart> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }),
  });
  if (!res.ok) throw new Error(`GitHub device-code request failed (${res.status})`);
  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error("Unexpected response from GitHub device-code endpoint");
  }
  const interval = data.interval ?? 5;
  pending = {
    deviceCode: data.device_code,
    interval,
    expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
  };
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in ?? 900,
    interval,
  };
}

export async function pollDeviceFlow(): Promise<GitHubDevicePoll> {
  if (!pending) return { status: "error", error: "No device authorization in progress." };
  if (Date.now() > pending.expiresAt) {
    pending = null;
    return { status: "expired" };
  }
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: pending.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    interval?: number;
  };

  if (data.access_token) {
    pending = null;
    try {
      const login = await fetchLogin(data.access_token);
      configureCredentials(login, data.access_token);
      log.info(`GitHub auth complete for ${login}`);
      return { status: "complete", login };
    } catch (err) {
      log.error("Failed to store GitHub credentials:", err);
      return { status: "error", error: errMsg(err) };
    }
  }

  switch (data.error) {
    case "authorization_pending":
      return { status: "pending", interval: pending.interval };
    case "slow_down":
      pending.interval = data.interval ?? pending.interval + 5;
      return { status: "pending", interval: pending.interval };
    case "expired_token":
      pending = null;
      return { status: "expired" };
    case "access_denied":
      pending = null;
      return { status: "denied" };
    default:
      return { status: "error", error: data.error ?? "Unknown error from GitHub" };
  }
}

// ---- status / sign-out ----------------------------------------------------

export async function getStatus(): Promise<GitHubAuthStatus> {
  const gh = ghInstalled();
  const token = currentToken();
  if (!token) return { authenticated: false, ghCli: gh };
  try {
    const login = await fetchLogin(token);
    return { authenticated: true, login, ghCli: gh };
  } catch {
    // Token present but rejected (revoked/expired).
    return { authenticated: false, ghCli: gh };
  }
}

export function signOut(): void {
  pending = null;
  if (ghInstalled()) {
    try {
      execFileSync("gh", ["auth", "logout", "--hostname", "github.com"], { stdio: "ignore" });
    } catch {
      /* not logged in via gh, or gh refused — ignore */
    }
  }
  removeGitCredentialsEntry();
}

// ---- wiring ---------------------------------------------------------------

function configureCredentials(login: string, token: string): void {
  // Prefer the gh CLI when present (also makes `gh` commands work); fall back
  // to git's credential store so plain `git push` works regardless.
  if (ghInstalled()) {
    try {
      execFileSync("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], {
        input: token,
        stdio: ["pipe", "ignore", "ignore"],
      });
      execFileSync("gh", ["auth", "setup-git"], { stdio: "ignore" });
      return;
    } catch (err) {
      log.warn("gh auth login failed; falling back to git credential store:", err);
    }
  }
  writeGitCredentials(login, token);
}

function writeGitCredentials(login: string, token: string): void {
  const line = `https://${encodeURIComponent(login)}:${encodeURIComponent(token)}@github.com`;
  const others = readCredentialLines().filter((l) => !isGitHub(l));
  writeFileSync(GIT_CREDENTIALS, [...others, line].join("\n") + "\n", { mode: 0o600 });
  ensureCredentialHelper();
}

function removeGitCredentialsEntry(): void {
  if (!existsSync(GIT_CREDENTIALS)) return;
  const kept = readCredentialLines().filter((l) => !isGitHub(l));
  writeFileSync(GIT_CREDENTIALS, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
}

function ensureCredentialHelper(): void {
  try {
    const current = execFileSync("git", ["config", "--global", "--get", "credential.helper"], {
      encoding: "utf8",
    }).trim();
    if (!current) {
      execFileSync("git", ["config", "--global", "credential.helper", "store"], { stdio: "ignore" });
    }
  } catch {
    // `--get` exits non-zero when unset; set the helper.
    try {
      execFileSync("git", ["config", "--global", "credential.helper", "store"], { stdio: "ignore" });
    } catch (err) {
      log.warn("Could not set git credential.helper:", err);
    }
  }
}

// ---- helpers --------------------------------------------------------------

function currentToken(): string | null {
  if (ghInstalled()) {
    try {
      const t = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (t) return t;
    } catch {
      /* not authenticated via gh */
    }
  }
  return readGitCredentialsToken();
}

function readCredentialLines(): string[] {
  if (!existsSync(GIT_CREDENTIALS)) return [];
  return readFileSync(GIT_CREDENTIALS, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function isGitHub(line: string): boolean {
  try {
    return new URL(line).hostname === "github.com";
  } catch {
    return false;
  }
}

function readGitCredentialsToken(): string | null {
  for (const line of readCredentialLines()) {
    try {
      const u = new URL(line);
      if (u.hostname === "github.com" && u.password) return decodeURIComponent(u.password);
    } catch {
      /* skip malformed line */
    }
  }
  return null;
}

let ghChecked: boolean | null = null;
function ghInstalled(): boolean {
  if (ghChecked !== null) return ghChecked;
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    ghChecked = true;
  } catch {
    ghChecked = false;
  }
  return ghChecked;
}

async function fetchLogin(token: string): Promise<string> {
  const res = await fetch(USER_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
    },
  });
  if (!res.ok) throw new Error(`GitHub user lookup failed (${res.status})`);
  const data = (await res.json()) as { login?: string };
  if (!data.login) throw new Error("GitHub user response missing login");
  return data.login;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

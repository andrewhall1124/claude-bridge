import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { log } from "./logger.js";
import type { PermissionMode, Repo } from "./protocol.js";

// The server is launched from the server/ workspace dir (tsx), so the cwd is
// not the repo root. Resolve the repo root from this module's location so
// .env / config.json are found no matter where the process is started.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Load .env from the cwd (if any) and from the repo root. dotenv does not
// override already-set vars, so real environment variables still win.
dotenv.config();
dotenv.config({ path: join(REPO_ROOT, ".env") });

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "stdio";
}

export interface AppConfig {
  port: number;
  bindAddress: string;
  dbPath: string;
  /** When set, the Agent SDK bills against this API key (pay-as-you-go).
   *  When null/undefined, usage bills against the subscription stored by `claude login`. */
  anthropicApiKey: string | null;
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  repos: Repo[];
  mcpServers: Record<string, McpServerEntry>;
  /** Railway API token (account scope) for the Deploy page. Null disables it.
   *  Each repo is linked to a specific Railway project in the UI. */
  railwayApiToken: string | null;
  /** Default Railway environment name to show (e.g. "production"). */
  railwayEnvironment: string;
}

interface FileConfig {
  port?: number;
  bindAddress?: string;
  dbPath?: string;
  anthropicApiKey?: string | null;
  defaultModel?: string;
  defaultPermissionMode?: PermissionMode;
  repos?: Repo[];
  reposDir?: string;
  mcpServers?: Record<string, McpServerEntry>;
  railwayApiToken?: string | null;
  railwayEnvironment?: string;
}

const DEFAULT_PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

function asPermissionMode(value: string | undefined, fallback: PermissionMode): PermissionMode {
  if (value && (DEFAULT_PERMISSION_MODES as string[]).includes(value)) {
    return value as PermissionMode;
  }
  return fallback;
}

function loadFileConfig(): FileConfig {
  // CONFIG_PATH wins; otherwise prefer cwd/config.json, then repo-root.
  const candidates = process.env.CONFIG_PATH
    ? [resolve(process.env.CONFIG_PATH)]
    : [resolve("config.json"), join(REPO_ROOT, "config.json")];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    log.info(`No config.json found (looked in ${candidates.join(", ")}); using env vars / defaults.`);
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FileConfig;
    log.info(`Loaded config from ${path}`);
    return parsed;
  } catch (err) {
    log.error(`Failed to parse ${path}:`, err);
    return {};
  }
}

// Parse REPOS="id:Name:/path,id2:Name2:/path2"
function parseReposEnv(raw: string): Repo[] {
  const out: Repo[] = [];
  for (const chunk of raw.split(",")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":");
    if (parts.length < 3) {
      log.warn(`Skipping malformed REPOS entry: "${trimmed}" (expected id:name:path)`);
      continue;
    }
    const id = parts[0]!.trim();
    const path = parts.slice(-1)[0]!.trim();
    const name = parts.slice(1, -1).join(":").trim() || id;
    out.push({ id, name, path });
  }
  return out;
}

function scanReposDir(dir: string): Repo[] {
  const root = resolve(dir);
  if (!existsSync(root)) {
    log.warn(`REPOS_DIR ${root} does not exist; no repos discovered.`);
    return [];
  }
  const out: Repo[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    try {
      if (statSync(full).isDirectory()) {
        out.push({ id: entry, name: entry, path: full });
      }
    } catch {
      /* ignore unreadable entries */
    }
  }
  return out;
}

function resolveRepos(file: FileConfig): Repo[] {
  let repos: Repo[] = [];
  if (process.env.REPOS) {
    repos = parseReposEnv(process.env.REPOS);
  } else if (file.repos && file.repos.length > 0) {
    repos = file.repos;
  } else if (process.env.REPOS_DIR || file.reposDir) {
    repos = scanReposDir((process.env.REPOS_DIR ?? file.reposDir)!);
  }
  // Normalize and validate paths; warn (don't crash) on missing dirs so the
  // server still starts and the UI can surface the problem.
  const seen = new Set<string>();
  const valid: Repo[] = [];
  for (const repo of repos) {
    if (!repo.id || !repo.path) continue;
    if (seen.has(repo.id)) {
      log.warn(`Duplicate repo id "${repo.id}" ignored.`);
      continue;
    }
    seen.add(repo.id);
    const abs = isAbsolute(repo.path) ? repo.path : resolve(repo.path);
    if (!existsSync(abs)) {
      log.warn(`Repo "${repo.id}" path does not exist: ${abs}`);
    }
    valid.push({
      id: repo.id,
      name: repo.name || repo.id || basename(abs),
      path: abs,
      railwayProjectId: repo.railwayProjectId ?? null,
    });
  }
  return valid;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const file = loadFileConfig();

  const apiKeyFromEnv = process.env.ANTHROPIC_API_KEY;
  const anthropicApiKey =
    apiKeyFromEnv && apiKeyFromEnv.length > 0
      ? apiKeyFromEnv
      : file.anthropicApiKey ?? null;

  cached = {
    port: Number(process.env.PORT ?? file.port ?? 8787),
    bindAddress: process.env.BIND_ADDRESS ?? file.bindAddress ?? "127.0.0.1",
    dbPath: resolve(process.env.DB_PATH ?? file.dbPath ?? "./data/bridge.sqlite"),
    anthropicApiKey,
    defaultModel: process.env.DEFAULT_MODEL ?? file.defaultModel ?? "opus",
    defaultPermissionMode: asPermissionMode(
      process.env.DEFAULT_PERMISSION_MODE,
      file.defaultPermissionMode ?? "default",
    ),
    repos: resolveRepos(file),
    mcpServers: file.mcpServers ?? {},
    railwayApiToken:
      process.env.RAILWAY_API_TOKEN ?? file.railwayApiToken ?? null,
    railwayEnvironment:
      process.env.RAILWAY_ENVIRONMENT ?? file.railwayEnvironment ?? "production",
  };

  if (cached.anthropicApiKey) {
    log.warn(
      "ANTHROPIC_API_KEY is set — usage will bill against the API key (pay-as-you-go), " +
        "NOT your Claude subscription. Unset it to use subscription billing.",
    );
  } else {
    log.info(
      "No ANTHROPIC_API_KEY set — using subscription credentials from `claude login`.",
    );
  }

  return cached;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are Bridge, the owner's personal coding agent running on their VPS. " +
  "Be concise and direct. Make focused changes that match the surrounding code. " +
  "Explain what you changed and why. When a task is ambiguous, ask before making " +
  "large or destructive changes. Prefer small, reviewable diffs.";

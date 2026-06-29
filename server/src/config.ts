import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, basename, isAbsolute } from "node:path";
import dotenv from "dotenv";
import { log } from "./logger.js";
import type { PermissionMode, Repo } from "./protocol.js";

dotenv.config();

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
  const path = resolve(process.env.CONFIG_PATH ?? "config.json");
  if (!existsSync(path)) {
    log.info(`No config.json found at ${path}; using env vars / defaults.`);
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
    valid.push({ id: repo.id, name: repo.name || repo.id || basename(abs), path: abs });
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
    defaultModel: process.env.DEFAULT_MODEL ?? file.defaultModel ?? "sonnet",
    defaultPermissionMode: asPermissionMode(
      process.env.DEFAULT_PERMISSION_MODE,
      file.defaultPermissionMode ?? "default",
    ),
    repos: resolveRepos(file),
    mcpServers: file.mcpServers ?? {},
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

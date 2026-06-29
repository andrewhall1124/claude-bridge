// Read/write the user-level Claude Code config that lives outside Bridge:
//   ~/.claude/CLAUDE.md       — global guidance prepended to every session
//   ~/.claude/settings.json   — global settings; we only manage the `hooks` key
//   ~/.claude.json            — CLI state; we only manage the `mcpServers` key
//
// Bridge sessions already load these (the Agent SDK loads all filesystem
// settings by default), so editing them here changes behaviour for new
// sessions. We touch only the keys we own and preserve everything else, writing
// atomically (temp file + rename) so a crash can't truncate these files.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpHttpServer, McpServerConfig, McpStdioServer } from "./protocol.js";

const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_MD = join(CLAUDE_DIR, "CLAUDE.md");
const SETTINGS_JSON = join(CLAUDE_DIR, "settings.json");
const CLAUDE_JSON = join(homedir(), ".claude.json");

function ensureClaudeDir(): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${msg(err)}`);
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${msg(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// Write content atomically, preserving an existing file's permission bits so we
// never loosen ~/.claude.json (0600, holds OAuth credentials).
function writeFileAtomic(path: string, content: string): void {
  let mode = 0o644;
  if (existsSync(path)) {
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      /* fall back to default mode */
    }
  }
  const tmp = `${path}.bridge-tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

function writeJsonAtomic(path: string, data: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}

// ---- CLAUDE.md ------------------------------------------------------------

export function readClaudeMd(): string {
  return existsSync(CLAUDE_MD) ? readFileSync(CLAUDE_MD, "utf8") : "";
}

export function writeClaudeMd(content: string): void {
  ensureClaudeDir();
  writeFileAtomic(CLAUDE_MD, content);
}

// ---- Hooks (settings.json) ------------------------------------------------

export function readHooks(): Record<string, unknown> {
  const settings = readJsonObject(SETTINGS_JSON);
  const hooks = settings.hooks;
  return hooks && typeof hooks === "object" && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>)
    : {};
}

export function writeHooks(hooks: Record<string, unknown>): void {
  ensureClaudeDir();
  const settings = readJsonObject(SETTINGS_JSON);
  if (Object.keys(hooks).length > 0) {
    settings.hooks = hooks;
  } else {
    delete settings.hooks;
  }
  writeJsonAtomic(SETTINGS_JSON, settings);
}

// ---- MCP servers (~/.claude.json) -----------------------------------------

export function readUserMcpServers(): Record<string, McpServerConfig> {
  const root = readJsonObject(CLAUDE_JSON);
  const servers = root.mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? (servers as Record<string, McpServerConfig>)
    : {};
}

export function writeUserMcpServers(servers: Record<string, McpServerConfig>): void {
  const root = readJsonObject(CLAUDE_JSON);
  if (Object.keys(servers).length > 0) {
    root.mcpServers = servers;
  } else {
    delete root.mcpServers;
  }
  writeJsonAtomic(CLAUDE_JSON, root);
}

// Validate and normalize a client-supplied MCP server map, throwing a clear
// message on the first problem so the UI can surface it.
export function validateMcpServers(input: unknown): Record<string, McpServerConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("servers must be an object");
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [rawName, rawEntry] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) throw new Error("server name cannot be empty");
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error(`server "${name}" must be an object`);
    }
    const e = rawEntry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type : "stdio";

    if (type === "http" || type === "sse") {
      const url = typeof e.url === "string" ? e.url.trim() : "";
      if (!url) throw new Error(`server "${name}" requires a url`);
      const entry: McpHttpServer = { type, url };
      const headers = toStringMap(e.headers, name, "headers");
      if (headers) entry.headers = headers;
      out[name] = entry;
    } else if (type === "stdio") {
      const command = typeof e.command === "string" ? e.command.trim() : "";
      if (!command) throw new Error(`server "${name}" requires a command`);
      const entry: McpStdioServer = { type: "stdio", command };
      if (e.args !== undefined) {
        if (!Array.isArray(e.args)) throw new Error(`server "${name}": args must be a list`);
        entry.args = e.args.map((a) => String(a));
      }
      const env = toStringMap(e.env, name, "env");
      if (env) entry.env = env;
      out[name] = entry;
    } else {
      throw new Error(`server "${name}" has unknown type "${type}"`);
    }
  }
  return out;
}

function toStringMap(
  value: unknown,
  serverName: string,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`server "${serverName}": ${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

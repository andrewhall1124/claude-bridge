import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig, DEFAULT_SYSTEM_PROMPT } from "./config.js";
import { log } from "./logger.js";
import type {
  Job,
  JobStatus,
  PermissionMode,
  Repo,
  SessionMeta,
  SessionStatus,
  Settings,
  TranscriptItem,
  TranscriptType,
} from "./protocol.js";

const config = getConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS repos (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  sdk_session_id TEXT,
  repo_id        TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'idle',
  created_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  type         TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
  session_id     TEXT,
  result_summary TEXT,
  changed_files  TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Migration: per-session permission mode (added after initial release).
{
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "permission_mode")) {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'`,
    );
  }
}

const now = () => new Date().toISOString();

// ---- Repos ---------------------------------------------------------------
// Repos are config-driven; we mirror them into the table so the rest of the
// app can join against persisted ids, refreshing on every boot.
export function syncRepos(repos: Repo[]): void {
  const upsert = db.prepare(
    `INSERT INTO repos (id, name, path) VALUES (@id, @name, @path)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path`,
  );
  const tx = db.transaction((rows: Repo[]) => {
    for (const r of rows) upsert.run(r);
  });
  tx(repos);
}

export function listRepos(): Repo[] {
  return db.prepare(`SELECT id, name, path FROM repos ORDER BY name`).all() as Repo[];
}

export function getRepo(id: string): Repo | undefined {
  return db.prepare(`SELECT id, name, path FROM repos WHERE id = ?`).get(id) as
    | Repo
    | undefined;
}

// ---- Settings ------------------------------------------------------------
export function getSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getSettings(): Settings {
  return {
    defaultSystemPrompt: getSetting("defaultSystemPrompt") ?? DEFAULT_SYSTEM_PROMPT,
    defaultModel: getSetting("defaultModel") ?? config.defaultModel,
    defaultPermissionMode:
      (getSetting("defaultPermissionMode") as Settings["defaultPermissionMode"]) ??
      config.defaultPermissionMode,
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  if (patch.defaultSystemPrompt !== undefined)
    setSetting("defaultSystemPrompt", patch.defaultSystemPrompt);
  if (patch.defaultModel !== undefined) setSetting("defaultModel", patch.defaultModel);
  if (patch.defaultPermissionMode !== undefined)
    setSetting("defaultPermissionMode", patch.defaultPermissionMode);
  return getSettings();
}

// Seed settings on first boot from config defaults.
export function seedSettings(): void {
  if (getSetting("defaultSystemPrompt") === undefined)
    setSetting("defaultSystemPrompt", DEFAULT_SYSTEM_PROMPT);
  if (getSetting("defaultModel") === undefined)
    setSetting("defaultModel", config.defaultModel);
  if (getSetting("defaultPermissionMode") === undefined)
    setSetting("defaultPermissionMode", config.defaultPermissionMode);
}

// ---- Sessions ------------------------------------------------------------
interface SessionRow {
  id: string;
  sdk_session_id: string | null;
  repo_id: string;
  title: string;
  status: string;
  permission_mode: string;
  created_at: string;
  last_active_at: string;
}

function rowToSession(r: SessionRow): SessionMeta {
  return {
    id: r.id,
    sdkSessionId: r.sdk_session_id,
    repoId: r.repo_id,
    title: r.title,
    status: r.status as SessionStatus,
    permissionMode: (r.permission_mode as SessionMeta["permissionMode"]) ?? "default",
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  };
}

export function createSession(
  repoId: string,
  title: string,
  permissionMode?: PermissionMode,
): SessionMeta {
  const id = randomUUID();
  const ts = now();
  const mode = permissionMode ?? getSettings().defaultPermissionMode;
  db.prepare(
    `INSERT INTO sessions (id, sdk_session_id, repo_id, title, status, permission_mode, created_at, last_active_at)
     VALUES (?, NULL, ?, ?, 'idle', ?, ?, ?)`,
  ).run(id, repoId, title, mode, ts, ts);
  return getSession(id)!;
}

export function setSessionMode(id: string, mode: PermissionMode): void {
  db.prepare(`UPDATE sessions SET permission_mode = ? WHERE id = ?`).run(mode, id);
}

export function getSession(id: string): SessionMeta | undefined {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    | SessionRow
    | undefined;
  return row ? rowToSession(row) : undefined;
}

export function listSessions(): SessionMeta[] {
  const rows = db
    .prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`)
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

export function setSessionSdkId(id: string, sdkSessionId: string): void {
  db.prepare(`UPDATE sessions SET sdk_session_id = ? WHERE id = ?`).run(sdkSessionId, id);
}

export function setSessionStatus(id: string, status: SessionStatus): void {
  db.prepare(`UPDATE sessions SET status = ?, last_active_at = ? WHERE id = ?`).run(
    status,
    now(),
    id,
  );
}

export function setSessionTitle(id: string, title: string): void {
  db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
}

export function touchSession(id: string): void {
  db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`).run(now(), id);
}

// On boot, any session left in 'running' is stale (process died); reset to idle.
export function resetRunningSessions(): void {
  db.prepare(`UPDATE sessions SET status = 'idle' WHERE status = 'running'`).run();
}

// ---- Messages / transcript ----------------------------------------------
interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  type: string;
  content_json: string;
  created_at: string;
}

function rowToItem(r: MessageRow): TranscriptItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as TranscriptItem["role"],
    type: r.type as TranscriptType,
    content: JSON.parse(r.content_json),
    createdAt: r.created_at,
  };
}

export function appendMessage(
  sessionId: string,
  role: TranscriptItem["role"],
  type: TranscriptType,
  content: unknown,
): TranscriptItem {
  const item: TranscriptItem = {
    id: randomUUID(),
    sessionId,
    role,
    type,
    content,
    createdAt: now(),
  };
  db.prepare(
    `INSERT INTO messages (id, session_id, role, type, content_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(item.id, sessionId, role, type, JSON.stringify(content), item.createdAt);
  touchSession(sessionId);
  return item;
}

export function getTranscript(sessionId: string): TranscriptItem[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id`)
    .all(sessionId) as MessageRow[];
  return rows.map(rowToItem);
}

// ---- Jobs ----------------------------------------------------------------
interface JobRow {
  id: string;
  repo_id: string;
  prompt: string;
  status: string;
  session_id: string | null;
  result_summary: string | null;
  changed_files: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    repoId: r.repo_id,
    prompt: r.prompt,
    status: r.status as JobStatus,
    sessionId: r.session_id,
    resultSummary: r.result_summary,
    changedFiles: r.changed_files ? (JSON.parse(r.changed_files) as string[]) : null,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export function createJob(repoId: string, prompt: string): Job {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO jobs (id, repo_id, prompt, status, created_at) VALUES (?, ?, ?, 'queued', ?)`,
  ).run(id, repoId, prompt, now());
  return getJob(id)!;
}

export function getJob(id: string): Job | undefined {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

export function listJobs(): Job[] {
  const rows = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC`).all() as JobRow[];
  return rows.map(rowToJob);
}

export function updateJob(
  id: string,
  patch: Partial<{
    status: JobStatus;
    sessionId: string | null;
    resultSummary: string | null;
    changedFiles: string[] | null;
    error: string | null;
    finishedAt: string | null;
  }>,
): Job | undefined {
  const current = getJob(id);
  if (!current) return undefined;
  const next = {
    status: patch.status ?? current.status,
    session_id: patch.sessionId !== undefined ? patch.sessionId : current.sessionId,
    result_summary:
      patch.resultSummary !== undefined ? patch.resultSummary : current.resultSummary,
    changed_files:
      patch.changedFiles !== undefined
        ? patch.changedFiles
          ? JSON.stringify(patch.changedFiles)
          : null
        : current.changedFiles
          ? JSON.stringify(current.changedFiles)
          : null,
    error: patch.error !== undefined ? patch.error : current.error,
    finished_at: patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
  };
  db.prepare(
    `UPDATE jobs SET status=@status, session_id=@session_id, result_summary=@result_summary,
       changed_files=@changed_files, error=@error, finished_at=@finished_at WHERE id=@id`,
  ).run({ ...next, id });
  return getJob(id);
}

// On boot, any job left mid-flight is stale; mark errored so the queue is clean.
export function resetRunningJobs(): void {
  db.prepare(
    `UPDATE jobs SET status='error', error='Server restarted while job was running', finished_at=?
     WHERE status IN ('queued','running')`,
  ).run(now());
}

export function initDb(): void {
  syncRepos(config.repos);
  seedSettings();
  resetRunningSessions();
  resetRunningJobs();
  log.info(`SQLite ready at ${config.dbPath} (${config.repos.length} repo(s) configured)`);
}

export default db;

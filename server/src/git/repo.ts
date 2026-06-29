import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve, relative, join, sep, isAbsolute } from "node:path";
import {
  readdir,
  readFile as fsReadFile,
  stat,
  unlink,
  mkdir,
} from "node:fs/promises";

const exec = promisify(execFile);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB cap for the file viewer

export class PathEscapeError extends Error {
  constructor(p: string) {
    super(`Path escapes the repository root: ${p}`);
    this.name = "PathEscapeError";
  }
}

// Resolve a client-supplied relative path against the repo root and guarantee
// it cannot escape (handles "..", absolute paths, and symlink-ish tricks at the
// string level). Always pass the result to fs/git, never the raw input.
export function safeResolve(root: string, rel: string): string {
  const cleaned = rel.replace(/^[/\\]+/, ""); // strip leading slashes
  const abs = resolve(root, cleaned);
  const rootResolved = resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new PathEscapeError(rel);
  }
  if (abs.split(sep).includes(".git")) {
    throw new PathEscapeError(rel);
  }
  return abs;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export interface FileEntry {
  name: string;
  path: string; // relative to repo root, POSIX separators
  type: "file" | "dir";
}

export async function listDir(root: string, rel = ""): Promise<FileEntry[]> {
  const abs = safeResolve(root, rel || ".");
  const entries = await readdir(abs, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.name === ".git") continue;
    const childRel = (rel ? `${rel.replace(/\/+$/, "")}/` : "") + e.name;
    out.push({
      name: e.name,
      path: childRel.replace(/\\/g, "/"),
      type: e.isDirectory() ? "dir" : "file",
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export async function readFile(root: string, rel: string): Promise<FileContent> {
  const abs = safeResolve(root, rel);
  const info = await stat(abs);
  if (info.isDirectory()) throw new Error("Path is a directory");
  const buf = await fsReadFile(abs);
  const slice = buf.subarray(0, MAX_FILE_BYTES);
  // Heuristic binary detection: NUL byte in the sampled region.
  const binary = slice.includes(0);
  return {
    path: rel.replace(/\\/g, "/"),
    content: binary ? "" : slice.toString("utf8"),
    truncated: buf.length > MAX_FILE_BYTES,
    binary,
  };
}

export interface StatusEntry {
  path: string;
  index: string; // staged status char
  worktree: string; // unstaged status char
  untracked: boolean;
}

export async function status(root: string): Promise<StatusEntry[]> {
  const out = await git(root, ["status", "--porcelain=v1", "-z"]);
  const parts = out.split("\0").filter(Boolean);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]!;
    const x = token[0] ?? " ";
    const y = token[1] ?? " ";
    let path = token.slice(3);
    // Renames/copies record "old -> new"; porcelain -z puts the source in the
    // next token. Consume it and keep the destination path.
    if (x === "R" || x === "C") {
      i++; // skip the source path token
    }
    entries.push({
      path: path.replace(/\\/g, "/"),
      index: x,
      worktree: y,
      untracked: x === "?" && y === "?",
    });
  }
  return entries;
}

// Build a single unified diff covering tracked changes (working tree + index
// vs HEAD) plus full additions for untracked files.
export async function diff(root: string): Promise<{
  unified: string;
  staged: string;
  untracked: string[];
}> {
  let tracked = "";
  try {
    tracked = await git(root, ["diff", "HEAD", "--"]);
  } catch {
    // No HEAD yet (empty repo): diff the index against the empty tree.
    tracked = await git(root, ["diff", "--"]);
  }
  const staged = await git(root, ["diff", "--cached", "--"]).catch(() => "");

  const entries = await status(root);
  const untracked = entries.filter((e) => e.untracked).map((e) => e.path);

  let untrackedDiff = "";
  for (const p of untracked) {
    try {
      const abs = safeResolve(root, p);
      const info = await stat(abs);
      if (info.isDirectory() || info.size > MAX_FILE_BYTES) continue;
      // git diff --no-index exits 1 when files differ; capture stdout anyway.
      const { stdout } = await exec(
        "git",
        ["diff", "--no-index", "--", "/dev/null", p],
        { cwd: root, maxBuffer: 32 * 1024 * 1024 },
      ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
      untrackedDiff += stdout;
    } catch {
      /* skip unreadable untracked files */
    }
  }

  return { unified: tracked + untrackedDiff, staged, untracked };
}

export async function commit(
  root: string,
  message: string,
  files?: string[],
): Promise<{ hash: string }> {
  if (files && files.length > 0) {
    const safe = files.map((f) => safeResolve(root, f)).map((abs) => relPosix(root, abs));
    await git(root, ["add", "--", ...safe]);
  } else {
    await git(root, ["add", "-A"]);
  }
  await git(root, ["commit", "-m", message]);
  const hash = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { hash };
}

export async function discardFile(root: string, rel: string): Promise<void> {
  const abs = safeResolve(root, rel);
  const entries = await status(root);
  const entry = entries.find((e) => e.path === rel.replace(/\\/g, "/"));
  if (entry?.untracked) {
    await unlink(abs).catch(() => {});
    return;
  }
  const rp = relPosix(root, abs);
  // Unstage then restore working tree to HEAD.
  await git(root, ["restore", "--staged", "--worktree", "--", rp]).catch(async () => {
    await git(root, ["checkout", "HEAD", "--", rp]);
  });
}

export async function discardAll(root: string): Promise<void> {
  await git(root, ["restore", "--staged", "--worktree", "--", "."]).catch(async () => {
    await git(root, ["checkout", "HEAD", "--", "."]);
  });
  await git(root, ["clean", "-fd"]); // remove untracked files & dirs
}

function relPosix(root: string, abs: string): string {
  const r = relative(resolve(root), abs);
  return r.split(sep).join("/");
}

// Returns paths changed relative to HEAD.
export async function changedFiles(root: string): Promise<string[]> {
  const entries = await status(root);
  return entries.map((e) => e.path);
}

// ---- Find usages (textual, whole-word) -----------------------------------
export interface RefMatch {
  path: string;
  line: number;
  text: string;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Whole-word, repo-wide occurrences of an identifier via `git grep`. This is a
// textual search (not a semantic/LSP reference search), scoped to tracked files
// and respecting .gitignore.
export async function findReferences(
  root: string,
  symbol: string,
  limit = 500,
): Promise<{ matches: RefMatch[]; truncated: boolean }> {
  if (!IDENT_RE.test(symbol)) return { matches: [], truncated: false };
  let out = "";
  try {
    out = (
      await exec(
        "git",
        ["grep", "-n", "-w", "-I", "--no-color", "-e", symbol, "--", "."],
        { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      )
    ).stdout;
  } catch (err) {
    // `git grep` exits 1 when there are no matches — that's not an error.
    const e = err as { code?: number; stdout?: string };
    out = typeof e.stdout === "string" ? e.stdout : "";
  }
  const rows = out.split("\n").filter(Boolean);
  const matches: RefMatch[] = [];
  for (const row of rows) {
    const m = row.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    matches.push({
      path: m[1]!.replace(/\\/g, "/"),
      line: Number(m[2]),
      text: m[3]!.slice(0, 300),
    });
    if (matches.length >= limit) break;
  }
  return { matches, truncated: rows.length > matches.length };
}

// ---- Adding repos --------------------------------------------------------

// Expand a leading "~" to the owner's home directory and resolve to absolute.
export function expandPath(p: string): string {
  let out = p.trim();
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  return resolve(out);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isEmptyDir(p: string): Promise<boolean> {
  try {
    const entries = await readdir(p);
    return entries.filter((e) => e !== ".git").length === 0;
  } catch {
    return true; // doesn't exist yet → treat as empty
  }
}

// Create a new directory (if needed) and `git init` it.
export async function gitInit(absPath: string): Promise<void> {
  await mkdir(absPath, { recursive: true });
  if (!(await isGitRepo(absPath))) {
    await git(absPath, ["init"]);
  }
}

// Clone a remote repo into absPath. The destination must not already exist or
// must be empty. The parent directory is created if missing.
export async function gitClone(url: string, absPath: string): Promise<void> {
  if ((await pathExists(absPath)) && !(await isEmptyDir(absPath))) {
    throw new Error(`Destination already exists and is not empty: ${absPath}`);
  }
  const parent = resolve(absPath, "..");
  await mkdir(parent, { recursive: true });
  await git(parent, ["clone", "--", url, absPath]);
}

export { join, isAbsolute };

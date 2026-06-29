import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { log } from "../logger.js";
import * as dbm from "../db.js";
import { emitGlobal } from "../bus.js";
import { closeSession } from "../agent/sessionManager.js";
import * as git from "../git/repo.js";
import * as railway from "../railway/client.js";
import { getConfig } from "../config.js";
import * as userClaude from "../userClaude.js";
import * as github from "../github.js";
import { randomSessionName } from "../names.js";
import type { PermissionMode, Repo, Settings } from "../protocol.js";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

function uniqueRepoId(base: string): string {
  let id = base;
  let n = 2;
  while (dbm.getRepo(id)) id = `${base}-${n++}`;
  return id;
}

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(process.env.WEB_DIST ?? resolve(here, "../../../web/dist"));

function requireRepo(id: string) {
  const repo = dbm.getRepo(id);
  if (!repo) {
    const err = new Error(`Unknown repo: ${id}`) as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  return repo;
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  // Tolerate an empty body on application/json requests (e.g. a DELETE that a
  // client sends with a JSON content-type but no payload) instead of 400ing.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (!text) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  // File uploads (chat attachments). 25 MB/file, up to 10 files per request.
  await app.register(fastifyMultipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  });

  // ---- REST API ----------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/repos", async () => ({ repos: dbm.listRepos() }));

  // Add a repo to the picker. Three modes:
  //   existing — register a directory already on disk
  //   init     — create a new directory and `git init`
  //   clone    — `git clone <url>` into the destination path
  app.post<{
    Body: { mode?: "existing" | "init" | "clone"; path?: string; url?: string };
  }>("/api/repos", async (req, reply) => {
    const body = req.body ?? {};
    const mode = body.mode ?? "existing";

    try {
      let absPath: string;
      if (mode === "clone") {
        const url = body.url?.trim();
        const dest = body.path?.trim();
        if (!url) return reply.code(400).send({ error: "url is required to clone" });
        if (!dest)
          return reply.code(400).send({ error: "destination path is required to clone" });
        absPath = git.expandPath(dest);
        await git.gitClone(url, absPath);
      } else if (mode === "init") {
        const p = body.path?.trim();
        if (!p) return reply.code(400).send({ error: "path is required" });
        absPath = git.expandPath(p);
        await git.gitInit(absPath);
      } else {
        const p = body.path?.trim();
        if (!p) return reply.code(400).send({ error: "path is required" });
        absPath = git.expandPath(p);
        if (!(await git.isDirectory(absPath)))
          return reply
            .code(400)
            .send({ error: `Path does not exist or is not a directory: ${absPath}` });
      }

      const name = basename(absPath);
      const repo: Repo = { id: uniqueRepoId(slugify(name)), name, path: absPath };
      dbm.addRepo(repo);
      emitGlobal({ type: "repos_changed" });
      const isGit = await git.isGitRepo(absPath);
      return { repo, isGit };
    } catch (err) {
      return reply.code(400).send({ error: errMsg(err) });
    }
  });

  // Update a repo: set its linked Railway project.
  app.patch<{
    Params: { id: string };
    Body: { railwayProjectId?: string | null };
  }>("/api/repos/:id", async (req, reply) => {
    const repo = dbm.getRepo(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Unknown repo" });
    const body = req.body ?? {};
    if (body.railwayProjectId === undefined)
      return reply.code(400).send({ error: "Nothing to update" });
    const pid = body.railwayProjectId?.trim() || null;
    dbm.setRepoRailway(repo.id, pid);
    emitGlobal({ type: "repos_changed" });
    return { repo: dbm.getRepo(repo.id) };
  });

  // Unregister a repo (files on disk are left untouched).
  app.delete<{ Params: { id: string } }>("/api/repos/:id", async (req, reply) => {
    const repo = dbm.getRepo(req.params.id);
    if (!repo) return reply.code(404).send({ error: "Unknown repo" });
    dbm.deleteRepo(repo.id);
    emitGlobal({ type: "repos_changed" });
    return { ok: true };
  });

  app.get("/api/settings", async () => dbm.getSettings());

  app.put<{ Body: Partial<Settings> }>("/api/settings", async (req) => {
    const body = req.body ?? {};
    const patch: Partial<Settings> = {};
    if (typeof body.defaultSystemPrompt === "string")
      patch.defaultSystemPrompt = body.defaultSystemPrompt;
    if (typeof body.defaultModel === "string") patch.defaultModel = body.defaultModel;
    if (
      body.defaultPermissionMode &&
      ["default", "acceptEdits", "plan", "bypassPermissions"].includes(
        body.defaultPermissionMode,
      )
    )
      patch.defaultPermissionMode = body.defaultPermissionMode as PermissionMode;
    return dbm.updateSettings(patch);
  });

  // ---- User-level Claude config (MCP servers, CLAUDE.md, hooks) ----------
  // These read/write the real ~/.claude files shared with the `claude` CLI.
  app.get("/api/user/mcp", async () => ({ servers: userClaude.readUserMcpServers() }));

  app.put<{ Body: { servers?: unknown } }>("/api/user/mcp", async (req, reply) => {
    try {
      const servers = userClaude.validateMcpServers(req.body?.servers ?? {});
      userClaude.writeUserMcpServers(servers);
      return { servers };
    } catch (err) {
      return reply.code(400).send({ error: errMsg(err) });
    }
  });

  app.get("/api/user/claude-md", async () => ({ content: userClaude.readClaudeMd() }));

  app.put<{ Body: { content?: string } }>("/api/user/claude-md", async (req, reply) => {
    const content = req.body?.content;
    if (typeof content !== "string")
      return reply.code(400).send({ error: "content must be a string" });
    try {
      userClaude.writeClaudeMd(content);
      return { content };
    } catch (err) {
      return reply.code(400).send({ error: errMsg(err) });
    }
  });

  app.get("/api/user/hooks", async () => ({ hooks: userClaude.readHooks() }));

  app.put<{ Body: { hooks?: unknown } }>("/api/user/hooks", async (req, reply) => {
    const hooks = req.body?.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
      return reply.code(400).send({ error: "hooks must be a JSON object" });
    try {
      userClaude.writeHooks(hooks as Record<string, unknown>);
      return { hooks: userClaude.readHooks() };
    } catch (err) {
      return reply.code(400).send({ error: errMsg(err) });
    }
  });

  // ---- GitHub auth (device flow) -----------------------------------------
  app.get("/api/github/status", async () => github.getStatus());

  app.post("/api/github/device", async (_req, reply) => {
    try {
      return await github.startDeviceFlow();
    } catch (err) {
      return reply.code(502).send({ error: errMsg(err) });
    }
  });

  app.post("/api/github/device/poll", async (_req, reply) => {
    try {
      return await github.pollDeviceFlow();
    } catch (err) {
      return reply.code(502).send({ error: errMsg(err) });
    }
  });

  app.post("/api/github/signout", async () => {
    github.signOut();
    return { ok: true };
  });

  // Sessions
  app.get("/api/sessions", async () => ({ sessions: dbm.listSessions() }));

  app.post<{
    Body: { repoId?: string; title?: string; permissionMode?: PermissionMode };
  }>("/api/sessions", async (req, reply) => {
    const { repoId, title, permissionMode } = req.body ?? {};
    if (!repoId) return reply.code(400).send({ error: "repoId is required" });
    requireRepo(repoId);
    const mode =
      permissionMode &&
      ["default", "acceptEdits", "plan", "bypassPermissions"].includes(permissionMode)
        ? permissionMode
        : undefined;
    const session = dbm.createSession(
      repoId,
      title?.trim() || randomSessionName(),
      mode,
    );
    return { session };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const session = dbm.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return { session, transcript: dbm.getTranscript(session.id) };
  });

  app.patch<{ Params: { id: string }; Body: { title?: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      const session = dbm.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const title = req.body?.title?.trim();
      if (!title) return reply.code(400).send({ error: "title is required" });
      dbm.setSessionTitle(session.id, title);
      emitGlobal({ type: "sessions_changed" });
      return { session: dbm.getSession(session.id) };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const session = dbm.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    closeSession(session.id);
    dbm.deleteSession(session.id);
    emitGlobal({ type: "sessions_changed" });
    return { ok: true };
  });

  // Find usages (whole-word, repo-wide textual search)
  app.get<{ Params: { id: string }; Querystring: { symbol?: string } }>(
    "/api/repos/:id/references",
    async (req, reply) => {
      const repo = requireRepo(req.params.id);
      const symbol = (req.query.symbol ?? "").trim();
      if (!symbol) return reply.code(400).send({ error: "symbol is required" });
      try {
        if (!(await git.isGitRepo(repo.path)))
          return { symbol, matches: [], truncated: false, notGit: true };
        const res = await git.findReferences(repo.path, symbol);
        return { symbol, ...res };
      } catch (err) {
        return reply.code(400).send({ error: errMsg(err) });
      }
    },
  );

  // Upload chat attachments. Saved outside the repo (Bridge data dir) so they
  // don't pollute the working tree; the agent reads them by absolute path.
  app.post<{ Params: { id: string } }>(
    "/api/repos/:id/upload",
    async (req, reply) => {
      const repo = requireRepo(req.params.id);
      const destDir = join(
        dirname(getConfig().dbPath),
        "uploads",
        repo.id,
      );
      await mkdir(destDir, { recursive: true });
      const saved: { name: string; path: string; size: number }[] = [];
      try {
        for await (const part of req.files()) {
          const original = basename(part.filename || "file");
          const safe = original.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
          const dest = join(destDir, `${randomUUID().slice(0, 8)}-${safe}`);
          const buf = await part.toBuffer(); // enforces the fileSize limit
          await writeFile(dest, buf);
          saved.push({ name: original, path: dest, size: buf.length });
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE")
          return reply.code(413).send({ error: "File too large (max 25 MB)" });
        return reply.code(400).send({ error: errMsg(err) });
      }
      if (saved.length === 0)
        return reply.code(400).send({ error: "No files uploaded" });
      return { files: saved };
    },
  );

  // Repo file browsing
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/repos/:id/files",
    async (req, reply) => {
      const repo = requireRepo(req.params.id);
      try {
        const entries = await git.listDir(repo.path, req.query.path ?? "");
        return { path: req.query.path ?? "", entries };
      } catch (err) {
        return reply.code(400).send({ error: errMsg(err) });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/repos/:id/file",
    async (req, reply) => {
      const repo = requireRepo(req.params.id);
      if (!req.query.path) return reply.code(400).send({ error: "path is required" });
      try {
        return await git.readFile(repo.path, req.query.path);
      } catch (err) {
        return reply.code(400).send({ error: errMsg(err) });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/repos/:id/diff", async (req, reply) => {
    const repo = requireRepo(req.params.id);
    try {
      const isRepo = await git.isGitRepo(repo.path);
      if (!isRepo)
        return reply.code(400).send({ error: "Not a git repository", notGit: true });
      const d = await git.diff(repo.path);
      const st = await git.status(repo.path);
      return { ...d, status: st };
    } catch (err) {
      return reply.code(400).send({ error: errMsg(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { message?: string; files?: string[] } }>(
    "/api/repos/:id/commit",
    async (req, reply) => {
      const repo = requireRepo(req.params.id);
      const message = req.body?.message?.trim();
      if (!message) return reply.code(400).send({ error: "Commit message is required" });
      try {
        const res = await git.commit(repo.path, message, req.body?.files);
        return res;
      } catch (err) {
        return reply.code(400).send({ error: errMsg(err) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path?: string; all?: boolean } }>(
    "/api/repos/:id/discard",
    async (req, reply) => {
      const repo = requireRepo(req.params.id);
      try {
        if (req.body?.all || !req.body?.path) {
          await git.discardAll(repo.path);
        } else {
          await git.discardFile(repo.path, req.body.path);
        }
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: errMsg(err) });
      }
    },
  );

  // ---- Railway (Deploy page) ---------------------------------------------
  // Token + environment resolve DB-first (set via the UI) then fall back to
  // env/config. The token stays server-side and is never returned to the client.
  function resolvedRailway(): { token: string | null; environment: string } {
    const cfg = getConfig();
    return {
      token: dbm.getSetting("railwayApiToken") ?? cfg.railwayApiToken,
      environment: dbm.getSetting("railwayEnvironment") ?? cfg.railwayEnvironment,
    };
  }

  app.get("/api/railway/config", async () => {
    const r = resolvedRailway();
    return { configured: Boolean(r.token), environment: r.environment };
  });

  // Set the Railway token / environment from the UI. Omit apiToken to keep the
  // current one; pass an empty string to remove it.
  app.put<{ Body: { apiToken?: string | null; environment?: string } }>(
    "/api/railway/config",
    async (req) => {
      const body = req.body ?? {};
      if (body.apiToken !== undefined) {
        const t = (body.apiToken ?? "").trim();
        if (t) dbm.setSetting("railwayApiToken", t);
        else dbm.deleteSetting("railwayApiToken");
      }
      if (typeof body.environment === "string")
        dbm.setSetting("railwayEnvironment", body.environment.trim() || "production");
      const r = resolvedRailway();
      return { configured: Boolean(r.token), environment: r.environment };
    },
  );

  app.get("/api/railway/projects", async (_req, reply) => {
    const { token } = resolvedRailway();
    if (!token) return reply.code(400).send({ error: "Railway is not configured" });
    try {
      return { projects: await railway.listProjects(token) };
    } catch (err) {
      return reply.code(502).send({ error: errMsg(err) });
    }
  });

  app.get<{ Querystring: { project?: string; env?: string } }>(
    "/api/railway/status",
    async (req, reply) => {
      const { token, environment } = resolvedRailway();
      if (!token) return reply.code(400).send({ error: "Railway is not configured" });
      const projectId = req.query.project;
      if (!projectId)
        return reply
          .code(400)
          .send({ error: "No project specified (link the repo to a Railway project)" });
      try {
        return await railway.getProjectStatus(
          token,
          projectId,
          req.query.env ?? environment,
        );
      } catch (err) {
        return reply.code(502).send({ error: errMsg(err) });
      }
    },
  );

  // ---- Static PWA --------------------------------------------------------
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
    // SPA fallback: anything that isn't /api or /ws and isn't a real file
    // returns index.html so client-side routing works.
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && (req.raw.url.startsWith("/api") || req.raw.url.startsWith("/ws"))) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
    log.info(`Serving PWA from ${WEB_DIST}`);
  } else {
    log.warn(
      `Web build not found at ${WEB_DIST}. Run "npm run build" (or use the Vite dev server).`,
    );
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && (req.raw.url.startsWith("/api") || req.raw.url.startsWith("/ws"))) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply
        .code(503)
        .type("text/html")
        .send(
          "<h1>Bridge</h1><p>Web build not found. Run <code>npm run build</code> or start the Vite dev server (<code>npm run dev:web</code>).</p>",
        );
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error("Request error:", err);
    reply.code(status).send({ error: errMsg(err) });
  });

  return app;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

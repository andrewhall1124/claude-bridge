import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { log } from "../logger.js";
import * as dbm from "../db.js";
import { emitGlobal } from "../bus.js";
import { closeSession } from "../agent/sessionManager.js";
import * as git from "../git/repo.js";
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

  // ---- REST API ----------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/repos", async () => ({ repos: dbm.listRepos() }));

  // Add a repo to the picker. Three modes:
  //   existing — register a directory already on disk
  //   init     — create a new directory and `git init`
  //   clone    — `git clone <url>` into the destination path
  app.post<{
    Body: { mode?: "existing" | "init" | "clone"; name?: string; path?: string; url?: string };
  }>("/api/repos", async (req, reply) => {
    const body = req.body ?? {};
    const name = body.name?.trim();
    const mode = body.mode ?? "existing";
    if (!name) return reply.code(400).send({ error: "name is required" });

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

      const repo: Repo = { id: uniqueRepoId(slugify(name)), name, path: absPath };
      dbm.addRepo(repo);
      emitGlobal({ type: "repos_changed" });
      const isGit = await git.isGitRepo(absPath);
      return { repo, isGit };
    } catch (err) {
      return reply.code(400).send({ error: errMsg(err) });
    }
  });

  // Rename a repo's display name.
  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    "/api/repos/:id",
    async (req, reply) => {
      const repo = dbm.getRepo(req.params.id);
      if (!repo) return reply.code(404).send({ error: "Unknown repo" });
      const name = req.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: "name is required" });
      dbm.renameRepo(repo.id, name);
      emitGlobal({ type: "repos_changed" });
      return { repo: dbm.getRepo(repo.id) };
    },
  );

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
    const session = dbm.createSession(repoId, title?.trim() || "New session", mode);
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

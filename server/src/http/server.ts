import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { log } from "../logger.js";
import * as dbm from "../db.js";
import { emitGlobal } from "../bus.js";
import { closeSession } from "../agent/sessionManager.js";
import { enqueue } from "../jobs/queue.js";
import * as git from "../git/repo.js";
import type { PermissionMode, Settings } from "../protocol.js";

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

  // ---- REST API ----------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/repos", async () => ({ repos: dbm.listRepos() }));

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

  // Jobs
  app.get("/api/jobs", async () => ({ jobs: dbm.listJobs() }));

  app.post<{ Body: { repoId?: string; prompt?: string } }>(
    "/api/jobs",
    async (req, reply) => {
      const { repoId, prompt } = req.body ?? {};
      if (!repoId || !prompt?.trim())
        return reply.code(400).send({ error: "repoId and prompt are required" });
      requireRepo(repoId);
      const job = enqueue(repoId, prompt.trim());
      return { job };
    },
  );

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = dbm.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    const transcript = job.sessionId ? dbm.getTranscript(job.sessionId) : [];
    return { job, transcript };
  });

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

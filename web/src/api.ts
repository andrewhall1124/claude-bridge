// REST client for the Bridge backend. Same-origin.

import type {
  DiffResult,
  FileContent,
  FileListing,
  Job,
  NotGitResult,
  Repo,
  SessionMeta,
  Settings,
  TranscriptItem,
} from "./protocol";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  // Only declare a JSON content-type when we actually send a body. Sending it
  // on a bodyless request (e.g. DELETE) makes Fastify reject the empty body
  // with FST_ERR_CTP_EMPTY_JSON_BODY (400).
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: true }>("/api/health"),

  getRepos: () => request<{ repos: Repo[] }>("/api/repos"),

  getSettings: () => request<Settings>("/api/settings"),
  putSettings: (patch: Partial<Settings>) =>
    request<Settings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  getSessions: () => request<{ sessions: SessionMeta[] }>("/api/sessions"),
  createSession: (repoId: string, title?: string) =>
    request<{ session: SessionMeta }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ repoId, title }),
    }),
  getSession: (id: string) =>
    request<{ session: SessionMeta; transcript: TranscriptItem[] }>(
      `/api/sessions/${encodeURIComponent(id)}`
    ),
  renameSession: (id: string, title: string) =>
    request<{ session: SessionMeta }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteSession: (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  getJobs: () => request<{ jobs: Job[] }>("/api/jobs"),
  createJob: (repoId: string, prompt: string) =>
    request<{ job: Job }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ repoId, prompt }),
    }),
  getJob: (id: string) =>
    request<{ job: Job; transcript: TranscriptItem[] }>(
      `/api/jobs/${encodeURIComponent(id)}`
    ),

  listFiles: (repoId: string, path = "") =>
    request<FileListing>(
      `/api/repos/${encodeURIComponent(repoId)}/files?path=${encodeURIComponent(path)}`
    ),
  readFile: (repoId: string, path: string) =>
    request<FileContent>(
      `/api/repos/${encodeURIComponent(repoId)}/file?path=${encodeURIComponent(path)}`
    ),
  getDiff: (repoId: string) =>
    request<DiffResult | NotGitResult>(
      `/api/repos/${encodeURIComponent(repoId)}/diff`
    ),
  commit: (repoId: string, message: string, files?: string[]) =>
    request<{ hash: string }>(
      `/api/repos/${encodeURIComponent(repoId)}/commit`,
      {
        method: "POST",
        body: JSON.stringify({ message, files }),
      }
    ),
  discard: (repoId: string, opts: { path?: string; all?: boolean }) =>
    request<{ ok: true }>(
      `/api/repos/${encodeURIComponent(repoId)}/discard`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      }
    ),
};

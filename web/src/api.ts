// REST client for the Bridge backend. Same-origin.

import type {
  AddRepoRequest,
  DiffResult,
  FileContent,
  FileListing,
  GitHubAuthStatus,
  GitHubDevicePoll,
  GitHubDeviceStart,
  McpServerConfig,
  NotGitResult,
  RailwayConfig,
  RailwayProject,
  RailwayStatus,
  ReferencesResult,
  Repo,
  SessionMeta,
  Settings,
  TranscriptItem,
  UploadedFile,
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
  addRepo: (req: AddRepoRequest) =>
    request<{ repo: Repo; isGit: boolean }>("/api/repos", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  setRepoRailway: (id: string, railwayProjectId: string | null) =>
    request<{ repo: Repo }>(`/api/repos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ railwayProjectId }),
    }),
  deleteRepo: (id: string) =>
    request<{ ok: true }>(`/api/repos/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  getSettings: () => request<Settings>("/api/settings"),
  putSettings: (patch: Partial<Settings>) =>
    request<Settings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  // User-level Claude config
  getUserMcp: () =>
    request<{ servers: Record<string, McpServerConfig> }>("/api/user/mcp"),
  putUserMcp: (servers: Record<string, McpServerConfig>) =>
    request<{ servers: Record<string, McpServerConfig> }>("/api/user/mcp", {
      method: "PUT",
      body: JSON.stringify({ servers }),
    }),
  getUserClaudeMd: () => request<{ content: string }>("/api/user/claude-md"),
  putUserClaudeMd: (content: string) =>
    request<{ content: string }>("/api/user/claude-md", {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  getUserHooks: () => request<{ hooks: Record<string, unknown> }>("/api/user/hooks"),
  putUserHooks: (hooks: Record<string, unknown>) =>
    request<{ hooks: Record<string, unknown> }>("/api/user/hooks", {
      method: "PUT",
      body: JSON.stringify({ hooks }),
    }),

  // GitHub auth (device flow)
  getGitHubStatus: () => request<GitHubAuthStatus>("/api/github/status"),
  startGitHubDevice: () =>
    request<GitHubDeviceStart>("/api/github/device", { method: "POST", body: "{}" }),
  pollGitHubDevice: () =>
    request<GitHubDevicePoll>("/api/github/device/poll", { method: "POST", body: "{}" }),
  signOutGitHub: () =>
    request<{ ok: true }>("/api/github/signout", { method: "POST", body: "{}" }),

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

  listFiles: (repoId: string, path = "") =>
    request<FileListing>(
      `/api/repos/${encodeURIComponent(repoId)}/files?path=${encodeURIComponent(path)}`
    ),
  readFile: (repoId: string, path: string) =>
    request<FileContent>(
      `/api/repos/${encodeURIComponent(repoId)}/file?path=${encodeURIComponent(path)}`
    ),
  findReferences: (repoId: string, symbol: string) =>
    request<ReferencesResult>(
      `/api/repos/${encodeURIComponent(repoId)}/references?symbol=${encodeURIComponent(symbol)}`
    ),
  uploadFiles: async (repoId: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    // No JSON content-type — the browser sets the multipart boundary itself.
    const res = await fetch(
      `/api/repos/${encodeURIComponent(repoId)}/upload`,
      { method: "POST", body: fd }
    );
    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* non-JSON error body */
      }
    }
    if (!res.ok) {
      const msg =
        (body as { error?: string })?.error ?? `Upload failed (${res.status})`;
      throw new ApiError(msg, res.status);
    }
    return body as { files: UploadedFile[] };
  },
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

  getRailwayConfig: () => request<RailwayConfig>("/api/railway/config"),
  setRailwayConfig: (patch: { apiToken?: string | null; environment?: string }) =>
    request<RailwayConfig>("/api/railway/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  getRailwayProjects: () =>
    request<{ projects: RailwayProject[] }>("/api/railway/projects"),
  getRailwayStatus: (project?: string, env?: string) => {
    const qs = new URLSearchParams();
    if (project) qs.set("project", project);
    if (env) qs.set("env", env);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<RailwayStatus>(`/api/railway/status${suffix}`);
  },
};

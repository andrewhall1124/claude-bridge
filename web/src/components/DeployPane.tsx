import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  RailwayConfig,
  RailwayProject,
  RailwayStatus,
  RailwayWorkspace,
  Repo,
} from "../protocol";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Map Railway deployment status to a color class (phosphor palette + red).
function statusClass(status: string): string {
  switch (status) {
    case "SUCCESS":
      return "dep-ok";
    case "BUILDING":
    case "DEPLOYING":
    case "INITIALIZING":
    case "QUEUED":
    case "WAITING":
    case "NEEDS_APPROVAL":
      return "dep-active";
    case "FAILED":
    case "CRASHED":
      return "dep-bad";
    default:
      return "dep-idle";
  }
}

interface Props {
  repoId: string | null;
  repos: Repo[];
  onReposChanged: () => void | Promise<void>;
}

export function DeployPane({ repoId, repos, onReposChanged }: Props) {
  const [config, setConfig] = useState<RailwayConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<RailwayWorkspace[] | null>(null);
  const [wsScoped, setWsScoped] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [projects, setProjects] = useState<RailwayProject[]>([]);
  const [status, setStatus] = useState<RailwayStatus | null>(null);
  const [env, setEnv] = useState<string | null>(null);
  const [relinking, setRelinking] = useState(false);
  const [pick, setPick] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const repo = useMemo(
    () => repos.find((r) => r.id === repoId) ?? null,
    [repos, repoId],
  );
  const linkedProject = repo?.railwayProjectId ?? null;
  const needPicker = Boolean(repo) && (!linkedProject || relinking);

  // Load config once.
  useEffect(() => {
    let alive = true;
    api
      .getRailwayConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        setEnv((prev) => prev ?? c.environment);
      })
      .catch((e) => alive && setError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Reset view when the selected repo changes.
  useEffect(() => {
    setStatus(null);
    setError(null);
    setRelinking(false);
    setUpdatedAt(null);
    setEnv(config?.environment ?? null);
  }, [repoId, config?.environment]);

  // Fetch the workspace list (for the link picker) when needed.
  useEffect(() => {
    if (!config?.configured || !needPicker || workspaces !== null) return;
    api
      .getRailwayWorkspaces()
      .then((r) => {
        setWorkspaces(r.workspaces);
        setWsScoped(r.scoped);
        setWorkspace((prev) => prev || r.workspaces[0]?.id || "");
      })
      .catch((e) => setError(errMsg(e)));
  }, [config?.configured, needPicker, workspaces]);

  // Fetch the selected workspace's projects for the link picker.
  useEffect(() => {
    if (!config?.configured || !needPicker || !workspace) return;
    let alive = true;
    setProjects([]);
    api
      .getRailwayProjects(workspace)
      .then((r) => alive && setProjects(r.projects))
      .catch((e) => alive && setError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [config?.configured, needPicker, workspace]);

  const loadStatus = useCallback(async () => {
    if (!config?.configured || !linkedProject || relinking) return;
    setLoading(true);
    try {
      const s = await api.getRailwayStatus(linkedProject, env ?? undefined);
      setStatus(s);
      setEnv((prev) => prev ?? s.environment.name);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [config?.configured, linkedProject, env, relinking]);

  // Load + auto-refresh every 10s while a project is linked.
  useEffect(() => {
    if (!config?.configured || !linkedProject || relinking) return;
    void loadStatus();
    const t = setInterval(() => void loadStatus(), 10000);
    return () => clearInterval(t);
  }, [config?.configured, linkedProject, relinking, loadStatus]);

  async function link() {
    if (!repoId || !pick) return;
    try {
      await api.setRepoRailway(repoId, pick);
      await onReposChanged();
      setRelinking(false);
      setStatus(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }

  if (!config) return <div className="empty-state subtle">Loading…</div>;

  if (!config.configured) {
    return (
      <div className="deploy-setup">
        <h3>Railway not configured</h3>
        <p className="subtle">
          Add your Railway API token in <strong>Settings → Railway</strong> to
          enable the Deploy page, then link each repo to a Railway project here.
        </p>
        <p className="subtle">
          Create a token at{" "}
          <a
            href="https://railway.com/account/tokens"
            target="_blank"
            rel="noopener noreferrer"
          >
            railway.com/account/tokens
          </a>
          .
        </p>
      </div>
    );
  }

  if (!repo) {
    return <div className="empty-state subtle">Select a repo.</div>;
  }

  if (needPicker) {
    return (
      <div className="deploy-link">
        <h3>
          Link <span className="refs-sym">{repo.name}</span> to a Railway project
        </h3>
        <p className="subtle">
          Pick the Railway project for this repo. The Deploy page then shows that
          project's services whenever this repo is selected.
        </p>
        {error && <div className="system-line error">{error}</div>}
        <div className="deploy-link-row">
          <label className="deploy-field">
            <span className="subtle">Workspace</span>
            <select
              value={workspace}
              onChange={(e) => {
                setWorkspace(e.target.value);
                setPick("");
              }}
            >
              {workspaces === null && <option value="">Loading…</option>}
              {(workspaces ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="deploy-link-row">
          <label className="deploy-field">
            <span className="subtle">Project</span>
            <select
              value={pick || linkedProject || ""}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">Select a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void link()}
            disabled={!(pick || linkedProject)}
          >
            Link
          </button>
          {relinking && (
            <button className="btn btn-sm" onClick={() => setRelinking(false)}>
              Cancel
            </button>
          )}
        </div>
        {workspace && projects.length === 0 && !error && (
          <p className="subtle">Loading projects…</p>
        )}
        {wsScoped && (
          <p className="subtle">
            This Railway token only sees one workspace. To pick projects from
            other workspaces (e.g. a team), create an account token without
            selecting a workspace at railway.com/account/tokens and update it
            in Settings → Railway.
          </p>
        )}
      </div>
    );
  }

  const envList = status?.environments ?? [];

  return (
    <div className="deploy-pane">
      <div className="deploy-toolbar">
        <span className="deploy-proj">
          {status?.projectName ?? "project"}
          <button
            className="btn btn-xs"
            title="Link a different project"
            onClick={() => {
              setPick(linkedProject ?? "");
              setRelinking(true);
            }}
          >
            change
          </button>
        </span>
        <label className="deploy-field">
          <span className="subtle">Environment</span>
          <select
            value={env ?? ""}
            onChange={(e) => {
              setEnv(e.target.value);
              setStatus(null);
            }}
          >
            {envList.length === 0 && env && <option value={env}>{env}</option>}
            {envList.map((e) => (
              <option key={e.id} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {updatedAt && (
          <span className="subtle deploy-updated">
            updated {relTime(new Date(updatedAt).toISOString())}
          </span>
        )}
        <button
          className="btn btn-sm"
          onClick={() => void loadStatus()}
          disabled={loading}
        >
          {loading ? "…" : "↻ Refresh"}
        </button>
      </div>

      {error && <div className="system-line error deploy-error">{error}</div>}

      {status && (
        <div className="deploy-table">
          <div className="dep-row dep-head">
            <span className="dep-svc">Service</span>
            <span className="dep-badge-col">Status</span>
            <span className="dep-commit">Latest deployment</span>
            <span className="dep-time">When</span>
            <span className="dep-actions-col" />
          </div>
          {status.services.length === 0 && (
            <div className="empty-state subtle">
              No services in this environment.
            </div>
          )}
          {status.services.map((s) => {
            const d = s.latest;
            const subject = d?.commitMessage?.split("\n")[0] ?? null;
            const link = d?.staticUrl
              ? `https://${d.staticUrl.replace(/^https?:\/\//, "")}`
              : d?.url ?? null;
            return (
              <div className="dep-row" key={s.id}>
                <span className="dep-svc" title={s.name}>
                  {s.name}
                </span>
                <span className="dep-badge-col">
                  {d ? (
                    <span className={`dep-badge ${statusClass(d.status)}`}>
                      {d.status}
                    </span>
                  ) : (
                    <span className="dep-badge dep-idle">NONE</span>
                  )}
                </span>
                <span className="dep-commit">
                  {subject ? (
                    <>
                      <span className="dep-subject" title={d?.commitMessage ?? ""}>
                        {subject}
                      </span>
                      {d?.commitHash && (
                        <span className="dep-sha">{d.commitHash.slice(0, 7)}</span>
                      )}
                    </>
                  ) : (
                    <span className="subtle">—</span>
                  )}
                </span>
                <span className="dep-time subtle">
                  {relTime(d?.createdAt ?? null)}
                </span>
                <span className="dep-actions-col">
                  {link && (
                    <a
                      className="dep-link"
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open deployment"
                      onClick={(e) => e.stopPropagation()}
                    >
                      ↗
                    </a>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

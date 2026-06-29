import type { Repo, SessionMeta } from "../protocol";

interface Props {
  repos: Repo[];
  sessions: SessionMeta[];
  selectedRepoId: string | null;
  selectedSessionId: string | null;
  onSelectRepo: (id: string) => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onRenameSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  creating: boolean;
}

export function Sidebar({
  repos,
  sessions,
  selectedRepoId,
  selectedSessionId,
  onSelectRepo,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  creating,
}: Props) {
  const repoSessions = sessions.filter((s) => s.repoId === selectedRepoId);

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-title">Repos</div>
        {repos.length === 0 && (
          <div className="empty-state subtle">No repos configured.</div>
        )}
        <ul className="repo-list">
          {repos.map((r) => (
            <li key={r.id}>
              <button
                className={`repo-item ${
                  r.id === selectedRepoId ? "selected" : ""
                }`}
                onClick={() => onSelectRepo(r.id)}
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-section sessions-section">
        <div className="sidebar-title">
          <span>Sessions</span>
          <button
            className="btn btn-xs btn-primary"
            onClick={onNewSession}
            disabled={!selectedRepoId || creating}
          >
            {creating ? "…" : "+ New"}
          </button>
        </div>
        {!selectedRepoId && (
          <div className="empty-state subtle">Select a repo.</div>
        )}
        {selectedRepoId && repoSessions.length === 0 && (
          <div className="empty-state subtle">No sessions yet.</div>
        )}
        <ul className="session-list">
          {repoSessions.map((s) => (
            <li key={s.id} className="session-row">
              <button
                className={`session-item ${
                  s.id === selectedSessionId ? "selected" : ""
                }`}
                onClick={() => onSelectSession(s.id)}
              >
                <span className="session-title">{s.title || "Untitled"}</span>
                <span className={`status-badge ${s.status}`}>{s.status}</span>
              </button>
              <div className="session-actions">
                <button
                  className="icon-btn icon-btn-sm"
                  title="Rename session"
                  aria-label="Rename session"
                  onClick={() => onRenameSession(s.id)}
                >
                  ✎
                </button>
                <button
                  className="icon-btn icon-btn-sm danger"
                  title="Delete session"
                  aria-label="Delete session"
                  onClick={() => onDeleteSession(s.id)}
                >
                  🗑
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

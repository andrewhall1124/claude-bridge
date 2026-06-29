import { useCallback, useEffect, useState } from "react";
import { html as diffHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { api } from "../api";
import type { DiffResult, NotGitResult } from "../protocol";

interface Props {
  repoId: string | null;
}

function isNotGit(d: DiffResult | NotGitResult): d is NotGitResult {
  return (d as NotGitResult).notGit === true;
}

export function DiffViewer({ repoId }: Props) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [notGit, setNotGit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!repoId) return;
    setLoading(true);
    setError(null);
    setNotGit(false);
    try {
      const res = await api.getDiff(repoId);
      if (isNotGit(res)) {
        setNotGit(true);
        setDiff(null);
      } else {
        setDiff(res);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function discardPath(path: string) {
    if (!repoId) return;
    if (!confirm(`Discard changes to ${path}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.discard(repoId, { path });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function discardAll() {
    if (!repoId) return;
    if (!confirm("Discard ALL uncommitted changes? This cannot be undone."))
      return;
    setBusy(true);
    try {
      await api.discard(repoId, { all: true });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!repoId || !message.trim()) return;
    setBusy(true);
    try {
      await api.commit(repoId, message.trim());
      setMessage("");
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!repoId) {
    return <div className="empty-state subtle">No repo selected.</div>;
  }
  if (loading) return <div className="subtle">Loading diff…</div>;
  if (notGit)
    return <div className="empty-state subtle">This repo is not a git repository.</div>;
  if (error) return <div className="system-line error">{error}</div>;
  if (!diff) return null;

  const hasChanges =
    diff.status.length > 0 ||
    diff.untracked.length > 0 ||
    diff.unified.trim().length > 0;

  const rendered = diff.unified.trim()
    ? diffHtml(diff.unified, {
        drawFileList: true,
        matching: "lines",
        outputFormat: "line-by-line",
      })
    : "";

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <button className="btn btn-sm" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
        {hasChanges && (
          <button
            className="btn btn-sm btn-danger"
            onClick={() => void discardAll()}
            disabled={busy}
          >
            Discard all
          </button>
        )}
      </div>

      {!hasChanges && (
        <div className="empty-state subtle">No uncommitted changes.</div>
      )}

      {diff.status.length > 0 && (
        <div className="status-list">
          {diff.status.map((s) => (
            <div key={s.path} className="status-item">
              <span className="status-flags">
                {s.untracked ? "??" : `${s.index || " "}${s.worktree || " "}`}
              </span>
              <span className="status-path">{s.path}</span>
              <button
                className="btn btn-xs btn-danger"
                onClick={() => void discardPath(s.path)}
                disabled={busy}
              >
                Discard
              </button>
            </div>
          ))}
        </div>
      )}

      {diff.untracked.length > 0 && (
        <div className="untracked">
          <div className="subtle">Untracked files:</div>
          <ul>
            {diff.untracked.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {rendered && (
        <div
          className="diff2html-wrap"
          dangerouslySetInnerHTML={{ __html: rendered }}
        />
      )}

      {hasChanges && (
        <div className="commit-box">
          <input
            type="text"
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void commit()}
            disabled={busy || !message.trim()}
          >
            Commit
          </button>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { api } from "../api";
import type { AddRepoMode, Repo } from "../protocol";

interface Props {
  onClose: () => void;
  onAdded: (repo: Repo) => void;
}

const MODES: { value: AddRepoMode; label: string; hint: string }[] = [
  {
    value: "existing",
    label: "Existing",
    hint: "Register a repo that already exists on the server's disk.",
  },
  {
    value: "init",
    label: "New",
    hint: "Create a new directory on the server and run git init.",
  },
  {
    value: "clone",
    label: "Clone",
    hint: "git clone a remote repo into a destination path on the server.",
  },
];

export function AddRepoModal({ onClose, onAdded }: Props) {
  const [mode, setMode] = useState<AddRepoMode>("existing");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hint = MODES.find((m) => m.value === mode)!.hint;

  async function submit() {
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    if (mode === "clone" && !url.trim()) return setError("Repository URL is required.");
    if (!path.trim()) return setError("Path is required.");
    setBusy(true);
    try {
      const res = await api.addRepo({
        mode,
        name: name.trim(),
        path: path.trim() || undefined,
        url: url.trim() || undefined,
      });
      onAdded(res.repo);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add repository"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>Add repository</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-tabs">
          {MODES.map((m) => (
            <button
              key={m.value}
              className={`modal-tab ${mode === m.value ? "active" : ""}`}
              onClick={() => setMode(m.value)}
              disabled={busy}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="subtle modal-hint">{hint}</p>

        <label className="field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            placeholder="My project"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>

        {mode === "clone" && (
          <label className="field">
            <span>Repository URL</span>
            <input
              type="text"
              value={url}
              placeholder="https://github.com/owner/repo.git  or  git@github.com:owner/repo.git"
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
          </label>
        )}

        <label className="field">
          <span>
            {mode === "clone"
              ? "Destination path (on the server)"
              : mode === "init"
                ? "New directory path (on the server)"
                : "Existing path (on the server)"}
          </span>
          <input
            type="text"
            value={path}
            placeholder="/srv/repos/my-project  (or ~/code/my-project)"
            onChange={(e) => setPath(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && <div className="system-line error modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Adding…" : "Add repo"}
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

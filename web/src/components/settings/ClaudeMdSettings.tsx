import { useEffect, useState } from "react";
import { api } from "../../api";

// Editor for the user-level ~/.claude/CLAUDE.md, prepended to every session.
export function ClaudeMdSettings() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUserClaudeMd()
      .then((r) => setContent(r.content))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const r = await api.putUserClaudeMd(content);
      setContent(r.content);
      setStatus("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="subtle">Loading…</div>;

  return (
    <>
      <p className="subtle">
        Global guidance at <code>~/.claude/CLAUDE.md</code>. Applies to every
        repo and session. Leave empty to remove it.
      </p>
      <label className="field">
        <textarea
          className="mono"
          rows={20}
          value={content}
          placeholder="# Personal global guidance for Claude…"
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <div className="settings-actions">
        <button
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {status && <span className="subtle">{status}</span>}
        {error && <span className="system-line error">{error}</span>}
      </div>
    </>
  );
}

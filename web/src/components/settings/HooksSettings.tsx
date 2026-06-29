import { useEffect, useState } from "react";
import { api } from "../../api";

const EXAMPLE = `{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        { "type": "command", "command": "echo running a bash command" }
      ]
    }
  ]
}`;

// Raw-JSON editor for the user-level hooks block in ~/.claude/settings.json.
// Hooks have a nested matcher/command schema, so we edit the object directly
// rather than reimplement the whole shape as a form.
export function HooksSettings() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUserHooks()
      .then((r) => setText(JSON.stringify(r.hooks ?? {}, null, 2)))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setStatus(null);
    setError(null);
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      setError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("Hooks must be a JSON object.");
      return;
    }
    setSaving(true);
    try {
      const r = await api.putUserHooks(parsed as Record<string, unknown>);
      setText(JSON.stringify(r.hooks ?? {}, null, 2));
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
        The <code>hooks</code> block of <code>~/.claude/settings.json</code>.
        Edit as JSON; an empty object <code>{"{}"}</code> removes all hooks.
      </p>
      <label className="field">
        <textarea
          className="mono"
          rows={18}
          spellCheck={false}
          value={text}
          placeholder={EXAMPLE}
          onChange={(e) => setText(e.target.value)}
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

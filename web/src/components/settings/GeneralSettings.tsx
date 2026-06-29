import { useEffect, useState } from "react";
import { api } from "../../api";
import type { PermissionMode, Settings as SettingsType } from "../../protocol";

const MODEL_SUGGESTIONS = ["opus", "sonnet", "haiku"];
const MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "default — ask before write/edit/run" },
  { value: "acceptEdits", label: "acceptEdits — auto-approve file edits only" },
  { value: "plan", label: "plan — explore only, no execution" },
  {
    value: "bypassPermissions",
    label: "bypassPermissions — run everything unprompted",
  },
];

export function GeneralSettings() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const updated = await api.putSettings(settings);
      setSettings(updated);
      setStatus("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="subtle">Loading settings…</div>;
  if (!settings)
    return <div className="system-line error">{error ?? "No settings."}</div>;

  return (
    <>
      <label className="field">
        <span>Default system prompt</span>
        <textarea
          rows={6}
          value={settings.defaultSystemPrompt}
          onChange={(e) =>
            setSettings({ ...settings, defaultSystemPrompt: e.target.value })
          }
        />
      </label>

      <label className="field">
        <span>Default model</span>
        <input
          type="text"
          list="model-suggestions"
          value={settings.defaultModel}
          onChange={(e) =>
            setSettings({ ...settings, defaultModel: e.target.value })
          }
        />
        <datalist id="model-suggestions">
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      <label className="field">
        <span>Default permission mode</span>
        <select
          value={settings.defaultPermissionMode}
          onChange={(e) =>
            setSettings({
              ...settings,
              defaultPermissionMode: e.target.value as PermissionMode,
            })
          }
        >
          {MODE_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {settings.defaultPermissionMode === "bypassPermissions" && (
          <span className="system-line error" style={{ marginTop: 6 }}>
            bypassPermissions lets the agent read, write, and run anything in
            new sessions without asking. Only use this on a trusted, tailnet-only
            box. Applies to sessions created after saving.
          </span>
        )}
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

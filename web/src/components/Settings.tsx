import { useEffect, useState } from "react";
import { api } from "../api";
import type {
  PermissionMode,
  RailwayConfig,
  Settings as SettingsType,
} from "../protocol";

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

export function Settings() {
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

  if (loading) return <div className="pane subtle">Loading settings…</div>;
  if (!settings)
    return (
      <div className="pane system-line error">{error ?? "No settings."}</div>
    );

  return (
    <div className="pane settings-pane">
      <h2>Settings</h2>

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

      <RailwaySettings />
    </div>
  );
}

function RailwaySettings() {
  const [cfg, setCfg] = useState<RailwayConfig | null>(null);
  const [token, setToken] = useState("");
  const [env, setEnv] = useState("production");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getRailwayConfig()
      .then((c) => {
        setCfg(c);
        setEnv(c.environment);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function save() {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const patch: { apiToken?: string; environment?: string } = { environment: env };
      if (token.trim()) patch.apiToken = token.trim();
      const next = await api.setRailwayConfig(patch);
      setCfg(next);
      setEnv(next.environment);
      setToken("");
      setStatus("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function removeToken() {
    if (!window.confirm("Remove the Railway token? The Deploy page will be disabled."))
      return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const next = await api.setRailwayConfig({ apiToken: "" });
      setCfg(next);
      setToken("");
      setStatus("Token removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h3>Railway (Deploy page)</h3>
      <p className="subtle settings-hint">
        Connects the Deploy tab to your Railway account. The token is stored on
        the server and never shown again. Create one at{" "}
        <a
          href="https://railway.com/account/tokens"
          target="_blank"
          rel="noopener noreferrer"
        >
          railway.com/account/tokens
        </a>
        .
      </p>

      <label className="field">
        <span>API token {cfg?.configured ? "(configured)" : ""}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          placeholder={
            cfg?.configured
              ? "•••••••• — leave blank to keep current"
              : "Paste your Railway API token"
          }
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Default environment</span>
        <input
          type="text"
          value={env}
          spellCheck={false}
          onChange={(e) => setEnv(e.target.value)}
        />
      </label>

      <div className="settings-actions">
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {cfg?.configured && (
          <button className="btn btn-danger" onClick={() => void removeToken()} disabled={saving}>
            Remove token
          </button>
        )}
        {status && <span className="subtle">{status}</span>}
        {error && <span className="system-line error">{error}</span>}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "../../api";
import type { RailwayConfig } from "../../protocol";

// Railway token + default environment for the Deploy page. The token is stored
// server-side and never returned, so the field stays blank once configured.
export function RailwaySettings() {
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
    <>
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
    </>
  );
}

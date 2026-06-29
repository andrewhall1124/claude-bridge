import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { GitHubAuthStatus, GitHubDeviceStart } from "../../protocol";

export function GitHubSettings() {
  const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<GitHubDeviceStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set false on unmount so an in-flight poll loop stops touching state.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, []);

  async function refresh() {
    try {
      const s = await api.getGitHubStatus();
      if (alive.current) setStatus(s);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }

  async function connect() {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const start = await api.startGitHubDevice();
      if (!alive.current) return;
      setFlow(start);
      void poll(start.interval);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function poll(intervalSec: number) {
    await sleep(intervalSec * 1000);
    if (!alive.current) return;
    try {
      const r = await api.pollGitHubDevice();
      if (!alive.current) return;
      switch (r.status) {
        case "pending":
          void poll(r.interval ?? intervalSec);
          return;
        case "complete":
          setFlow(null);
          setNote(`Connected as ${r.login}.`);
          void refresh();
          return;
        case "expired":
          setFlow(null);
          setError("The code expired before you authorized. Try again.");
          return;
        case "denied":
          setFlow(null);
          setError("Authorization was denied.");
          return;
        default:
          setFlow(null);
          setError(r.error ?? "Authorization failed.");
      }
    } catch (err) {
      if (alive.current) {
        setFlow(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function signOut() {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      await api.signOutGitHub();
      await refresh();
      setNote("Signed out.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (loading) return <div className="subtle">Loading…</div>;

  return (
    <>
      <p className="subtle">
        Authenticate GitHub so Bridge can push and pull over HTTPS. Uses GitHub's
        device flow — no token to copy by hand.
        {status && !status.ghCli && (
          <>
            {" "}
            The <code>gh</code> CLI isn't installed, so this configures git's
            credential store (enough for <code>git push</code>).
          </>
        )}
      </p>

      {status?.authenticated ? (
        <div className="gh-status">
          <span className="gh-badge">●</span>
          <span>
            Signed in as <strong>{status.login}</strong>
            {status.ghCli ? " (git + gh)" : " (git)"}
          </span>
          <button className="btn btn-sm" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </button>
        </div>
      ) : flow ? (
        <div className="gh-flow">
          <p>
            1. Open{" "}
            <a href={flow.verificationUri} target="_blank" rel="noreferrer">
              {flow.verificationUri}
            </a>
            <br />2. Enter this code, then authorize:
          </p>
          <div className="gh-code">{flow.userCode}</div>
          <p className="subtle">Waiting for authorization…</p>
        </div>
      ) : (
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={() => void connect()} disabled={busy}>
            {busy ? "Starting…" : "Connect GitHub"}
          </button>
        </div>
      )}

      {note && <span className="subtle">{note}</span>}
      {error && <span className="system-line error">⚠ {error}</span>}
    </>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

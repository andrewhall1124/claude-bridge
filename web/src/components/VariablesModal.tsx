import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Props {
  project: string;
  environmentId: string;
  service: string;
  serviceName: string;
  envName: string;
  onClose: () => void;
}

export function VariablesModal({
  project,
  environmentId,
  service,
  serviceName,
  envName,
  onClose,
}: Props) {
  const [vars, setVars] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getRailwayVariables(project, environmentId, service);
      setVars(res.variables);
      setEdited(res.variables);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [project, environmentId, service]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(name: string, value: string) {
    setBusy(name);
    setError(null);
    try {
      await api.setRailwayVariable(project, environmentId, service, name, value);
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`Delete variable "${name}"?`)) return;
    setBusy(name);
    setError(null);
    try {
      await api.deleteRailwayVariable(project, environmentId, service, name);
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const name = newName.trim();
    if (!name) return;
    setBusy("__new__");
    setError(null);
    try {
      await api.setRailwayVariable(project, environmentId, service, name, newValue);
      setNewName("");
      setNewValue("");
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const names = Object.keys(vars).sort((a, b) => a.localeCompare(b));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal vars-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            Variables — <span className="refs-sym">{serviceName}</span>
            <span className="subtle"> · {envName}</span>
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="system-line error">{error}</div>}
        {loading && <div className="subtle">Loading…</div>}

        {!loading && (
          <div className="vars-list">
            {names.length === 0 && (
              <div className="empty-state subtle">No variables yet.</div>
            )}
            {names.map((name) => {
              const dirty = (edited[name] ?? "") !== (vars[name] ?? "");
              return (
                <div className="var-row" key={name}>
                  <span className="var-name" title={name}>
                    {name}
                  </span>
                  <input
                    className="var-value"
                    type="text"
                    value={edited[name] ?? ""}
                    spellCheck={false}
                    onChange={(e) =>
                      setEdited((m) => ({ ...m, [name]: e.target.value }))
                    }
                  />
                  <button
                    className="btn btn-sm"
                    disabled={!dirty || busy === name}
                    onClick={() => void save(name, edited[name] ?? "")}
                  >
                    {busy === name ? "…" : "Save"}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy === name}
                    onClick={() => void remove(name)}
                  >
                    Del
                  </button>
                </div>
              );
            })}

            <div className="var-row var-add">
              <input
                className="var-name-input"
                type="text"
                placeholder="NAME"
                value={newName}
                spellCheck={false}
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                className="var-value"
                type="text"
                placeholder="value"
                value={newValue}
                spellCheck={false}
                onChange={(e) => setNewValue(e.target.value)}
              />
              <button
                className="btn btn-sm btn-primary"
                disabled={!newName.trim() || busy === "__new__"}
                onClick={() => void add()}
              >
                {busy === "__new__" ? "…" : "Add"}
              </button>
            </div>
          </div>
        )}

        <p className="subtle vars-note">
          Changes apply to the {envName} environment and trigger a redeploy of the
          service.
        </p>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "../../api";
import type { McpServerConfig } from "../../protocol";

type Transport = "stdio" | "http" | "sse";

// A flattened, editable view of one server. Multi-line text fields are parsed
// into the wire shape on save.
interface Draft {
  key: string; // stable local id for React
  name: string;
  type: Transport;
  command: string;
  argsText: string; // one arg per line
  envText: string; // KEY=VALUE per line
  url: string;
  headersText: string; // KEY=VALUE per line
}

let nextKey = 0;
function newKey(): string {
  return `mcp-${nextKey++}`;
}

function blankDraft(): Draft {
  return {
    key: newKey(),
    name: "",
    type: "stdio",
    command: "",
    argsText: "",
    envText: "",
    url: "",
    headersText: "",
  };
}

function toDraft(name: string, cfg: McpServerConfig): Draft {
  const d = blankDraft();
  d.name = name;
  if ("url" in cfg) {
    d.type = cfg.type;
    d.url = cfg.url;
    d.headersText = mapToText(cfg.headers);
  } else {
    d.type = "stdio";
    d.command = cfg.command;
    d.argsText = (cfg.args ?? []).join("\n");
    d.envText = mapToText(cfg.env);
  }
  return d;
}

function mapToText(m?: Record<string, string>): string {
  if (!m) return "";
  return Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

// Parse "KEY=VALUE" lines into a map; blank lines ignored. Throws on a line
// without "=".
function textToMap(text: string, label: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`${label}: "${line}" must be KEY=VALUE`);
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function draftToConfig(d: Draft): McpServerConfig {
  if (d.type === "http" || d.type === "sse") {
    const url = d.url.trim();
    if (!url) throw new Error(`"${d.name}": URL is required`);
    const headers = textToMap(d.headersText, `"${d.name}" headers`);
    return headers ? { type: d.type, url, headers } : { type: d.type, url };
  }
  const command = d.command.trim();
  if (!command) throw new Error(`"${d.name}": command is required`);
  const args = d.argsText
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);
  const env = textToMap(d.envText, `"${d.name}" env`);
  const cfg: McpServerConfig = { type: "stdio", command };
  if (args.length) cfg.args = args;
  if (env) cfg.env = env;
  return cfg;
}

export function McpSettings() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUserMcp()
      .then((r) =>
        setDrafts(
          Object.entries(r.servers).map(([name, cfg]) => toDraft(name, cfg))
        )
      )
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setLoading(false));
  }, []);

  function update(key: string, patch: Partial<Draft>) {
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function remove(key: string) {
    setDrafts((ds) => ds.filter((d) => d.key !== key));
  }

  async function save() {
    setStatus(null);
    setError(null);
    const servers: Record<string, McpServerConfig> = {};
    try {
      for (const d of drafts) {
        const name = d.name.trim();
        if (!name) throw new Error("Every server needs a name.");
        if (servers[name]) throw new Error(`Duplicate server name "${name}".`);
        servers[name] = draftToConfig(d);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setSaving(true);
    try {
      const r = await api.putUserMcp(servers);
      setDrafts(
        Object.entries(r.servers).map(([name, cfg]) => toDraft(name, cfg))
      );
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
        User-scope MCP servers in <code>~/.claude.json</code>, shared with the{" "}
        <code>claude</code> CLI. Applies to sessions started after saving.
      </p>

      <div className="mcp-list">
        {drafts.length === 0 && (
          <div className="subtle">No MCP servers configured.</div>
        )}
        {drafts.map((d) => (
          <div className="mcp-server" key={d.key}>
            <div className="mcp-server-head">
              <input
                type="text"
                className="mcp-name"
                placeholder="server-name"
                value={d.name}
                onChange={(e) => update(d.key, { name: e.target.value })}
              />
              <select
                value={d.type}
                onChange={(e) =>
                  update(d.key, { type: e.target.value as Transport })
                }
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => remove(d.key)}
              >
                Remove
              </button>
            </div>

            {d.type === "stdio" ? (
              <>
                <label className="field">
                  <span>Command</span>
                  <input
                    type="text"
                    placeholder="npx"
                    value={d.command}
                    onChange={(e) => update(d.key, { command: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Args (one per line)</span>
                  <textarea
                    className="mono"
                    rows={3}
                    placeholder={"@playwright/mcp@latest"}
                    value={d.argsText}
                    onChange={(e) => update(d.key, { argsText: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Env (KEY=VALUE per line)</span>
                  <textarea
                    className="mono"
                    rows={2}
                    value={d.envText}
                    onChange={(e) => update(d.key, { envText: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  <span>URL</span>
                  <input
                    type="text"
                    placeholder="https://example.com/mcp"
                    value={d.url}
                    onChange={(e) => update(d.key, { url: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Headers (KEY=VALUE per line)</span>
                  <textarea
                    className="mono"
                    rows={2}
                    placeholder={"Authorization=Bearer …"}
                    value={d.headersText}
                    onChange={(e) =>
                      update(d.key, { headersText: e.target.value })
                    }
                  />
                </label>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="settings-actions">
        <button
          className="btn"
          onClick={() => setDrafts((ds) => [...ds, blankDraft()])}
        >
          + Add server
        </button>
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

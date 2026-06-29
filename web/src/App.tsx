import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ws } from "./ws";
import { useConnState, useSessionStream } from "./hooks";
import type { AnyServerEvent, PermissionMode, Repo, SessionMeta } from "./protocol";
import { Sidebar } from "./components/Sidebar";
import { AddRepoModal } from "./components/AddRepoModal";
import { ChatPane } from "./components/ChatPane";
import { CodePane } from "./components/CodePane";
import { Settings } from "./components/Settings";

type Tab = "chat" | "code" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "code", label: "Code", icon: "📁" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

// ---- URL persistence: /<tab>/<repoId>/<sessionId> ----
const TAB_IDS = ["chat", "code", "settings"] as const;

function parsePath(): { tab: Tab; repoId: string | null; sessionId: string | null } {
  const segs = window.location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const tab = (TAB_IDS as readonly string[]).includes(segs[0] ?? "")
    ? (segs[0] as Tab)
    : "chat";
  return { tab, repoId: segs[1] ?? null, sessionId: segs[2] ?? null };
}

function buildPath(tab: Tab, repoId: string | null, sessionId: string | null): string {
  let p = `/${tab}`;
  if (repoId) {
    p += `/${encodeURIComponent(repoId)}`;
    if (sessionId) p += `/${encodeURIComponent(sessionId)}`;
  }
  return p;
}

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(
    () => parsePath().repoId
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => parsePath().sessionId
  );
  const [tab, setTab] = useState<Tab>(() => parsePath().tab);
  const [creating, setCreating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);

  const conn = useConnState();
  const wide = useMediaQuery("(min-width: 900px)");
  const stream = useSessionStream(selectedSessionId);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
  const selectedSession =
    sessions.find((s) => s.id === selectedSessionId) ?? null;

  const loadSessions = useCallback(async () => {
    try {
      const res = await api.getSessions();
      setSessions(res.sessions);
    } catch (err) {
      console.error("load sessions", err);
    }
  }, []);

  const loadRepos = useCallback(async () => {
    try {
      const res = await api.getRepos();
      setRepos(res.repos);
      setSelectedRepoId((cur) => cur ?? res.repos[0]?.id ?? null);
    } catch (err) {
      console.error("load repos", err);
    }
  }, []);

  useEffect(() => {
    ws.start();
    void loadRepos();
    void loadSessions();
  }, [loadRepos, loadSessions]);

  useEffect(() => {
    const off = ws.onEvent((ev: AnyServerEvent) => {
      if (ev.type === "sessions_changed") void loadSessions();
      else if (ev.type === "repos_changed") void loadRepos();
    });
    return off;
  }, [loadSessions, loadRepos]);

  // Keep the URL in sync with the current tab/repo/session so a refresh
  // restores them (and back/forward works).
  useEffect(() => {
    const path = buildPath(tab, selectedRepoId, selectedSessionId);
    if (window.location.pathname !== path) {
      window.history.replaceState(null, "", path);
    }
  }, [tab, selectedRepoId, selectedSessionId]);

  useEffect(() => {
    const onPop = () => {
      const p = parsePath();
      setTab(p.tab);
      setSelectedRepoId(p.repoId);
      setSelectedSessionId(p.sessionId);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function selectRepo(id: string) {
    setSelectedRepoId(id);
    setSelectedSessionId(null);
    setSidebarOpen(false);
  }

  function onRepoAdded(repo: Repo) {
    void loadRepos();
    setSelectedRepoId(repo.id);
    setSelectedSessionId(null);
  }

  async function renameRepo(id: string) {
    const repo = repos.find((r) => r.id === id);
    const next = window.prompt("Rename repo", repo?.name ?? "");
    if (next == null) return;
    const name = next.trim();
    if (!name || name === repo?.name) return;
    try {
      await api.renameRepo(id, name);
      await loadRepos();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeRepo(id: string) {
    const repo = repos.find((r) => r.id === id);
    if (
      !window.confirm(
        `Remove "${repo?.name || "this repo"}" from Bridge? Files on disk are kept; this only unregisters it.`,
      )
    )
      return;
    try {
      await api.deleteRepo(id);
      if (selectedRepoId === id) {
        setSelectedRepoId(null);
        setSelectedSessionId(null);
      }
      await loadRepos();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  function selectSession(id: string) {
    setSelectedSessionId(id);
    setSidebarOpen(false);
    if (!wide) setTab("chat");
  }

  async function newSession() {
    if (!selectedRepoId) return;
    setCreating(true);
    try {
      const res = await api.createSession(selectedRepoId);
      await loadSessions();
      setSelectedSessionId(res.session.id);
      setSidebarOpen(false);
      if (!wide) setTab("chat");
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function setMode(mode: PermissionMode) {
    if (selectedSessionId) ws.setPermissionMode(selectedSessionId, mode);
  }

  async function renameSession(id: string) {
    const current = sessions.find((s) => s.id === id);
    const next = window.prompt("Rename session", current?.title ?? "");
    if (next == null) return;
    const title = next.trim();
    if (!title || title === current?.title) return;
    try {
      await api.renameSession(id, title);
      await loadSessions();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteSession(id: string) {
    const current = sessions.find((s) => s.id === id);
    if (
      !window.confirm(
        `Delete "${current?.title || "this session"}" and its transcript? This cannot be undone.`,
      )
    )
      return;
    try {
      await api.deleteSession(id);
      if (selectedSessionId === id) setSelectedSessionId(null);
      await loadSessions();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  const connLabel =
    conn === "connected"
      ? "connected"
      : conn === "connecting"
      ? "connecting…"
      : conn === "reconnecting"
      ? "reconnecting…"
      : "offline";

  function renderMain() {
    switch (tab) {
      case "chat":
        return (
          <ChatPane
            session={selectedSession}
            stream={stream}
            onSetMode={setMode}
          />
        );
      case "code":
        return <CodePane repoId={selectedRepoId} />;
      case "settings":
        return <Settings repos={repos} />;
      default:
        return null;
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        {!wide && (
          <button
            className="icon-btn"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
        )}
        <span className="brand">Bridge</span>
        <span className="topbar-context subtle">
          {selectedRepo ? selectedRepo.name : "no repo"}
          {selectedSession ? ` · ${selectedSession.title || "session"}` : ""}
        </span>
        <span className="spacer" />
        {wide && (
          <nav className="top-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`top-tab ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        )}
        <span className={`conn-dot ${conn}`} title={connLabel} />
        <span className="conn-label subtle">{connLabel}</span>
      </header>

      <div className="body">
        <div
          className={`sidebar-wrap ${sidebarOpen ? "open" : ""} ${
            wide ? "wide" : ""
          }`}
        >
          <Sidebar
            repos={repos}
            sessions={sessions}
            selectedRepoId={selectedRepoId}
            selectedSessionId={selectedSessionId}
            onSelectRepo={selectRepo}
            onSelectSession={selectSession}
            onNewSession={newSession}
            onRenameSession={renameSession}
            onDeleteSession={deleteSession}
            onAddRepo={() => setAddRepoOpen(true)}
            onRenameRepo={renameRepo}
            onRemoveRepo={removeRepo}
            creating={creating}
          />
        </div>
        {sidebarOpen && !wide && (
          <div
            className="scrim"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}

        <main className="main">{renderMain()}</main>
      </div>

      {!wide && (
        <nav className="bottom-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`bottom-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <span className="bottom-tab-icon">{t.icon}</span>
              <span className="bottom-tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
      )}

      {addRepoOpen && (
        <AddRepoModal onClose={() => setAddRepoOpen(false)} onAdded={onRepoAdded} />
      )}
    </div>
  );
}

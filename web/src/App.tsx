import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ws } from "./ws";
import { useConnState, useSessionStream } from "./hooks";
import type { AnyServerEvent, PermissionMode, Repo, SessionMeta } from "./protocol";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { Activity } from "./components/Activity";
import { CodePane } from "./components/CodePane";
import { Jobs } from "./components/Jobs";
import { Settings } from "./components/Settings";

type Tab = "chat" | "activity" | "code" | "jobs" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "activity", label: "Activity", icon: "📡" },
  { id: "code", label: "Code", icon: "📁" },
  { id: "jobs", label: "Jobs", icon: "⚙" },
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

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [tab, setTab] = useState<Tab>("chat");
  const [creating, setCreating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  useEffect(() => {
    ws.start();
    api
      .getRepos()
      .then((res) => {
        setRepos(res.repos);
        setSelectedRepoId((cur) => cur ?? res.repos[0]?.id ?? null);
      })
      .catch((err) => console.error("load repos", err));
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const off = ws.onEvent((ev: AnyServerEvent) => {
      if (ev.type === "sessions_changed") void loadSessions();
    });
    return off;
  }, [loadSessions]);

  function selectRepo(id: string) {
    setSelectedRepoId(id);
    setSelectedSessionId(null);
    setSidebarOpen(false);
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
      case "activity":
        return <Activity session={selectedSession} stream={stream} />;
      case "code":
        return <CodePane repoId={selectedRepoId} />;
      case "jobs":
        return <Jobs repos={repos} selectedRepoId={selectedRepoId} />;
      case "settings":
        return <Settings repos={repos} />;
      default:
        return null;
    }
  }

  // On wide screens, show the code column alongside chat / activity.
  const showRightCode = wide && (tab === "chat" || tab === "activity");

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

        {showRightCode && (
          <div className="right-col">
            <CodePane repoId={selectedRepoId} />
          </div>
        )}
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
    </div>
  );
}

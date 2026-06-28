import type { ServerEvent } from "./protocol.js";

// Lightweight in-process pub/sub. WebSocket connections subscribe to a session
// id; the session manager and job queue emit ServerEvents that get fanned out
// to every subscriber of that session. A "*" global channel carries list-level
// notifications (sessions/jobs changed) so clients can refresh.

export type SessionListener = (event: ServerEvent) => void;
export type GlobalListener = (event: GlobalEvent) => void;

export type GlobalEvent =
  | { type: "sessions_changed" }
  | { type: "jobs_changed" };

const sessionListeners = new Map<string, Set<SessionListener>>();
const globalListeners = new Set<GlobalListener>();

export function subscribeSession(sessionId: string, fn: SessionListener): () => void {
  let set = sessionListeners.get(sessionId);
  if (!set) {
    set = new Set();
    sessionListeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) sessionListeners.delete(sessionId);
  };
}

export function emitSession(sessionId: string, event: ServerEvent): void {
  const set = sessionListeners.get(sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* a broken listener must not break the emitter */
    }
  }
}

export function subscribeGlobal(fn: GlobalListener): () => void {
  globalListeners.add(fn);
  return () => globalListeners.delete(fn);
}

export function emitGlobal(event: GlobalEvent): void {
  for (const fn of globalListeners) {
    try {
      fn(event);
    } catch {
      /* ignore */
    }
  }
}

import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import { log } from "../logger.js";
import {
  subscribeSession,
  subscribeGlobal,
  type GlobalEvent,
} from "../bus.js";
import * as sm from "../agent/sessionManager.js";
import * as dbm from "../db.js";
import type { ClientCommand, ServerEvent } from "../protocol.js";

export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    const sessionSubs = new Map<string, () => void>(); // sessionId -> unsubscribe

    const send = (data: ServerEvent | GlobalEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    };

    const unsubGlobal = subscribeGlobal((event) => send(event));

    const subscribe = (sessionId: string) => {
      if (sessionSubs.has(sessionId)) return;
      const off = subscribeSession(sessionId, (event) => send(event));
      sessionSubs.set(sessionId, off);
      const meta = dbm.getSession(sessionId);
      send({
        type: "hello",
        sessionId,
        status: meta?.status ?? "idle",
      });
    };

    const unsubscribe = (sessionId: string) => {
      const off = sessionSubs.get(sessionId);
      if (off) {
        off();
        sessionSubs.delete(sessionId);
      }
    };

    ws.on("message", (raw) => {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(raw.toString()) as ClientCommand;
      } catch {
        return;
      }
      try {
        switch (cmd.type) {
          case "subscribe":
            subscribe(cmd.sessionId);
            break;
          case "unsubscribe":
            unsubscribe(cmd.sessionId);
            break;
          case "send":
            if (cmd.text.trim()) sm.sendMessage(cmd.sessionId, cmd.text);
            break;
          case "approval_response":
            sm.resolveApproval(cmd.sessionId, cmd.requestId, cmd.decision, cmd.message);
            break;
          case "interrupt":
            void sm.interrupt(cmd.sessionId);
            break;
          case "set_permission_mode":
            void sm.setPermissionMode(cmd.sessionId, cmd.mode);
            break;
        }
      } catch (err) {
        log.error("WS command error:", err);
      }
    });

    ws.on("close", () => {
      for (const off of sessionSubs.values()) off();
      sessionSubs.clear();
      unsubGlobal();
    });

    ws.on("error", (err) => log.warn("WS error:", err));
  });

  log.info("WebSocket endpoint mounted at /ws");
  return wss;
}

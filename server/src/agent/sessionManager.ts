import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../util/asyncQueue.js";
import { getConfig } from "../config.js";
import { log } from "../logger.js";
import { emitSession } from "../bus.js";
import * as dbm from "../db.js";
import type { PermissionMode } from "../protocol.js";

const config = getConfig();

// Build the env handed to the Agent SDK so billing follows the configured mode.
function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (config.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = config.anthropicApiKey; // API-key (pay-as-you-go) fallback
  } else {
    delete env.ANTHROPIC_API_KEY; // force subscription billing
  }
  return env;
}

interface PendingApproval {
  resolve: (result: PermissionResult) => void;
}

interface ActiveSession {
  sessionId: string;
  repoPath: string;
  input: AsyncQueue<SDKUserMessage>;
  query: Query;
  permissionMode: PermissionMode;
  pending: Map<string, PendingApproval>;
  consumer: Promise<void>;
}

const active = new Map<string, ActiveSession>();

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

// Map a permission mode to the SDK's set; "plan" is passed through.
function sdkPermissionMode(mode: PermissionMode): Options["permissionMode"] {
  return mode as Options["permissionMode"];
}

function buildCanUseTool(sessionId: string, sess: () => ActiveSession | undefined) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> => {
    const requestId = randomUUID();
    const current = sess();
    if (!current) return { behavior: "allow" };

    return await new Promise<PermissionResult>((resolve) => {
      current.pending.set(requestId, { resolve });

      const onAbort = () => {
        if (current.pending.delete(requestId)) {
          resolve({ behavior: "deny", message: "Interrupted before approval." });
        }
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });

      emitSession(sessionId, {
        type: "approval_request",
        sessionId,
        requestId,
        toolName,
        toolUseId: opts.toolUseID,
        input,
      });
    });
  };
}

// Consume the SDK message stream for a session: persist transcript items and
// fan them out to subscribed clients.
async function consume(sessionId: string, q: Query): Promise<void> {
  try {
    for await (const message of q) {
      handleMessage(sessionId, message);
    }
  } catch (err) {
    log.error(`Session ${sessionId} stream error:`, err);
    dbm.setSessionStatus(sessionId, "error");
    emitSession(sessionId, {
      type: "status",
      sessionId,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    active.delete(sessionId);
  }
}

function captureSdkId(sessionId: string, m: { session_id?: string }): void {
  if (m.session_id) {
    const meta = dbm.getSession(sessionId);
    if (meta && meta.sdkSessionId !== m.session_id) {
      dbm.setSessionSdkId(sessionId, m.session_id);
    }
  }
}

function handleMessage(sessionId: string, message: SDKMessage): void {
  const m = message as unknown as {
    type: string;
    session_id?: string;
    subtype?: string;
    message?: { content?: unknown };
    event?: { type?: string; delta?: { type?: string; text?: string } };
    total_cost_usd?: number;
    num_turns?: number;
    duration_ms?: number;
  };
  captureSdkId(sessionId, m);

  switch (m.type) {
    case "system": {
      // init/system notices — mark running.
      dbm.setSessionStatus(sessionId, "running");
      emitSession(sessionId, { type: "status", sessionId, status: "running" });
      return;
    }
    case "stream_event": {
      // Partial token delta — forward for live typing, do not persist.
      const ev = m.event;
      if (ev?.type === "content_block_delta" && ev.delta) {
        if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
          emitSession(sessionId, {
            type: "delta",
            sessionId,
            blockType: "text",
            text: ev.delta.text,
          });
        } else if (
          ev.delta.type === "thinking_delta" &&
          typeof (ev.delta as { thinking?: string }).thinking === "string"
        ) {
          emitSession(sessionId, {
            type: "delta",
            sessionId,
            blockType: "thinking",
            text: (ev.delta as { thinking?: string }).thinking!,
          });
        }
      }
      return;
    }
    case "assistant": {
      const content = m.message?.content ?? [];
      const item = dbm.appendMessage(sessionId, "assistant", "assistant", content);
      emitSession(sessionId, { type: "message", sessionId, item });
      return;
    }
    case "user": {
      // Persist tool_result echoes; skip plain text echoes of our own prompt.
      const content = m.message?.content;
      if (Array.isArray(content)) {
        const hasToolResult = content.some(
          (b) => (b as { type?: string }).type === "tool_result",
        );
        if (hasToolResult) {
          const item = dbm.appendMessage(sessionId, "user", "tool_result", content);
          emitSession(sessionId, { type: "message", sessionId, item });
        }
      }
      return;
    }
    case "result": {
      const result = {
        subtype: m.subtype ?? "success",
        totalCostUsd: m.total_cost_usd ?? null,
        numTurns: m.num_turns ?? null,
        durationMs: m.duration_ms ?? null,
      };
      const item = dbm.appendMessage(sessionId, "system", "result", result);
      emitSession(sessionId, { type: "message", sessionId, item });
      dbm.setSessionStatus(sessionId, "idle");
      emitSession(sessionId, { type: "status", sessionId, status: "idle" });
      emitSession(sessionId, { type: "done", sessionId, result });
      return;
    }
    default:
      return;
  }
}

function startSession(sessionId: string): ActiveSession {
  const meta = dbm.getSession(sessionId);
  if (!meta) throw new Error(`Unknown session ${sessionId}`);
  const repo = dbm.getRepo(meta.repoId);
  if (!repo) throw new Error(`Session ${sessionId} references unknown repo ${meta.repoId}`);

  const settings = dbm.getSettings();
  const input = new AsyncQueue<SDKUserMessage>();
  const pending = new Map<string, PendingApproval>();
  const permissionMode = settings.defaultPermissionMode;

  const getSelf = () => active.get(sessionId);

  const options: Options = {
    cwd: repo.path,
    model: settings.defaultModel,
    permissionMode: sdkPermissionMode(permissionMode),
    includePartialMessages: true,
    canUseTool: buildCanUseTool(sessionId, getSelf),
    env: agentEnv(),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: settings.defaultSystemPrompt,
    },
    ...(meta.sdkSessionId ? { resume: meta.sdkSessionId } : {}),
  };

  const q = query({ prompt: input, options });
  const consumer = consume(sessionId, q);

  const session: ActiveSession = {
    sessionId,
    repoPath: repo.path,
    input,
    query: q,
    permissionMode,
    pending,
    consumer,
  };
  active.set(sessionId, session);
  log.info(`Started agent for session ${sessionId} (repo ${repo.id}, ${repo.path})`);
  return session;
}

function ensureSession(sessionId: string): ActiveSession {
  return active.get(sessionId) ?? startSession(sessionId);
}

// ---- Public API ----------------------------------------------------------

export function sendMessage(sessionId: string, text: string): void {
  const sess = ensureSession(sessionId);
  const item = dbm.appendMessage(sessionId, "user", "user_text", { text });
  emitSession(sessionId, { type: "message", sessionId, item });
  dbm.setSessionStatus(sessionId, "running");
  emitSession(sessionId, { type: "status", sessionId, status: "running" });
  sess.input.push(userMessage(text));
}

export function resolveApproval(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
  message?: string,
): void {
  const sess = active.get(sessionId);
  if (!sess) return;
  const pending = sess.pending.get(requestId);
  if (!pending) return;
  sess.pending.delete(requestId);
  if (decision === "allow") {
    pending.resolve({ behavior: "allow" });
  } else {
    pending.resolve({
      behavior: "deny",
      message: message ?? "Denied by the owner.",
    });
  }
  emitSession(sessionId, { type: "approval_resolved", sessionId, requestId });
}

export async function interrupt(sessionId: string): Promise<void> {
  const sess = active.get(sessionId);
  if (!sess) return;
  // Deny any pending approvals so the turn can unwind.
  for (const [requestId, p] of sess.pending) {
    p.resolve({ behavior: "deny", message: "Interrupted." });
    emitSession(sessionId, { type: "approval_resolved", sessionId, requestId });
  }
  sess.pending.clear();
  try {
    await sess.query.interrupt();
  } catch (err) {
    log.warn(`Interrupt failed for ${sessionId}:`, err);
  }
}

export async function setPermissionMode(
  sessionId: string,
  mode: PermissionMode,
): Promise<void> {
  const sess = active.get(sessionId);
  if (!sess) return;
  sess.permissionMode = mode;
  try {
    await sess.query.setPermissionMode(sdkPermissionMode(mode) as PermissionMode);
  } catch (err) {
    log.warn(`setPermissionMode failed for ${sessionId}:`, err);
  }
}

export function isActive(sessionId: string): boolean {
  return active.has(sessionId);
}

export async function closeAll(): Promise<void> {
  for (const sess of active.values()) {
    try {
      sess.input.close();
      sess.query.close();
    } catch {
      /* ignore */
    }
  }
  active.clear();
}

// ---- One-shot job execution ---------------------------------------------
// Runs a prompt to completion non-interactively for the job queue. Auto-approves
// tools (acceptEdits + allow-all canUseTool) so it never blocks waiting on input.
export interface JobRunResult {
  sdkSessionId: string | null;
  resultSubtype: string;
  resultText: string;
  costUsd: number | null;
}

export async function runJob(
  repoPath: string,
  prompt: string,
  onMessage: (sessionId: string | null, type: string, content: unknown) => void,
): Promise<JobRunResult> {
  const settings = dbm.getSettings();
  const options: Options = {
    cwd: repoPath,
    model: settings.defaultModel,
    permissionMode: "acceptEdits",
    includePartialMessages: false,
    canUseTool: async () => ({ behavior: "allow" }),
    env: agentEnv(),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: settings.defaultSystemPrompt,
    },
  };

  let sdkSessionId: string | null = null;
  let resultSubtype = "success";
  let resultText = "";
  let costUsd: number | null = null;

  for await (const message of query({ prompt, options })) {
    const m = message as unknown as {
      type: string;
      session_id?: string;
      subtype?: string;
      result?: string;
      message?: { content?: unknown };
      total_cost_usd?: number;
    };
    if (m.session_id) sdkSessionId = m.session_id;

    if (m.type === "assistant") {
      onMessage(sdkSessionId, "assistant", m.message?.content ?? []);
    } else if (m.type === "user") {
      const content = m.message?.content;
      if (
        Array.isArray(content) &&
        content.some((b) => (b as { type?: string }).type === "tool_result")
      ) {
        onMessage(sdkSessionId, "tool_result", content);
      }
    } else if (m.type === "result") {
      resultSubtype = m.subtype ?? "success";
      costUsd = m.total_cost_usd ?? null;
      if (typeof m.result === "string") resultText = m.result;
      onMessage(sdkSessionId, "result", {
        subtype: resultSubtype,
        totalCostUsd: costUsd,
      });
    }
  }

  return { sdkSessionId, resultSubtype, resultText, costUsd };
}

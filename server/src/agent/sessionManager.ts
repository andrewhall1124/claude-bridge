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
import { readUserMcpServers } from "../userClaude.js";
import { log } from "../logger.js";
import { emitSession } from "../bus.js";
import * as dbm from "../db.js";
import type { PermissionMode, QuestionAnswer, QuestionItem } from "../protocol.js";

const ASK_TOOL = "AskUserQuestion";

// Parse the AskUserQuestion tool input into our QuestionItem[] shape, tolerating
// missing/extra fields from the model.
function parseQuestions(input: Record<string, unknown>): QuestionItem[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const items: QuestionItem[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const obj = q as Record<string, unknown>;
    const options = Array.isArray(obj.options)
      ? (obj.options as Record<string, unknown>[]).map((o) => ({
          label: String(o?.label ?? ""),
          description: String(o?.description ?? ""),
          ...(typeof o?.preview === "string" ? { preview: o.preview } : {}),
        }))
      : [];
    items.push({
      question: String(obj.question ?? ""),
      header: String(obj.header ?? ""),
      multiSelect: Boolean(obj.multiSelect),
      options,
    });
  }
  return items;
}

// Turn the user's selections into a clear natural-language tool result so the
// model treats it as the answer (delivered via canUseTool's deny message — the
// only channel that conveys free text back through the permission callback).
function formatAnswers(questions: QuestionItem[], answers: QuestionAnswer[]): string {
  const byQuestion = new Map(answers.map((a) => [a.question, a]));
  const lines: string[] = ["The user answered your question(s):"];
  for (const q of questions) {
    const a = byQuestion.get(q.question);
    const picked = a?.selected?.length ? a.selected.join(", ") : null;
    const free = a?.freeform?.trim();
    const value = [picked, free ? `(other: ${free})` : null].filter(Boolean).join(" ");
    lines.push(`- ${q.header ? `[${q.header}] ` : ""}${q.question}\n  → ${value || "(no answer)"}`);
  }
  lines.push(
    "Use these answers and continue. Do not call AskUserQuestion again to re-ask the same thing.",
  );
  return lines.join("\n");
}

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
  // Present when the pending request is an AskUserQuestion (vs a tool approval).
  questions?: QuestionItem[];
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

    // AskUserQuestion is the model asking the *owner* a question — render it as
    // a question picker rather than a generic approve/reject.
    const isQuestion = toolName === ASK_TOOL;
    const questions = isQuestion ? parseQuestions(input) : [];

    return await new Promise<PermissionResult>((resolve) => {
      current.pending.set(requestId, {
        resolve,
        ...(isQuestion ? { questions } : {}),
      });

      const onAbort = () => {
        if (current.pending.delete(requestId)) {
          resolve({
            behavior: "deny",
            message: isQuestion
              ? "The question was dismissed without an answer."
              : "Interrupted before approval.",
          });
        }
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });

      if (isQuestion && questions.length > 0) {
        emitSession(sessionId, {
          type: "question_request",
          sessionId,
          requestId,
          toolUseId: opts.toolUseID,
          questions,
        });
      } else {
        emitSession(sessionId, {
          type: "approval_request",
          sessionId,
          requestId,
          toolName,
          toolUseId: opts.toolUseID,
          input,
        });
      }
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
    thinkingBuffers.delete(sessionId);
  }
}

// The SDK delivers the final `assistant` message with thinking blocks stripped
// to just their signature (empty `thinking` text). The actual reasoning text
// only arrives via streamed `thinking_delta` events. We accumulate that text
// here, keyed by content-block index, and merge it back into the assistant
// content before persisting so the transcript's thinking view has something to
// show. Keyed by sessionId; reset at each message boundary, cleared when the
// session's stream ends.
const thinkingBuffers = new Map<string, Map<number, string>>();

function thinkingBuffer(sessionId: string): Map<number, string> {
  let buf = thinkingBuffers.get(sessionId);
  if (!buf) {
    buf = new Map();
    thinkingBuffers.set(sessionId, buf);
  }
  return buf;
}

// Fill empty thinking blocks with their streamed text, matched in block order.
function mergeThinking(sessionId: string, content: unknown): unknown {
  const buf = thinkingBuffers.get(sessionId);
  if (!buf || buf.size === 0 || !Array.isArray(content)) return content;
  const texts = [...buf.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  let next = 0;
  return content.map((block) => {
    const b = block as { type?: string; thinking?: string };
    if (b.type === "thinking" && !b.thinking && next < texts.length) {
      return { ...b, thinking: texts[next++] };
    }
    return block;
  });
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
    event?: {
      type?: string;
      index?: number;
      delta?: { type?: string; text?: string; thinking?: string };
    };
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
      // A new assistant message starts a fresh thinking accumulator.
      if (ev?.type === "message_start") {
        thinkingBuffers.set(sessionId, new Map());
      } else if (ev?.type === "content_block_delta" && ev.delta) {
        if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
          emitSession(sessionId, {
            type: "delta",
            sessionId,
            blockType: "text",
            text: ev.delta.text,
          });
        } else if (
          ev.delta.type === "thinking_delta" &&
          typeof ev.delta.thinking === "string"
        ) {
          // Stash the streamed text so we can restore it on the final message.
          if (typeof ev.index === "number") {
            const buf = thinkingBuffer(sessionId);
            buf.set(ev.index, (buf.get(ev.index) ?? "") + ev.delta.thinking);
          }
          emitSession(sessionId, {
            type: "delta",
            sessionId,
            blockType: "thinking",
            text: ev.delta.thinking,
          });
        }
      }
      return;
    }
    case "assistant": {
      const content = mergeThinking(sessionId, m.message?.content ?? []);
      const item = dbm.appendMessage(sessionId, "assistant", "assistant", content);
      emitSession(sessionId, { type: "message", sessionId, item });
      thinkingBuffers.delete(sessionId);
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
  const permissionMode = meta.permissionMode ?? settings.defaultPermissionMode;

  const getSelf = () => active.get(sessionId);

  const options: Options = {
    cwd: repo.path,
    model: settings.defaultModel,
    permissionMode: sdkPermissionMode(permissionMode),
    // Load the user/project/local filesystem settings (this is the SDK default
    // when omitted, but we set it explicitly so user-level CLAUDE.md and hooks
    // — editable from Settings — are guaranteed to apply.
    settingSources: ["user", "project", "local"],
    // Bridge's own config.json servers plus the user-scope MCP servers managed
    // from Settings (~/.claude.json). Read fresh per session so edits take
    // effect for new sessions without a restart.
    mcpServers: { ...config.mcpServers, ...readUserMcpServers() },
    // The SDK requires this opt-in before bypassPermissions can take effect.
    // We enable it for chat sessions so the owner can switch a live session
    // into bypass from the UI. It is only a *precondition* — it never bypasses
    // anything on its own; bypass happens solely when permissionMode is
    // 'bypassPermissions', which is an explicit, clearly-warned choice.
    allowDangerouslySkipPermissions: true,
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

export function resolveQuestion(
  sessionId: string,
  requestId: string,
  answers: QuestionAnswer[],
  cancelled?: boolean,
): void {
  const sess = active.get(sessionId);
  if (!sess) return;
  const pending = sess.pending.get(requestId);
  if (!pending) return;
  sess.pending.delete(requestId);
  if (cancelled) {
    pending.resolve({
      behavior: "deny",
      message:
        "The user dismissed the question without answering. Use your best judgment with reasonable defaults; only ask again if it is truly essential.",
    });
  } else {
    pending.resolve({
      behavior: "deny",
      message: formatAnswers(pending.questions ?? [], answers),
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
  // Persist so it survives restarts and is reported to clients even before the
  // agent (re)starts.
  dbm.setSessionMode(sessionId, mode);
  const sess = active.get(sessionId);
  if (sess) {
    sess.permissionMode = mode;
    try {
      await sess.query.setPermissionMode(sdkPermissionMode(mode) as PermissionMode);
    } catch (err) {
      log.warn(`setPermissionMode failed for ${sessionId}:`, err);
    }
  }
  emitSession(sessionId, { type: "permission_mode", sessionId, mode });
}

export function isActive(sessionId: string): boolean {
  return active.has(sessionId);
}

// Tear down a live agent for a session (e.g. before deleting it). Resolves any
// pending approvals/questions so the SDK process can exit cleanly.
export function closeSession(sessionId: string): void {
  const sess = active.get(sessionId);
  if (!sess) return;
  active.delete(sessionId);
  for (const p of sess.pending.values()) {
    p.resolve({ behavior: "deny", message: "Session closed." });
  }
  sess.pending.clear();
  try {
    sess.input.close();
    sess.query.close();
  } catch (err) {
    log.warn(`closeSession failed for ${sessionId}:`, err);
  }
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


import { useState } from "react";
import { formatResult } from "../hooks";
import type {
  AssistantBlock,
  ResultContent,
  ToolResultBlock,
  TranscriptItem,
} from "../protocol";
import { RichText } from "./RichText";
import { Markdown } from "./Markdown";

// ---- node model ----------------------------------------------------------
// We flatten the transcript into an ordered list of render nodes, pairing each
// tool_use with the tool_result that answers it (they arrive in separate
// transcript items) so a call and its output render as one collapsible row.

interface ToolNode {
  kind: "tool";
  key: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError: boolean;
  done: boolean;
  isAnswer: boolean;
}

type Node =
  | { kind: "user"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | ToolNode
  | { kind: "result"; key: string; result: ResultContent }
  | { kind: "error"; key: string; message: string };

function toolResultText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)))
    .join("\n");
}

function buildNodes(items: TranscriptItem[]): Node[] {
  const nodes: Node[] = [];
  const byToolUseId = new Map<string, ToolNode>();

  for (const item of items) {
    switch (item.type) {
      case "user_text": {
        const text = (item.content as { text?: string })?.text ?? "";
        nodes.push({ kind: "user", key: item.id, text });
        break;
      }
      case "assistant": {
        const blocks = (item.content as AssistantBlock[]) ?? [];
        blocks.forEach((b, i) => {
          const key = `${item.id}:${i}`;
          if (b.type === "text") nodes.push({ kind: "text", key, text: b.text });
          else if (b.type === "thinking")
            nodes.push({ kind: "thinking", key, text: b.thinking });
          else if (b.type === "tool_use") {
            const node: ToolNode = {
              kind: "tool",
              key: b.id || key,
              name: b.name,
              input: b.input ?? {},
              isError: false,
              done: false,
              isAnswer: b.name === "AskUserQuestion",
            };
            byToolUseId.set(b.id, node);
            nodes.push(node);
          }
        });
        break;
      }
      case "tool_result": {
        const blocks = (item.content as ToolResultBlock[]) ?? [];
        for (const b of blocks) {
          const node = byToolUseId.get(b.tool_use_id);
          const text = toolResultText(b.content);
          if (node) {
            node.result = text;
            node.isError = !!b.is_error;
            node.done = true;
          } else {
            nodes.push({
              kind: "tool",
              key: `${item.id}:${b.tool_use_id}`,
              name: "tool result",
              input: {},
              result: text,
              isError: !!b.is_error,
              done: true,
              isAnswer: false,
            });
          }
        }
        break;
      }
      case "result": {
        nodes.push({ kind: "result", key: item.id, result: item.content as ResultContent });
        break;
      }
      case "error": {
        const message = (item.content as { message?: string })?.message ?? "error";
        nodes.push({ kind: "error", key: item.id, message });
        break;
      }
      default:
        break; // 'system' etc. are not rendered
    }
  }
  return nodes;
}

// The name of the most recent tool still awaiting a result (for the live
// "Running X…" progress label), or null.
export function pendingToolName(items: TranscriptItem[]): string | null {
  const nodes = buildNodes(items);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (n.kind === "tool" && !n.done) return n.name;
  }
  return null;
}

// ---- per-tool presentation ----------------------------------------------
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return str(input.file_path) || str(input.path) || str(input.notebook_path);
    case "Bash":
      return str(input.command).split("\n")[0] ?? "";
    case "Glob":
      return str(input.pattern) + (input.path ? ` in ${str(input.path)}` : "");
    case "Grep":
      return str(input.pattern);
    case "WebFetch":
      return str(input.url);
    case "WebSearch":
      return str(input.query);
    case "Task":
    case "Agent":
      return str(input.description) || str(input.prompt).slice(0, 80);
    case "AskUserQuestion":
      return "question";
    default: {
      const firstStr = Object.values(input).find((v) => typeof v === "string");
      return typeof firstStr === "string" ? firstStr.slice(0, 80) : "";
    }
  }
}

// Strip the model-facing boilerplate from an AskUserQuestion answer.
function answerText(raw: string): string {
  const lines = raw.split("\n");
  while (lines.length && /^the user answered your question/i.test(lines[0]!.trim()))
    lines.shift();
  while (
    lines.length &&
    /^use these answers and continue/i.test(lines[lines.length - 1]!.trim())
  )
    lines.pop();
  return lines.join("\n").trim() || raw.trim();
}

function clip(s: string, n = 90): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

function ToolView({ node }: { node: ToolNode }) {
  const [open, setOpen] = useState(false);
  // AskUserQuestion answers travel back through the is_error channel, so don't
  // treat them as errors — an answered question is a success.
  const errored = node.isError && !node.isAnswer;
  const status = !node.done ? "running" : errored ? "error" : "done";
  const statusIcon =
    status === "running" ? (
      <span className="spinner" aria-label="running" />
    ) : status === "error" ? (
      <span className="tool-status-icon error">✗</span>
    ) : (
      <span className="tool-status-icon done">✓</span>
    );

  const displayName = node.isAnswer ? "Question" : node.name;
  const summary = node.isAnswer
    ? node.done && node.result
      ? clip(answerText(node.result), 70)
      : "waiting for your answer"
    : clip(toolSummary(node.name, node.input));

  // For answered questions the input is the (huge) questions blob, which is
  // redundant with the answer — show only the answer.
  const showInput = !node.isAnswer && Object.keys(node.input).length > 0;

  return (
    <div className={`tool-node ${status}`}>
      <button className="tool-node-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-node-name">{displayName}</span>
        <span className="tool-node-summary">{summary}</span>
        {statusIcon}
        <span className="tool-toggle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-node-body">
          {showInput && (
            <div className="tool-node-section">
              <div className="tool-node-label">input</div>
              <pre className="tool-node-pre">{JSON.stringify(node.input, null, 2)}</pre>
            </div>
          )}
          {node.done && node.result != null && (
            <div className="tool-node-section">
              <div className="tool-node-label">
                {node.isAnswer ? "your answer" : errored ? "error" : "output"}
              </div>
              <pre className={`tool-node-pre ${errored ? "is-error" : ""}`}>
                {node.isAnswer ? answerText(node.result) : node.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="think-node">
      <button className="think-node-head" onClick={() => setOpen((o) => !o)}>
        <span className="think-label">thinking</span>
        {!open && <span className="think-preview">{clip(text, 80)}</span>}
        <span className="tool-toggle">{open ? "▾" : "▸"}</span>
      </button>
      {open && <pre className="think-body">{text}</pre>}
    </div>
  );
}

// A run of consecutive tool calls, collapsed into one summary row (like the
// thinking row). Expands to the individual tool rows, each independently
// expandable for its input/output.
function ToolGroup({ tools }: { tools: ToolNode[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => !t.done);
  const errored = tools.some((t) => t.isError && !t.isAnswer);

  const counts = new Map<string, number>();
  for (const t of tools) {
    const name = t.isAnswer ? "Question" : t.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(", ");

  const statusIcon = running ? (
    <span className="spinner" aria-label="running" />
  ) : errored ? (
    <span className="tool-status-icon error">✗</span>
  ) : (
    <span className="tool-status-icon done">✓</span>
  );

  return (
    <div className={`toolgroup ${running ? "running" : errored ? "error" : "done"}`}>
      <button className="toolgroup-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-node-name">working</span>
        <span className="toolgroup-count">{tools.length} steps</span>
        {!open && <span className="tool-node-summary">{summary}</span>}
        {statusIcon}
        <span className="tool-toggle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="toolgroup-body">
          {tools.map((t) => (
            <ToolView key={t.key} node={t} />
          ))}
        </div>
      )}
    </div>
  );
}

type RenderNode = Node | { kind: "toolgroup"; key: string; tools: ToolNode[] };

// Fold runs of consecutive tool nodes into a single toolgroup (groups of one
// stay as a standalone tool row).
function groupTools(nodes: Node[]): RenderNode[] {
  const out: RenderNode[] = [];
  let buf: ToolNode[] = [];
  const flush = () => {
    if (buf.length === 1) out.push(buf[0]!);
    else if (buf.length > 1)
      out.push({ kind: "toolgroup", key: `group-${buf[0]!.key}`, tools: buf });
    buf = [];
  };
  for (const n of nodes) {
    if (n.kind === "tool") buf.push(n);
    else {
      flush();
      out.push(n);
    }
  }
  flush();
  return out;
}

export function Transcript({ items }: { items: TranscriptItem[] }) {
  const nodes = groupTools(buildNodes(items));
  return (
    <>
      {nodes.map((n) => {
        switch (n.kind) {
          case "toolgroup":
            return <ToolGroup key={n.key} tools={n.tools} />;
          case "user":
            return (
              <div key={n.key} className="msg-row user-row">
                <div className="bubble user">
                  <RichText text={n.text} />
                </div>
              </div>
            );
          case "text":
            return (
              <div key={n.key} className="msg-row assistant-row">
                <div className="bubble assistant">
                  <Markdown text={n.text} />
                </div>
              </div>
            );
          case "thinking":
            return <ThinkingView key={n.key} text={n.text} />;
          case "tool":
            return <ToolView key={n.key} node={n} />;
          case "result":
            return (
              <div key={n.key} className="system-line">
                {n.result ? formatResult(n.result) : "done"}
              </div>
            );
          case "error":
            return (
              <div key={n.key} className="system-line error">
                {n.message}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

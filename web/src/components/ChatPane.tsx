import { useEffect, useMemo, useRef, useState } from "react";
import { ws } from "../ws";
import { api } from "../api";
import type { PermissionMode, SessionMeta, UploadedFile } from "../protocol";
import type { SessionStream } from "../hooks";
import { Approval } from "./Approval";
import { Question } from "./Question";
import { Transcript, pendingToolName } from "./Transcript";
import { Markdown } from "./Markdown";

// Short, color-coded modes, ordered by ascending risk.
const MODES: { value: PermissionMode; abbr: string; title: string }[] = [
  { value: "plan", abbr: "PLAN", title: "Plan — explore only, no changes" },
  { value: "default", abbr: "ASK", title: "Ask before edits & commands" },
  { value: "acceptEdits", abbr: "EDIT", title: "Auto-approve file edits" },
  { value: "bypassPermissions", abbr: "BYPASS", title: "Run everything unprompted" },
];

const MODE_ABBR: Record<PermissionMode, string> = {
  plan: "PLAN",
  default: "ASK",
  acceptEdits: "EDIT",
  bypassPermissions: "BYPASS",
};

interface Props {
  session: SessionMeta | null;
  stream: SessionStream;
  onSetMode: (mode: PermissionMode) => void;
}

export function ChatPane({
  session,
  stream,
  onSetMode,
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    stream.transcript,
    stream.streamingText,
    stream.streamingThinking,
    stream.status,
    stream.approvals,
    stream.questions,
  ]);

  // The tool currently awaiting a result, for the live progress label. Must run
  // before any early return — hooks can't be conditional.
  const pendingTool = useMemo(
    () => pendingToolName(stream.transcript),
    [stream.transcript],
  );

  if (!session) {
    return (
      <div className="pane empty-state">
        <p>No session selected.</p>
        <p className="subtle">Pick a repo and create a session to start.</p>
      </div>
    );
  }

  const running = stream.status === "running";
  const mode: PermissionMode = stream.permissionMode ?? session.permissionMode;

  function send() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || !session) return;
    let body = t;
    if (attachments.length > 0) {
      const refs = attachments.map((a) => `- ${a.path}`).join("\n");
      body =
        (t ? `${t}\n\n` : "") +
        `Attached files (use the Read tool to view them):\n${refs}`;
    }
    ws.sendText(session.id, body);
    setText("");
    setAttachments([]);
    setUploadError(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function upload(files: File[]) {
    if (!session || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const res = await api.uploadFiles(session.repoId, files);
      setAttachments((a) => [...a, ...res.files]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault(); // pasting an image/file → upload instead of inserting
      void upload(files);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void upload(files);
  }
  function onDragEnter(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth.current += 1;
    setDragOver(true);
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }

  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void upload(files);
    e.target.value = ""; // allow re-picking the same file
  }

  return (
    <div
      className={`pane chat-pane ${dragOver ? "drag-over" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="drop-overlay">
          <span>Drop files to attach</span>
        </div>
      )}
      <div className="chat-modebar">
        <span className="subtle">{session.title || "session"}</span>
        <span className="spacer" />
        <span className={`mode-badge mode-${mode}`} title={`Permission mode: ${mode}`}>
          {MODE_ABBR[mode]}
        </span>
        <span className={`status-badge status-${stream.status}`}>{stream.status}</span>
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {stream.loading && <div className="subtle">Loading transcript…</div>}
        {!stream.loading && stream.transcript.length === 0 && (
          <div className="empty-state subtle">
            No messages yet. Say something below.
          </div>
        )}
        <Transcript items={stream.transcript} />

        {stream.streaming && stream.streamingText && (
          <div className="msg-row assistant-row">
            <div className="bubble assistant streaming">
              <Markdown text={stream.streamingText} />
              <span className="cursor">▋</span>
            </div>
          </div>
        )}

        {running && !(stream.streaming && stream.streamingText) && (
          <WorkingNote
            label={
              stream.streamingThinking
                ? "Thinking"
                : pendingTool
                  ? `Running ${pendingTool}`
                  : "Working"
            }
            preview={
              stream.streamingThinking
                ? stream.streamingThinking.replace(/\s+/g, " ").trim().slice(-180)
                : undefined
            }
          />
        )}

        {stream.approvals.map((a) => (
          <Approval
            key={a.requestId}
            approval={a}
            onRespond={(rid, decision, msg) =>
              ws.respondApproval(session.id, rid, decision, msg)
            }
          />
        ))}

        {stream.questions.map((q) => (
          <Question
            key={q.requestId}
            pending={q}
            onRespond={(rid, answers, cancelled) =>
              ws.respondQuestion(session.id, rid, answers, cancelled)
            }
          />
        ))}
      </div>

      <div className="chat-input">
        <div className="chat-input-controls">
          <div className="mode-seg" role="group" aria-label="Permission mode">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`mode-chip mode-${m.value} ${mode === m.value ? "active" : ""}`}
                title={m.title}
                aria-pressed={mode === m.value}
                onClick={() => onSetMode(m.value)}
              >
                {m.abbr}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {running && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => ws.interrupt(session.id)}
            >
              Stop
            </button>
          )}
        </div>
        {(attachments.length > 0 || uploading || uploadError) && (
          <div className="chat-attachments">
            {attachments.map((a, i) => (
              <span className="attach-chip" key={`${a.path}-${i}`} title={a.path}>
                <span className="attach-name">{a.name}</span>
                <span className="attach-size">{formatSize(a.size)}</span>
                <button
                  className="attach-x"
                  aria-label="Remove attachment"
                  onClick={() =>
                    setAttachments((list) => list.filter((_, j) => j !== i))
                  }
                >
                  ✕
                </button>
              </span>
            ))}
            {uploading && <span className="attach-chip subtle">uploading…</span>}
            {uploadError && (
              <span className="system-line error">{uploadError}</span>
            )}
          </div>
        )}
        <div className="chat-input-row">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={onFilePick}
          />
          <button
            className="btn attach-btn"
            title="Attach files"
            aria-label="Attach files"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            +
          </button>
          <textarea
            value={text}
            placeholder="Message Claude…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={2}
          />
          <button className="btn btn-primary send-btn" onClick={send}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function WorkingNote({ label, preview }: { label: string; preview?: string }) {
  return (
    <div className="working-note">
      <div className="working-head">
        <span className="spinner" />
        <span className="working-label">{label}</span>
        <span className="working-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
      {preview && <div className="working-preview">{preview}</div>}
    </div>
  );
}

// Shared protocol types for the HTTP/WebSocket surface.
// The web client mirrors these shapes in web/src/protocol.ts — keep them in sync.

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type ModelAlias = "opus" | "sonnet" | "haiku" | (string & {});

export interface Repo {
  id: string;
  name: string;
  path: string;
  /** Linked Railway project id for the Deploy page (optional). */
  railwayProjectId?: string | null;
}

export type SessionStatus = "idle" | "running" | "error";

export interface SessionMeta {
  id: string;
  sdkSessionId: string | null;
  repoId: string;
  title: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  createdAt: string;
  lastActiveAt: string;
}

// A normalized transcript entry persisted to SQLite and streamed to clients.
export type TranscriptType =
  | "user_text"
  | "assistant"
  | "tool_result"
  | "result"
  | "system"
  | "error";

export interface TranscriptItem {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  type: TranscriptType;
  // `content` shape depends on `type`:
  //  - user_text:   { text: string }
  //  - assistant:   ContentBlock[]  (text / tool_use blocks from the model)
  //  - tool_result: ContentBlock[]  (tool_result blocks)
  //  - result:      { subtype, totalCostUsd, numTurns, durationMs }
  //  - system:      { subtype, [info] }
  //  - error:       { message }
  content: unknown;
  createdAt: string;
}

// ---- WebSocket: server -> client ----
export type ServerEvent =
  | { type: "hello"; sessionId: string; status: SessionStatus; mode: PermissionMode }
  | { type: "permission_mode"; sessionId: string; mode: PermissionMode }
  | { type: "message"; sessionId: string; item: TranscriptItem }
  | {
      type: "delta";
      sessionId: string;
      blockType: "text" | "thinking";
      text: string;
    }
  | {
      type: "approval_request";
      sessionId: string;
      requestId: string;
      toolName: string;
      toolUseId: string;
      input: Record<string, unknown>;
    }
  | { type: "approval_resolved"; sessionId: string; requestId: string }
  | {
      type: "question_request";
      sessionId: string;
      requestId: string;
      toolUseId: string;
      questions: QuestionItem[];
    }
  | { type: "status"; sessionId: string; status: SessionStatus; error?: string }
  | {
      type: "done";
      sessionId: string;
      result: {
        subtype: string;
        totalCostUsd: number | null;
        numTurns: number | null;
        durationMs: number | null;
      };
    };

// ---- WebSocket: client -> server ----
export type ClientCommand =
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "send"; sessionId: string; text: string }
  | {
      type: "approval_response";
      sessionId: string;
      requestId: string;
      decision: "allow" | "deny";
      message?: string;
    }
  | { type: "interrupt"; sessionId: string }
  | { type: "set_permission_mode"; sessionId: string; mode: PermissionMode }
  | {
      type: "question_response";
      sessionId: string;
      requestId: string;
      answers: QuestionAnswer[];
      cancelled?: boolean;
    };

export interface Settings {
  defaultSystemPrompt: string;
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
}

// ---- User-level Claude config (managed via Settings) ----
// A subset of the Agent SDK's MCP server shapes that the UI can edit. Stored in
// ~/.claude.json under `mcpServers`.
export interface McpStdioServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface McpHttpServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}
export type McpServerConfig = McpStdioServer | McpHttpServer;

// ---- AskUserQuestion tool ----
export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

// The user's answer to one question: the labels they selected (one for
// single-select, possibly many for multiSelect), or a freeform string.
export interface QuestionAnswer {
  question: string;
  selected: string[];
  freeform?: string;
}

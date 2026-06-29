// Protocol types — mirror of the backend contract. TYPES ONLY.

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface Repo {
  id: string;
  name: string;
  path: string;
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
  content: unknown;
  createdAt: string;
}

export interface Settings {
  defaultSystemPrompt: string;
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
}

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

export interface QuestionAnswer {
  question: string;
  selected: string[];
  freeform?: string;
}

// ---- content shapes by TranscriptItem.type ----

export interface UserTextContent {
  text: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
export type AssistantBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ResultContent {
  subtype: string;
  totalCostUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
}

export interface SystemContent {
  subtype?: string;
}

export interface ErrorContent {
  message: string;
}

// ---- File browser / diff shapes ----

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
  untracked: boolean;
}

export interface DiffResult {
  unified: string;
  staged: string;
  untracked: string[];
  status: GitStatusEntry[];
}

export interface NotGitResult {
  error: string;
  notGit: true;
}

export interface ReferenceMatch {
  path: string;
  line: number;
  text: string;
}

export interface ReferencesResult {
  symbol: string;
  matches: ReferenceMatch[];
  truncated: boolean;
  notGit?: boolean;
}

// ---- WebSocket server -> client events ----
export type ServerEvent =
  | { type: "hello"; sessionId: string; status: SessionStatus; mode: PermissionMode }
  | { type: "permission_mode"; sessionId: string; mode: PermissionMode }
  | { type: "message"; sessionId: string; item: TranscriptItem }
  | { type: "delta"; sessionId: string; blockType: "text" | "thinking"; text: string }
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

// Global events on the same socket
export type GlobalEvent =
  | { type: "sessions_changed" }
  | { type: "repos_changed" };

export type AddRepoMode = "existing" | "init" | "clone";

export interface AddRepoRequest {
  mode: AddRepoMode;
  name: string;
  path?: string;
  url?: string;
}

export type AnyServerEvent = ServerEvent | GlobalEvent;

// ---- WebSocket client -> server commands ----
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

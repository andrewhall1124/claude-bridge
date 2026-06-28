import { getConfig } from "../config.js";
import { log } from "../logger.js";
import * as dbm from "../db.js";
import { emitGlobal, emitSession } from "../bus.js";
import { runJob } from "../agent/sessionManager.js";
import { changedFiles } from "../git/repo.js";
import type { Job, TranscriptType } from "../protocol.js";

const config = getConfig();

const pending: string[] = []; // job ids
let running = 0;

export function enqueue(repoId: string, prompt: string): Job {
  const job = dbm.createJob(repoId, prompt);
  pending.push(job.id);
  emitGlobal({ type: "jobs_changed" });
  schedule();
  return job;
}

function schedule(): void {
  while (running < config.jobConcurrency && pending.length > 0) {
    const id = pending.shift()!;
    running++;
    void runOne(id).finally(() => {
      running--;
      schedule();
    });
  }
}

function summarize(prompt: string): string {
  const firstLine = prompt.split("\n")[0]!.trim();
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine || "Job";
}

function lastAssistantText(sessionId: string): string {
  const transcript = dbm.getTranscript(sessionId);
  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i]!;
    if (item.type === "assistant" && Array.isArray(item.content)) {
      const text = (item.content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

async function runOne(jobId: string): Promise<void> {
  const job = dbm.getJob(jobId);
  if (!job) return;
  const repo = dbm.getRepo(job.repoId);
  if (!repo) {
    dbm.updateJob(jobId, {
      status: "error",
      error: `Unknown repo ${job.repoId}`,
      finishedAt: new Date().toISOString(),
    });
    emitGlobal({ type: "jobs_changed" });
    return;
  }

  // Each job gets a session so its transcript & live stream reuse the normal
  // session machinery (viewable + watchable from the UI).
  // Jobs always run with auto-approval; reflect that in the session record.
  const session = dbm.createSession(repo.id, `Job: ${summarize(job.prompt)}`, "acceptEdits");
  dbm.setSessionStatus(session.id, "running");
  dbm.updateJob(jobId, { status: "running", sessionId: session.id });
  emitGlobal({ type: "jobs_changed" });
  emitGlobal({ type: "sessions_changed" });

  // Persist + fan out each streamed message to the job's session.
  const onMessage = (
    _sdkId: string | null,
    type: string,
    content: unknown,
  ): void => {
    const role: "assistant" | "user" | "system" =
      type === "assistant" ? "assistant" : type === "tool_result" ? "user" : "system";
    const item = dbm.appendMessage(session.id, role, type as TranscriptType, content);
    emitSession(session.id, { type: "message", sessionId: session.id, item });
  };

  // Record the kickoff prompt as the first transcript entry.
  const promptItem = dbm.appendMessage(session.id, "user", "user_text", {
    text: job.prompt,
  });
  emitSession(session.id, { type: "message", sessionId: session.id, item: promptItem });

  try {
    const result = await runJob(repo.path, job.prompt, onMessage);
    if (result.sdkSessionId) dbm.setSessionSdkId(session.id, result.sdkSessionId);

    const files = await changedFiles(repo.path).catch(() => []);
    const summary = result.resultText.trim() || lastAssistantText(session.id) || "Done.";

    dbm.setSessionStatus(session.id, "idle");
    dbm.updateJob(jobId, {
      status: result.resultSubtype === "success" ? "done" : "error",
      resultSummary: summary.slice(0, 4000),
      changedFiles: files,
      error: result.resultSubtype === "success" ? null : `Ended: ${result.resultSubtype}`,
      finishedAt: new Date().toISOString(),
    });
    log.info(`Job ${jobId} finished (${result.resultSubtype}, ${files.length} file(s))`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dbm.setSessionStatus(session.id, "error");
    dbm.updateJob(jobId, {
      status: "error",
      error: message,
      finishedAt: new Date().toISOString(),
    });
    log.error(`Job ${jobId} failed:`, err);
  } finally {
    emitGlobal({ type: "jobs_changed" });
    emitGlobal({ type: "sessions_changed" });
    emitSession(session.id, { type: "status", sessionId: session.id, status: dbm.getSession(session.id)?.status ?? "idle" });
  }
}

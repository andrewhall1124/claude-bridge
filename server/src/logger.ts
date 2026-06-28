// Minimal leveled logger. Set LOG_LEVEL=debug for verbose output.
type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

function emit(level: Level, args: unknown[]): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  const tag = `[${ts}] ${level.toUpperCase()}`;
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(tag, ...args);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};

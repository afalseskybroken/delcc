// src/lib/applog.ts — in-memory diagnostics ring (pass #48).
// Purpose: make debugging NOT painful — the user opens Settings → Diagnostics and
// sees what actually happened (API failures, run verdicts, sweep progress) instead
// of digging webview devtools. Memory only, capped, never uploaded: copying out is
// a manual user action (honest-client doctrine).
export type LogLevel = "info" | "error";
export interface LogEntry { t: number; level: LogLevel; msg: string }

const MAX = 400;
const ring: LogEntry[] = [];
const listeners = new Set<() => void>();

const push = (level: LogLevel, msg: string): void => {
  ring.push({ t: Date.now(), level, msg: String(msg).slice(0, 600) });
  if (ring.length > MAX) ring.shift();
  listeners.forEach(fn => fn());
};
export const logInfo = (msg: string): void => push("info", msg);
export const logError = (msg: string): void => push("error", msg);

export const logSnapshot = (): LogEntry[] => [...ring];
export const clearLog = (): void => { ring.length = 0; listeners.forEach(fn => fn()); };
export const onLog = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const formatEntries = (entries: LogEntry[]): string =>
  entries.map(e => `${new Date(e.t).toLocaleTimeString()} [${e.level}] ${e.msg}`).join("\n");

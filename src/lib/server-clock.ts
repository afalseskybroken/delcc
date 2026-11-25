let sampledTime: number | null = null;
let sampledAt = 0;

export function observeServerTime(value: unknown): void {
  if (typeof value !== "string") return;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  const next = Date.parse(value);
  if (!parts || !Number.isFinite(next)) return;
  const offset = parts[7] ? (Number(parts[8]) * 60 + Number(parts[9])) * (parts[7] === "-" ? -1 : 1) : 0;
  const calendar = new Date(next + offset * 60_000);
  const fields = [calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), calendar.getUTCHours(), calendar.getUTCMinutes(), calendar.getUTCSeconds()];
  // Date.parse normalizes invalid calendar dates instead of rejecting them.
  if (fields.some((field, i) => field !== Number(parts[i + 1]))) return;
  const at = performance.now();
  if (sampledTime != null && next < sampledTime + at - sampledAt) return;
  sampledTime = next;
  sampledAt = at;
}

export function serverTimeNow(): number | null {
  return sampledTime == null ? null : sampledTime + performance.now() - sampledAt;
}

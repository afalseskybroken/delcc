// delcc-app/src/lib/regex-probe.ts
// pass #144 (wave-8 W8-L15): the main-thread gate for user-supplied RegExp patterns
// (the submissions smart search). `regexSafe(pattern)` answers SYNCHRONOUSLY so the
// render path stays sync:
//   - a known-safe pattern  → true (the caller may compile it),
//   - unknown / unsafe / broken worker → false (the caller uses the literal
//     substring fallback — the SAFE DEFAULT; a benign pattern briefly matching
//     literally is cosmetic, a hung main thread is not).
// The verdict comes from a terminable canary worker (regex-probe-worker.ts): it runs
// the pattern against an adversarial input; a hang gets its worker TERMINATED at the
// 1.5 s deadline and the verdict is remembered. Verdicts cache per pattern — the
// 10 s polling repaint never re-probes a settled pattern.
import RegexProbeWorker from "./regex-probe-worker?worker";

const verdicts = new Map<string, boolean>();
const inflight = new Map<number, (safe: boolean) => void>();
let worker: Worker | null = null;
let seq = 0;

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new RegexProbeWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; safe: boolean }>) => {
      const resolve = inflight.get(e.data.id);
      inflight.delete(e.data.id);
      resolve?.(e.data.safe);
    };
    worker.onerror = () => {
      // the worker is broken (OOM'd, terminated mid-flight) — every pending probe
      // fails closed; the next probe respawns a fresh worker.
      inflight.forEach((resolve) => resolve(false));
      inflight.clear();
      worker = null;
    };
  } catch {
    worker = null; // no Worker support — every pattern stays literal
  }
  return worker;
}

export function regexSafe(pattern: string): boolean {
  const cached = verdicts.get(pattern);
  if (cached !== undefined) return cached;
  const w = ensureWorker();
  if (!w) return false;
  const id = ++seq;
  w.postMessage({ id, pattern });
  const timer = setTimeout(() => {
    // the canary hung — catastrophic pattern. Kill the worker wholesale (a hanging
    // JS regex cannot be interrupted any other way), fail closed, remember.
    try { w.terminate(); } catch { /* already gone */ }
    worker = null;
    inflight.delete(id);
    verdicts.set(pattern, false);
  }, 1500);
  inflight.set(id, (safe) => {
    clearTimeout(timer);
    verdicts.set(pattern, safe);
  });
  return false; // unknown until proven — the literal fallback runs meanwhile
}

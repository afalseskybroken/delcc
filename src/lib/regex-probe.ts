// delcc-app/src/lib/regex-probe.ts
// pass #157 (wave-11 W11-07): the worker-side MATCHER. The #144 canary proved a
// pattern against one fixed input and cached "safe" — a pattern that hung on REAL
// server data still ran on the main thread. Now the MATCHING ITSELF runs in the
// terminable worker: the caller sends the pattern plus the texts to test and gets
// matched indices back. A hang dies with the worker at the deadline and the pattern
// is REMEMBERED as proven-catastrophic — it gets the literal substring filter
// permanently (the guarantee is the worker plus the memory, not a canary). No
// user-supplied RegExp is ever compiled on the main thread.
import RegexProbeWorker from "./regex-probe-worker?worker";

const hangPatterns = new Set<string>();
const inflight = new Map<number, (matched: number[] | null) => void>();
let worker: Worker | null = null;
let seq = 0;

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new RegexProbeWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; matched: number[] | null }>) => {
      const resolve = inflight.get(e.data.id);
      inflight.delete(e.data.id);
      resolve?.(e.data.matched);
    };
    worker.onerror = () => {
      // the worker is broken (OOM'd, terminated mid-flight) — every pending match
      // fails closed (null = the literal filter); the next call respawns a fresh worker.
      inflight.forEach((resolve) => resolve(null));
      inflight.clear();
      worker = null;
    };
  } catch {
    worker = null; // no Worker support — every pattern stays literal
  }
  return worker;
}

// Returns the INDICES of texts the pattern matches, or null when the caller must
// fall back to the literal substring filter (worker unavailable, pattern proven
// catastrophic on real data, invalid pattern, or the deadline lost).
export async function regexMatchInWorker(pattern: string, texts: string[]): Promise<number[] | null> {
  if (!pattern || hangPatterns.has(pattern)) return null;
  const w = ensureWorker();
  if (!w) return null;
  const id = ++seq;
  return new Promise<number[] | null>((resolve) => {
    const timer = setTimeout(() => {
      // hung on REAL data — catastrophic beyond what any canary predicted. Kill the
      // worker wholesale (a hanging JS regex cannot be interrupted any other way),
      // remember the pattern as proven-catastrophic, fail closed.
      try { w.terminate(); } catch { /* already gone */ }
      worker = null;
      inflight.delete(id);
      hangPatterns.add(pattern);
      resolve(null);
    }, 1500);
    inflight.set(id, (matched) => {
      clearTimeout(timer);
      resolve(matched);
    });
    w.postMessage({ id, pattern, texts });
  });
}

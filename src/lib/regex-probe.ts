// delcc-app/src/lib/regex-probe.ts
// pass #157 (wave-11 W11-07): the worker-side MATCHER. The #144 canary proved a
// pattern against one fixed input and cached "safe" — a pattern that hung on REAL
// server data still ran on the main thread. Now the MATCHING ITSELF runs in the
// terminable worker: the caller sends the pattern plus the texts to test and gets
// matched indices back. A hang dies with the worker at the deadline and the pattern
// is REMEMBERED as proven-catastrophic — it gets the literal substring filter
// permanently (the guarantee is the worker plus the memory, not a canary). No
// user-supplied RegExp is ever compiled on the main thread.
// pass #163 (wave-12 W12-20/21): concurrent calls share one FIFO worker. A timeout now
// fails closed EVERY call on that worker but condemns only the HEAD pattern (the one the
// worker was actually executing) — a queued innocent pattern is no longer permanently
// degraded. The global worker pointer is cleared only when it still names the terminated
// instance, so a concurrently respawned worker is never orphaned, and onerror acts only
// on its own instance. The hang memory is a bounded Set (oldest evicted).
import RegexProbeWorker from "./regex-probe-worker?worker";

// pass #163 (wave-12 W12-21): the hang memory is bounded — patterns arrive from route
// params (a crafted #/submissions link could seed entries), so an uncapped Set was a
// session-lifetime memory leak. Oldest evicted; an evicted catastrophic pattern is simply
// re-probed (and re-condemned) if it ever appears again.
const MAX_HANG_PATTERNS = 256;
const hangPatterns = new Set<string>();
type Pending = { w: Worker; pattern: string; timer: ReturnType<typeof setTimeout>; done: (matched: number[] | null) => void };
const inflight = new Map<number, Pending>();
let worker: Worker | null = null;
let seq = 0;

function rememberHang(pattern: string): void {
  if (hangPatterns.has(pattern)) return;
  if (hangPatterns.size >= MAX_HANG_PATTERNS) {
    const oldest = hangPatterns.values().next().value;
    if (oldest !== undefined) hangPatterns.delete(oldest);
  }
  hangPatterns.add(pattern);
}

// Fail closed every pending call on worker w (resolve null, clear its timer, drop the
// entry). The worker is FIFO, so the FIRST inflight entry on w is the one it was
// executing; `condemnHead` remembers only that pattern as proven-catastrophic. The rest
// were queued behind the hang and never ran — condemning them was W12-20's bug. Deleting
// the current entry while iterating a Map is well-defined (the iterator advances).
function failWorker(w: Worker, condemnHead: boolean): void {
  let head = true;
  for (const [id, ent] of inflight) {
    if (ent.w !== w) continue;
    inflight.delete(id);
    clearTimeout(ent.timer);
    if (condemnHead && head) rememberHang(ent.pattern);
    head = false;
    ent.done(null);
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    const w = new RegexProbeWorker();
    worker = w;
    w.onmessage = (e: MessageEvent<{ id: number; matched: number[] | null }>) => {
      const ent = inflight.get(e.data.id);
      if (!ent) return;
      inflight.delete(e.data.id);
      clearTimeout(ent.timer);
      ent.done(e.data.matched);
    };
    w.onerror = () => {
      // the worker is broken (OOM'd, threw). Act only on THIS instance — if it was already
      // terminated/replaced, its calls were failed by the timeout that did so, and
      // clobbering the global here would orphan the live worker (W12-20). An error is not
      // a proven hang, so no pattern is condemned.
      if (worker !== w) return;
      failWorker(w, false);
      try { w.terminate(); } catch { /* already gone */ }
      worker = null;
    };
    return w;
  } catch {
    worker = null; // no Worker support — every pattern stays literal
    return null;
  }
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
      // hung on REAL data — catastrophic beyond what any canary predicted. Kill the worker
      // wholesale (a hanging JS regex cannot be interrupted any other way) and fail closed
      // every call on it, condemning only the head pattern. Clear the global only if it
      // still names THIS worker, so a concurrently respawned one survives (W12-20).
      try { w.terminate(); } catch { /* already gone */ }
      if (worker === w) worker = null;
      failWorker(w, true);
    }, 1500);
    inflight.set(id, { w, pattern, timer, done: resolve });
    w.postMessage({ id, pattern, texts });
  });
}

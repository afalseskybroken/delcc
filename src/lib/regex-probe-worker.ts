// delcc-app/src/lib/regex-probe-worker.ts
// pass #144 (wave-8 W8-L15): the canary worker for user-supplied search patterns.
// The MAIN thread never compiles an unvetted pattern — a catastrophic one
// ((a+)+$-class) would hang the render. This worker compiles the pattern and runs
// it against an adversarial canary; a hang dies with the worker (the manager
// terminates it), a benign pattern answers instantly.
self.onmessage = (e: MessageEvent<{ id: number; pattern: string }>) => {
  const { id, pattern } = e.data;
  // an a-blob + non-match tail: exponential backtracking chokes on it in fractions
  // of a second; every bounded pattern answers immediately.
  const canary = "a".repeat(200) + "b";
  try {
    const re = new RegExp(pattern, "i");
    re.test(canary);
    (self as unknown as Worker).postMessage({ id, safe: true });
  } catch {
    (self as unknown as Worker).postMessage({ id, safe: false });
  }
};

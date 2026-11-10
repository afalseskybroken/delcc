// delcc-app/src/lib/regex-probe-worker.ts
// pass #157 (wave-11 W11-07): the matching worker. Compiles the caller's pattern and
// tests it against the REAL texts the caller sends — a hang dies with the worker (the
// manager terminates it at the deadline and remembers the pattern), so a catastrophic
// pattern can never reach the main thread, on any input.
self.onmessage = (e: MessageEvent<{ id: number; pattern: string; texts: string[] }>) => {
  const { id, pattern, texts } = e.data;
  try {
    const re = new RegExp(pattern, "i");
    const matched: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (re.test(texts[i])) matched.push(i);
    }
    (self as unknown as Worker).postMessage({ id, matched });
  } catch {
    // an invalid pattern matches nothing as a regex — null sends the caller to the
    // literal substring filter (which is what a broken pattern deserves)
    (self as unknown as Worker).postMessage({ id, matched: null });
  }
};

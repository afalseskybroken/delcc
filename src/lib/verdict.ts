// delcc-app/src/lib/verdict.ts
// Verdict watcher: stream-first, poll-fallback. The SSE payload shape is not in the contract
// ("OK"), so a stream event is only a WAKE-UP — every state still comes from the REST detail GET.
// That keeps the SubmissionDetail shape identical on both paths.
import { api, API_BASE, type SubmissionDetail } from "./api";

export interface WatchOpts {
  id: number;
  contestKey?: string | null;
  participationId?: number | null;   // stream only exists for contest participations
  token: () => string | null;
  onState: (s: SubmissionDetail, via: "stream" | "poll", terminal: boolean) => void;
  onTimeout: (last: SubmissionDetail | null) => void;
  onError: (e: unknown) => void;
  maxMs?: number;
}

const PENDING = ["QU", "W", "P", "G", "J", "judging", "waiting", "pending", "queued", ""];
const heuristicDone = (s: any) => {
  const st = String(s.status || ""), disp = String(s.status_display || s.result || "").toLowerCase();
  return !PENDING.includes(st) && !PENDING.includes(disp);
};

export function watchVerdict(o: WatchOpts): () => void {
  let stopped = false, streamLive = false, last: SubmissionDetail | null = null;
  let wake: (() => void) | null = null;
  const ctl = new AbortController();
  const stop = () => { stopped = true; ctl.abort(); wake?.(); };

  const detail = () => {
    const t = o.token()!;
    return o.contestKey ? api.submissionContest(t, o.contestKey, o.id) : api.submission(t, o.id);
  };

  async function streamLoop(pid: number) {
    try {
      const t = o.token();
      if (!t || typeof ReadableStream === "undefined") return;
      // WebView fetch (EventSource can't carry Bearer). Blocked by CORS / non-200 => silent poll fallback.
      const r = await fetch(api.streamUrl(pid), {
        headers: { Authorization: "Bearer " + t, Accept: "text/event-stream" }, signal: ctl.signal,
      });
      if (!r.ok || !r.body) return;
      streamLive = true;
      const rd = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^(data|event):/m.test(ev)) wake?.();   // any event => re-read detail now
        }
      }
    } catch { /* fall back to polling */ }
    finally { streamLive = false; wake?.(); }
  }

  const nap = (ms: number) => new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    wake = () => { clearTimeout(t); res(); };
  });

  void (async () => {
    const t0 = Date.now(), max = o.maxMs ?? 120_000;
    if (o.participationId != null) void streamLoop(o.participationId);
    for (;;) {
      if (stopped) return;
      try {
        const s = await detail();
        if (stopped) return;
        last = s;
        const term = typeof s.is_terminal === "boolean" ? s.is_terminal : heuristicDone(s);
        o.onState(s, streamLive ? "stream" : "poll", term);
        if (term) { stop(); return; }
      } catch (e) { if (!stopped) { stop(); o.onError(e); } return; }
      if (Date.now() - t0 > max) { stop(); o.onTimeout(last); return; }
      await nap(streamLive ? 10_000 : 2_000);  // stream live: slow safety poll
    }
  })();

  return stop;
}

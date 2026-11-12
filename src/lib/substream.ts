// delcc-app/src/lib/substream.ts
// pass #164 (He's queued lane): the submission SSE streams — the client side.
//
// Wire format (live probe 2026-11-12, dev account, /submissions/stream):
//   event: ready
//   data: {"schema_version":1,"scope":"public_practice","replay_supported":false}
//   : heartbeat
// Any other named event carries an update signal; the view refreshes through the
// DOCUMENTED REST call (the stream is the bell, the GET is the data — no invented
// payload semantics, exactly the honest-client line).
//
// Two transports, one interface: the Tauri shell opens the stream (EventSource
// cannot carry an Authorization header and api_fetch buffers whole bodies), the
// browser-dev fallback reads the same wire via fetch + ReadableStream. The caller
// owns reconnection and liveness; this module owns ONE connection.
export type StreamKind = { type: "public" } | { type: "participation"; id: number };

export interface SubStreamHandlers {
  onReady(info: unknown): void;
  onUpdate(): void;
  onDown(reason: string): void;
}

export interface SubStreamHandle {
  close(): void;
}

const API_BASE = "https://oj.tmathcoding.vn/api/v3";

export function streamPath(kind: StreamKind): string {
  return kind.type === "public"
    ? "/submissions/stream"
    : `/participations/${kind.id}/submissions/stream`;
}

interface Frame { event: string; data: string }

function dispatchFrame(raw: string, h: SubStreamHandlers): void {
  let f: Frame;
  try {
    const parsed = JSON.parse(raw) as { event?: unknown; data?: unknown };
    if (typeof parsed.event !== "string" || typeof parsed.data !== "string") return;
    f = { event: parsed.event, data: parsed.data };
  } catch { return; }
  switch (f.event) {
    case "ready": {
      let info: unknown = f.data;
      try { info = JSON.parse(f.data); } catch { /* keep the raw string */ }
      h.onReady(info);
      return;
    }
    case "down":
      h.onDown(f.data);
      return;
    case "closed":
      h.onDown(f.data || "stream closed");
      return;
    default:
      h.onUpdate();
  }
}

function tauriStream(kind: StreamKind, token: string, h: SubStreamHandlers): Promise<SubStreamHandle | null> {
  // dynamic import — plain-browser dev has no bridge
  return (async () => {
    try {
      const m = await import("@tauri-apps/api/core");
      if (!(typeof m.invoke === "function" && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)) return null;
      let closed = false;
      let id: number | null = null;
      const chan = new m.Channel<string>();
      chan.onmessage = (msg: string) => {
        if (closed) return;
        dispatchFrame(msg, h);
      };
      id = await m.invoke<number>("submission_stream_start", { path: streamPath(kind), token, onEvent: chan });
      if (closed) { void m.invoke("submission_stream_stop", { id }); return null; }
      return {
        close(): void {
          closed = true;
          void m.invoke("submission_stream_stop", { id }).catch(() => { /* already gone */ });
        },
      };
    } catch { return null; }
  })();
}

function browserStream(kind: StreamKind, token: string, h: SubStreamHandlers): SubStreamHandle {
  const ctrl = new AbortController();
  void (async () => {
    try {
      const r = await fetch(API_BASE + streamPath(kind), {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) { h.onDown(`HTTP ${r.status}`); return; }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // frames split on \n\n; tolerate \r\n
        let idx: number;
        while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
          let event = "";
          let data = "";
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith(":")) continue; // heartbeat comment
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
          }
          if (data || event) dispatchFrame(JSON.stringify({ event: event || "message", data }), h);
        }
        if (buf.length > 1024 * 1024) { h.onDown("frame buffer over 1 MiB"); return; }
      }
      h.onDown("stream ended");
    } catch (e) {
      if (!ctrl.signal.aborted) h.onDown(e instanceof Error ? e.message : String(e));
    }
  })();
  return { close: () => ctrl.abort() };
}

export async function openSubmissionStream(kind: StreamKind, token: string, h: SubStreamHandlers): Promise<SubStreamHandle> {
  const viaShell = await tauriStream(kind, token, h);
  return viaShell ?? browserStream(kind, token, h);
}

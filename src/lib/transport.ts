// delcc-app/src/lib/transport.ts
// Rust-side HTTP first (Tauri `api_fetch` command), WebView fetch as fallback.
// The WebView fetch stack died with `Failed to fetch` against a CORS-open
// endpoint on the check box while curl/python sailed through — so the shell
// does the talking and the page renders. Same shape the official client uses.
export interface TransportResponse { status: number; json: any; text: string }

import { logError } from "./applog";

let invokeFn: null | ((cmd: string, args: any) => Promise<string>) = null;
export type InvokeFn = (cmd: string, args: any) => Promise<string>;
let probe: Promise<InvokeFn | null> | null = null;

// One shared probe promise: a concurrent first caller used to see `probed === true` while the
// dynamic import was still in flight, read invokeFn as null and fall through to WebView fetch
// (the very path that dies on the check box). Everyone now awaits the same probe.
function invoke(): Promise<InvokeFn | null> {
  if (!probe) probe = probeBridge();
  return probe;
}

// pass #78: shared probe accessor — lib/secure.ts rides the same bridge probe as the
// CPH/API wrappers (one dynamic import, one probe promise for the whole app).
export async function shellInvoke(): Promise<InvokeFn | null> {
  return invoke();
}

async function probeBridge(): Promise<InvokeFn | null> {
  try {
    const m = await import("@tauri-apps/api/core");
    // a cheap echo-free probe: api_fetch exists iff the shell provides it.
    // we don't call it yet — just confirm the bridge is wired.
    // plain-browser dev: module imports fine but the bridge is absent -> fall through to fetch.
    if (typeof m.invoke === "function" && (window as any).__TAURI_INTERNALS__) invokeFn = m.invoke as any;
  } catch { invokeFn = null; }
  return invokeFn;
}

export async function transport(
  method: string,
  url: string,
  headers: Record<string, string>,
  bodyText?: string,
): Promise<TransportResponse> {
  const inv = await invoke();
  if (inv) {
    const u = new URL(url);
    const raw = await inv("api_fetch", {
      method,
      path: u.pathname.replace(/^\/api\/v3/, "") + u.search,
      body: bodyText ?? null,
      headers,
    });
    const env = JSON.parse(raw) as { status: number; body: string };
    let json: any = {};
    try { json = JSON.parse(env.body); } catch { json = {}; }
    if (env.status >= 400) logError(`api ${method} ${u.pathname}${u.search} -> ${env.status}`);
    return { status: env.status, json, text: env.body };
  }
  const r = await fetch(url, { method, headers, body: bodyText });
  const text = await r.text().catch(() => "");
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = {}; }
  if (r.status >= 400) logError(`api ${method} ${url} -> ${r.status}`);
  return { status: r.status, json, text };
}

// pass #83: profile-provided About images — fetched by the Rust shell (asset_fetch:
// https-only, public hosts per redirect hop, image-only, 2 MiB cap, no credentials) so
// the webview CSP stays pinned; the shell answers with a data: URL. Plain-browser dev
// keeps a direct best-effort fetch with the same caps. null = fetch refused/failed,
// the caller degrades to a plain link.
export async function fetchAsset(url: string): Promise<string | null> {
  const inv = await invoke();
  if (inv) {
    try { return (await inv("asset_fetch", { url })) as unknown as string; }
    catch { return null; }
  }
  try {
    const r = await fetch(url, { headers: { Accept: "image/*" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ct.startsWith("image/")) return null;
    // pass #141 (wave-8 W8-01): stream the body and bail the moment it would cross the
    // cap — arrayBuffer() used to allocate the complete response BEFORE the size check,
    // so a chunked server could balloon the dev-page's memory past the advertised cap.
    const MAX = 2_000_000;
    const reader = r.body?.getReader();
    if (!reader) return null;
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX) { void reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const p of parts) { bytes.set(p, off); off += p.byteLength; }
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${ct};base64,${btoa(bin)}`;
  } catch { return null; }
}

// pass #18: public site HTML (avatar harvest). Rust shell first — the webview fetch
// is CORS-blocked on profile pages; plain-browser dev keeps a best-effort fetch.
export async function siteGet(path: string): Promise<TransportResponse> {  const direct = async (): Promise<TransportResponse> => {
    const r = await fetch(`https://oj.tmathcoding.vn${path}`, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(10_000) });
    return { status: r.status, json: {}, text: await r.text().catch(() => "") };
  };
  try {
    const inv = await invoke();
    if (!inv) return direct();
    const raw = await inv("site_fetch", { path });
    const env = JSON.parse(raw) as { status: number; body: string };
    return { status: env.status, json: {}, text: env.body };
  } catch {
    // shell route unavailable (command error/ACL) — the direct fetch still works
    // wherever the site sends its CORS header
    return direct();
  }
}
export async function getLayout(): Promise<string> {
  const inv = await invoke();
  if (inv) return inv("get_layout", {}) as Promise<string>;
  return "baseplate";
}

// Open an https URL in the system browser (Rust `open_url`); plain-browser dev uses window.open.
export async function openExternal(url: string): Promise<boolean> {
  const inv = await invoke();
  if (!inv) { window.open(url, "_blank"); return true; }
  // pass #136 (the AGE lesson, applied): a silently-swallowed open failure is exactly the
  // class of bug that hides for weeks — the shell command now reports WHY it refused.
  try { await inv("open_url", { url }); return true; }
  catch (e) { logError(`open_url failed for ${url}: ${e instanceof Error ? e.message : String(e)}`); return false; }
}

// ---------- CPH: local compile/run, desktop shell only ----------
export interface CphToolchain { lang_key: string; label: string; binary: string; version: string }
export interface CphCase {
  id: string; input: string; expected?: string | null; enabled?: boolean;
  timeLimitMs?: number;  // lane 2: per-case override, else the panel's limit
  memoryLimitMb?: number; // lane 1: per-case override; enforced by the Windows Job Object (default since pass #49)
}
export interface CphCaseResult { id: string; verdict: string; stdout: string; stderr: string; time_ms: number; exit_code?: number | null }
export interface CphRunResponse { compile_ok: boolean; compile_log: string; results: CphCaseResult[]; cancelled?: boolean }
export interface CphCompileResponse { compile_ok: boolean; compile_log: string; exit_code: number | null; time_ms: number; cancelled: boolean }

// browser-dev (no Tauri bridge) has no process access at all -> empty list, feature stays hidden.
// pass #129 (attack-surface A5): force=true skips the shell's 60 s detection TTL cache —
// the Settings button's explicit re-scan; the default rides the cache.
export async function cphDetect(force = false): Promise<CphToolchain[]> {
  const inv = await invoke();
  if (!inv) return [];
  try { return (await inv("cph_detect", { force })) as unknown as CphToolchain[]; } catch { return []; }
}

// pass #78: mirror the Settings toolchain override into the shell's execution allowlist
// (cph_set_override). The shell refuses cph_run/cph_compile for any binary it has not
// detected or that was not registered here — so an override MUST be mirrored before the
// first run, and a rejected path surfaces honestly instead of failing at spawn.
export async function cphSetOverride(langKey: string, binary: string): Promise<void> {
  const inv = await invoke();
  if (!inv) return; // plain-browser dev: no shell, no cph_run either
  await inv("cph_set_override", { langKey, binary });
}

export async function cphRun(
  langKey: string, binary: string, source: string, cases: CphCase[], timeLimitMs: number, memoryLimitMb?: number, std?: string,
): Promise<CphRunResponse> {
  const inv = await invoke();
  if (!inv) throw new Error("CPH needs the desktop shell — no local process access in a plain browser.");
  return (await inv("cph_run", {
    req: { langKey, binary, source, cases, timeLimitMs, memoryLimitMb, std: std || null },
  })) as unknown as CphRunResponse;
}

// pass #11: compile-only (explicit Compile / PY3 syntax check) and Stop. Rust keeps one job at a time;
// cphStop flags it and the runner kills the whole process tree.
export async function cphCompile(langKey: string, binary: string, source: string, std?: string): Promise<CphCompileResponse> {
  const inv = await invoke();
  if (!inv) throw new Error("CPH needs the desktop shell — no local process access in a plain browser.");
  return (await inv("cph_compile", { req: { langKey, binary, source, std: std || null } })) as unknown as CphCompileResponse;
}

export async function cphStop(): Promise<boolean> {
  const inv = await invoke();
  if (!inv) return false;
  try { return (await inv("cph_stop", {})) as unknown as boolean; } catch { return false; }
}

// pass #106: step-by-step (Shift+Run). Snapshot fields are snake_case on purpose — same
// convention as the other cph output structs (solve.ts reads them directly).
export interface DebugLocal { name: string; kind: string; value: string }
export interface DebugSnapshot {
  line: number | null;
  function: string | null;
  locals: DebugLocal[];
  locals_truncated: boolean;
  output: string;
  output_truncated: boolean;
  exited: boolean;
  exit_code: number | null;
  /** pass #164 (W11-L06): the session died on the 32 MiB output cap — never paint that as exit 0. */
  overflow?: boolean;
}

export async function debugStart(langKey: string, binary: string, source: string, stdinText: string, std?: string): Promise<DebugSnapshot> {
  const inv = await invoke();
  if (!inv) throw new Error("Step-by-step needs the desktop shell — no local process access in a plain browser.");
  return (await inv("debug_start", {
    req: { langKey, binary, source, stdinText, std: std || null },
  })) as unknown as DebugSnapshot;
}

// pass #130 (He): steps = the slider's count (how many engine steps one click advances);
// 1 stays the exact pre-#130 behavior.
export async function debugStep(kind: "over" | "into" | "out" | "continue", steps = 1): Promise<DebugSnapshot> {
  const inv = await invoke();
  if (!inv) throw new Error("Step-by-step needs the desktop shell — no local process access in a plain browser.");
  return (await inv("debug_step", { kind, steps })) as unknown as DebugSnapshot;
}

export async function debugStop(): Promise<boolean> {
  const inv = await invoke();
  if (!inv) return false;
  try { return (await inv("debug_stop", {})) as unknown as boolean; } catch { return false; }
}

// pass #134 (He: the footnote update dot): one read-only GET of delcc's own GitHub
// latest-release endpoint (Rust-side, pinned host, capped body — see main.rs). Returns
// the JSON text {current, latest, update_available}; browser-dev has no bridge -> null.
export async function updateCheck(): Promise<string | null> {
  const inv = await invoke();
  if (!inv) return null;
  return (await inv("update_check", {})) as unknown as string;
}

// pass #106: window identity (custom title + taskbar/window icon), applied live and on
// launch. reset_icon restores the bundle icon. Plain-browser dev: nothing to retitle.
export async function applyIdentity(title: string | null, icon: { width: number; height: number; rgba: string } | null, resetIcon = false): Promise<void> {
  const inv = await invoke();
  if (!inv) return;
  await inv("identity_apply", { title, icon, resetIcon });
}

// pass #10: installed font families for the Statement font picker ("System font"
// option + Refresh font). Registry harvest lives in src-tauri/src/fonts.rs; a
// plain-browser dev returns [] and the curated list stays, honest-client style.
export async function systemFonts(): Promise<string[]> {
  const inv = await invoke();
  if (!inv) return [];
  try { return (await inv("fonts_list", {})) as unknown as string[]; } catch { return []; }
}

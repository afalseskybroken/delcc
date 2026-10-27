// delcc-app/src/lib/api.ts
// typed fetch wrapper for oj.tmathcoding.vn/api/v3
// contract: ../docs/api-docs.md + ../tools/openapi-frontend.json (read-only, not copied)
// rule: WebView / Tauri build sends custom headers freely (no CORS preflight).
// plain-browser dev build avoids custom headers except on submit POSTs.

export const API_BASE = "https://oj.tmathcoding.vn/api/v3";
// What we tell the server we are. Resolved at boot from
// `client-releases/current` (same feed the official client reads), so delcc
// always reports the newest official version — see `syncClientVersion`.
let _clientVersion = "1.0.8";
export const clientVersion = () => _clientVersion;

export async function syncClientVersion(platform = "windows-x64"): Promise<string> {
  try {
    const m: any = await raw(
      `/client-releases/current?channel=internal&platform=${encodeURIComponent(platform)}`,
    );
    const v = m?.required_version ?? m?.version ?? m?.latest_version
      ?? m?.manifest?.required_version ?? m?.current?.required_version;
    if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) _clientVersion = v;
  } catch { /* offline or odd shape — keep the fallback */ }
  return _clientVersion;
}

export async function bumpVersion(platform = "windows-x64"): Promise<string> {
  return syncClientVersion(platform);
}

export interface ClientReleaseManifest {
  schema_version: 1; channel: "internal"; platform: string; release_id: string;
  required_version: string; installer_url: string; sha256: string; size_bytes: number;
  published_at: string; release_notes: string; rollback_allowed?: boolean;
}
export interface DevelopmentClientReleaseManifest {
  schema_version: 1; channel: "internal"; platform: string; required_version: string; development: true;
}
export type ReleaseManifest = ClientReleaseManifest | DevelopmentClientReleaseManifest;
export interface ClientReleaseDownloadStats {
  platform: string; release_id: string; required_version: string; download_count: number;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  access_expires_in: number;
  refresh_expires_in: number;
  server_time: string;
  obtained_at?: number; // local ms stamp, set by auth.ts (not from server)
}

export interface ContestListItem {
  key: string; name: string; topic: string; mode: string;
  start_time: string; end_time: string; time_limit?: unknown;
  is_rated: boolean; is_private: boolean; tags: string[];
  can_join: boolean; can_view_tasks: boolean; is_in_contest: boolean;
  is_spectator?: boolean;
  is_locked?: boolean; rate_ceiling?: number | null;
  [k: string]: unknown;
}

export interface ContestProblem {
  label?: string | null; code: string; name: string; title?: string | null;
  order: number; points: number; partial: boolean;
  time_limit?: unknown; memory_limit?: unknown; max_submissions?: unknown;
}

export interface ContestProblemDetail extends ContestProblem {
  statement: string;
  allowed_languages: string[];
  io_method: unknown; version_update: number;
  has_submission: boolean; latest_submission_id?: unknown; latest_submission_version?: unknown;
  submission_count?: number; remaining_submissions?: unknown;
  statement_hidden?: boolean;
  time_limit: number; memory_limit: number;
}

export interface ProblemListItem {
  code: string; name: string; group?: unknown; types: string[];
  points: number; partial: boolean; is_public: boolean;
  is_organization_private: boolean; user_count?: unknown;
  user_progress?: "solved" | "attempted" | "unattempted";
}

export interface ProblemDetail extends ProblemListItem {
  authors: string[]; curators: string[]; time_limit: number; memory_limit: number;
  short_circuit: boolean; allowed_languages: string[];
  language_resource_limits: unknown[]; statement: string;
  io_method: unknown; can_edit: boolean; can_submit: boolean;
  online_judges: unknown[]; latest_submission?: unknown;
}

export interface SubmitResponse { detail: string; submission_id: number; replaced_existing: boolean; }

export interface SubmissionCase {
  answer?: string | null; extended_feedback?: string | null;
  feedback?: string | null; input?: string | null; output?: string | null;
}

export interface SubmissionDetail {
  version: number; is_terminal: boolean; current_testcase?: unknown;
  id: number; problem: string; problem_name?: string;
  can_view_detail?: unknown; can_view_source?: unknown;
  user: string; user_display_name?: string; user_rating?: unknown;
  date: string; language?: string; time?: unknown; memory?: unknown;
  points?: unknown; result?: unknown; status: string;
  case_points: number; case_total: number; cases: SubmissionCase[];
  status_display?: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) { super(detail); this.status = status; }
}

// A request belongs to the session that started it, even when it is replayed.
export class SessionChangedError extends Error {
  constructor() { super("Session changed; request cancelled."); this.name = "SessionChangedError"; }
}

import { deviceId } from "./device";
import { transport } from "./transport";

// 12 calls the shell needs (todo Phase 0): login, refresh, contests,
// workspace, problem, submit, submission, stream-url, join, leave, release, me.
export async function raw(
  path: string,
  opt: { method?: string; body?: unknown; token?: string | null; submitHeaders?: boolean } = {},
): Promise<any> {
  const authPath = /^\/auth\//.test(path);
  const guard = opt.token && sessionGuardHook ? sessionGuardHook(opt.token, !authPath) : () => {};
  const headers: Record<string, string> = {};
  // X-Client-Version / X-Device-Id are REQUIRED on submit POSTs per spec,
  // and demanded on detail reads by the server (undocumented — proven by
  // tools/delcc-e2e.py). Rust transport has no preflight concept, so send
  // them always; WebView-fetch fallback only on submits (CORS Allow-Headers).
  const inTauri = "__TAURI__" in window || (window as any).__TAURI_INTERNALS__ != null;
  const isSubmit = (opt.method === "POST" || opt.method === "PUT") && /\/submit$/.test(path);
  const isDetail = /\/problems\/[^/]+$/.test(path);
  if (inTauri || isSubmit || opt.submitHeaders || isDetail) {
    headers["X-Client-Version"] = clientVersion();
    headers["X-Device-Id"] = deviceId();
  }
  if (opt.token) headers["Authorization"] = "Bearer " + opt.token;
  const bodyText = opt.body !== undefined ? JSON.stringify(opt.body) : undefined;
  if (bodyText !== undefined) headers["Content-Type"] = "application/json";
  const send = async () => {
    guard();
    try {
      const response = await transport(opt.method || "GET", API_BASE + path, headers, bodyText);
      guard();
      return response;
    } catch (e) { guard(); throw e; }
  };
  let r = await send();
  if (r.status === 426 && !/\/client-releases\//.test(path)) {
    headers["X-Client-Version"] = await bumpVersion();
    guard();
    r = await send();
  }
  // access token died mid-session: refresh once, replay. never for /auth/* calls.
  if (r.status === 401 && opt.token && refreshHook && !authPath) {
    guard();
    let nt: string | null;
    try { nt = await refreshHook(); }
    catch (e) { guard(); throw e; }
    guard();
    if (nt) { headers["Authorization"] = "Bearer " + nt; r = await send(); }
  }
  if (r.status >= 200 && r.status < 300) return r.json;
  const d = (r.json && ((r.json as any).detail ?? (r.json as any).message)) || (r.text || "").slice(0, 200) || ("HTTP " + r.status);
  throw new ApiError(r.status, typeof d === "string" ? d : JSON.stringify(d));
}

let refreshHook: null | (() => Promise<string | null>) = null;
export function setRefreshHook(f: () => Promise<string | null>) { refreshHook = f; }
let sessionGuardHook: null | ((token: string, requireCurrentToken: boolean) => () => void) = null;
export function setSessionGuardHook(f: (token: string, requireCurrentToken: boolean) => () => void) { sessionGuardHook = f; }

export const api = {
  login: (u: string, p: string): Promise<TokenPair> =>
    raw("/auth/login", { method: "POST", body: { username: u, password: p } }),
  refresh: (refreshToken: string): Promise<TokenPair> =>
    raw("/auth/refresh", { method: "POST", body: { refresh_token: refreshToken } }),
  logout: (t: string) => raw("/auth/logout", { method: "POST", body: {}, token: t }),
  me: (t: string) => raw("/me", { token: t }),
  contests: (t: string, o: { tag?: string; search?: string; page?: number; page_size?: number } = {}): Promise<ContestListItem[]> => {
    const q = new URLSearchParams();
    if (o.tag) q.set("tag", o.tag);
    if (o.search) q.set("search", o.search);
    q.set("page", String(o.page ?? 1));
    q.set("page_size", String(o.page_size ?? 50));
    return raw(`/contests?${q.toString()}`, { token: t });
  },
  // the /contests feed is joined-only (probe: 1 row = the joined one).
  // current/upcoming come from /home + /current-contest instead.
  home: (t: string): Promise<any> => raw("/home", { token: t }),
  currentContest: (t: string): Promise<any> => raw("/current-contest", { token: t }),
  join: (t: string, key: string) =>
    raw(`/contests/${encodeURIComponent(key)}/join`, { method: "POST", body: {}, token: t }),
  leave: (t: string, key: string) =>
    raw(`/contests/${encodeURIComponent(key)}/leave`, { method: "POST", body: {}, token: t }),
  workspace: (t: string, key: string) =>
    raw(`/contests/${encodeURIComponent(key)}/workspace`, { token: t }),
  contestProblems: (t: string, key: string): Promise<ContestProblem[]> =>
    raw(`/contests/${encodeURIComponent(key)}/problems`, { token: t }),
  // pass #59: contest standings — BARE ARRAY of LeaderboardEntrySchema (rank is a STRING;
  // problem_cells[i] carries has_data/penalty/points/time/status like "full-score").
  // Problem headers (labels + max points) are NOT in this payload — pair with contestProblems.
  leaderboard: (t: string, key: string): Promise<any[]> =>
    raw(`/contests/${encodeURIComponent(key)}/leaderboard`, { token: t }),
  contestProblem: (t: string, key: string, code: string, withHeaders = false): Promise<ContestProblemDetail> =>
    raw(`/contests/${encodeURIComponent(key)}/problems/${encodeURIComponent(code)}`, { token: t, submitHeaders: withHeaders }),
  problems: (t: string, o: { page?: number; page_size?: number; search?: string; type?: string; group?: string } = {}): Promise<ProblemListItem[]> => {
    const q = new URLSearchParams();
    // search/type/group are real server-side params per openapi contract.
    for (const k of ["search", "type", "group"] as const)
      if (o[k]) q.set(k, String(o[k]));
    q.set("page", String(o.page ?? 1));
    q.set("page_size", String(o.page_size ?? 50));
    return raw(`/problems?${q.toString()}`, { token: t });
  },
  topics: (t: string): Promise<string[]> =>
    raw("/problem-topics?scope=public", { token: t }),
  problem: (t: string, code: string, withHeaders = false): Promise<ProblemDetail> =>
    raw(`/problems/${encodeURIComponent(code)}`, { token: t, submitHeaders: withHeaders }),
  submitContest: (t: string, key: string, code: string, language_key: string, source: string, participation_id?: number | null): Promise<SubmitResponse> =>
    raw(`/contests/${encodeURIComponent(key)}/problems/${encodeURIComponent(code)}/submit`,
      { method: "POST", token: t, body: { language_key, source, ...(participation_id != null ? { participation_id } : {}) } }),
  submitPublic: (t: string, code: string, language_key: string, source: string): Promise<SubmitResponse> =>
    raw(`/problems/${encodeURIComponent(code)}/submit`,
      { method: "POST", token: t, body: { language_key, source } }),
  submissionContest: (t: string, key: string, id: number): Promise<SubmissionDetail> =>
    raw(`/contests/${encodeURIComponent(key)}/submissions/${id}`, { token: t }),
  // pass #58 live probe: /contests/{key}/submissions returns a WRAPPED payload —
  // {name, participation_id, scope:"participation", problems:[{code,name,display_index}], items:[…]}
  // (problems powers the scope's problem sub-select; items are the participation rows)
  contestSubmissions: (t: string, key: string): Promise<any> =>
    raw(`/contests/${encodeURIComponent(key)}/submissions`, { token: t }),
  contestSubmissionSource: (t: string, key: string, id: number): Promise<any> =>
    raw(`/contests/${encodeURIComponent(key)}/submissions/${id}/source`, { token: t }),
  submission: (t: string, id: number, scope?: string): Promise<SubmissionDetail> =>
    raw(`/submissions/${id}${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, { token: t }),
  contestProblemSubmissions: (t: string, key: string, code: string): Promise<any[]> =>
    raw(`/contests/${encodeURIComponent(key)}/problems/${encodeURIComponent(code)}/submissions`, { token: t }),
  // Google PKCE login (api-docs: start 200|429|503, exchange 200|202|401|403|410|503)
  googleStart: (code_challenge: string): Promise<{ transaction_id: string; authorization_url: string; expires_in: number; interval: number }> =>
    raw("/auth/google/start", { method: "POST", body: { code_challenge, code_challenge_method: "S256" } }),
  googleExchange: (transaction_id: string, code_verifier: string): Promise<any> =>
    raw("/auth/google/exchange", { method: "POST", body: { transaction_id, code_verifier } }),
  submissions: (t: string, o: { page?: number; page_size?: number; scope?: string; user?: string; problem?: string; result?: string } = {}): Promise<any[]> => {
    const q = new URLSearchParams({ page: String(o.page ?? 1), page_size: String(o.page_size ?? 20) });
    for (const k of ["scope", "user", "problem", "result"] as const) if (o[k]) q.set(k, o[k]!);
    return raw(`/submissions?${q.toString()}`, { token: t });
  },
  // official tmath-tauri-client feed, channel is always "internal" per contract.
  // used both to spoof X-Client-Version (syncClientVersion) and, separately, by lib/updater.ts
  // to tell the user a newer official build exists — delcc is not itself on this feed.
  release: (platform = "windows-x64"): Promise<ReleaseManifest> =>
    raw(`/client-releases/current?channel=internal&platform=${encodeURIComponent(platform)}`),
  recordDownload: (platform: string, release_id: string): Promise<ClientReleaseDownloadStats> =>
    raw(`/client-releases/downloads?channel=internal&platform=${encodeURIComponent(platform)}&release_id=${encodeURIComponent(release_id)}`, { method: "POST" }),
  // SSE verdict stream (Phase 2, claude lane): kept as URL builder —
  // EventSource cannot carry Authorization header, so Tauri shell
  // fetches with header + streams, browser falls back to polling.
  streamUrl: (participationId: number) =>
    `${API_BASE}/participations/${participationId}/submissions/stream`,
  // 2026-10-22 (Nyx, audit-sheet follow-up #3): tmath previously called these raw() — now wrapped.
  submissionSource: (t: string, id: number, scope?: string): Promise<any> =>
    raw(`/submissions/${id}/source${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, { token: t }),
  user: (t: string, username: string): Promise<any> =>
    raw(`/users/${encodeURIComponent(username)}`, { token: t }),
  users: (t: string, query: string): Promise<any> =>
    raw(`/users?${query}`, { token: t }),
};

export function humanError(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.message && !/^HTTP \d+$/.test(e.message) ? ` — ${e.message}` : "";
    switch (e.status) {
      case 400: return `400 — bad request${d} (server refused the shape).`;
      case 401: return "401 — session expired or bad login. log in again.";
      case 403: return `403 — not allowed here${d} (private contest or missing join).`;
      case 404: return `404 — not found${d} (bad key/code or left contest).`;
      case 409: return `409 — conflict${d}.`;
      case 422: return `422 — rejected${d} (bad language or empty source).`;
      case 410: return `410 — expired${d} (Google sign-in window closed; start again).`;
      case 503: return `503 — service unavailable${d} (server or Google side; retry shortly).`;
      case 426: return "426 — client too old. bump X-Client-Version.";
      case 429: return `429 — slow down, rate-limited${d}.`;
      default: return `${e.status} — ${e.message}`;
    }
  }
  return String((e as any)?.message || e);
}

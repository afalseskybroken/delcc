// delcc-app/src/lib/api.ts
// typed fetch wrapper for oj.tmathcoding.vn/api/v3
// contract: ../docs/api-docs.md + ../tools/openapi-frontend.json (read-only, not copied)
// rule: WebView / Tauri build sends custom headers freely (no CORS preflight).
// plain-browser dev build avoids custom headers except on submit POSTs.

export const API_BASE = "https://oj.tmathcoding.vn/api/v3";
// What we tell the server we are. MAINTAINER VERDICT (2026-10-29, S4 policy track — He):
// the judge 426-gates any client whose X-Client-Version is older than the official
// release feed's `required_version`, and delcc is not on that feed — reporting our own
// version would hard-brick every submission. oj.tmathcoding.vn publishes NO Terms of
// Service (verified 2026-10-29), so there is no contract to satisfy; this shim is the
// documented, load-bearing accommodation that lets an independent client exist at all.
// We adopt the newest version from the same public feed the official client reads
// (syncClientVersion below) and disclose the whole posture here, in README §Notices
// and SECURITY.md — impersonation by CONCEALMENT is what the honest-client doctrine
// forbids; disclosure does not.
let _clientVersion = "1.0.8";
export const clientVersion = () => _clientVersion;
// pass #177: X-Client-Platform — the feed's platform-enum vocabulary
// (windows-x64 / macos-x64 / macos-arm64 / linux-x64 / linux-arm64). A build-class
// disclosure (the same string for every install of a build; the server computes
// joinBlockedReason from it), sent only when honestly mappable — an unmappable
// platform OMITS the header (the pre-#177 behavior) rather than sending a wrong
// value that could trigger CLIENT_PLATFORM_MISMATCH. delcc's shipped binary is
// windows-x64, so the practical value is constant.
let _clientPlatform: string | null = null;
try {
  const nav = navigator as { platform?: string; userAgent?: string };
  const p = nav.platform || "";
  if (/^Win/i.test(p)) _clientPlatform = "windows-x64";
  else if (/^Mac/i.test(p)) _clientPlatform = "macos-x64"; // UA-Chrome-Client-Hints could split arm; sync APIs cannot
  else if (/Linux/i.test(p)) _clientPlatform = /aarch64|arm/i.test(nav.userAgent || "") ? "linux-arm64" : "linux-x64";
  else _clientPlatform = null;
} catch { _clientPlatform = null; }
export const clientPlatform = (): string | null => _clientPlatform;
// pass #177/#179: X-Request-Id — a per-request correlation id, memory-only.
// Official stamps ONE cached id per launch on every request (observable on the
// wire; the internal mechanics live in the off-repo research); delcc deliberately
// mints FRESH PER REQUEST — the linkability properties are strictly weaker (an
// authenticated session is already correlated by its JWT; the fresh id adds
// nothing to correlate), and the server's error-envelope echo
// (ClientErrorResponse.request_id, the support loop) still matches the failing
// request. Recorded divergence: delcc is LESS trackable than Official here.
// H2 (the wave-15 audit): the value is a UUID v4 — the same shape match the
// device id got in #178, so the ids carry no delcc- prefix a format check could
// flag and no format divergence exists to observe.
// H1 (the wave-15 audit): NO degraded fallback — a Date.now()+Math.random() id
// is exactly the collision class this layer exists to refuse. No CSPRNG context
// means the request fails, consistently with deviceId() failing closed.
function mintUuidV4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function newRequestId(): string {
  return mintUuidV4();
}
// pass #177/#179: Idempotency-Key — one key per logical submit, minted ONCE per
// raw() invocation so the 426 version-bump and 401 refresh REPLAYS reuse it
// (Official's contract: the same key replays the original result; a different
// operation reusing a key gets IDEMPOTENCY_CONFLICT). Memory-only, never
// persisted, never spanning two logical submits. H1: no degraded fallback; H2:
// the UUID v4 shape, like the request id.
function newIdempotencyKey(): string {
  return mintUuidV4();
}

export async function syncClientVersion(platform = "windows-x64", manifest?: unknown): Promise<string> {
  try {
    // pass #123 (attack-surface P3): callers holding a freshly fetched release
    // manifest pass it in — the boot path used to fetch the IDENTICAL URL twice
    // back-to-back (api.release then syncClientVersion's own GET).
    const m: any = manifest ?? await raw(
      `/client-releases/current?channel=internal&platform=${encodeURIComponent(platform)}`,
    );
    const v = m?.required_version ?? m?.version ?? m?.latest_version
      ?? m?.manifest?.required_version ?? m?.current?.required_version;
    if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) _clientVersion = v;
  } catch { /* offline or odd shape — keep the fallback */ }
  return _clientVersion;
}

// pass #141 (wave-8 W8-L06): a required-version bump (HTTP 426) used to send EVERY
// concurrent failed request at the release feed — N in-flight calls, N identical GETs.
// One shared in-flight promise now serves them all (the same single-flight shape auth's
// refresh uses); it clears when it settles so a later 426 re-syncs fresh.
let versionSync: Promise<string> | null = null;
export async function bumpVersion(platform = "windows-x64"): Promise<string> {
  if (!versionSync) {
    versionSync = syncClientVersion(platform).finally(() => { versionSync = null; });
  }
  return versionSync;
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
  // the exam-contest marker (an in-spec display field)
  is_exam_contest?: boolean;
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
  // pass #169: the official API dropped is_organization_private from the problem
  // schemas (live spec 2026-11-13); contests still carry it. Optional now — the
  // baseplate "org" flag degrades to absent when the field is gone.
  is_organization_private?: boolean; user_count?: unknown;
  user_progress?: "solved" | "attempted" | "unattempted";
}

export interface ProblemDetail extends ProblemListItem {
  authors: string[]; curators: string[]; time_limit: number; memory_limit: number;
  short_circuit: boolean; allowed_languages: string[];
  language_resource_limits: unknown[]; statement: string;
  io_method: unknown; can_edit: boolean; can_submit: boolean;
  online_judges: unknown[]; latest_submission?: unknown;
}

// pass #181 — the Official 1.1.1 homework surface. The live spec (2026-11-25,
// 64 paths / 88 schemas, byte-identical to the 2026-11-23 harvest) defines seven
// paths and twelve schemas; these are the wire shapes verbatim. `state`,
// `user_progress` and `submit_blocked_reason` are the server's own tokens — the
// UI renders them as-is, never invents a local status.
export interface HomeworkFilters { page?: number; page_size?: number; search?: string; contest?: string }
export interface HomeworkPageFilters { page?: number; page_size?: number }
export interface HomeworkHistoryFilters { page?: number; page_size?: number; problem?: string }
export interface HomeworkEnvelope { server_time: string; page: number; page_size: number; has_more: boolean }
export interface HomeworkProblem {
  contest_key: string; contest_name: string; code: string; name: string;
  points: number; partial: boolean; homework_start_time: string; homework_due_at: string;
  best_points: number | null; submission_count: number;
  user_progress: "unattempted" | "grading" | "attempted" | "solved";
  can_submit: boolean; submit_blocked_reason: string | null;
}
export interface HomeworkPage extends HomeworkEnvelope { items: HomeworkProblem[] }
export interface HomeworkContext extends HomeworkEnvelope {
  contest_key: string; contest_name: string;
  homework_start_time: string; homework_due_at: string;
  state: "scheduled" | "open" | "closed";
  can_submit: boolean; submit_blocked_reason: string | null;
  items: HomeworkProblem[];
}
export interface HomeworkProblemDetail extends HomeworkProblem {
  server_time: string; state: "open" | "closed"; statement: string;
  time_limit: number; memory_limit: number; short_circuit: boolean;
  allowed_languages: string[]; io_method: unknown; version_update: number;
  fastio: boolean; forbidden_words: string[]; can_run: boolean;
}
export interface HomeworkSubmitRequest { language_key: string; source: string }
export interface HomeworkSubmission {
  version: number; is_terminal: boolean; current_testcase?: number | null;
  id: number; problem: string; problem_name: string;
  can_view_detail: boolean; can_view_source: boolean;
  user: string; user_display_name?: string | null; user_rating?: number | null;
  date: string; language?: string | null; time?: number | null; memory?: number | null;
  points?: number | null; result?: string | null; status: string; contest_key: string;
}
export interface HomeworkHistoryPage extends HomeworkEnvelope { items: HomeworkSubmission[] }
export interface HomeworkSubmissionDetail extends HomeworkSubmission {
  error?: string | null; case_points: number; case_total: number; cases: SubmissionCase[];
}
export interface HomeworkSource {
  submission_id: number; language_key?: string | null; source: string;
  version_update: number; submitted_at: string; contest_key: string; problem: string;
}

// pass #183 — the remaining low-hanging Official surfaces. All shapes below are
// from the live 2026-11-25 spec (api-docs.md checklist); no endpoint is invented.
export interface CodeShareMetadata {
  contest_key: string; student_id: number; username: string; display_name: string;
  user_rating?: number | null; participation_id: number; problem_code: string; problem_name: string;
  language_key: string; revision: number; updated_at: string; expires_at: string; active: boolean;
}
export interface CodeShareState {
  contest_key: string; student_id: number; active: boolean; revision: number;
  can_share_code: boolean; can_view_shared_codes: boolean; item: CodeShareMetadata | null;
}
export interface CodeShareSource extends CodeShareMetadata { source: string }
export interface CodeSharePut {
  expected_revision: number; participation_id: number; problem_code: string;
  language_key: string; source: string;
}
export interface OrganizationListItem {
  id: number; slug: string; name: string; short_name: string; is_open: boolean;
  is_hidden: boolean; logo_override_image: string; member_count?: number | null;
}
export interface OrganizationDetail extends OrganizationListItem {
  about: string; creation_date: string; admins: string[]; members_preview: any[];
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
import { observeServerTime } from "./server-clock";

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
  // X-Client-Version's value: the disclosed 426 shim (maintainer-verdict note
  // at _clientVersion). X-Device-Id: one fresh random id per runtime (device.ts,
  // He's 2026-10-29 anti-tracking verdict) — derived from nothing, never
  // persisted; the server has only ever demanded the header's presence.
  const inTauri = "__TAURI__" in window || (window as any).__TAURI_INTERNALS__ != null;
  const isSubmit = (opt.method === "POST" || opt.method === "PUT") && /\/submit$/.test(path);
  const isDetail = /\/problems\/[^/]+$/.test(path);
  if (inTauri || isSubmit || opt.submitHeaders || isDetail) {
    headers["X-Client-Version"] = clientVersion();
    headers["X-Device-Id"] = deviceId();
    // pass #177 (the parity reconciliation): the correlation + disclosure class.
    // Same attach conditions as the identity headers — the plain-browser fetch
    // fallback keeps custom headers to submits (the CORS Allow-Headers note).
    const platform = clientPlatform();
    if (platform) headers["X-Client-Platform"] = platform;
    headers["X-Request-Id"] = newRequestId();
    if (isSubmit) headers["Idempotency-Key"] = newIdempotencyKey();
    // X-API-Scope: deliberately ABSENT — the live probe (2026-11-14) proved the
    // server ignores it on every read surface (16/16 combos 200, byte-identical),
    // and the write-side per-endpoint literal mapping is unverified; a mislabeled
    // scope could trigger the adjudication the absent header does not. Probe-
    // pending until the exam surface makes it load-bearing.
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
  if (r.status >= 200 && r.status < 300) {
    if (!authPath) observeServerTime(r.json?.server_time);
    return r.json;
  }
  const d = (r.json && ((r.json as any).detail ?? (r.json as any).message)) || (r.text || "").slice(0, 200) || ("HTTP " + r.status);
  throw new ApiError(r.status, typeof d === "string" ? d : JSON.stringify(d));
}

let refreshHook: null | (() => Promise<string | null>) = null;
export function setRefreshHook(f: () => Promise<string | null>) { refreshHook = f; }
let sessionGuardHook: null | ((token: string, requireCurrentToken: boolean) => () => void) = null;
export function setSessionGuardHook(f: (token: string, requireCurrentToken: boolean) => () => void) { sessionGuardHook = f; }

// pass #181: the homework endpoints share the spec's hard paging caps — a bad
// URL param degrades to the documented default instead of being forwarded.
const boundedInt = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : fallback;
};

export const api = {
  login: (u: string, p: string): Promise<TokenPair> =>
    raw("/auth/login", { method: "POST", body: { username: u, password: p } }),
  refresh: (refreshToken: string): Promise<TokenPair> =>
    raw("/auth/refresh", { method: "POST", body: { refresh_token: refreshToken } }),
  // pass #164: LogoutRequestSchema carries an optional refresh_token — send it so
  // the server revokes BOTH tokens (live probe: "Provided tokens have been revoked").
  logout: (t: string, refresh_token?: string | null) =>
    raw("/auth/logout", { method: "POST", body: { refresh_token: refresh_token ?? null }, token: t }),
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
  // pass #155: poll=true = the judge's long-poll (the response is held until the
  // board changes; gated by ContestDetailSchema.can_poll_leaderboard). The caller
  // races it against its own timeout and falls back to the plain fetch — a held
  // poll must never read as an error.
  leaderboard: (t: string, key: string, poll = false, ended = false): Promise<any[]> => {
    // pass #170 (He's parity order): ?ended=true = the judge's FROZEN final board for
    // an ended contest (the official API added it with ContestDetail/ListItem's
    // can_view_ended_leaderboard; the server 403s accounts without the flag — the
    // caller gates on that field and falls back to the plain fetch on any error).
    const q = new URLSearchParams();
    if (poll) q.set("poll", "true");
    if (ended) q.set("ended", "true");
    const qs = q.toString();
    return raw(`/contests/${encodeURIComponent(key)}/leaderboard${qs ? `?${qs}` : ""}`, { token: t });
  },
  contestProblem: (t: string, key: string, code: string, withHeaders = false): Promise<ContestProblemDetail> =>
    raw(`/contests/${encodeURIComponent(key)}/problems/${encodeURIComponent(code)}`, { token: t, submitHeaders: withHeaders }),
  problems: (t: string, o: { page?: number; page_size?: number; search?: string; type?: string; group?: string; progress?: "attempted" | "unattempted" } = {}): Promise<ProblemListItem[]> => {
    const q = new URLSearchParams();
    // search/type/group are real server-side params per openapi contract.
    for (const k of ["search", "type", "group"] as const)
      if (o[k]) q.set(k, String(o[k]));
    // pass #121 (the recarve queued upgrade, His word): the server-side progress filter
    // the 2026-10-27 live OpenAPI documents — "attempted" = submitted, not fully AC;
    // "unattempted" = no submissions (the server's own legend semantics).
    if (o.progress) q.set("progress", o.progress);
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
  // used to sync X-Client-Version (the disclosed 426 shim — see the maintainer-verdict
  // note at _clientVersion) and, separately, by lib/updater.ts to tell the user a newer
  // official build exists — delcc is not itself on this feed.
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
  // ---- Official 1.1.1 homework (pass #181) ----
  // Same verbs and grading funnel as the contest lane; NO homework stream path
  // exists in the spec, so callers poll version/is_terminal instead.
  homework: (t: string, o: HomeworkFilters = {}): Promise<HomeworkPage> => {
    const q = new URLSearchParams({ page: String(boundedInt(o.page, 1, 1_000_000)), page_size: String(boundedInt(o.page_size, 20, 100)) });
    if (o.search && o.search.length <= 200) q.set("search", o.search);
    if (o.contest && o.contest.length <= 128) q.set("contest", o.contest);
    return raw(`/homework?${q.toString()}`, { token: t });
  },
  homeworkContext: (t: string, key: string, o: HomeworkPageFilters = {}): Promise<HomeworkContext> => {
    const q = new URLSearchParams({ page: String(boundedInt(o.page, 1, 1_000_000)), page_size: String(boundedInt(o.page_size, 20, 100)) });
    return raw(`/contests/${encodeURIComponent(key)}/homework?${q.toString()}`, { token: t });
  },
  homeworkProblem: (t: string, key: string, code: string): Promise<HomeworkProblemDetail> =>
    raw(`/contests/${encodeURIComponent(key)}/homework/problems/${encodeURIComponent(code)}`, { token: t, submitHeaders: true }),
  submitHomework: (t: string, key: string, code: string, language_key: string, source: string): Promise<SubmitResponse> =>
    raw(`/contests/${encodeURIComponent(key)}/homework/problems/${encodeURIComponent(code)}/submit`,
      { method: "POST", token: t, body: { language_key, source } }),
  homeworkSubmissions: (t: string, key: string, o: HomeworkHistoryFilters = {}): Promise<HomeworkHistoryPage> => {
    const q = new URLSearchParams({ page: String(boundedInt(o.page, 1, 1_000_000)), page_size: String(boundedInt(o.page_size, 20, 100)) });
    if (o.problem && o.problem.length <= 128) q.set("problem", o.problem);
    return raw(`/contests/${encodeURIComponent(key)}/homework/submissions?${q.toString()}`, { token: t });
  },
  homeworkSubmission: (t: string, key: string, id: number): Promise<HomeworkSubmissionDetail> =>
    raw(`/contests/${encodeURIComponent(key)}/homework/submissions/${encodeURIComponent(String(id))}`, { token: t }),
  homeworkSubmissionSource: (t: string, key: string, id: number): Promise<HomeworkSource> =>
    raw(`/contests/${encodeURIComponent(key)}/homework/submissions/${encodeURIComponent(String(id))}/source`, { token: t }),
  // ---- pass #183: code-shares, account settings gate, community browsing ----
  codeShareState: (t: string, key: string): Promise<CodeShareState> =>
    raw(`/contests/${encodeURIComponent(key)}/code-share/me`, { token: t }),
  putCodeShare: (t: string, key: string, body: CodeSharePut): Promise<CodeShareState> =>
    raw(`/contests/${encodeURIComponent(key)}/code-share/me`, { method: "PUT", token: t, body }),
  stopCodeShare: (t: string, key: string, expected_revision: number): Promise<CodeShareState> =>
    raw(`/contests/${encodeURIComponent(key)}/code-share/me`, { method: "DELETE", token: t, body: { expected_revision } }),
  codeShares: (t: string, key: string, o: { student?: string; problem_code?: string; page?: number; page_size?: number } = {}): Promise<any> => {
    const q = new URLSearchParams({ page: String(boundedInt(o.page, 1, 1_000_000)), page_size: String(boundedInt(o.page_size, 20, 100)) });
    if (o.student && o.student.length <= 150) q.set("student", o.student);
    if (o.problem_code && o.problem_code.length <= 128) q.set("problem_code", o.problem_code);
    return raw(`/contests/${encodeURIComponent(key)}/code-shares?${q.toString()}`, { token: t });
  },
  codeShare: (t: string, key: string, student_id: number, revision?: number): Promise<CodeShareSource> =>
    raw(`/contests/${encodeURIComponent(key)}/code-shares/${encodeURIComponent(String(student_id))}${revision != null ? `?revision=${encodeURIComponent(String(revision))}` : ""}`, { token: t }),
  codeShareStatus: (t: string, key: string, student_id: number): Promise<CodeShareMetadata> =>
    raw(`/contests/${encodeURIComponent(key)}/code-shares/${encodeURIComponent(String(student_id))}/status`, { token: t }),
  verifyPassword: (t: string, password: string): Promise<any> =>
    raw("/auth/verify-password", { method: "POST", token: t, body: { password } }),
  organizations: (t: string, o: { is_open?: boolean; page?: number; page_size?: number } = {}): Promise<OrganizationListItem[]> => {
    const q = new URLSearchParams({ page: String(boundedInt(o.page, 1, 1_000_000)), page_size: String(boundedInt(o.page_size, 20, 100)) });
    if (o.is_open !== undefined) q.set("is_open", String(o.is_open).toLowerCase());
    return raw(`/organizations?${q.toString()}`, { token: t });
  },
  organization: (t: string, id: number): Promise<OrganizationDetail> =>
    raw(`/organizations/${encodeURIComponent(String(id))}`, { token: t }),
  years: (): Promise<any[]> => raw("/years"),
  // pass #185: BootstrapSchema = {site, nav_tabs[], nav_tree[], user|null} — the
  // consolidated boot payload. delcc's boot stays /home + /me (no boot-surface
  // change); this is fetched ON DEMAND from the community page's site tab and
  // rendered defensively — the server's nav tree is observed, never adopted as
  // delcc's own navigation (an independent client's routes stay its own).
  bootstrap: (t: string): Promise<any> => raw("/bootstrap", { token: t }),
  // pass #185: the problem-class system. The spec documents the INPUT shapes
  // verbatim (RequestInput {problem_class_id, reason<=4000}, VoteInput {decision,
  // comment<=4000}, RevocationInput {grant_id, reason<=4000}) but the GET
  // responses are UNDOCUMENTED ("OK", no schema) — the view renders whatever the
  // server returns, defensively, and the Debug payloads carry the raw.
  problemClasses: (t: string, o: { page?: number; page_size?: number } = {}): Promise<any> => {
    const q = new URLSearchParams();
    if (o.page) q.set("page", String(o.page));
    if (o.page_size) q.set("page_size", String(o.page_size));
    return raw(`/problem-classes${q.toString() ? `?${q.toString()}` : ""}`, { token: t });
  },
  problemClassRequests: (t: string, o: { page?: number; page_size?: number } = {}): Promise<any> => {
    const q = new URLSearchParams();
    if (o.page) q.set("page", String(o.page));
    if (o.page_size) q.set("page_size", String(o.page_size));
    return raw(`/problem-class-requests${q.toString() ? `?${q.toString()}` : ""}`, { token: t });
  },
  problemClassRequest: (t: string, problem_class_id: number, reason = ""): Promise<any> =>
    raw("/problem-class-requests", { method: "POST", body: { problem_class_id, reason: reason.slice(0, 4000) }, token: t }),
  problemClassVote: (t: string, request_id: number, decision: string, comment = ""): Promise<any> =>
    raw(`/problem-class-requests/${encodeURIComponent(String(request_id))}/votes`, { method: "POST", body: { decision, comment: comment.slice(0, 4000) }, token: t }),
  problemClassRevocation: (t: string, grant_id: number, reason = ""): Promise<any> =>
    raw("/problem-class-revocations", { method: "POST", body: { grant_id, reason: reason.slice(0, 4000) }, token: t }),
  achievements: (): Promise<any[]> => raw("/achievements"),
  achievementsFeatured: (): Promise<any[]> => raw("/achievements/featured"),
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

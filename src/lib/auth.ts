// delcc-app/src/lib/auth.ts
// token store + silent refresh + lock/clear.
// stop rule: relaunch keeps session, expiry never surfaces mid-contest.
// Refresh is owned by main.ts boot (single path) — no module-load refresh race.
// Pass #78 (Sonnet S2): persistence moved to the DPAPI secure store (lib/secure.ts);
// the plaintext localStorage copy is migrated on first boot and deleted. No shell
// (plain-browser dev) keeps the documented localStorage fallback.
import { api, SessionChangedError, setRefreshHook, setSessionGuardHook, type TokenPair } from "./api";
import { logError, logInfo } from "./applog";
import { secureDel, secureGet, securePut } from "./secure";
import { shellInvoke } from "./transport";

const LS = "delcc-auth";
const SEC_NAME = "auth";
let cur: TokenPair | null = null;
let refreshTimer: number | null = null;
let refreshing: { version: number; promise: Promise<TokenPair | null> } | null = null;
let version = 0;
let loginVersion: number | null = null;
let retryCount = 0;
const retryDelays = [5_000, 15_000, 30_000];
let listener: ((t: TokenPair | null) => void) | null = null;

// Legacy seed from plaintext localStorage: authoritative ONLY until initAuthStore()
// settles (then the secure store wins and the plaintext copy is deleted); it is the
// permanent store in plain-browser dev, where no shell exists.
try {
  const raw = localStorage.getItem(LS);
  // pass #144 (wave-8 W8-L14): the legacy seed is validated, not trusted — a
  // malformed plaintext copy (a corrupted dev store) must not become a session.
  const parsed = raw ? (JSON.parse(raw) as unknown) : null;
  if (parsed && typeof parsed === "object"
    && typeof (parsed as TokenPair).access_token === "string"
    && typeof (parsed as TokenPair).refresh_token === "string") {
    cur = parsed as TokenPair;
  }
} catch { cur = null; }
let sessionTokens = new Set(cur?.access_token ? [cur.access_token] : []);

// ---- pass #78: DPAPI-backed persistence ----
let storeInit: Promise<void> | null = null;
let useShell: boolean | null = null; // null = probe pending; persists queue behind init
let persistChain: Promise<void> = Promise.resolve();

// Awaited once by the boot path BEFORE any login/refresh; idempotent.
export function initAuthStore(): Promise<void> {
  if (!storeInit) {
    storeInit = (async () => {
      useShell = (await shellInvoke()) != null;
      if (!useShell) return; // dev fallback stays as documented
      const stored = await secureGet(SEC_NAME);
      if (stored) {
        try { cur = JSON.parse(stored) as TokenPair; } catch { cur = null; }
      } else if (cur) {
        // migrate the legacy plaintext copy, then delete it — one boot, no ceremony
        if (await securePut(SEC_NAME, JSON.stringify(cur))) {
          try { localStorage.removeItem(LS); } catch { /* ignore */ }
          logInfo("auth: token store migrated to the DPAPI secure store");
        }
      }
      if (cur?.access_token) sessionTokens = new Set([cur.access_token]);
    })();
  }
  return storeInit;
}

// pass #144 (wave-8 W8-L13): persist returns the LINK's outcome — true = the token
// (or its deletion) is durably on disk. The chain itself still never rejects
// (persistence must never break auth), but logout can now AWAIT the deletion and
// surface an incomplete one instead of leaving it a log entry.
function persist(t: TokenPair | null): Promise<boolean> {
  // serialized: concurrent saves (a login racing a refresh) must land in call order
  const done = persistChain.then(async (): Promise<boolean> => {
    if (useShell === null) await initAuthStore(); // a persist can never outrun the probe
    if (useShell) {
      if (t) {
        const ok = await securePut(SEC_NAME, JSON.stringify(t));
        if (!ok) logError("auth: secure store write failed — session stays memory-only this boot");
        try { localStorage.removeItem(LS); } catch { /* ignore */ }
        return ok;
      }
      const del = await secureDel(SEC_NAME);
      if (!del) logError("auth: secure deletion failed — the DPAPI blob is still on disk");
      try { localStorage.removeItem(LS); } catch { /* ignore */ }
      return del;
    }
    try {
      if (t) localStorage.setItem(LS, JSON.stringify(t));
      else localStorage.removeItem(LS);
      return true;
    } catch { return false; /* private mode — session only */ }
  });
  persistChain = done.then(() => {}, () => {}); // the queue keeps flowing, never rejecting
  return done;
}

// profiles persist the rotated token through this (refresh tokens rotate; a stale copy = forced re-login).
export function onTokenChange(f: (t: TokenPair | null) => void) { listener = f; }

// pass #142 (wave-8 W8-05): the save KIND is visible while the listener runs. login()
// and seed() mark their save FRESH — a fresh token belongs to NO profile until identity
// binding completes; silentRefresh()/logout() mark REFRESH (an already-bound session's
// rotation belongs to its slot). The tmath profile listener persists only REFRESH saves,
// so a fresh login can no longer write account B's token into the currently-active
// unlocked profile A (the audit's cross-profile contamination — He's documented
// burner+main pattern with one locked slot).
export type SaveKind = "fresh" | "refresh" | null;
let saveKind: SaveKind = null;
export function currentSaveKind(): SaveKind { return saveKind; }

function save(t: TokenPair | null, kind: Exclude<SaveKind, null>): Promise<boolean> {
  if (t) {
    // pass #141 (wave-8 W8-L05): the pair's timing fields are server JSON. A
    // nonnumeric/absurd access_expires_in used to ride straight into schedule() —
    // `NaN * 1000` made the refresh delay NaN, and setTimeout(NaN) fires at 0: a tight
    // refresh loop against the judge. Obtained_at must be a real timestamp too (the
    // countdown anchors on it). Coerced once, at the single save() funnel.
    const fix: Partial<TokenPair> = {};
    if (t.obtained_at == null || !Number.isFinite(Number(t.obtained_at))) fix.obtained_at = Date.now();
    const exp = Number(t.access_expires_in);
    if (!Number.isFinite(exp) || exp <= 0) fix.access_expires_in = 3600;
    else if (exp > 604_800) fix.access_expires_in = 604_800; // a week caps the timer math
    if (Object.keys(fix).length) t = { ...t, ...fix };
  }
  cur = t;
  if (t) sessionTokens.add(t.access_token);
  const done = persist(t);
  saveKind = kind;
  try { listener?.(t); } catch { /* listener must never break auth */ } finally { saveKind = null; }
  return done;
}

function clearTimer() {
  if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null; }
}

function schedule() {
  clearTimer();
  retryCount = 0;
  if (!cur) return;
  // refresh 60s before access expiry, counted from when it was issued; floor 5s.
  const left = (cur.obtained_at ?? Date.now()) + cur.access_expires_in * 1000 - Date.now();
  refreshTimer = window.setTimeout(() => { refreshTimer = null; void silentRefresh().catch(() => {}); }, Math.max(5_000, left - 60_000));
}

function retryLater() {
  clearTimer();
  if (!cur?.refresh_token || retryCount >= retryDelays.length) return;
  refreshTimer = window.setTimeout(() => { refreshTimer = null; void silentRefresh().catch(() => {}); }, retryDelays[retryCount++]);
}

function newIntent() {
  ++version;
  loginVersion = null;
  clearTimer();
  retryCount = 0;
  sessionTokens = new Set(cur?.access_token ? [cur.access_token] : []);
  return version;
}

function assertCurrent(expected: number, signal?: AbortSignal) {
  if (version !== expected || signal?.aborted) throw new SessionChangedError();
}

export function getToken(): TokenPair | null { return cur; }
export function accessToken(): string | null { return cur?.access_token ?? null; }
export function sessionVersion(): number { return version; }

export async function login(u: string, p: string, signal?: AbortSignal): Promise<TokenPair> {
  const intent = newIntent();
  loginVersion = intent;
  const cancelled = () => {
    if (version === intent && loginVersion === intent) { loginVersion = null; schedule(); }
  };
  signal?.addEventListener("abort", cancelled, { once: true });
  try {
    assertCurrent(intent, signal);
    const t = await api.login(u, p);
    assertCurrent(intent, signal);
    loginVersion = null;
    sessionTokens.clear();
    save(t, "fresh"); schedule();
    return t;
  } catch (e) {
    if (version === intent) { loginVersion = null; schedule(); }
    assertCurrent(intent, signal);
    throw e;
  } finally { signal?.removeEventListener("abort", cancelled); }
}

export function seed(t: TokenPair | null) {
  newIntent();
  sessionTokens.clear();
  save(t, "fresh"); schedule();
}

export async function silentRefresh(): Promise<TokenPair | null> {
  if (loginVersion === version) throw new SessionChangedError();
  if (!cur?.refresh_token) return null;
  if (refreshing?.version === version) return refreshing.promise;
  const expected = version, refreshToken = cur.refresh_token;
  const flight = { version: expected, promise: null as unknown as Promise<TokenPair | null> };
  flight.promise = (async () => {
    try {
      const t = await api.refresh(refreshToken);
      assertCurrent(expected);
      save(t, "refresh"); schedule();
      return cur;
    } catch (e) {
      assertCurrent(expected);
      // The local contract specifies no definitive invalid-refresh response.
      // Preserve credentials on ambiguous failures; callers receive the error.
      retryLater();
      throw e;
    } finally {
      if (refreshing === flight) refreshing = null;
    }
  })();
  refreshing = flight;
  return flight.promise;
}

setSessionGuardHook((token, requireCurrentToken) => {
  const expected = version;
  const owned = !requireCurrentToken || sessionTokens.has(token);
  return () => {
    assertCurrent(expected);
    if (!owned || (requireCurrentToken && !sessionTokens.has(token))) throw new SessionChangedError();
  };
});

// 401 replay hook for api.raw(): hands back a fresh access token or null.
setRefreshHook(async () => (await silentRefresh())?.access_token ?? null);

// pass #144 (wave-8 W8-L13): logout now awaits the LOCAL deletion too and returns
// whether it fully landed — the caller can surface an incomplete logout (the DPAPI
// blob still on disk can restore the supposedly logged-out session) instead of the
// old shape that awaited only the server request.
export async function logout(): Promise<boolean> {
  const t = cur?.access_token;
  const rt = cur?.refresh_token;
  newIntent();
  sessionTokens.clear();
  const persisted = save(null, "refresh");
  if (t) {
    try {
      await api.logout(t, rt);
    } catch (e) {
      // pass #164: the 1.1.0 logout endpoint revokes server-side; a failure here
      // means the server may still honor the (already locally discarded) tokens.
      // The local session is gone either way — the outcome is surfaced in the log
      // viewer instead of being swallowed (the W8-L13 honesty shape, server side).
      logError(`logout: server-side revocation did not confirm (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return persisted;
}

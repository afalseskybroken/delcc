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
  if (raw) cur = JSON.parse(raw) as TokenPair;
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

function persist(t: TokenPair | null) {
  // serialized: concurrent saves (a login racing a refresh) must land in call order
  persistChain = persistChain.then(async () => {
    if (useShell === null) await initAuthStore(); // a persist can never outrun the probe
    if (useShell) {
      if (t) {
        const ok = await securePut(SEC_NAME, JSON.stringify(t));
        if (!ok) logError("auth: secure store write failed — session stays memory-only this boot");
        try { localStorage.removeItem(LS); } catch { /* ignore */ }
      } else {
        await secureDel(SEC_NAME);
        try { localStorage.removeItem(LS); } catch { /* ignore */ }
      }
    } else {
      try {
        if (t) localStorage.setItem(LS, JSON.stringify(t));
        else localStorage.removeItem(LS);
      } catch { /* private mode — session only */ }
    }
  }).catch(() => { /* persistence must never break auth */ });
}

// profiles persist the rotated token through this (refresh tokens rotate; a stale copy = forced re-login).
export function onTokenChange(f: (t: TokenPair | null) => void) { listener = f; }

function save(t: TokenPair | null) {
  if (t && t.obtained_at == null) t = { ...t, obtained_at: Date.now() };
  cur = t;
  if (t) sessionTokens.add(t.access_token);
  persist(t);
  try { listener?.(t); } catch { /* listener must never break auth */ }
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
    save(t); schedule();
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
  save(t); schedule();
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
      save(t); schedule();
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

export async function logout(): Promise<void> {
  const t = cur?.access_token;
  newIntent();
  sessionTokens.clear();
  save(null);
  if (t) { try { await api.logout(t); } catch { /* already dead */ } }
}

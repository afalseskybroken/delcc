// delcc-app/src/lib/profiles.ts
// Saved login profiles for the Default layout (see ../delcc/sketches/login.png).
// Quick-login = refresh token kept per profile. Burner rule still applies: this file
// never leaves the machine, never gets screenshotted.
// Pass #78 (Sonnet S2): the list — which carries the per-profile refresh tokens —
// moved to the DPAPI secure store (lib/secure.ts). The legacy plaintext copy
// (`delcc-profiles`) migrates on first boot and is deleted; plain-browser dev (no
// shell) keeps the documented localStorage behavior. `delcc-active-profile` stays in
// localStorage (a pointer, not a secret).
import type { TokenPair } from "./api";
import { logError, logInfo } from "./applog";
import { secureGet, securePut } from "./secure";
import { shellInvoke } from "./transport";

// lockPw/savedPw used to be raw strings here (pass #9 lanes 2+3 replaced them with
// lockHash/savedPwEnc — see lib/vault.ts). A profile loaded from old localStorage may
// still carry the legacy fields; lib/vault.ts migrates them once, silently, at boot.
export interface Profile {
  id: string;
  username: string;
  locked: boolean;      // padlock glyph: lock password required to open
  lockHash: { salt: string; hash: string; iterations: number } | null; // PBKDF2(lockPw) — never the raw password
  savedPwEnc: { salt: string; iv: string; ct: string; iterations: number } | null; // AES-GCM(savedPw), key = PBKDF2(lockPw)
  needsReauth: boolean; // yellowed entry: stored token died, log in again
  token: TokenPair | null;
}

const LS = "delcc-profiles";
const SEC_NAME = "profiles";
const LS_ACTIVE = "delcc-active-profile";

// ---- pass #78: DPAPI-backed persistence ----
let cache: Profile[] | null = null;
let useShell: boolean | null = null;
let storeInit: Promise<Profile[]> | null = null;
let persistChain: Promise<void> = Promise.resolve();

// Awaited once by the boot path BEFORE anything reads profiles; idempotent.
export function initProfiles(): Promise<Profile[]> {
  if (!storeInit) {
    storeInit = (async () => {
      let legacy: Profile[] = [];
      try {
        const raw = localStorage.getItem(LS);
        if (raw) legacy = JSON.parse(raw) as Profile[];
      } catch { /* fresh start */ }
      useShell = (await shellInvoke()) != null;
      if (useShell) {
        const stored = await secureGet(SEC_NAME);
        if (stored) {
          try { cache = JSON.parse(stored) as Profile[]; } catch { cache = legacy; }
          if (legacy.length) {
            // secure store wins; drop the stale plaintext copy
            try { localStorage.removeItem(LS); } catch { /* ignore */ }
          }
        } else {
          cache = legacy;
          if (legacy.length && await securePut(SEC_NAME, JSON.stringify(legacy))) {
            try { localStorage.removeItem(LS); } catch { /* ignore */ }
            logInfo("profiles: migrated to the DPAPI secure store");
          }
        }
      } else {
        cache = legacy; // dev fallback stays as documented
      }
      if (!Array.isArray(cache)) cache = [];
      return cache;
    })();
  }
  return storeInit;
}

export function loadProfiles(): Profile[] {
  // The cache after initProfiles(); pre-init callers (none on the real boot path —
  // main.ts awaits initProfiles before any render) get the legacy localStorage view.
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS);
    if (raw) return JSON.parse(raw) as Profile[];
  } catch { /* fresh start */ }
  return [];
}

export function saveProfiles(list: Profile[]) {
  cache = list;
  persistChain = persistChain.then(async () => {
    if (useShell === null) await initProfiles(); // a persist can never outrun the probe
    if (useShell) {
      const ok = await securePut(SEC_NAME, JSON.stringify(list));
      if (!ok) logError("profiles: secure store write failed — changes stay memory-only this boot");
      try { localStorage.removeItem(LS); } catch { /* ignore */ }
    } else {
      try { localStorage.setItem(LS, JSON.stringify(list)); } catch { /* private mode */ }
    }
  }).catch(() => { /* persistence must never break a render */ });
}

export function activeId(): string | null {
  try { return localStorage.getItem(LS_ACTIVE); } catch { return null; }
}

export function setActiveId(id: string | null) {
  try {
    if (id) localStorage.setItem(LS_ACTIVE, id);
    else localStorage.removeItem(LS_ACTIVE);
  } catch { /* ignore */ }
}

export function upsertProfile(list: Profile[], p: Profile): Profile[] {
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p;
  else list.push(p);
  return list;
}

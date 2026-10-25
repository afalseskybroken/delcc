// delcc-app/src/lib/profiles.ts
// Saved login profiles for the Default layout (see ../delcc/sketches/login.png).
// Quick-login = refresh token kept in localStorage per profile. Burner rule
// still applies: this file never leaves the machine, never gets screenshotted.
import type { TokenPair } from "./api";

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
const LS_ACTIVE = "delcc-active-profile";

export function loadProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(LS);
    if (raw) return JSON.parse(raw) as Profile[];
  } catch { /* fresh start */ }
  return [];
}

export function saveProfiles(list: Profile[]) {
  try { localStorage.setItem(LS, JSON.stringify(list)); } catch { /* private mode */ }
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

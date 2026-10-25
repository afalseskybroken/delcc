// delcc-app/src/lib/vault.ts
// Local-only credential protection for saved profiles (pass #9 lanes 2+3).
// Threat model is casual exposure of localStorage — a screenshot, a synced
// browser profile, someone glancing at devtools — not an adversary who can
// already run code on this machine. Lock password never leaves the device,
// and it is the only key: lose it and the saved login is gone too (see
// "locking = forgetting" below). Nothing here is constant-time; that defends
// against a remote timing attacker, which doesn't exist in this threat model.
import type { Profile } from "./profiles";

const PBKDF2_ITERATIONS = 150_000; // WebCrypto PBKDF2-SHA256, interactive-login cost — not moralized, just the number

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
const randBytes = (len: number) => crypto.getRandomValues(new Uint8Array(len));

async function pbkdf2Bits(pw: string, salt: Uint8Array, bits: number, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, key, bits);
}
async function aesKeyFrom(pw: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

// ---------- lane 3: lock password, stored as {salt, hash}, never raw ----------
export interface LockHash { salt: string; hash: string; iterations: number }

export async function hashLockPw(pw: string): Promise<LockHash> {
  const salt = randBytes(16);
  const bits = await pbkdf2Bits(pw, salt, 256, PBKDF2_ITERATIONS);
  return { salt: b64(salt), hash: b64(bits), iterations: PBKDF2_ITERATIONS };
}
export async function verifyLockPw(pw: string, h: LockHash): Promise<boolean> {
  const bits = await pbkdf2Bits(pw, unb64(h.salt), 256, h.iterations);
  return b64(bits) === h.hash;
}

// ---------- lane 2: savedPw encrypted with a key derived from the lock password ----------
// Only locked profiles get a savedPwEnc — an unlocked profile has no lock password to
// derive a key from, so there's nothing to encrypt it with. (Previously an unlocked
// profile's savedPw was written in plaintext and never read back anywhere — dead weight
// that this lane also just removes, rather than leaving a half-protected field around.)
export interface EncBlob { salt: string; iv: string; ct: string; iterations: number }

export async function encryptWithLockPw(pw: string, plaintext: string): Promise<EncBlob> {
  const salt = randBytes(16);
  const key = await aesKeyFrom(pw, salt, PBKDF2_ITERATIONS);
  const iv = randBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct), iterations: PBKDF2_ITERATIONS };
}
// null = wrong password (GCM auth tag fails closed) or corrupt data — same outcome either way,
// and the caller already treats "no saved password" as "ask for the account password again".
export async function decryptWithLockPw(pw: string, blob: EncBlob): Promise<string | null> {
  try {
    const key = await aesKeyFrom(pw, unb64(blob.salt), blob.iterations);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ct) as BufferSource);
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

// ---------- one-time migration off the old plaintext lockPw/savedPw fields ----------
// Both old fields were plaintext, so there's no "decrypt with the old scheme" step — just
// hash the lock password and, for locked profiles, encrypt the saved password with it.
// Runs silently at boot (see main.ts), before profiles are ever read by the UI, so there is
// nothing to prompt the user for: everything needed is already sitting in the legacy JSON.
interface LegacyProfile extends Profile { lockPw?: string | null; savedPw?: string | null }

export function isLegacy(p: Profile): boolean {
  const lp = p as LegacyProfile;
  return lp.lockPw != null || lp.savedPw != null;
}

export async function migrateProfiles(list: Profile[]): Promise<boolean> {
  let changed = false;
  for (const p of list) {
    if (!isLegacy(p)) continue;
    const lp = p as LegacyProfile;
    if (lp.lockPw) {
      p.lockHash = await hashLockPw(lp.lockPw);
      p.savedPwEnc = lp.savedPw ? await encryptWithLockPw(lp.lockPw, lp.savedPw) : null;
    } else {
      p.lockHash = p.lockHash ?? null;
      p.savedPwEnc = null; // unlocked — nothing to derive a key from, so nothing kept (see above)
    }
    delete lp.lockPw;
    delete lp.savedPw;
    changed = true;
  }
  return changed;
}

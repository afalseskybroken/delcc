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
// pass #164 (wave-11 W11-L11): every persisted base64 field is decoded through this
// — a malformed value fails CLOSED (null) instead of throwing out of atob mid-boot
// or feeding crypto.subtle garbage. The consumers treat null exactly like a wrong
// password: the record is unusable either way.
function safeUnb64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || !s || s.length > 8192 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try { return unb64(s); } catch { return null; }
}
export function isLockHash(v: unknown): v is LockHash {
  if (!v || typeof v !== "object") return false;
  const h = v as Partial<LockHash>;
  return typeof h.salt === "string" && typeof h.hash === "string"
    && boundedIterations(h.iterations) !== null
    && safeUnb64(h.salt) !== null && safeUnb64(h.hash) !== null;
}
export function isEncBlob(v: unknown): v is EncBlob {
  if (!v || typeof v !== "object") return false;
  const b = v as Partial<EncBlob>;
  return typeof b.salt === "string" && typeof b.iv === "string" && typeof b.ct === "string"
    && boundedIterations(b.iterations) !== null
    && safeUnb64(b.salt) !== null && safeUnb64(b.iv) !== null && safeUnb64(b.ct) !== null;
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
// pass #144 (wave-8 W8-L14): the iteration count rides PERSISTED records — a
// corrupted or attacker-controlled value could request extreme derivation work
// (a DoS on the lock screen). Anything outside the sane band fails closed, exactly
// like a wrong password (the record is unusable either way).
export const KDF_MIN_ITERATIONS = 10_000;
export const KDF_MAX_ITERATIONS = 2_000_000;
function boundedIterations(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const i = Math.floor(v);
  return i >= KDF_MIN_ITERATIONS && i <= KDF_MAX_ITERATIONS ? i : null;
}

export async function verifyLockPw(pw: string, h: LockHash): Promise<boolean> {
  const iterations = boundedIterations(h.iterations);
  if (!iterations) return false;
  const salt = safeUnb64(h.salt);
  if (!salt) return false;
  const bits = await pbkdf2Bits(pw, salt, 256, iterations);
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
  const iterations = boundedIterations(blob.iterations);
  if (!iterations) return null; // corrupt record — same outcome as a wrong password
  try {
    const salt = safeUnb64(blob.salt), iv = safeUnb64(blob.iv), ct = safeUnb64(blob.ct);
    if (!salt || !iv || !ct) return null;
    const key = await aesKeyFrom(pw, salt, iterations);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource);
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

# Windows Hello / TPM-bound key design (pass #10, lane 4)

Design only. Nothing here is implemented; this is the input to a future code lane, not a
spec to start building from today.

## What exists today

`lib/vault.ts` (pass #9): a profile's lock password runs through PBKDF2-SHA256
(150k iterations) to produce two independent derived outputs — a verification hash
(`lockHash: {salt, hash, iterations}`) and, separately, an AES-GCM-256 key
(`EncBlob: {salt, iv, ct, iterations}`) that wraps the saved account password
(`savedPwEnc`). Both derivations start from the same typed password; the module's own
doc comment states the threat model plainly: casual local exposure (screenshot, synced
browser profile, someone glancing at devtools), not an adversary already running code on
the machine. Nothing is constant-time, on purpose, for that threat model.

The thing actually being protected is small: one AES-256 key, long-lived, released by
typing the lock password. Hello/TPM doesn't change *what's* protected — it changes how
the key gets released, and who/what can release it.

## What Hello/TPM would add

Windows Hello backed by TPM gives a hardware-bound key that can only be used (not just
"only unwrapped") by a biometric or PIN gesture tied to the specific TPM on the specific
machine. The practical change: the AES key that unwraps `savedPwEnc` would no longer be
*derivable from a password alone* — it would be sealed to the TPM via CNG
(`NCryptCreatePersistedKey` / `BCrypt*` with a TPM-backed provider, commonly surfaced
through `NCRYPT_PLATFORM_ATTEST_KEY` or similar KSP-level APIs), and releasing it would
require a successful Hello ceremony, not just knowledge of a string.

### What gets wrapped

Same artifact as today, nothing new: the derived key currently produced by
`vault.ts::encryptWithLockPw` / `decryptWithLockPw`. The design doesn't add a new
secret — it changes *how that one key is released*:

- **Today**: `lockPw` (typed) → PBKDF2 → AES key → unwraps `savedPwEnc`.
- **With Hello**: Hello/TPM gesture → CNG-released key-encryption-key (KEK) → unwraps a
  TPM-sealed blob containing the *same* AES key `vault.ts` already produces today →
  that key unwraps `savedPwEnc`, unchanged.

This means `vault.ts`'s AES-GCM layer and `savedPwEnc`'s shape don't need to change at
all. Only the thing that releases the key underneath it changes. `lockHash` (the
PBKDF2 verification hash) stays as the fallback path's gate — see below.

### Fallback UX when Hello is unavailable

Hello isn't always there: no biometric hardware, no PIN set up, a non-Windows build
(this entire design is Windows-only — macOS/Linux builds keep the current PBKDF2-only
path unconditionally, no feature parity attempted), Hello temporarily locked out after
failed attempts, or the TPM-sealed key's own underlying TPM changed (new machine, TPM
reset, OS reinstall — the seal is machine-bound by design, so this is an *expected*
failure mode, not a bug to route around).

Proposed UX, matching the existing lock-password ceremony's shape rather than
introducing a second flow:

1. On a Windows build where Hello is available and a profile's lock is Hello-capable,
   the existing lock prompt gains a Hello option *alongside* the password field — not
   instead of it. Hello succeeds → same code path as today's `verifyLockPw`/
   `decryptWithLockPw` success, just arrived at differently.
2. Hello fails, is cancelled, or isn't available → the password field is already right
   there, already focused — no modal, no "try again" dead end. This matches "locking =
   forgetting" from pass #9: the password path must keep working standalone, because a
   Hello-only profile that permanently loses Hello access (new machine, TPM wipe) would
   otherwise have no recovery path at all. The PBKDF2 `lockHash` path is not allowed to
   become vestigial — it's the one path that survives every hardware change.
3. Setting up Hello for a profile is opt-in and additive: it wraps the *existing* key
   with a second KEK, it doesn't replace `lockHash`/the password-derived key. Removing
   Hello for a profile (or Hello simply becoming unavailable) falls back to exactly
   today's behavior, not a degraded one.

### Threat-model deltas vs. the current PBKDF2 scheme

| | PBKDF2 (today) | Hello/TPM (proposed) |
|---|---|---|
| What's required to release the key | knowledge of the lock password | possession of this specific machine's TPM + a successful biometric/PIN gesture |
| Exposure if `localStorage` is copied elsewhere | the attacker still needs the password, but once they have it, the key derives anywhere | the TPM-sealed blob is useless off this machine — copying `localStorage` to another PC gets nothing, Hello or not |
| Brute-force surface | 150k-iteration PBKDF2 over whatever password strength the user chose — real but not the strongest available | effectively removed for the Hello path; the TPM rate-limits/lockouts its own gesture attempts, not this app's code |
| What this app's code can leak | the salt/hash/ciphertext — not the password itself, not the AES key | same local blobs, but one more layer removed from being useful even if leaked *with* the password, since the KEK never leaves the TPM |
| New failure modes | typo, forgotten password (unrecoverable by design — "locking = forgetting") | TPM/hardware change (unrecoverable for that specific sealed key — same unrecoverable-by-design posture, different trigger), Hello temporarily locked out (recoverable via fallback) |
| Cross-platform story | works identically on every OS | Windows-only; macOS/Linux never see this path, no parity attempted |

The net gain is specifically against *this machine being compromised while still
locked* (malware reading `localStorage` without also being able to drive a Hello
gesture) and against *credential reuse off-machine* (stolen disk image, synced profile
folder) — not against a password the user chose to make weak, and not against an
attacker who can already drive Hello themselves (a compromised, unlocked session).

### What would be `cfg(windows)` Rust

None of `vault.ts`'s WebCrypto logic needs to move to Rust — PBKDF2/AES-GCM via
WebCrypto stays exactly as it is today, in the WebView. What's unavoidably native:

- CNG key creation/retrieval for the TPM-backed KEK
  (`NCryptOpenStorageProvider`/`NCryptCreatePersistedKey` against the platform KSP,
  `NCryptFinalizeKey`).
- Triggering the actual Windows Hello consent UI (`UserConsentVerifier` via WinRT, or
  the Credential UI surface depending on which API family ends up used — needs real
  research against a Windows box, not assumed here).
- Sealing/unsealing the AES key bytes through that CNG key — this is the only place the
  "same derived key the lockPw ceremony releases today" actually crosses into Rust: a
  new Tauri command pair, something like `hello_seal_key(bytes) -> blob` and
  `hello_unseal_key(blob) -> bytes`, called from `vault.ts` only when a Hello-capable
  profile exists, with the existing PBKDF2 path completely untouched for every other
  profile.
- Querying whether Hello/a TPM is available at all on this machine, so the UI can
  decide whether to ever offer the option in the first place, same spirit as `cph.rs`'s
  `cph_detect` — probe, don't assume.

Everything else — the lock prompt UI, the fallback logic, `savedPwEnc`'s shape, the
AES-GCM wrapping of the account password — stays exactly where it is in `vault.ts` and
`main.ts` today.

## Explicitly out of scope for this doc

- No implementation, no new Tauri commands written, no Cargo dependencies chosen.
- No decision yet on which Windows API family (WinRT `UserConsentVerifier` vs. a
  lower-level CNG-only path) — that needs a real Windows box to prototype against, not
  guessed from here, same caveat as lane 1's Job Object work from pass #9.
- No UI mockup — the fallback shape above is a behavior description, not a layout.

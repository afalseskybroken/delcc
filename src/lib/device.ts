// delcc-app/src/lib/device.ts
// He's verdict 2026-10-29 (S4 follow-up): X-Device-Id must NOT persist. A stored id is
// a tracking handle across sessions — exactly the telemetry posture the honest-client
// doctrine rejects (and likely what Official uses it for). So: one fresh random id per
// runtime, memory-only, derived from nothing; every app launch presents a new one, and
// the legacy stored key (`delcc-device`) is deleted on load so pre-verdict installs
// stop carrying the handle. The header's PRESENCE is what the server demands on
// submits/detail reads — its stability across restarts is not part of any contract.
// Pass #178 (He's catch on the #177 parity): the SHAPE now matches Official too — a
// UUID v4 (the carve's own evidence for the official client's id), not the old
// "delcc-" hex. The server does not validate the format today, but the exam-session
// device binding is where a format check would first bite, and the match costs zero
// doctrine: 122 random bits after the RFC 4122 version/variant fields, per launch,
// memory-only, derived from nothing.
function mintUuidV4(): string | null {
  try {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  } catch { return null; }
}
let RUNTIME_ID: string | null = null;

export function deviceId(): string {
  // Lazy mint at first use (not module load) so a no-CSPRNG context fails the
  // requests that need the identity — not the whole app boot. There is NO static
  // fallback: a shared "delcc-session" string presented by every no-crypto client
  // was itself a collision generator (the v2 audit's finding, adopted here).
  if (RUNTIME_ID === null) RUNTIME_ID = mintUuidV4();
  if (RUNTIME_ID === null) throw new Error("device: no CSPRNG context; no requests can be made without an identity this launch");
  return RUNTIME_ID;
}

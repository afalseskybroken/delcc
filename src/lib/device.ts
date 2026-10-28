// delcc-app/src/lib/device.ts
// He's verdict 2026-10-29 (S4 follow-up): X-Device-Id must NOT persist. A stored id is
// a tracking handle across sessions — exactly the telemetry posture the honest-client
// doctrine rejects (and likely what Official uses it for). So: one fresh random id per
// runtime, memory-only, derived from nothing; every app launch presents a new one, and
// the legacy stored key (`delcc-device`) is deleted on load so pre-verdict installs
// stop carrying the handle. The header's PRESENCE is what the server demands on
// submits/detail reads — its stability across restarts is not part of any contract.
const RUNTIME_ID = (() => {
  try { localStorage.removeItem("delcc-device"); } catch { /* nothing stored */ }
  try {
    return "delcc-" + Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return "delcc-session"; } // no crypto.subtle context — honest fallback
})();

export function deviceId(): string {
  return RUNTIME_ID;
}

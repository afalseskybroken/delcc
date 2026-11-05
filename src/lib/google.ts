// delcc-app/src/lib/google.ts
// Google OAuth PKCE via the server's start -> (browser) -> exchange-poll contract.
// 200 tokens | 202 pending {interval} | 401/403 refused | 410 expired | 429 (start: too many; poll: back off) | 503 down.
// Pass #130 (T1 OAuth, He's live finding "OAUTH BROKEN"): the server's OAuth machinery was
// probed healthy end-to-end (start 200 / exchange 202-pending / refused-verifier 401 /
// begin page -> Google consent redirect all contract-faithful; probes/pass-129) and the
// official 1.1.0 client itself gates the feature off ("Đăng nhập Google chưa khả dụng") —
// so the residual break users can hit is OUR side's fragility: the poll loop used to die
// on ANY single failed poll (one transport timeout or 5xx with the judge slow = whole
// sign-in dead). The loop now rides out transient failures until the server-advertised
// window actually closes, and both legs report into the diagnostics ring so the next
// occurrence carries its own evidence.
import { api, ApiError, type TokenPair } from "./api";
import { logError, logInfo } from "./applog";

export class GoogleAbort extends Error {}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Definitive server verdicts on the exchange route — surface and stop. Everything else
// (transport timeouts, network blips, 5xx/503 "down for now") is transient: the 202/401
// shapes are flat Ninja envelopes and the probed 5xx family means "not right now", not "no".
const FATAL_POLL = new Set([400, 401, 403, 410]);

async function pkce() {
  if (!globalThis.crypto?.subtle) throw new Error("crypto.subtle unavailable (insecure context) — PKCE needs it.");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48))); // 64 chars, RFC 7636 range 43..128
  const challenge = b64url(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function sleep(ms: number, sig: AbortSignal) {
  return new Promise<void>((res, rej) => {
    if (sig.aborted) return rej(new GoogleAbort("cancelled"));
    const ab = () => { clearTimeout(t); rej(new GoogleAbort("cancelled")); };
    const t = setTimeout(() => { sig.removeEventListener("abort", ab); res(); }, ms);
    sig.addEventListener("abort", ab, { once: true });
  });
}

export async function googleLogin(o: {
  signal: AbortSignal;
  onUrl: (url: string) => void;
  onStatus: (s: string) => void;
}): Promise<TokenPair> {
  const check = () => { if (o.signal.aborted) throw new GoogleAbort("cancelled"); };
  const left = (deadline: number) => Math.max(0, Math.round((deadline - Date.now()) / 1000));
  check();
  const { verifier, challenge } = await pkce();
  check();
  let st;
  try {
    st = await api.googleStart(challenge);
  } catch (e) {
    check();
    if (e instanceof ApiError && e.status === 429)
      throw new ApiError(429, "too many Google sign-in starts — wait a minute, then retry");
    const transient = !(e instanceof ApiError) || e.status >= 500;
    if (!transient) { logError(`google oauth: start failed — ${e instanceof ApiError ? e.status : "transport"} ${(e as Error).message}`.slice(0, 180)); throw e; }
    // one retry for the flaky link (transport throw / 5xx) — a second definitive
    // verdict surfaces as-is instead of being retried into confusion
    logError(`google oauth: start hiccup (${e instanceof ApiError ? e.status : "transport"}) — retrying once`);
    await sleep(3000, o.signal);
    check();
    try { st = await api.googleStart(challenge); }
    catch (e2) {
      check();
      if (e2 instanceof ApiError && e2.status === 429)
        throw new ApiError(429, "too many Google sign-in starts — wait a minute, then retry");
      logError(`google oauth: start failed on retry — ${e2 instanceof ApiError ? e2.status : "transport"} ${(e2 as Error).message}`.slice(0, 180));
      throw e2;
    }
  }
  check();
  logInfo(`google oauth: start ok (window ${st.expires_in}s, poll every ${st.interval || 2}s)`);
  o.onUrl(st.authorization_url);
  check();
  const deadline = Date.now() + st.expires_in * 1000;
  let interval = Math.max(1, st.interval || 2);
  for (;;) {
    await sleep(interval * 1000, o.signal);
    check();
    if (Date.now() > deadline) throw new ApiError(410, "sign-in window ran out");
    let r: any;
    try {
      r = await api.googleExchange(st.transaction_id, verifier);
    } catch (e) {
      check();
      if (e instanceof ApiError && e.status === 429) {       // rate-limited poll: back off, keep going
        interval = Math.min(interval * 2, 30);
        o.onStatus(`rate-limited — polling every ${interval}s now`);
        check();
        continue;
      }
      const fatal = e instanceof ApiError && FATAL_POLL.has(e.status);
      if (fatal) { logError(`google oauth: exchange refused — ${e.status}`); throw e; }
      // transient (timeout / network blip / 5xx): ease off, keep waiting while the window stands —
      // one slow poll must not kill a sign-in the user is mid-way through on the browser side
      interval = Math.min(Math.max(interval, 2) * 2, 15);
      logError(`google oauth: poll hiccup (${e instanceof ApiError ? e.status : "transport"}) — retrying every ${interval}s, ${left(deadline)}s left`);
      o.onStatus(`network hiccup — still waiting… (${left(deadline)}s left)`);
      check();
      continue;
    }
    check();
    if (r?.access_token) { logInfo("google oauth: token received"); return r as TokenPair; } // 200
    if (Number(r?.interval) > 0) interval = Math.max(1, Number(r.interval)); // 202 pending (also restores the fast cadence after a hiccup)
    o.onStatus(`waiting for the browser sign-in… (${left(deadline)}s left)`);
    check();
  }
}

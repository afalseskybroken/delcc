// delcc-app/src/lib/google.ts
// Google OAuth PKCE via the server's start -> (browser) -> exchange-poll contract.
// 200 tokens | 202 pending {interval} | 401/403 refused | 410 expired | 429 (start: too many; poll: back off) | 503 down.
import { api, ApiError, type TokenPair } from "./api";

export class GoogleAbort extends Error {}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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
  check();
  const { verifier, challenge } = await pkce();
  check();
  let st;
  try { st = await api.googleStart(challenge); }
  catch (e) {
    check();
    if (e instanceof ApiError && e.status === 429)
      throw new ApiError(429, "too many Google sign-in starts — wait a minute, then retry");
    throw e;
  }
  check();
  o.onUrl(st.authorization_url);
  check();
  const deadline = Date.now() + st.expires_in * 1000;
  let interval = Math.max(1, st.interval || 2);
  for (;;) {
    await sleep(interval * 1000, o.signal);
    check();
    if (Date.now() > deadline) throw new ApiError(410, "sign-in window ran out");
    try {
      const r: any = await api.googleExchange(st.transaction_id, verifier);
      check();
      if (r?.access_token) return r as TokenPair;      // 200
      if (Number(r?.interval) > 0) interval = Math.max(1, Number(r.interval)); // 202 pending
      o.onStatus(`waiting for the browser sign-in… (${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s left)`);
      check();
    } catch (e) {
      check();
      if (e instanceof ApiError && e.status === 429) {       // rate-limited poll: back off, keep going
        interval = Math.min(interval * 2, 30);
        o.onStatus(`rate-limited — polling every ${interval}s now`);
        check();
        continue;
      }
      throw e;                                               // 401/403/410/503 surface as-is
    }
  }
}

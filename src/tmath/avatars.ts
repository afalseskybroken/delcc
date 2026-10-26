// src/tmath/avatars.ts — other-user avatars, honestly (pass #27, rescoped #28).
// /api/v3 withholds gravatar_hash on every non-self view (delivery rule:
// research/gravatar-investigation-2026-10-25.md), but each user's public profile
// page on the server-rendered site embeds their gravatar hash — the exact bytes
// any anonymous browser receives (CORS: access-control-allow-origin: *). We read
// only what the site itself publishes: no auth tricks, no email guessing, hashes
// are validated before use and cached locally so a user costs one GET ever.
// Rankings rows deliberately do NOT use this (audit #28): the site hashes every
// user but most have no gravatar image, and d=404 made those rows show broken
// icons — profile pages fall back to the letter via onerror instead.
import { read, write } from "./preferences";
import { siteGet } from "../lib/transport";
import { logError } from "../lib/applog";

const SITE = "https://oj.tmathcoding.vn";
const CACHE_KEY = "delcc-gravatar-map";
const CACHE_CAP = 6000; // FIFO beyond this — bounds a long session's leaderboard walk
const HASH = /^[a-f0-9]{32,64}$/;
// the site serves this hash for users without an avatar (MD5 of ""), d=identicon — never a real one
const PLACEHOLDER_HASH = "d41d8cd98f00b204e9800998ecf8427e";
const NAME = /^[a-zA-Z0-9_.-]{1,60}$/;

type AvatarMap = Record<string, { h: string; t: number }>;
// cache is untrusted on load: only well-shaped entries survive
let store: AvatarMap = (() => {
  try {
    const parsed = JSON.parse(read(CACHE_KEY, "{}")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: AvatarMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as { h?: unknown; t?: unknown };
      if (NAME.test(k) && typeof e?.h === "string" && HASH.test(e.h) && e.h !== PLACEHOLDER_HASH)
        out[k] = { h: e.h, t: typeof e.t === "number" ? e.t : 0 };
    }
    return out;
  } catch { return {}; }
})();

export function cachedAvatar(username: string): string | undefined {
  return NAME.test(username) ? store[username]?.h : undefined;
}

function remember(username: string, hash: string): void {
  if (NAME.test(username) && HASH.test(hash) && hash !== PLACEHOLDER_HASH) store[username] = { h: hash, t: Date.now() };
}

function persist(): void {
  const entries = Object.entries(store);
  if (entries.length > CACHE_CAP) {
    entries.sort((a, b) => b[1].t - a[1].t);
    store = Object.fromEntries(entries.slice(0, CACHE_CAP));
  }
  try { write(CACHE_KEY, JSON.stringify(store)); } catch { /* quota — in-memory map still serves */ }
}

// hash → username pairing: each gravatar <img> is followed within its row by the
// profile link or the @handle text — nearest of the two wins
function harvest(html: string, pageOwner?: string): void {
  const hits = [...html.matchAll(/gravatar\.com\/avatar\/([a-f0-9]{32,64})/g)];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].index! : hits[i].index! + hits[i][0].length + 900;
    const window = html.slice(hits[i].index! + hits[i][0].length, end);
    const href = window.match(/href="\/user\/([a-zA-Z0-9_.-]+)"/);
    const handle = window.match(/@([a-zA-Z0-9_.-]+)\s*</);
    const name = href?.[1] ?? handle?.[1];
    if (name) remember(name, hits[i][1]);
  }
  // a profile page that mentions exactly one avatar is that user's own — the site
  // only embeds other people's hashes in multi-avatar widgets
  if (pageOwner && NAME.test(pageOwner) && hits.length === 1 && !store[pageOwner])
    remember(pageOwner, hits[0][1]);
}

async function getText(path: string): Promise<string> {
  // Rust shell route (pass #18): profile pages lost their CORS header, so the webview
  // fetch is silently blocked. Timeout lives in site_fetch now.
  const r = await siteGet(path);
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return r.text;
}

let inFlight: Promise<void> | null = null;
// Fire-and-forget by design: callers paint the letter first and lay the image in
// when this settles. Bounded per call (≤24 profile GETs, waves of 6).
export async function hydrateAvatars(usernames: string[]): Promise<void> {
  const want = [...new Set(usernames.filter(n => NAME.test(n) && !store[n]))].slice(0, 24);
  if (!want.length) return;
  if (inFlight) await inFlight.catch(() => {}); // serialize — no duplicate fetches
  const run = (async () => {
    for (let base = 0; base < want.length; base += 6) {
      await Promise.allSettled(want.slice(base, base + 6).map(async n => {
        try { harvest(await getText(`/user/${encodeURIComponent(n)}`), n); } catch (e) { logError(`avatar hydrate ${n}: ${e instanceof Error ? e.message : String(e)}`); }
      }));
    }
    persist();
  })();
  inFlight = run.finally(() => { inFlight = null; });
  await run.catch(() => {});
}

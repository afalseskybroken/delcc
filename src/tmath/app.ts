import { api, raw, ApiError, clientVersion, syncClientVersion, type ContestListItem, type ContestProblem } from "../lib/api";
import { recordDownload } from "../lib/updater";
import * as auth from "../lib/auth";
import { activeId, initProfiles, loadProfiles, saveProfiles, setActiveId, upsertProfile } from "../lib/profiles";
import { googleLogin, GoogleAbort } from "../lib/google";
import { openExternal, fetchAsset } from "../lib/transport";
import DOMPurify from "dompurify";
import { getLocale, t, type DictKey } from "../i18n";
import { applyPreferences, loadPreferences, savePreferences, read, write, type Preferences } from "./preferences";
import { button, date, empty, errorBox, errorText, esc, list, loading, text, textBr } from "./ui";
import { mdInline as mdInlineRender } from "./md";
import { cachedAvatar, hydrateAvatars } from "./avatars";
import { logError, logInfo } from "../lib/applog";
import { phIcon, type PhName } from "./phosphor";
import { renderSettings } from "./settings";
import { mountSolve } from "./solve";
import "./tmath.css";

// About renders markdown FIRST (md.ts, scheme-allow-listed), then the RESULT goes through
// DOMPurify so raw HTML elements in About text also render (what the web client does;
// official strips them). XSS guard stays two-layer: md escapes + allow-lists URLs,
// DOMPurify sanitizes the final structure; iframes survive ONLY for YouTube embed origins.
// Pass #78 (Sonnet S7): the iframe hook registers ONCE at module scope — addHook mutates a
// module-global list, so the old per-call re-registration made every hook fire N times
// after N About renders — and the guard fails CLOSED: a sanitizer crash renders the pane
// empty and logs, never returns unsanitized HTML.
const purify: any = (DOMPurify as any).default ?? DOMPurify;
purify?.addHook?.("uponSanitizeElement", (node: any, data: any) => {
  if (data?.tagName === "iframe") {
    const src = String(node.getAttribute?.("src") ?? "");
    if (!/^https:\/\/(www\.)?(youtube|youtube-nocookie)\.com\/embed\/[A-Za-z0-9_-]+/.test(src)) node.remove?.();
  }
});
const sanitizeAbout = (html: string): string => {
  try {
    return String(purify.sanitize(html, {
      // pass #83: img restored (He: isolate, don't cripple) — remote srcs are swapped
      // for shell-fetched data: URLs by wireAboutImages; a failed fetch degrades to a link
      ALLOWED_TAGS: ["p","br","strong","em","b","i","u","ul","ol","li","blockquote","code","pre","a","img","iframe","span","div","center","h1","h2","h3","h4","h5","h6","table","thead","tbody","tr","td","th","font","small","sub","sup","hr"],
      ALLOWED_ATTR: ["href","src","alt","title","target","rel","class","loading","allowfullscreen","width","height","color","align","colspan","rowspan"],
    }));
  } catch (e) {
    logError(`sanitizeAbout: sanitizer failed — rendering empty (${e instanceof Error ? e.message : String(e)})`);
    return "";
  }
};
// pass #83: About images are fetched by the SHELL (asset_fetch: https-only, public hosts
// per redirect hop, image-only, 2 MiB, no credentials — see main.rs) and swapped in as
// data: URLs, so the webview CSP stays pinned and no third party is contacted by the
// page itself. Memory cache, FIFO-capped; max 8 remote images per pane.
const assetCache = new Map<string, string>();
const wireAboutImages = (root: HTMLElement): void => {
  const imgs = [...root.querySelectorAll("img")].slice(0, 8);
  for (const img of imgs) {
    const src = img.getAttribute("src") ?? "";
    if (!/^https:\/\//i.test(src)) continue;
    if (assetCache.has(src)) { img.src = assetCache.get(src)!; continue; }
    img.removeAttribute("src");
    img.classList.add("tm-about-img-pending");
    img.alt = img.alt || "image";
    void fetchAsset(src).then(du => {
      if (!du) {
        const a = document.createElement("a");
        a.href = src; a.textContent = src; a.rel = "noreferrer noopener"; a.target = "_blank";
        img.replaceWith(a);
        return;
      }
      assetCache.set(src, du);
      while (assetCache.size > 60) assetCache.delete(assetCache.keys().next().value as string);
      if (!img.isConnected) return;
      img.src = du;
      img.classList.remove("tm-about-img-pending");
    });
  }
};

type Route = "contests" | "problems" | "workspace" | "submissions" | "rankings" | "account" | "settings";
const titles: Record<Route, DictKey> = { contests:"contests.title", problems:"problems.title", workspace:"app.workspace", submissions:"subs.title", rankings:"rankings.title", account:"account.title", settings:"settings.title" };
// Official icon mapping (weighed duotone, ported verbatim from the 1.0.9 client).
const navIcons: Record<Route, PhName> = { contests:"squares-four", problems:"code", workspace:"code", submissions:"list-checks", rankings:"trophy", account:"user-circle", settings:"gear" };
const routes = Object.keys(titles) as Route[];
const PAGE_SIZE = 20;
const SUBS_FILTERS_KEY = "delcc-subs-filters";
const SUBS_RESULTS = ["QU","W","P","G","J","AC","WA","TLE","MLE","OLE","RTE","CE","IR","IE","AB","PD","SC","D"];
interface SubsFilterPrefs { scope: string; mine: string; user: string; problem: string; result: string; pageSize: string }
const brand = () => `<div class="tm-wordmark">TMATH<span>STUDENT</span></div>`;

// official rating tier table (carve Zg/Qg + carved css --color-*-500 values, pass #19):
// gray <1000, green <1300, blue <1600, purple <1900, orange <2400, red else
const ratingStyle = (r: unknown): string => {
  const n = Number(r);
  const c = Number.isFinite(n) ? n < 1000 ? "#6a7282" : n < 1300 ? "#00c758" : n < 1600 ? "#3080ff" : n < 1900 ? "#ac4bff" : n < 2400 ? "#fe6e00" : "#fb2c36" : "";
  return c ? ` style="color:${c}"` : "";
};
// CF-style Rate display shared by rankings + account (1.501 = 1501)
const fmtRateCol = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? (v / 1000).toFixed(3) : "—";
// official KE avatar: gravatar image layed over the letter initial, hidden on error (carve @858797).
// Delivery rule (research/gravatar-investigation-2026-10-25.md, live-verified): the server
// ships gravatar_hash ONLY on the owner's own /me, and only when that account's email is
// Gravatar-registered — every other view returns null. OTHER users' avatars come from the
// public server-rendered site instead (avatars.ts): the same hashes any browser receives.
const avatarImg = (h: string, size: number): string => `<img class="tm-avatar-img" src="https://www.gravatar.com/avatar/${h}?s=${size * 2}&d=404&r=g" alt="" width="${size}" height="${size}" referrerpolicy="no-referrer" decoding="async">`;
const avatarHtml = (name: string, hash: unknown, size: number): string => {
  const h = typeof hash === "string" && /^[a-f0-9]{32,64}$/i.test(hash.trim()) ? hash.trim().toLowerCase() : "";
  return `<span class="tm-avatar" aria-hidden="true">${esc(name.slice(0, 1).toLocaleUpperCase("vi-VN"))}${h ? avatarImg(h, size) : ""}</span>`;
};

// official ig trigger row: [current theme icon][label][chevron]; labels are literal English (carve rg)
const THEME_LABELS: Record<string, string> = { light: "Light", dark: "Dark", system: "System" };
const themeIconSvg = (v: string): string => v === "dark"
  ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`
  : v === "system"
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const themeCheckSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const themeChevronSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
const themeTrigger = (v: string): string => `${themeIconSvg(v)}<span>${THEME_LABELS[v]}</span>${themeChevronSvg}`;

// pass #52 — official submission-row glyphs (carve S_: collapsed = eye, expanded = chevron-up, 18px)
const eyeSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.5 10.5 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.5 10.5 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>`;
const chevronUpSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>`;
const caseChevronSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

// official language display names (carve l_/U_: PY3 → "Python 3", CPPNN → "C++NN")
const langName = (value: unknown): string => {
  const k = String(value ?? "");
  if (!k) return "—";
  if (/^CPP/.test(k)) return `C++${k.slice(3)}`;
  return ({ PY3: "Python 3", PY2: "Python 2", PYPY3: "PyPy 3", JAVA8: "Java 8", MONOCS: "C#", PAS: "Pascal", TEXT: "Text" } as Record<string, string>)[k] ?? k;
};

// C++ source highlighting for the source page (carve h_: CPP* languages get tokens).
// esc-FIRST doctrine: every token's text passes esc() on emission; the only tags in the
// output are our own <span class="tok-*">. Deliberately small: comments, strings/chars,
// preprocessor lines, numbers, a keyword set — a wrong guess just colors plain text.
const CPP_KEYWORDS = new Set(["alignas","alignof","and","asm","auto","bool","break","case","catch","char","class","const","consteval","constexpr","constinit","const_cast","continue","decltype","default","delete","do","double","dynamic_cast","else","enum","explicit","export","extern","false","float","for","friend","goto","if","inline","int","long","mutable","namespace","new","noexcept","not","nullptr","operator","or","private","protected","public","register","reinterpret_cast","requires","return","short","signed","sizeof","static","static_assert","static_cast","struct","switch","template","this","thread_local","throw","true","try","typedef","typeid","typename","union","unsigned","using","virtual","void","volatile","wchar_t","while","std","cout","cin","cerr","endl","vector","string","pair","map","set"]);
const cppHighlight = (src: string): string => {
  let out = "";
  let i = 0;
  const push = (cls: string, text: string): void => { out += cls ? `<span class="tok-${cls}">${esc(text)}</span>` : esc(text); };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i); const at = end < 0 ? src.length : end;
      push("comment", src.slice(i, at)); i = at; continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2); const at = j < 0 ? src.length : j + 2;
      push("comment", src.slice(i, at)); i = at; continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) { if (src[j] === "\\") j++; j++; }
      j = Math.min(j + 1, src.length);
      push("string", src.slice(i, j)); i = j; continue;
    }
    if (ch === "#" && (i === 0 || src[i - 1] === "\n")) {
      const end = src.indexOf("\n", i); const at = end < 0 ? src.length : end;
      push("pre", src.slice(i, at)); i = at; continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxX.uUlLeE+-]/.test(src[j]!) && !(src[j] === "+" && !/[eE]/.test(src[j - 1] ?? "")) && !(src[j] === "-" && !/[eE]/.test(src[j - 1] ?? ""))) j++;
      push("num", src.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /\w/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      push(CPP_KEYWORDS.has(word) ? "kw" : "", word); i = j; continue;
    }
    out += esc(ch); i++;
  }
  return out;
};
// official Popover+RadioGroup anatomy ported to a native details popover; check rides the selected value
const themeMenuHtml = (current: string): string =>
  `<details class="tm-menu tm-theme-menu-root"><summary class="theme-select" aria-label="Theme: ${THEME_LABELS[current]}" title="Theme">${themeTrigger(current)}</summary><div class="theme-menu">${["light", "dark", "system"].map(v => `<button type="button" class="theme-option" data-theme-choice="${v}">${themeIconSvg(v)}<span>${THEME_LABELS[v]}</span><span class="theme-check"${v === current ? "" : " hidden"}>${themeCheckSvg}</span></button>`).join("")}</div></details>`;

/** Independent shell: existing baseplate/WIP DOM and event handlers are never mounted. */
// pass #57 — He's min(rate_limit, device) sweep budget as an AIMD controller shared by
// every sweep loop (problems index, own-submissions walk, rankings). One global budget,
// because the loops run concurrently: each clean stretch grows the in-flight cap by one,
// any 429 halves it, so the equilibrium is the highest rate the server actually serves —
// no wasted retries above it, and a strained device never grows past its own capacity
// (hardwareConcurrency floor), where its own throughput becomes the binding limit.
class SweepPacer {
  private static readonly MIN = 2;
  private static readonly MAX = Math.min(16, Math.max(4, (navigator.hardwareConcurrency || 4) * 2));
  private limit = Math.min(6, SweepPacer.MAX);
  private inFlight = 0;
  private clean = 0;
  private last429 = 0;
  private readonly waiters: (() => void)[] = [];
  get cap(): number { return SweepPacer.MAX; }
  async acquire(): Promise<void> {
    while (this.inFlight >= this.limit) await new Promise<void>(r => this.waiters.push(r));
    this.inFlight++;
  }
  release(hit429: boolean): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (hit429) {
      this.limit = Math.max(SweepPacer.MIN, Math.floor(this.limit / 2));
      this.clean = 0;
      this.last429 = Date.now();
    } else if (++this.clean >= this.limit && Date.now() - this.last429 > 3000 && this.limit < SweepPacer.MAX) {
      this.limit++;
      this.clean = 0;
    }
    while (this.inFlight < this.limit && this.waiters.length) this.waiters.shift()!();
  }
}

export class TmathApp {
  private prefs: Preferences = loadPreferences();
  private user: any = null;
  private route: Route = "contests";
  private generation = 0;
  private disposeView: (() => void) | null = null;
  private oauth: AbortController | null = null;
  private contest: ContestListItem | null = null;
  private part: number | null = null;
  // pass #58: one-shot notice painted on the contests view after an automatic
  // Contest-View exit (timer over / left via another process)
  private autoLeftNotice: "endedAuto" | "leftAuto" | null = null;
  private collapsed = read("delcc-tmath-sidebar") === "collapsed";
  private sessionReady = false;
  private stopped = false;

  // informational update notice (honest-client: tells, never forces)
  private versionNotice: { client: string; required: string } | null = null;
  private bannerDismissed = false;
  private hashChange = () => void this.render();
  private themeChange = () => { if (this.prefs.theme === "system") applyPreferences(this.prefs); };
  private media = matchMedia("(prefers-color-scheme: dark)");
  constructor(private host: HTMLElement) {}

  async start(): Promise<void> {
    document.body.dataset.persona = "tmath";
    document.title = "delcc · TMATH";
    document.getElementById("sig")!.hidden = true;
    document.getElementById("updateBanner")!.hidden = true;
    applyPreferences(this.prefs);
    this.media.addEventListener("change", this.themeChange);
    window.addEventListener("hashchange", this.hashChange);
    // pass #78: idempotent — main.ts boot already ran these before bootTmath; kept here
    // so a direct start() can never read a store the probe hasn't settled.
    await auth.initAuthStore();
    await initProfiles();
    const profile = loadProfiles().find(p => p.id === activeId());
    // pass #63: boot trace — every resume decision lands in the Settings log, so a
    // failed auto-login is REPORTABLE instead of a mystery (He's regression reports).
    logInfo(`boot: active profile=${profile?.username ?? "none"} locked=${String(profile?.locked ?? false)} needsReauth=${String(profile?.needsReauth ?? false)}`);
    if (profile?.locked || profile?.needsReauth) auth.seed(null);
    auth.onTokenChange(token => {
      // pass #60-#63: this listener REPLACED the baseplate one (onTokenChange is a
      // single slot). The tmath shell has no profile switcher — the active unlocked
      // slot IS whoever holds the live session, so every token landing persists to it
      // and clears needsReauth (a token landing IS the recovery; a logout lands null
      // and intentionally empties the slot's token).
      const profiles = loadProfiles();
      const p = profiles.find(x => x.id === activeId());
      if (p && !p.locked) { p.token = token; p.needsReauth = false; saveProfiles(profiles); }
      if (!token && this.sessionReady && !this.stopped) {
        this.user = null; this.contest = null; this.part = null;
        void this.render();
      }
    });
    const hadToken = !!auth.getToken();
    logInfo(`boot: stored session=${String(hadToken)}`);
    this.host.innerHTML = `<main class="tm-welcome">${brand()}<h1>${text("auth.prepare")}</h1><p role="status">${text("auth.restore")}</p></main>`;
    // Session restore is independent of the informational version lookup.
    void (async () => {
      try {
        const feed = await api.release("windows-x64");
        await syncClientVersion();
        if (this.stopped) return;
        // Only trips when the masqueraded X-Client-Version disagrees with what
        // the server requires — delcc's own package version is irrelevant here.
        const required = (feed as { required_version?: string } | null)?.required_version ?? "";
        const presented = clientVersion();
        this.versionNotice = required && presented !== required ? { client: presented, required } : null;
        if (this.versionNotice) void this.render();
      } catch { /* feed unreachable — no evidence, no banner */ }
    })();
    if (hadToken) {
      // transient refresh failures keep credentials (F10) — the stored access token
      // may still be live, so identify() gets the final say on this boot.
      try { await auth.silentRefresh(); logInfo("boot: session refresh ok"); }
      catch (e) { logError(`boot: session refresh failed — credentials retained (${e instanceof Error ? e.message : String(e)})`); }
      if (auth.accessToken()) { try { await this.identify(); logInfo(`boot: identity=${String(this.user?.username ?? "unknown")}`); } catch { /* Render a recoverable error on the first authenticated read. */ } }
    }
    // F12 reworked (pass #63): the tmath shell has no profile switcher — the active
    // unlocked slot IS the live session. A mismatched identity is a REBIND (canonical
    // username + token + flag cleared, slot made active), never a punishment: the old
    // punish path kept re-arming needsReauth and killing auto-login whenever the
    // slot's name lagged the account actually signed in (He's burner/main switching).
    // A fresh account with no profile at all gets one here.
    if (this.user) {
      const live = String(this.user.username ?? "").toLowerCase();
      if (live) {
        const profiles = loadProfiles();
        let p = profiles.find(x => x.id === activeId()) ?? profiles.find(x => (x.username || "").toLowerCase() === live && !x.locked);
        if (!p) p = { id: "p-" + Date.now().toString(36), username: String(this.user.username), locked: false, lockHash: null, savedPwEnc: null, needsReauth: false, token: null };
        if ((p.username || "").toLowerCase() !== live || !p.token) {
          p.username = String(this.user.username); p.token = auth.getToken(); p.needsReauth = false;
          saveProfiles(upsertProfile(profiles, p));
          setActiveId(p.id);
          logInfo(`boot: session bound to profile ${p.username}`);
        }
      }
    }
    this.sessionReady = true;
    await this.render();
    // pass #63 (Official behavior, He): a live participation lands back in Contest View.
    void this.syncContestState();
  }

  destroy(): void {
    this.stopped = true; this.generation++; this.disposeView?.(); this.oauth?.abort();
    window.removeEventListener("hashchange", this.hashChange);
    this.media.removeEventListener("change", this.themeChange);
    auth.onTokenChange(() => {});
  }

  // pass #63 (Official behavior, He): on boot, a LIVE participation lands back in
  // Contest View. /current-contest returns null (200) when not in one; a joined
  // contest comes back as a FLAT contest object (live probe 2026-10-28: {key, name,
  // start_time, end_time, is_in_contest, …} — no participation_id, the workspace
  // fetch fills it). Only the default contests landing is redirected — an explicit
  // route at boot is never yanked.
  private async syncContestState(): Promise<void> {
    try {
      const token = auth.accessToken();
      if (!token) return;
      const cur = await api.currentContest(token);
      const c = cur && typeof cur === "object" && !Array.isArray(cur) ? cur as { key?: unknown; participation_id?: unknown } : null;
      const key = typeof c?.key === "string" && c.key ? c.key : "";
      if (!key) { logInfo("boot: contest state → none"); return; }
      this.contest = { ...(cur as unknown as ContestListItem), key };
      const pid = Number(c?.participation_id ?? NaN);
      this.part = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
      logInfo(`boot: contest state → ${key} (workspace)`);
      if (this.route === "contests") this.go("workspace", { contest: key });
    } catch { /* offline or not resolvable — the contests list stays */ }
  }

  private async identify(): Promise<void> {
    const token = auth.accessToken();
    if (!token) return;
    // /bootstrap (contract-documented, JWT) carries an OPTIONAL user object — the cold-boot
    // session payload the official Rust almost certainly reads its gravatarHash from.
    const [meR, bsR] = await Promise.allSettled([api.me(token), raw("/bootstrap", { token })]);
    if (!auth.accessToken()) return;
    const me: any = meR.status === "fulfilled" ? meR.value : null;
    const bs: any = bsR.status === "fulfilled" ? bsR.value : null;
    // merge, don't replace: /me is UNTYPED in the contract — unwrap every wrapper the
    // official client's serde table implies (user/profile/data) and keep top-level
    // extras (a session gravatar must survive into this.user; carve: session gravatarHash).
    // TOP-LEVEL WINS (audit: @delete's avatar never rendered — the old spread let a
    // nested wrapper that lacks gravatar_hash override the flattened /me fields).
    const merged = me ? { ...(me.user ?? me.profile ?? me.data ?? {}), ...me } : {};
    const bsUser = bs?.user ?? bs?.profile ?? null;
    this.user = (me || bsUser) ? { ...merged, ...(bsUser ?? {}) } : null;
    // own-avatar fallback: when /me ships no hash, pull our own PUBLIC profile page
    // (same bytes the site shows everyone) so the topbar still gets an avatar
    const uname = String(this.user?.username ?? "");
    if (uname && !(this.user?.gravatarHash ?? this.user?.gravatar_hash)) {
      void hydrateAvatars([uname]).then(() => {
        const h = cachedAvatar(uname);
        const av = document.querySelector(".tm-topbar-account .tm-avatar");
        if (!h || !av || av.querySelector("img")) return;
        av.insertAdjacentHTML("beforeend", avatarImg(h, 34));
        const img = av.querySelector("img");
        if (img) img.onerror = () => img.remove();
      }).catch(() => { /* letter stays */ });
    }
  }

  private go(route: Route, params: Record<string, string> = {}): void {
    const q = new URLSearchParams(params).toString();
    const hash = `#/${route}${q ? `?${q}` : ""}`;
    if (location.hash === hash) void this.render(); else location.hash = hash;
  }

  private currentRoute(): URLSearchParams {
    const [page, query] = location.hash.replace(/^#\/?/, "").split("?");
    this.route = routes.includes(page as Route) ? page as Route : "contests";
    return new URLSearchParams(query);
  }

  private async render(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.disposeView?.(); this.disposeView = null; this.oauth?.abort(); this.oauth = null;
    const params = this.currentRoute();
    if (!auth.accessToken() && this.route !== "settings") { this.login(); return; }
    this.shell();
    const content = this.host.querySelector<HTMLElement>("#tm-content")!;
    const alive = () => gen === this.generation && !this.stopped;
    if (this.route === "settings") {
      this.disposeView = renderSettings(content, this.prefs, () => void this.render()); return;
    }
    content.innerHTML = loading();
    try {
      if (this.route === "contests") await this.contests(content, params, alive);
      if (this.route === "problems") {
        if (params.get("code")) this.solve(content, params.get("code")!, null);
        else await this.problems(content, params, alive);
      }
      if (this.route === "workspace") await this.workspace(content, params, alive);
      if (this.route === "submissions") await this.submissions(content, params, alive);
      if (this.route === "rankings") await this.rankings(content, alive);
      if (this.route === "account") await this.account(content, alive);
      // every page's hero Refresh button (audit: it rendered but was never wired)
      const refresh = content.querySelector<HTMLButtonElement>('[data-action="refresh"]');
      if (refresh) refresh.onclick = () => { if (alive()) void this.render(); };
      // GitHub fast-travel (sidebar footer + settings)
      this.host.querySelectorAll<HTMLButtonElement>('[data-action="open-github"]').forEach(b => b.onclick = () => void openExternal("https://github.com/afalseskybroken/delcc"));
    } catch (error) {
      logError(`view ${this.route}: ${error instanceof Error ? error.message : String(error)}`);
      if (!alive()) return;
      content.innerHTML = errorBox(error) + button("common.retry", "retry");
      content.querySelector<HTMLButtonElement>("button")!.onclick = () => void this.render();
    }
  }

  private shell(): void {
    const loggedIn = !!auth.accessToken();
    const nav = (r: Route) => `<button type="button" data-route="${r}" class="${this.route === r ? "tm-current" : ""}" title="${text(titles[r])}" aria-label="${text(titles[r])}"${this.route === r ? ' aria-current="page"' : ""}>${phIcon(navIcons[r], 20)}<span>${text(titles[r])}</span></button>`;
    const displayName = this.user?.display_name ?? this.user?.username ?? "?";
    this.host.innerHTML = `<div class="tm-shell${this.collapsed ? " collapsed" : ""}">
      <aside class="tm-sidebar"><div class="tm-sidebar-header">${brand()}<button type="button" class="tm-sidebar-toggle" data-action="collapse" aria-controls="tm-navigation" aria-expanded="${!this.collapsed}" aria-label="${text(this.collapsed ? "app.expandSidebar" : "app.collapseSidebar")}">${phIcon("sidebar-simple", 22)}</button></div><div class="tm-nav-label">${text("app.navigation")}</div><nav class="tm-nav" id="tm-navigation">${loggedIn ? (this.contest ? nav("workspace") : nav("contests") + nav("problems")) + nav("submissions") + nav("rankings") + nav("account") : ""}${nav("settings")}</nav><div class="tm-sidebar-footer"><b>delcc</b><p>${text("app.independent")}</p><button type="button" class="tm-sidebar-gh" data-action="open-github" title="github.com/afalseskybroken/delcc" aria-label="GitHub"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.78 1.05.78 2.12v3.14c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg></button>${loggedIn ? "" : button("auth.login","login")}</div></aside>
      <div class="tm-main"><header class="tm-topbar"><div class="tm-topbar-page"><span class="tm-topbar-page-icon" aria-hidden="true">${phIcon(navIcons[this.route] ?? "user-circle", 22)}</span><div class="tm-topbar-page-copy"><span class="tm-topbar-eyebrow">TMATH / STUDENT</span><strong class="tm-topbar-title">${text(titles[this.route])}</strong></div></div><div class="tm-topbar-actions">${themeMenuHtml(this.prefs.theme)}${loggedIn ? `<button type="button" class="tm-topbar-account" data-route="account">${avatarHtml(displayName, this.user?.gravatarHash ?? this.user?.gravatar_hash ?? cachedAvatar(String(this.user?.username ?? "")), 34)}<span class="tm-topbar-account-name"${ratingStyle(this.user?.rating)}>${esc(displayName)}</span></button><button type="button" class="tm-topbar-logout" data-action="logout" aria-label="${text("app.topbar.logout")}" title="${text("app.topbar.logout")}">${phIcon("sign-out", 18, "regular")}<span>${text("app.topbar.logout")}</span></button>` : button("auth.login","login")}</div></header>${this.versionNotice && !this.bannerDismissed ? this.bannerHtml() : ""}<main class="tm-content" id="tm-content"></main></div></div>`;
    this.host.querySelectorAll<HTMLElement>("[data-route]").forEach(b => b.onclick = () => this.go(b.dataset.route as Route, b.dataset.route === "workspace" && this.contest ? {contest:this.contest.key} : {}));
    this.host.querySelector<HTMLButtonElement>('[data-action="collapse"]')!.onclick = () => {
      this.collapsed = !this.collapsed; write("delcc-tmath-sidebar", this.collapsed ? "collapsed" : "expanded");
      this.host.querySelector(".tm-shell")!.classList.toggle("collapsed", this.collapsed);
      const b = this.host.querySelector('[data-action="collapse"]')!;
      b.setAttribute("aria-expanded", String(!this.collapsed));
      b.setAttribute("aria-label", t(this.collapsed ? "app.expandSidebar" : "app.collapseSidebar"));
    };
    const logout = this.host.querySelector<HTMLButtonElement>('[data-action="logout"]');
    if (logout) logout.onclick = () => { void auth.logout(); };
    this.host.querySelectorAll<HTMLButtonElement>('[data-action="login"]').forEach(b => b.onclick = () => this.go("contests"));
    this.wireThemeMenus(this.host);
    this.host.querySelectorAll<HTMLImageElement>(".tm-avatar-img").forEach(img => img.onerror = () => img.remove());
    this.bindBanner();
  }

  // informational server-version banner — internal to the persona, never the leaked baseplate strip
  private bannerHtml(): string {
    const n = this.versionNotice!;
    return `<div class="tm-banner-wrap"><section class="tm-update-banner" role="status"><div class="tm-update-copy"><b>${text("update.bannerTitle")}</b><p>${text("update.bannerDesc", { client: n.client, required: n.required })}</p></div><div class="tm-banner-actions"><button type="button" class="tm-button" data-action="open-installer">${text("update.open")}</button><button type="button" class="tm-button ghost" data-action="dismiss-banner">${text("update.dismiss")}</button></div></section></div>`;
  }

  private pageTitle(eyebrow: string, title: string, desc: string, refresh: string): string {
    return `<div class="tm-page-title"><div><div class="tm-eyebrow">${text(eyebrow as "contests.eyebrow")}</div><h1>${text(title as "contests.title")}</h1><p class="tm-muted">${text(desc as "contests.desc")}</p></div><button type="button" class="tm-button" data-action="refresh">${text(refresh as "contests.refresh")}</button></div>`;
  }

  private bindBanner(): void {
    const refresh = this.host.querySelector<HTMLButtonElement>('[data-action="refresh"]');
    if (refresh) refresh.onclick = () => void this.render();
    const installer = this.host.querySelector<HTMLButtonElement>('[data-action="open-installer"]');
    if (installer) installer.onclick = async () => {
      installer.disabled = true;
      try {
        const m = await api.release("windows-x64");
        if (m && "installer_url" in m && m.installer_url) { await openExternal(m.installer_url); void recordDownload(m.platform, m.release_id); }
      } catch { /* feed unreachable — the banner stays informational */ } finally { installer.disabled = false; }
    };
    const dismiss = this.host.querySelector<HTMLButtonElement>('[data-action="dismiss-banner"]');
    if (dismiss) dismiss.onclick = () => { this.bannerDismissed = true; void this.render(); };
  }

  private login(): void {
    // Official login anatomy (carve @908856): intro column with brand eyebrow + tagline + honest
    // delcc foot, login card with tools row (settings button + theme select), label-wrapped inputs
    // with official placeholders, primary full-width "Đăng nhập →". The eye toggle stays removed —
    // official has none.
    this.host.innerHTML = `<main class="tm-login-page"><section class="tm-login-brand">${brand()}<div><div class="tm-eyebrow">${text("auth.brandEyebrow")}</div><h1>${textBr("auth.introTitle")}</h1><p>${textBr("auth.introSubtitle")}</p></div><footer class="tm-login-foot">delcc · ${text("app.independent")}</footer></section><section class="tm-login-panel"><div class="tm-login-card"><div class="tm-login-tools"><button type="button" class="tm-button" data-action="settings">${phIcon("gear", 16, "regular")}<span>${text("app.settings")}</span></button>${themeMenuHtml(this.prefs.theme)}</div><div class="tm-eyebrow">${text("auth.welcome")}</div><h2>${text("auth.login")}</h2><p class="tm-muted">${text("auth.subtitle")}</p><form id="tm-login" class="tm-login-form"><label>${text("auth.username")}<input id="tm-username" name="username" autocomplete="username" required maxlength="150" placeholder="${text("auth.usernamePlaceholder")}"></label><label>${text("auth.password")}<span class="tm-pw-wrap"><input id="tm-password" name="password" type="password" autocomplete="current-password" required maxlength="1024" placeholder="${text("auth.passwordPlaceholder")}"><button type="button" class="tm-reveal" data-reveal aria-pressed="false" aria-label="${text("auth.showPassword")}" title="${text("auth.showPassword")}"></button></span></label><button type="submit" class="tm-button primary full">${text("auth.login")} →</button></form><div class="tm-divider"><span>${text("auth.or")}</span></div><button type="button" class="tm-button full" data-action="google"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.3c1.9-1.8 2.9-4.3 2.9-7.4Z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4L15.4 17c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.8-5.6-4.1H3v2.6A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.8a6 6 0 0 1 0-3.6V7.6H3a10 10 0 0 0 0 8.8l3.4-2.6Z"/><path fill="#EA4335" d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.6l3.4 2.6C7.2 7.9 9.4 6.1 12 6.1Z"/></svg> ${text("auth.google")}</button><div id="tm-auth-message" role="status" aria-live="polite"></div><button class="tm-button" data-action="cancel" hidden>${text("auth.cancel")}</button><p class="tm-muted tm-login-foot">${text("auth.footer")}</p></div></section></main>`;
    const gen = this.generation;
    const alive = () => gen === this.generation;
    const form = this.host.querySelector<HTMLFormElement>("form")!;
    const pass = this.host.querySelector<HTMLInputElement>("#tm-password")!;
    const message = this.host.querySelector<HTMLElement>("#tm-auth-message")!;
    const reveal = this.host.querySelector<HTMLButtonElement>("[data-reveal]")!;
    const revealKey = () => pass.type === "text" ? "auth.hidePassword" : "auth.showPassword";
    reveal.onclick = () => {
      pass.type = pass.type === "password" ? "text" : "password";
      const key = revealKey();
      const shown = pass.type === "text";
      reveal.setAttribute("aria-pressed", String(shown));
      reveal.classList.toggle("on", shown);
      reveal.setAttribute("aria-label", t(key));
      reveal.title = text(key);
    };
    const google = this.host.querySelector<HTMLButtonElement>('[data-action="google"]')!;
    const cancel = this.host.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
    const busy = (yes: boolean) => { form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach(el => el.disabled = yes); google.disabled = yes; };
    // pass #63: the login form is the tmath shell's ONLY account surface — upsert the
    // signed-in account as a profile (matched by username, any casing), make it the
    // ACTIVE slot, and store the fresh token. Without this the last logged-in account
    // never existed as a profile, so every boot's resume flags pointed at a stale or
    // missing slot and auto-login kept dying (He's regression).
    const finish = async () => {
      try { await this.identify(); } catch { /* next page has retry */ }
      const name = String(this.user?.username ?? "").toLowerCase();
      if (name) {
        const profiles = loadProfiles();
        let p = profiles.find(x => (x.username || "").toLowerCase() === name);
        if (!p) p = { id: "p-" + Date.now().toString(36), username: String(this.user!.username), locked: false, lockHash: null, savedPwEnc: null, needsReauth: false, token: null };
        if (!p.locked) { p.username = String(this.user!.username); p.token = auth.getToken(); p.needsReauth = false; }
        saveProfiles(upsertProfile(profiles, p));
        setActiveId(p.id);
        logInfo(`login: profile bound → ${p.username}`);
      }
      // pass #66: a login made AFTER boot never ran start()'s contest-state hook —
      // land this session in Contest View too when a participation is live
      if (alive()) { this.go("contests"); void this.syncContestState(); }
    };
    this.host.querySelector<HTMLButtonElement>('[data-action="settings"]')!.onclick = () => this.go("settings");
    this.wireThemeMenus(this.host);
    form.onsubmit = async event => {
      event.preventDefault(); if (google.disabled) return;
      const username = this.host.querySelector<HTMLInputElement>("#tm-username")!.value.trim();
      if (!username || !pass.value) { message.textContent = t("auth.error.empty"); return; }
      busy(true); message.textContent = t("auth.loggingIn");
      try { await auth.login(username, pass.value); pass.value = ""; await finish(); }
      catch (error) { if (alive()) { message.innerHTML = errorBox(error); busy(false); } }
    };
    google.onclick = async () => {
      busy(true); cancel.hidden = false; message.textContent = t("auth.waiting");
      const controller = this.oauth = new AbortController();
      cancel.onclick = () => controller.abort();
      try {
        const token = await googleLogin({ signal: controller.signal,
          onUrl: url => { void openExternal(url).then(ok => { if (!ok && alive()) { controller.abort(); message.textContent = t("errors.unavailable"); } }); },
          onStatus: () => { if (alive()) message.textContent = t("auth.waiting"); },
        });
        if (controller.signal.aborted || !alive()) return;
        auth.seed(token); await finish();
      } catch (e) { if (alive() && !(e instanceof GoogleAbort)) message.innerHTML = errorBox(e); }
      finally { if (alive()) { busy(false); cancel.hidden = true; } }
    };
  }

  private pager(host: HTMLElement, page: number, count: number, params: URLSearchParams, pageSize = PAGE_SIZE, total?: number): void {
    // idempotent (audit: the progressive rankings repaint appended one pager PER batch)
    host.querySelectorAll(".tm-pager").forEach(el => el.remove());
    host.insertAdjacentHTML("beforeend", `<div class="tm-pager">${button("common.previous", "prev")}<span>${text("subs.page", {n:page})}</span>${button("common.next", "next")}</div>`);
    const prev = host.querySelector<HTMLButtonElement>('[data-action="prev"]')!;
    const next = host.querySelector<HTMLButtonElement>('[data-action="next"]')!;
    prev.disabled = page === 1; next.disabled = total == null ? count < pageSize : page * pageSize >= total;
    const move = (n: number) => { params.set("page", String(n)); this.go(this.route, Object.fromEntries(params)); };
    prev.onclick = () => move(page - 1); next.onclick = () => move(page + 1);
  }

  private async contests(host: HTMLElement, params: URLSearchParams, alive: () => boolean): Promise<void> {
    const page = Math.max(1, Number(params.get("page")) || 1);
    const search = params.get("search") ?? "";
    const [joined, home] = await Promise.all([api.contests(auth.accessToken()!, {page,page_size:PAGE_SIZE,search}), api.home(auth.accessToken()!)]);
    if (!alive()) return;
    // a contest shown in an active group is not repeated in the logged/recent list
    const activeKeys = new Set([...list(home?.current_contests), ...list(home?.future_contests)].map(c => c.key));
    const deduped = list(joined).filter(c => !activeKeys.has(c.key));
    const now = Date.now();
    const rowTag = (c: ContestListItem): DictKey => c.is_spectator ? "contests.spectator" : this.contest?.key === c.key ? "contests.joined" : new Date(c.end_time).getTime() < now ? (c.can_join ? "contests.practice" : "contests.locked") : (c.can_join ? "contests.joinable" : "contests.locked");
    const row = (c: ContestListItem) => {
      const status: DictKey = new Date(c.start_time).getTime() > now ? "contests.scheduled" : new Date(c.end_time).getTime() < now ? "contests.finished" : "contests.running";
      return `<div class="tm-contest-row"><span class="tm-contest-icon" aria-hidden="true">${phIcon("trophy", 24)}</span><div class="tm-contest-summary"><strong>${esc(c.name)}</strong>${c.topic ? `<small class="tm-contest-topic">${esc(c.topic)}</small>` : ""}<small>${date(c.start_time)} – ${date(c.end_time)}</small></div><span class="tm-tag">${text(rowTag(c))}</span><button class="tm-button primary tm-contest-join" aria-label="${text(c.can_join && !c.is_in_contest ? "contests.join" : "contests.open")} ${esc(c.name)}" data-contest="${esc(c.key)}" data-join="${!!c.can_join && !c.is_in_contest}"${!c.can_join && !c.can_view_tasks && !c.is_in_contest ? " disabled" : ""}>${text(c.can_join && !c.is_in_contest ? "contests.join" : "contests.open")}</button></div>`;
    };
    const groups: [DictKey, DictKey, "active" | "upcoming" | "ended", ContestListItem[]][] = [
      ["contests.current", "contests.currentDesc", "active", list(home?.current_contests)],
      ["contests.upcoming", "contests.upcomingDesc", "upcoming", list(home?.future_contests)],
      ["contests.recent", "contests.recentDesc", "ended", deduped],
    ];
    const all = groups.flatMap(g => g[3]);
    const joinedBanner = !this.contest ? "" : `<section class="tm-current-banner" aria-label="${text("contests.currentEyebrow")}"><div class="tm-current-info"><div class="tm-eyebrow">${text("contests.currentEyebrow")}</div><h2>${esc(this.contest.name)}</h2>${this.contest.topic ? `<p class="tm-contest-topic">${esc(this.contest.topic)}</p>` : ""}<div class="tm-current-details"><span class="tm-tag">${esc(this.contest.mode || "Contest")}</span><span>${text("contests.start")}: <time dateTime="${esc(this.contest.start_time)}">${date(this.contest.start_time)}</time></span><span>${text("contests.end")}: <time dateTime="${esc(this.contest.end_time)}">${date(this.contest.end_time)}</time></span></div></div><button class="tm-button primary" data-action="continue">${text("contests.continue")}</button></section>`;
    host.innerHTML = this.pageTitle("contests.eyebrow","contests.title","contests.desc","contests.refresh") + joinedBanner + `<section class="tm-card"><div class="tm-card-head"><h2>${text("contests.list")}</h2><span class="tm-tag">${text("contests.onPage", {n: all.length})}</span></div><form class="tm-search-row" id="tm-search-form"><label for="tm-contest-search">${text("contests.searchField")}</label><div class="tm-search-controls"><input id="tm-contest-search" name="search" aria-label="${text("common.search")}" placeholder="${text("contests.searchPlaceholder")}" value="${esc(search)}" maxlength="200">${search ? `<button class="tm-button ghost" type="button" data-action="clear">${text("contests.clearFilter")}</button>` : ""}<button class="tm-button" type="submit">${text("common.search")}</button></div></form><div id="tm-contest-message" role="status"></div>` + groups.filter(([, , , cs]) => cs.length).map(([key, desc, tone, cs]) => `<section class="tm-contest-group tm-contest-group-${tone}"><div class="tm-contest-group-header"><h3>${text(key)} (${cs.length})</h3><p>${text(desc)}</p></div><div class="tm-contest-rows">${cs.map(row).join("")}</div></section>`).join("") + (groups.every(g => !g[3].length) ? empty() : "") + `</section>`;
    // pass #58: the auto-left notice (timer over / removed elsewhere) is one-shot
    if (this.autoLeftNotice) {
      const kind = this.autoLeftNotice; this.autoLeftNotice = null;
      const msg = host.querySelector<HTMLElement>("#tm-contest-message");
      if (msg) msg.innerHTML = `<p class="tm-ac-banner" role="status">${text(kind as "contests.endedAuto")}</p>`;
    }
    const clear = host.querySelector<HTMLButtonElement>('[data-action="clear"]');
    if (clear) clear.onclick = () => this.go("contests", {search: ""});
    const cont = host.querySelector<HTMLButtonElement>('[data-action="continue"]');
    if (cont) cont.onclick = () => this.go("workspace", {contest: this.contest!.key});
    host.querySelector<HTMLFormElement>("form")!.onsubmit = event => { event.preventDefault(); this.go("contests", {search: new FormData(event.currentTarget as HTMLFormElement).get("search") as string}); };
    host.querySelectorAll<HTMLButtonElement>("[data-contest]").forEach(b => b.onclick = async () => {
      b.disabled = true;
      const c = all.find(c => c.key === b.dataset.contest)!;
      try {
        if (b.dataset.join === "true") await api.join(auth.accessToken()!, c.key);
        if (!alive()) return;
        this.contest = c; this.go("workspace", {contest:c.key});
      } catch(e) { if (alive()) { host.querySelector("#tm-contest-message")!.innerHTML = errorBox(e); b.disabled = false; } }
    });
    this.pager(host,page,deduped.length,params);
  }


  // pass #19 — hybrid progress filters. The API exposes no per-user solved state, so
  // the honest source is one background sweep: every public problem (/problems), own
  // solved list (/users/<me> → solved_problems) and own submissions (attempted). The
  // unfiltered view stays server-paged; once the sweep lands, filtering/sorting/paging
  // run client-side over the full set. Memory only — nothing is persisted.
  private problemsIndex: { complete: boolean; items: any[]; solved: Set<string>; attempted: Set<string> } | null = null;
  private problemsSweep: Promise<void> | null = null;
  private problemsAttempts = 0;
  private problemsIndexTotal = 0;
  private problemsProgress: (() => void)[] = [];

  private readonly pacer = new SweepPacer();

  // pass #56, reworked in #57: every page fetch rides the shared pacer (acquire before
  // dispatch, release with the 429 verdict after), and 429/5xx retry with backoff so
  // the sweeps never silently skip pages — the rate limiter throttles instead.
  private async sweepPage(path: string, token: string, tries = 4): Promise<any> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      await this.pacer.acquire();
      try {
        const res = await raw(path, { token });
        this.pacer.release(false);
        return res;
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof ApiError && (e.status === 429 || e.status >= 500);
        this.pacer.release(retryable && e.status === 429);
        if (!retryable || attempt === tries - 1) throw e;
        await new Promise(r => setTimeout(r, 600 * (attempt + 1) + Math.floor(Math.random() * 300)));
      }
    }
    throw lastErr;
  }

  // pass #57: pacer-gated page walk — workers pull page numbers from a shared cursor,
  // so the pacer (not wave barriers) bounds concurrency: the slowest page of a batch no
  // longer stalls the next one, and short-page detection still ends the walk honestly.
  // A 404 on a page past the list end is an end marker, not a failure (DRF invalid page);
  // a 404 on page 1 is a real error and counts as a failure like any other.
  private async sweepWalk(cap: number, pathFor: (page: number) => string, token: string,
      onPage: (batch: any[]) => void, ps = 100): Promise<{ failures: number; stopped: boolean }> {
    let next = 1, failures = 0, stopped = false;
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const page = next++;
        if (page > cap) return;
        try {
          const batch = list(await this.sweepPage(pathFor(page), token));
          onPage(batch);
          if (batch.length < ps) { stopped = true; return; }
        } catch (e) {
          if (page > 1 && e instanceof ApiError && e.status === 404) { stopped = true; return; }
          failures++;
        }
      }
    };
    await Promise.all(Array.from({ length: this.pacer.cap }, () => worker()));
    return { failures, stopped };
  }

  private warmProblemsIndex(): Promise<void> {
    if (this.problemsSweep) return this.problemsSweep;
    if (this.problemsAttempts >= 2) return Promise.resolve();
    const token = auth.accessToken();
    if (!token) return Promise.resolve();
    this.problemsAttempts++;
    this.problemsSweep = (async () => {
      const PS = 100;
      const items: any[] = [];
      const seen = new Set<string>();
      let failures = 0;
      // pass #55/#57: pacer-gated walk (server caps page_size at 100 — verified live)
      const listWalk = await this.sweepWalk(300, p => `/problems?page=${p}&page_size=${PS}`, token, batch => {
        for (const p of batch) {
          if (!p || typeof p.code !== "string" || seen.has(p.code)) continue;
          seen.add(p.code);
          items.push({ code: p.code, name: String(p.name ?? p.title ?? ""), points: p.points ?? null, types: list(p.types), user_count: p.user_count ?? null });
        }
        this.problemsIndexTotal = items.length;
        for (const cb of this.problemsProgress) cb();
      });
      failures += listWalk.failures;
      const listComplete = listWalk.stopped && listWalk.failures === 0;
      const solved = new Set<string>();
      const attempted = new Set<string>();
      const me = this.user?.username;
      let triedComplete = !me;
      if (me) {
        try {
          const meRows = list<string>((await raw(`/users/${encodeURIComponent(me)}`, { token }))?.solved_problems);
          for (const code of meRows) solved.add(String(code));
        } catch { failures++; }
        const subsWalk = await this.sweepWalk(50, p => `/submissions?user=${encodeURIComponent(me)}&page=${p}&page_size=100`, token, batch => {
          for (const s of batch) {
            const code = String(s?.problem ?? "");
            if (code) attempted.add(code);
          }
        });
        failures += subsWalk.failures;
        triedComplete = subsWalk.stopped;
      }
      this.problemsIndex = { complete: listComplete && triedComplete && failures === 0, items, solved, attempted };
      // a partial scan (some pages failed) must not wedge the sweep promise as
      // resolved forever — clear it so the next visit retries (attempts cap bounds us)
      if (!this.problemsIndex.complete) this.problemsSweep = null;
      for (const cb of this.problemsProgress) cb();
      this.problemsProgress = [];
      if (this.problemsIndex.complete && this.route === "problems") void this.render();
    })().catch(() => { this.problemsSweep = null; });
    return this.problemsSweep;
  }

  private async problems(host: HTMLElement, params: URLSearchParams, alive: () => boolean): Promise<void> {
    const page = Math.max(1, Number(params.get("page")) || 1);
    const search = params.get("search") ?? "", type = params.get("type") ?? "", group = params.get("group") ?? "";
    const chipValue = params.get("chip") ?? "";
    const chip: "all" | "todo" | "none" = chipValue === "todo" ? "todo" : chipValue === "none" ? "none" : "all";
    const token = auth.accessToken()!;
    const idx = this.problemsIndex;
    const indexReady = Boolean(idx?.complete);
    const clientMode = Boolean(idx?.complete) && !group;
    if (!indexReady && !this.problemsSweep) void this.warmProblemsIndex();
    const topicsP = api.topics(token).catch(() => [] as string[]);
    let items: any[] = [], serverCount = 0;
    if (clientMode) {
      const q = search.trim().toLowerCase();
      items = idx!.items.filter(p =>
        (!q || String(p.code).toLowerCase().includes(q) || String(p.name).toLowerCase().includes(q)) &&
        (!type || p.types.includes(type)) &&
        (chip === "all" || (chip === "todo" ? idx!.attempted.has(p.code) && !idx!.solved.has(p.code) : !idx!.attempted.has(p.code) && !idx!.solved.has(p.code))));
    } else {
      const rows = await api.problems(token, { page, page_size: PAGE_SIZE, search, type, group });
      if (!alive()) return;
      items = list(rows); serverCount = items.length;
    }
    const topics = await topicsP;
    if (!alive()) return;
    const COLS: Record<string, (p: any) => string | number> = {
      code: p => String(p.code ?? ""), name: p => String(p.name ?? p.title ?? "").toLowerCase(),
      topic: p => list(p.types).join(", "), points: p => Number(p.points ?? -1), solvers: p => Number(p.user_count ?? -1),
    };
    const savedSort = read("delcc-problems-sort", "");
    let [col, dir] = savedSort.split(":");
    if (!Object.prototype.hasOwnProperty.call(COLS, col)) col = "";
    if (dir !== "asc" && dir !== "desc") dir = "asc";
    const sorted = col ? [...items].sort((a, b) => {
      const va = COLS[col](a), vb = COLS[col](b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return (dir === "asc" ? 1 : -1) * cmp;
    }) : items;
    const display = clientMode ? sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : sorted;
    const arrow = (k: string) => col === k ? (dir === "asc" ? " ↑" : " ↓") : "";
    const rowState = (code: string): "solved" | "attempted" | "untouched" => {
      if (!indexReady || !idx) return "untouched";
      if (idx.solved.has(code)) return "solved";
      if (idx.attempted.has(code)) return "attempted";
      return "untouched";
    };
    // official chips carry no counts (audit screenshots) — labels only
    const chipLabel = (k: "all" | "todo" | "none"): string => text(k === "all" ? "problems.chipAll" : k === "todo" ? "problems.chipTodo" : "problems.chipNone");
    const note = clientMode ? "" : !indexReady
      ? (this.problemsAttempts >= 2 && !this.problemsSweep ? t("problems.indexUnavailable") : t("problems.indexing", { n: this.problemsIndexTotal }))
      : t("problems.chipGroupNote");
    const chipBar = `<div class="tm-chip-row" role="group" aria-label="${text("problems.filterLabel")}">${(["all","todo","none"] as const).map(k => `<button type="button" class="tm-chip${clientMode && chip === k ? " active" : ""}" data-chip="${k}"${clientMode ? "" : " disabled"} aria-pressed="${clientMode && chip === k}">${chipLabel(k)}</button>`).join("")}${note ? `<span class="tm-chip-note"${indexReady ? "" : " data-index-note"} role="status">${esc(note)}</span>` : ""}</div>`;
    const legend = indexReady ? `<div class="tm-legend">${(["solved","attempted","none"] as const).map(k => `<span class="tm-legend-item"><span class="tm-legend-dot ${k}" aria-hidden="true"></span>${text(k === "solved" ? "problems.legendSolved" : k === "attempted" ? "problems.legendAttempted" : "problems.legendNone")}</span>`).join("")}</div>` : "";
    const activeFilter = Boolean(search || type || group);
    // pass #52 (official carve, problems list component): the search form, chips and
    // legend float FREE on the page — the bordered rounded card wraps ONLY the table.
    // Ours boxed everything in one tm-card, so a border ringed the search area too.
    host.innerHTML = this.pageTitle("problems.eyebrow","problems.title","problems.desc","problems.refresh") + `<form class="tm-filter-form" role="search"><div class="tm-filter-fields"><div class="tm-field"><label for="tm-problem-search">${text("problems.searchField")}</label><input id="tm-problem-search" name="search" placeholder="${text("problems.searchPlaceholder")}" value="${esc(search)}" maxlength="200"></div><div class="tm-field"><label for="tm-problem-topic">${text("problems.topic")}</label><select id="tm-problem-topic" name="type"><option value="">${text("problems.allTopics")}</option>${list<string>(topics).map(topic => `<option${topic === type ? " selected" : ""}>${esc(topic)}</option>`).join("")}</select></div><div class="tm-field tm-field-narrow"><label for="tm-problem-group">${text("problems.group")}</label><input id="tm-problem-group" name="group" placeholder="${text("problems.group")}" value="${esc(group)}"></div></div><div class="tm-filter-actions"><button class="tm-button primary" type="submit">${text("common.search")}</button>${activeFilter ? `<button class="tm-button ghost" type="button" data-action="clear">${text("contests.clearFilter")}</button>` : ""}</div></form>${chipBar}${legend}<section class="tm-card"><div class="tm-table-wrap"><table class="tm-table tm-problem-table"><thead><tr>${[["code","problems.code"],["name","problems.name"],["points","problems.points"],["topic","problems.topic"],["solvers","problems.solvers"]].map(([k, key]) => `<th><button type="button" class="tm-sort-h" data-sort="${k}" title="${text("problems.sortHint")}">${text(key as DictKey)}${arrow(k)}</button></th>`).join("")}</tr></thead><tbody>${display.map(p => { const st = rowState(String(p.code)); return `<tr class="tm-row-${st}"><td class="tm-code-muted"><span class="tm-dot ${st}" aria-hidden="true"></span>${esc(String(p.code).toUpperCase())}</td><td><a href="#/problems?code=${encodeURIComponent(p.code)}">${esc(p.name)}</a></td><td>${esc(p.points)}</td><td>${esc(list(p.types).join(", "))}</td><td>${esc(p.user_count ?? "—")}</td></tr>`; }).join("")}</tbody></table>${display.length ? "" : empty()}</div></section>`;
    const clearFilter = host.querySelector<HTMLButtonElement>('[data-action="clear"]');
    if (clearFilter) clearFilter.onclick = () => this.go("problems", {});
    host.querySelectorAll<HTMLButtonElement>("[data-chip]").forEach(b => b.onclick = () => {
      const k = b.dataset.chip!;
      const next: Record<string, string> = { ...Object.fromEntries(params), page: "1" };
      if (k === "all") delete next.chip; else next.chip = k;
      this.go("problems", next);
    });
    host.querySelectorAll<HTMLButtonElement>(".tm-sort-h").forEach(btn => btn.onclick = () => {
      const k = btn.dataset.sort!;
      const next = col === k && dir === "asc" ? `${k}:desc` : col === k ? "" : `${k}:asc`;
      write("delcc-problems-sort", next);
      if (alive()) void this.render();
    });
    host.querySelector<HTMLFormElement>("form")!.onsubmit = event => {
      event.preventDefault();
      this.go("problems", { ...Object.fromEntries(params) as Record<string, string>, ...Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement)) as Record<string, string>, page: "1" });
    };
    if (!clientMode && !indexReady) {
      const noteEl = host.querySelector<HTMLElement>("[data-index-note]");
      if (noteEl) {
        const cb = () => {
          if (!noteEl.isConnected || !alive() || !this.problemsSweep) {
            const i = this.problemsProgress.indexOf(cb);
            if (i >= 0) this.problemsProgress.splice(i, 1);
            return;
          }
          if (noteEl.isConnected) noteEl.textContent = t("problems.indexing", { n: this.problemsIndexTotal });
        };
        this.problemsProgress.push(cb);
      }
    }
    this.pager(host, page, clientMode ? display.length : serverCount, params, PAGE_SIZE, clientMode ? sorted.length : undefined);
  }

  private scoreClass(status?: string): string {
    const key = (status ?? "").replace(/^pretest-/, "");
    return key === "full-score" || key === "AC" ? "score-full" : key === "partial-score" ? "score-partial" : key === "failed-score" ? "score-failed" : "";
  }
  private scoreText(status?: string): string {
    switch (this.scoreClass(status)) {
      case "score-full": return text("contests.scoreFull");
      case "score-partial": return text("contests.scorePartial");
      case "score-failed": return text("contests.scoreFailed");
      default: return text("contests.scoreNone");
    }
  }
  private idxLetters(n: number): string {
    let out = "";
    for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(65 + (x - 1) % 26) + out;
    return out;
  }
  private async workspace(host: HTMLElement, params: URLSearchParams, alive: () => boolean): Promise<void> {
    const key = params.get("contest") ?? this.contest?.key;
    if (!key) { host.innerHTML = empty("contests.joinRequired"); return; }
    const workspace = await api.workspace(auth.accessToken()!, key);
    if (!alive()) return;
    const contest = workspace?.contest ?? this.contest;
    this.contest = { ...contest, key, name:contest?.name ?? key };
    this.part = workspace?.participation?.id ?? workspace?.participation_id ?? null;
    const problems = list(workspace?.problems ?? workspace?.tasks);
    const rows = problems.length ? problems : list(await api.contestProblems(auth.accessToken()!,key));
    if (!alive()) return;
    // pass #58 (workspace persistence, He's Official audit): rejoining a contest lands
    // on the LAST problem you had open there — one redirect so the tab strip highlights.
    // Language + per-language code drafts already persist per problem inside solve.ts.
    const lastKey = `delcc-contest-last:${key}`;
    const requested = params.get("code");
    if (!requested) {
      const last = read(lastKey);
      if (last && rows.some(p => p.code === last)) { this.go("workspace", { contest: key, code: last }); return; }
    } else write(lastKey, requested);
    // Repaint navigation once the restored workspace reveals its contest.
    this.shell(); host = this.host.querySelector<HTMLElement>("#tm-content")!;
    // Contest header + problem strip rebuilt to the official 1.0.9 anatomy (audit round, pass #5):
    // page-title copy with mode/deadline line, clock card with a live countdown (destructive at <=300s),
    // destructive leave, line-tab strip "Bài <letter>" with score tints + refresh icon button
    // carved from assets__index-BQyxomKN.js @808150-@811740.
    const part: any = workspace?.participation ?? null;
    const ptype: number | null = workspace?.participation_type ?? part?.participation_type ?? null;
    const deadlineAt: string | null = workspace?.deadline_at ?? contest?.end_time ?? null;
    const dlText = deadlineAt ? new Date(deadlineAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : null;
    const modeTxt = ptype != null && ptype > 0 ? text("contests.virtualMode").replace("#n", String(ptype)) : ptype === -1 ? text("contests.spectatorMode") : text("contests.officialMode");
    const tab = (p: any, i: number) => {
      const active = params.get("code") === p.code ? " active" : "";
      const score = this.scoreClass(p.score_status);
      return `<button type="button" class="tm-contest-tab${active}${score ? " " + score : ""}" data-code="${esc(p.code)}">${text("contests.tabWord")} ${this.idxLetters(typeof p.display_index === "number" ? p.display_index : i)}<span class="sr-only">${this.scoreText(p.score_status)}</span></button>`;
    };
    host.innerHTML = `<div class="tm-workspace"><div class="tm-page-title tm-contest-head"><div><div class="tm-eyebrow">${text("contests.workspaceEyebrow")}</div><h1>${esc(contest?.name ?? key)}</h1><p class="tm-contest-meta">${esc(modeTxt)}${dlText ? ` · ${text("contests.deadlineAt")}: ${esc(dlText)}` : ""}</p></div><div class="tm-contest-side"><aside class="tm-contest-clock" aria-label="${text("contests.clockLabel")}"><div class="tm-clock-label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span data-clock-label>${text("contests.timeUnknown")}</span></div><div class="tm-clock-value" role="timer" aria-label="${text("contests.ariaTimeLeft")}" data-clock>--:--:--</div></aside><button type="button" class="tm-button destructive" data-action="leave">${text("contests.leave")}</button></div></div><div class="tm-contest-strip"><div class="tm-contest-scroll"><nav class="tm-contest-tabs" aria-label="${text("contests.problemsListAria")}">${rows.map(tab).join("")}</nav></div><button type="button" class="tm-icon-button" data-action="refresh-problems" aria-label="${text("contests.refreshList")}" title="${text("contests.refreshList")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button></div>${workspace?.next_problem_requirement != null ? `<p class="tm-ac-banner" role="status">${t("contests.acBanner", { n: workspace.accepted_problem_count ?? 0, r: workspace.next_problem_requirement })}</p>` : ""}<div id="tm-workspace-message" role="status"></div><div id="tm-solve-host"></div></div>`;
    // Live countdown per the carve: ceil(deadline - now), padded HH:MM:SS, destructive tint at <=300s.
    // pass #60: the countdown runs on the SERVER clock (skew corrected by every poll —
    // live-probed payload carries server_time), and a deadline the server changes is adopted.
    let dl = deadlineAt ? Date.parse(deadlineAt) : NaN;
    let skew = 0;
    // pass #58 (Official behavior, He): Contest View polls its own state and LEAVES
    // itself — when the timer runs out, or when the participation disappears (left or
    // kicked via another process/window), the workspace exits to the contests list with
    // a one-shot notice instead of sitting on a stale view.
    let leftAuto = false;
    const leaveContestView = (reason: "endedAuto" | "leftAuto"): void => {
      if (leftAuto || !alive()) return;
      leftAuto = true;
      this.disposeView?.(); this.disposeView = null; // clears the countdown AND the state poll
      this.contest = null; this.part = null;
      this.autoLeftNotice = reason;
      this.go("contests");
    };
    const tick = () => {
      const clock = host.querySelector<HTMLElement>("[data-clock]");
      const label = host.querySelector<HTMLElement>("[data-clock-label]");
      if (!clock) return;
      const rem = Number.isFinite(dl) ? Math.max(0, Math.ceil((dl - (Date.now() + skew)) / 1000)) : null;
      clock.textContent = rem == null ? "--:--:--" : [Math.floor(rem / 3600), Math.floor(rem / 60) % 60, rem % 60].map(x => String(x).padStart(2, "0")).join(":");
      clock.classList.toggle("danger", rem != null && rem <= 300);
      // F41: [data-clock-label] is itself the span — querySelector("span") inside it never matched
      if (label) label.textContent = rem == null ? text("contests.timeUnknown") : rem === 0 ? text("contests.timeExhausted") : text("contests.timeLeft");
      if (rem === 0 && Number.isFinite(dl)) window.setTimeout(() => leaveContestView("endedAuto"), 1500); // one beat of 00:00:00
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    // pass #60 — the poll now WORKS LIKE OFFICIAL'S (He: "polling is NOT there"): each
    // 20s beat carries visible state — the countdown re-syncs to server_time, a changed
    // deadline is adopted, and a participation that vanished (left/kicked via another
    // process: live probe = 403 "You must join this contest first", or a 200 without a
    // participation_id) exits Contest View with a one-shot notice.
    const pollState = window.setInterval(() => {
      if (!alive() || leftAuto) { window.clearInterval(pollState); return; }
      if (document.hidden) return; // minimized: skip the beat — the next visible one re-syncs state + deadline
      void api.workspace(auth.accessToken()!, key).then(ws => {
        if (!alive() || leftAuto) return;
        if (!ws || ws.participation_id == null) { leaveContestView("leftAuto"); return; }
        const pid = Number(ws.participation_id);
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== this.part) this.part = pid; // rejoins rotate the participation
        const st = Date.parse(String(ws.server_time ?? ""));
        if (Number.isFinite(st)) skew = st - Date.now();
        const nextDl = Date.parse(String(ws.deadline_at ?? ""));
        if (Number.isFinite(nextDl) && nextDl !== dl) dl = nextDl;
      }).catch(e => {
        // 403/404 = the server itself says we are not in this contest (network blips retry silently)
        if (alive() && !leftAuto && e instanceof ApiError && (e.status === 403 || e.status === 404)) leaveContestView("leftAuto");
      });
    }, 20_000);
    // F27: enter the countdown into the dispose chain BEFORE solve() chains onto it — covers
    // workspace-without-solve, problem-tab switches, refreshes, navigation and destroy().
    const previous = this.disposeView;
    this.disposeView = () => { previous?.(); window.clearInterval(timer); window.clearInterval(pollState); };
    const refresh = host.querySelector<HTMLButtonElement>('[data-action="refresh-problems"]');
    if (refresh) refresh.onclick = () => this.go("workspace", params.get("code") ? { contest: key, code: params.get("code")! } : { contest: key });
    host.querySelectorAll<HTMLButtonElement>("[data-code]").forEach(b => b.onclick = () => this.go("workspace",{contest:key,code:b.dataset.code!}));
    host.querySelector<HTMLButtonElement>('[data-action="leave"]')!.onclick = async event => {
      const b = event.currentTarget as HTMLButtonElement; b.disabled = true;
      try { await api.leave(auth.accessToken()!,key); if (alive()) { this.contest = null; this.part = null; this.go("contests"); } }
      catch(e) { if (alive()) { host.querySelector("#tm-workspace-message")!.innerHTML = errorBox(e); b.disabled = false; } }
    };
    const code = params.get("code") ?? rows[0]?.code;
    const solveHost = host.querySelector<HTMLElement>("#tm-solve-host")!;
    if (code) this.solve(solveHost,code,key); else solveHost.innerHTML = empty();
  }

  private solve(host: HTMLElement, code: string, contestKey: string | null): void {
    const previous = this.disposeView;
    const dispose = mountSolve(host, {code,contestKey,participationId:this.part,username:this.user?.username ?? "",preferences:this.prefs,
      onSubmissions: () => this.go("submissions",{problem:code})});
    // chain: keep any earlier disposal (e.g. the workspace countdown interval) alive
    this.disposeView = () => { previous?.(); dispose(); };
  }

  private async submissions(host: HTMLElement, params: URLSearchParams, alive: () => boolean): Promise<void> {
    const page = Math.max(1, Number(params.get("page")) || 1);
    let remembered: Partial<SubsFilterPrefs> = {};
    try { remembered = JSON.parse(read(SUBS_FILTERS_KEY,"{}")) ?? {}; } catch { /* defaults */ }
    const value = (key: keyof SubsFilterPrefs, fallback = "") => params.has(key) ? params.get(key)! : typeof remembered[key] === "string" ? remembered[key]! : fallback;
    // pass #58 — He's scope tree: [Global] / [Public Problems] / [Current Contest] /
    // [past joined contests]; every non-Global scope gains a problem sub-select fed by
    // that scope's own problem list (Global deliberately has none). Default: Current
    // Contest inside a contest, Global outside. Server mapping: Global → /submissions
    // with no scope; Public → scope=public_practice; Contest → /contests/{key}/submissions
    // (live probe 2026-10-27: wrapped payload {name, participation_id, scope:"participation",
    // problems:[{code,name,display_index}], items:[…]}).
    const rememberedScope = remembered.scope === "public_practice" ? "public" : typeof remembered.scope === "string" ? remembered.scope : "";
    const scopeRaw = params.has("scope") ? params.get("scope")! : rememberedScope || (this.contest ? `contest:${this.contest.key}` : "global");
    const contestKey = scopeRaw.startsWith("contest:") ? scopeRaw.slice(8) : "";
    const isContestScope = !!contestKey;
    const serverScope = scopeRaw === "public" ? "public_practice" : ""; // /submissions scope enum: null | public_practice
    const detailScope = isContestScope ? scopeRaw : serverScope; // contest detail/source use the scoped endpoints
    const mine = !isContestScope && value("mine") === "1";
    const problem = value("problem"), user = value("user");
    const result = SUBS_RESULTS.includes(value("result")) ? value("result") : "";
    const size = value("pageSize","100"), pageSize = [10,20,50,100].includes(Number(size)) ? Number(size) : 100;
    const sizeOptions = [10,20,50,100];
    const scalar = (v: unknown) => Array.isArray(v) ? v[0] : v;
    // pass #64 (He: "813 h ago is diabolical"): never fabricate an age from a value we
    // cannot interpret. Absolute timestamps parse as-is; bare epoch numbers pick ms vs
    // seconds by magnitude; ANYTHING else renders VERBATIM — the raw server token beats
    // a confident lie. The date cell also carries the raw value as its tooltip.
    const ago = (value: unknown): string => {
      const raw = scalar(value);
      if (raw == null || raw === "") return "—";
      let ts: number;
      if (typeof raw === "number") ts = Math.abs(raw) > 1e11 ? raw : raw * 1000;
      else {
        const s = String(raw).trim();
        ts = new Date(s).getTime();
        if (!Number.isFinite(ts) && /^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); ts = Math.abs(n) > 1e11 ? n : n * 1000; }
      }
      if (!Number.isFinite(ts)) return String(raw);
      const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (secs < 60) return text("time.secondsAgo", { n: secs }); // official counts seconds, no "just now"
      if (secs < 3600) return text("time.minutesAgo", { n: Math.floor(secs / 60) });
      if (secs < 86400) return text("time.hoursAgo", { n: Math.floor(secs / 3600) }); // pass #66: /60 rendered MINUTES as hours — He's "871 h ago" was a 14.5 h age
      return text("time.daysAgo", { n: Math.floor(secs / 86400) });
    };
    const userFilter = isContestScope ? "" : user.trim() || (mine ? String(this.user?.username ?? "") : "");
    // smart search (audit: superior to official's exact fields): fuzzy + regex, and
    // a digits-only Problem box is a SUBMISSION ID. The server narrows only what it
    // understands exactly; smart inputs drop their param and refine client-side.
    const SMART = /[*+?()[\]{}|^$\\]/;
    const problemQ = problem.trim();
    const subId = /^\d+$/.test(problemQ) ? problemQ : "";
    const matcher = (q: string): ((v: string) => boolean) | null => {
      if (!q) return null;
      try { const re = new RegExp(q, "i"); return (v: string) => re.test(v); }
      catch { const l = q.toLowerCase(); return (v: string) => v.toLowerCase().includes(l); }
    };
    const pMatch = matcher(problemQ), uMatch = matcher(user.trim());
    const serverProblem = isContestScope ? "" : (subId || SMART.test(problemQ) ? "" : problemQ);
    const serverUser = isContestScope ? "" : (SMART.test(userFilter) ? "" : userFilter);
    const filters: SubsFilterPrefs = {scope:scopeRaw,mine:mine ? "1" : "",user:userFilter,problem,result,pageSize:String(pageSize)};
    // Resolve shared memory before the very first request, including explicit clears.
    for (const [key,v] of Object.entries(filters)) params.set(key,v);
    // pass #52: the #ID click jumps to the official source page — a sub-route of this
    // view (carve g_: list → source page → "Quay lại bài nộp"); sits after the shared
    // filter memory resolves so Back restores the exact filtered list
    const sourceParam = params.get("source");
    if (sourceParam && /^\d+$/.test(sourceParam)) {
      await this.submissionSource(host, params, Number(sourceParam), detailScope, alive);
      return;
    }
    // contest rows normalize onto the shared row shape (ContestSubmissionItemSchema:
    // submission_id/language_key/submitted_at/is_graded/… — live-probed, pass #58);
    // source is always the participant's own, so the ID click opens optimistically
    // pass #64 LIVE CAPTURE (burner submission #3800883): the wire row is
    // {submission_id, language_key, status, result, status_display, current_testcase,
    // points, case_points, case_total, time (s float), memory (KB float), is_graded,
    // is_pretested, version_update, submitted_at (ISO+00:00 WITH 6-digit microseconds),
    // problemCode, problemName} — problem identity is CAMELCASE, not problem/problem_code
    // (the old mapping left every contest row with an empty problem, so the scope's
    // problem filter never matched). rawDate rides the row for the date-cell tooltip.
    const normContest = (s: any): any => ({
      id: s?.submission_id, problem: String(s?.problemCode ?? s?.problem ?? s?.problem_code ?? ""), problem_name: String(s?.problemName ?? s?.problem_name ?? ""),
      user: String(this.user?.username ?? ""), user_display_name: String(this.user?.display_name ?? ""), user_rating: this.user?.rating,
      date: s?.submitted_at, rawDate: s?.submitted_at, language: s?.language_key, time: s?.time, memory: s?.memory,
      points: s?.points, result: s?.result ?? s?.status_display ?? s?.status, status: String(s?.status ?? s?.status_display ?? ""),
      is_terminal: !!s?.is_graded, current_testcase: s?.current_testcase ?? null,
      can_view_detail: !!s?.is_graded, can_view_source: true, version: s?.version_update ?? 0,
    });
    let contestProblems: { code: string; name: string; display_index?: number }[] = [];
    let scopeProblem = "";
    const applyContestFilters = (fresh: any[]): any[] => {
      let out = fresh.map(normContest).sort((a: any, b: any) => Number(b.id) - Number(a.id));
      if (result) out = out.filter(s => String(s.result ?? s.status) === result);
      if (scopeProblem) out = out.filter(s => !s.problem || String(s.problem) === scopeProblem);
      return out;
    };
    let rows: any[];
    if (isContestScope) {
      try {
        const payload = await api.contestSubmissions(auth.accessToken()!, contestKey);
        if (!alive()) return;
        contestProblems = list(payload?.problems).map((p: any) => ({ code: String(p?.code ?? ""), name: String(p?.name ?? ""), display_index: typeof p?.display_index === "number" ? p.display_index : undefined })).filter(p => p.code);
        scopeProblem = contestProblems.some(p => p.code === problem) ? problem : "";
        rows = applyContestFilters(list(payload?.items));
      } catch (e) {
        // Refresh failure can already have switched the view to login; still clear the shared key.
        if (e instanceof ApiError && e.status === 401) {
          try { localStorage.removeItem(SUBS_FILTERS_KEY); } catch { /* unavailable storage */ }
        }
        throw e;
      }
    } else {
      try { rows = list(await api.submissions(auth.accessToken()!,{page,page_size:pageSize,scope:serverScope,problem:serverProblem,user:serverUser,result})); }
      catch (e) {
        // Refresh failure can already have switched the view to login; still clear the shared key.
        if (e instanceof ApiError && e.status === 401) {
          try { localStorage.removeItem(SUBS_FILTERS_KEY); } catch { /* unavailable storage */ }
        }
        throw e;
      }
      if (!alive()) return;
      rows = rows.filter(s =>
        (!subId || String(s.id) === subId) &&
        (!pMatch || pMatch(String(s.problem_name ?? s.problem ?? "")) || pMatch(String(s.problem ?? ""))) &&
        (!uMatch || uMatch(String(s.user_display_name ?? s.user ?? ""))));
    }
    write(SUBS_FILTERS_KEY,JSON.stringify(filters));
    const activeFilter = Boolean(user || problem || result || mine);
    // pass #52 — official row anatomy (carve S_/public table): the ID is a
    // submission-problem-link BUTTON that opens the source page (disabled + greyed
    // when can_view_source is false), and the detail toggle is disabled while
    // !(is_terminal && can_view_detail) with the official reasons.
    const detailEnabled = (s: any): boolean => !!(s.is_terminal && s.can_view_detail);
    // pass #66 (outdo Official): hover any row's Submitted-at for the ABSOLUTE timestamp
    const dateTip = (s: any): string => {
      const abs = date(s.rawDate ?? s.date);
      return abs !== "—" ? abs : String(s.rawDate ?? s.date ?? "");
    };
    const rowHtml = (s: any): string => `<tr><td><button type="button" class="tm-sub-id" data-source="${esc(s.id)}"${s.can_view_source ? "" : " disabled"} title="${text(s.can_view_source ? "subs.viewSource" : "subs.noSourcePermission")}" aria-label="${text("subs.viewSource")} #${esc(s.id)}">#${esc(s.id)}</button></td><td><a href="#/account?user=${encodeURIComponent(String(s.user ?? ""))}"${ratingStyle(s.user_rating)} title="${esc(String(s.user_display_name ?? s.user ?? "—"))} (@${esc(String(s.user ?? ""))})">${esc(s.user_display_name ?? s.user ?? "—")}</a></td><td><a href="#/problems?code=${encodeURIComponent(String(s.problem ?? ""))}">${esc(s.problem_name ?? s.problem ?? "—")}</a></td><td title="${esc(dateTip(s))}">${esc(ago(s.date))}</td><td>${esc(langName(s.language))}</td><td><span class="tm-result-pill${s.result === "AC" ? " ok" : !s.is_terminal ? " pending" : " bad"}">${esc(s.result ?? s.status ?? "—")}${!s.is_terminal && s.current_testcase ? ` · #${esc(s.current_testcase)}` : ""}</span></td><td><strong>${esc(s.points ?? "—")}</strong></td><td class="tm-col-eye"><button class="tm-icon-button" data-sub="${s.id}" aria-expanded="false"${detailEnabled(s) ? "" : " disabled"} title="${detailEnabled(s) ? text("subs.details") : text(s.can_view_detail ? "subs.waitGrading" : "subs.noDetailPermission")}" aria-label="${text("subs.showDetails", { n: String(s.id) })}">${eyeSvg}</button></td></tr>`;
    // expanded details survive the 10s poll repaint (audit): the detail row element
    // is kept per submission id and re-inserted after its (repainted) summary row
    const openDetails = new Map<string, { row: HTMLTableRowElement; btn: HTMLButtonElement }>();
    const eyeSwap = (btn: HTMLButtonElement, expanded: boolean): void => {
      btn.innerHTML = expanded ? chevronUpSvg : eyeSvg; // official S_: eye → upward arrow on expand
      btn.setAttribute("aria-expanded", String(expanded));
      btn.setAttribute("aria-label", text(expanded ? "subs.hideDetails" : "subs.showDetails", { n: btn.dataset.sub ?? "" }));
    };
    const wireRows = (): void => {
      host.querySelectorAll<HTMLButtonElement>("[data-source]").forEach(b => b.onclick = () => {
        this.go("submissions", { ...Object.fromEntries(params), source: b.dataset.source ?? "" });
      });
      host.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach(b => b.onclick = async () => {
      const existing = host.querySelector(`[data-detail="${b.dataset.sub}"]`);
      if (existing) { existing.remove(); openDetails.delete(b.dataset.sub!); eyeSwap(b, false); return; }
      const row = document.createElement("tr"); row.dataset.detail = b.dataset.sub;
      const cell = row.insertCell(); cell.colSpan = 8; cell.className = "tm-sub-detail-cell"; cell.innerHTML = loading(); b.closest("tr")!.after(row); eyeSwap(b, true);
      openDetails.set(b.dataset.sub!, { row, btn: b });
      const summary = rows.find(s=>s.id === Number(b.dataset.sub));
      if (summary?.can_view_detail === false) { cell.innerHTML = empty("subs.noDetails"); return; }
      try {
        // pass #58: contest-scope details come from the scoped endpoint (detailScope
        // carries "contest:<key>"; global/public keep the /submissions detail shape)
        const detailScopeKey = detailScope.startsWith("contest:") ? detailScope.slice(8) : "";
        const s = detailScopeKey
          ? await api.submissionContest(auth.accessToken()!, detailScopeKey, Number(b.dataset.sub))
          : await api.submission(auth.accessToken()!,Number(b.dataset.sub),detailScope || undefined);
        if (!alive() || !row.isConnected) return;
        cell.innerHTML = this.submissionDetailHtml(s);
        this.wireCaseToggles(cell);
      } catch(e) { if (alive() && row.isConnected) cell.innerHTML = errorBox(e); }
    });
    };
    // pass #58: contest scope pages CLIENT-SIDE (the contest endpoint takes no page
    // params) — the table paints the current slice, the pager counts the full set
    const pageView = (): any[] => isContestScope ? rows.slice((page - 1) * pageSize, page * pageSize) : rows;
    const paintRows = (): void => {
      const tbody = host.querySelector("tbody");
      if (tbody) tbody.innerHTML = pageView().map(rowHtml).join("");
      wireRows();
      // re-seat expanded detail rows after their repainted summary rows
      for (const [id, ent] of openDetails) {
        const btn = tbody?.querySelector<HTMLButtonElement>(`button[data-sub="${id}"]`);
        if (!btn) { openDetails.delete(id); continue; } // summary scrolled off this page
        eyeSwap(btn, true);
        btn.closest("tr")!.after(ent.row);
      }
    };
    // scope select options: Global, Public Problems, the current contest, then past
    // joined ones from the joined-only /contests feed (newest end first); feed failure
    // degrades to the first options only
    let pastJoined: ContestListItem[] = [];
    try {
      pastJoined = list(await api.contests(auth.accessToken()!, { page_size: 50 }))
        .filter((c: ContestListItem) => c.key !== this.contest?.key)
        .sort((a: ContestListItem, b: ContestListItem) => Date.parse(String(b.end_time)) - Date.parse(String(a.end_time)));
    } catch { /* feed unavailable — scope select keeps its standing options */ }
    if (!alive()) return;
    const scopeOptions = [
      `<option value="global"${scopeRaw === "global" ? " selected" : ""}>${text("subs.scopeGlobal")}</option>`,
      `<option value="public"${scopeRaw === "public" ? " selected" : ""}>${text("subs.scopePublic")}</option>`,
      ...(this.contest ? [`<option value="contest:${esc(this.contest.key)}"${scopeRaw === `contest:${this.contest.key}` ? " selected" : ""}>${text("subs.scopeContest")} · ${esc(this.contest.name)}</option>`] : []),
      ...pastJoined.map(c => `<option value="contest:${esc(c.key)}"${scopeRaw === `contest:${c.key}` ? " selected" : ""}>${esc(c.name)}</option>`),
    ].join("");
    // problem sub-select per scope: contest scopes list that contest's problems with the
    // official "Bài <letter>" naming; Public uses the completed problems index; a scope
    // whose problem list isn't ready (public, pre-index) falls back to the smart text box
    const tabWord = text("contests.tabWord");
    const problemField = scopeRaw === "global" ? ""
      : isContestScope && contestProblems.length ? `<div class="tm-field"><label for="tm-subs-problem">${text("subs.problem")}</label><select id="tm-subs-problem" name="problem"><option value="">${text("subs.allProblems")}</option>${contestProblems.map(p => { const label = `${tabWord} ${this.idxLetters(p.display_index ?? contestProblems.findIndex(x => x.code === p.code))}`; return `<option value="${esc(p.code)}"${p.code === scopeProblem ? " selected" : ""}>${esc(label)}${p.name ? ` — ${esc(p.name)}` : ""}</option>`; }).join("")}</select></div>`
      : scopeRaw === "public" && this.problemsIndex?.complete ? `<div class="tm-field"><label for="tm-subs-problem">${text("subs.problem")}</label><select id="tm-subs-problem" name="problem"><option value="">${text("subs.allProblems")}</option>${this.problemsIndex.items.map(p => `<option value="${esc(String(p.code))}"${String(p.code).toUpperCase() === problemQ.toUpperCase() ? " selected" : ""}>${esc(String(p.code).toUpperCase())} — ${esc(String(p.name))}</option>`).join("")}</select></div>`
      : `<div class="tm-field"><label for="tm-subs-problem">${text("subs.problem")}</label><input id="tm-subs-problem" name="problem" placeholder="${text("subs.problemPlaceholder")}" value="${esc(problem)}"></div>`;
    const userField = isContestScope ? "" : `<div class="tm-field"><label for="tm-subs-user">${text("subs.user")}</label><input id="tm-subs-user" name="user" placeholder="${text("subs.user")}" value="${esc(user)}"></div>`;
    const mineField = isContestScope ? "" : `<label class="tm-check tm-filter-check"><input type="checkbox" name="mine" value="1"${mine ? " checked" : ""}>${text("subs.mine")}</label>`;
    // pass #54 (same case as problems): the filter form floats free — the bordered
    // card wraps ONLY the table
    host.innerHTML = this.pageTitle("subs.eyebrow","subs.title","subs.desc","subs.refresh") + `<form class="tm-filter-form" role="search"><div class="tm-filter-fields"><div class="tm-field"><label for="tm-subs-scope">${text("subs.scopeLabel")}</label><select id="tm-subs-scope" name="scope">${scopeOptions}</select></div>${userField}${problemField}<div class="tm-field"><label for="tm-subs-result">${text("subs.result")}</label><select id="tm-subs-result" name="result"><option value="">${text("subs.allResults")}</option>${SUBS_RESULTS.map(s=>`<option${result === s ? " selected" : ""}>${s}</option>`).join("")}</select></div><div class="tm-field tm-field-narrow"><label for="tm-subs-size">${text("subs.pageSize")}</label><select id="tm-subs-size" name="pageSize">${sizeOptions.map(n=>`<option value="${n}"${n === pageSize ? " selected" : ""}>${n}</option>`).join("")}</select></div>${mineField}</div><div class="tm-filter-actions"><button class="tm-button primary" type="submit">${text("common.search")}</button>${activeFilter ? `<button class="tm-button ghost" type="button" data-action="clear">${text("contests.clearFilter")}</button>` : ""}</div></form><section class="tm-card"><div class="tm-table-wrap"><table class="tm-table tm-subs-table"><thead><tr>${["subs.id","subs.user","subs.problem","subs.date","subs.language","subs.result","subs.score"].map(k=>`<th>${text(k as DictKey)}</th>`).join("")}<th class="tm-col-eye"><span class="sr-only">${text("subs.details")}</span></th></tr></thead><tbody>${pageView().map(rowHtml).join("")}</tbody></table>${rows.length ? "" : empty()}</div></section>`;
    const clearFilter = host.querySelector<HTMLButtonElement>('[data-action="clear"]');
    // audit: clear must ALSO forget the remembered filters — value() falls back to
    // SUBS_FILTERS_KEY, so an empty-params go() alone just re-applied the old filter
    if (clearFilter) clearFilter.onclick = () => { try { localStorage.removeItem(SUBS_FILTERS_KEY); } catch { /* storage off */ } this.go("submissions",{}); };
    host.querySelector<HTMLFormElement>("form")!.onsubmit = e => { e.preventDefault(); this.go("submissions",Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement)) as Record<string,string>); };
    wireRows();
    // official polls this view — refresh quietly in place (audit: Refresh did nothing)
    const refine = (fresh: any[]): any[] => fresh.filter(s =>
      (!subId || String(s.id) === subId) &&
      (!pMatch || pMatch(String(s.problem_name ?? s.problem ?? "")) || pMatch(String(s.problem ?? ""))) &&
      (!uMatch || uMatch(String(s.user_display_name ?? s.user ?? ""))));
    const poll = window.setInterval(() => {
      if (!alive()) { window.clearInterval(poll); return; }
      if (document.hidden) return; // minimized: skip the beat — rows refresh on return
      const req = isContestScope
        ? api.contestSubmissions(auth.accessToken()!, contestKey).then((payload: any) => applyContestFilters(list(payload?.items)))
        : api.submissions(auth.accessToken()!,{page,page_size:pageSize,scope:serverScope,problem:serverProblem,user:serverUser,result}).then(r => refine(list(r)));
      void req.then(fresh => {
        if (!alive()) { window.clearInterval(poll); return; }
        rows = fresh;
        paintRows();
      }).catch(() => { /* transient — next tick retries */ });
    }, 10_000);
    this.pager(host,page,isContestScope ? rows.length : pageView().length,params,pageSize);
  }

  // pass #52 — official x_/b_ detail anatomy (carve @456099, live server case schema
  // verified with curl: case_id/batch_id/status/time/memory/points/total/feedback/
  // output/extended_feedback): summary line + the case table; batched groups recurse
  // as "Nhóm #N" rows; each leaf test toggles its Output (rút gọn) + judge feedback
  // panels tinted by verdict. Times render toFixed(3) s, memory KB → MB (carve v_/y_).
  private submissionDetailHtml(s: any): string {
    const fmtT = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "—";
    const fmtM = (v: unknown): string => typeof v === "number" && Number.isFinite(v) ? `${(v / 1024).toFixed(2)} MB` : "—";
    const pill = (status: unknown): string => {
      const r = String(status ?? "—");
      return `<span class="tm-result-pill${r === "AC" ? " ok" : r === "—" ? " pending" : " bad"}">${esc(r)}</span>`;
    };
    const panels = (c: any): string => {
      const out = typeof c.output === "string" && c.output ? c.output.slice(0, 10_000) : ""; // "(rút gọn)" is honest: capped
      const fb = [c.extended_feedback, c.feedback].find((v: unknown): v is string => typeof v === "string" && !!v.trim()) ?? "";
      const tone = String(c.status ?? "") === "AC" ? "ok" : "bad";
      return `${out ? `<div class="tm-case-panel info"><b>${text("subs.yourOutput")}</b><pre>${esc(out)}</pre></div>` : ""}${fb ? `<div class="tm-case-panel ${tone}"><b>${text("subs.judgeFeedback")}</b><pre>${esc(fb)}</pre></div>` : ""}`;
    };
    const caseRows = (items: any[], group: number | null): string => (Array.isArray(items) ? items : []).map((c: any) => {
      if (!c || typeof c !== "object") return "";
      const batch = typeof c.batch_id === "number" ? c.batch_id : null;
      const leaf = batch == null;
      const panelHtml = panels(c);
      const testCell = leaf
        ? (panelHtml ? `<button type="button" class="tm-case-toggle" data-case-toggle aria-expanded="false"><span>#${esc(c.case_id ?? "—")}</span>${caseChevronSvg}</button>` : `#${esc(c.case_id ?? "—")}`)
        : "—";
      const groupCell = leaf ? (group == null ? "—" : text("subs.groupN", { n: group })) : text("subs.groupN", { n: batch! });
      return `<tr><th scope="row" class="tm-case-cell">${testCell}</th><td>${esc(groupCell)}</td><td>${leaf ? pill(c.status) : "—"}</td><td class="tm-case-number">${esc(fmtT(c.time))}</td><td class="tm-case-number">${esc(fmtM(c.memory))}</td><td>${esc(c.points ?? "—")} / ${esc(c.total ?? "—")}</td></tr>${panelHtml ? `<tr class="tm-case-panel-row" hidden><td colspan="6">${panelHtml}</td></tr>` : ""}${Array.isArray(c.cases) && c.cases.length ? caseRows(c.cases, batch) : ""}`;
    }).join("");
    const casesHtml = Array.isArray(s.cases) && s.cases.length
      ? `<div class="tm-sub-cases-wrap"><table class="tm-sub-cases" aria-label="${text("subs.testcase")}"><thead><tr><th>${text("subs.testcase")}</th><th>${text("subs.group")}</th><th>${text("subs.result")}</th><th>${text("subs.time")} (s)</th><th>${text("subs.memory")} (MB)</th><th>${text("subs.score")}</th></tr></thead><tbody>${caseRows(s.cases, null)}</tbody></table></div>`
      : `<p class="tm-muted">${text("subs.noCaseDetail")}</p>`;
    return `<div class="tm-sub-detail"><p class="tm-sub-detail-summary">${text("subs.testSummary", { p: String(s.case_points ?? "—"), t: String(s.case_total ?? "—"), time: fmtT(s.time), mem: fmtM(s.memory) })}</p>${casesHtml}</div>`;
  }

  private wireCaseToggles(scope: ParentNode): void {
    scope.querySelectorAll<HTMLButtonElement>("[data-case-toggle]").forEach(b => b.onclick = () => {
      const tr = b.closest("tr");
      const panel = tr?.nextElementSibling;
      if (!tr || !(panel instanceof HTMLElement) || !panel.classList.contains("tm-case-panel-row")) return;
      const open = panel.hidden;
      panel.hidden = !open;
      b.setAttribute("aria-expanded", String(open));
      b.classList.toggle("open", open);
    });
  }

  // pass #52 — official g_/h_ source page (carve @451440): "Quay lại bài nộp" back,
  // "Source Code" title with the #id · language subtitle, line-number gutter, and C++
  // token highlighting for CPP* languages. The old in-detail [Source code] button is
  // gone — the #ID click IS the jump to source.
  private async submissionSource(host: HTMLElement, params: URLSearchParams, id: number, scope: string, alive: () => boolean): Promise<void> {
    host.innerHTML = `<section class="tm-source-page"><div class="tm-source-actions"><button type="button" class="tm-button" data-action="back-subs">${text("subs.backToSubs")}</button></div><div class="tm-page-title tm-source-title"><div><h1>${text("subs.sourceTitle")}</h1><p class="tm-muted" data-source-sub>#${id}</p></div></div><div data-source-body role="status"><p class="tm-muted">${text("subs.loadingSource")}</p></div></section>`;
    host.querySelector<HTMLButtonElement>('[data-action="back-subs"]')!.onclick = () => {
      const next = { ...Object.fromEntries(params) };
      delete next.source;
      this.go("submissions", next);
    };
    const body = host.querySelector<HTMLElement>("[data-source-body]")!;
    try {
      // pass #58: contest-scope source rides the scoped endpoint (detailScope "contest:<key>")
      const contestKey = scope.startsWith("contest:") ? scope.slice(8) : "";
      const data = contestKey
        ? await api.contestSubmissionSource(auth.accessToken()!, contestKey, id)
        : await raw(`/submissions/${id}/source${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, { token: auth.accessToken() });
      if (!alive()) return;
      const sourceCode = typeof data?.source === "string" ? data.source : "";
      if (!sourceCode) { body.innerHTML = `<p class="tm-muted">${text("subs.noSourceProvided")}</p>`; return; }
      const lang = String(data?.language ?? "");
      const sub = host.querySelector<HTMLElement>("[data-source-sub]");
      if (sub) sub.textContent = `#${id}${lang ? ` · ${langName(lang)}` : ""}`;
      const lines = sourceCode.split("\n").length;
      const codeHtml = /^CPP/i.test(lang) ? cppHighlight(sourceCode) : esc(sourceCode);
      body.removeAttribute("role");
      body.innerHTML = `<div class="tm-source-viewer" tabindex="0" role="region" aria-label="${esc(text("subs.sourceAria", { n: String(id) }))}"><pre class="tm-source-gutter" aria-hidden="true">${Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</pre><pre class="tm-source-code"><code>${codeHtml}</code></pre></div>`;
    } catch (e) {
      if (!alive()) return;
      body.innerHTML = errorBox(e) + button("common.retry", "source-retry");
      host.querySelector<HTMLButtonElement>('[data-action="source-retry"]')!.onclick = () => void this.submissionSource(host, params, id, scope, alive);
    }
  }

  // global rankings cache: /users is server-paged with no count metadata and no sort
  // param — a global sort fetches every page once (cap 500 pages), then sorts +
  // pages client-side. A complete sweep also lands in localStorage (15-minute TTL),
  // so the next open paints instantly like the web OJ's first page.
  private rankingsAll: any[] | null = null;
  // one sweep at a time (audit D1): a render that joins mid-sweep attaches to it —
  // navigating away and back must never launch a second 206-request walk
  private rankingsSweep: Promise<any[]> | null = null;
  private rankingsProgress: ((rows: any[]) => void)[] = [];
  private async fetchAllUsers(onProgress?: (rowsSoFar: any[]) => void): Promise<any[]> {
    if (this.rankingsAll) return this.rankingsAll;
    if (onProgress) this.rankingsProgress.push(onProgress);
    if (!this.rankingsSweep) {
      const run = (async () => {
        const PS = 100; // server caps /users page_size at 100 (422 above) — verified live
        const out: any[] = [];
        const seen = new Set<string>();
        let complete = false;
        let failures = 0;
        // pass #65: shape each row ONCE at sweep time — pinning raw /users objects kept
        // every server field resident for the app's lifetime; rankings reads only these
        const trim = (r: any) => ({ username: String(r.username), display_name: typeof r.display_name === "string" ? r.display_name : "",
          organization: r.organization ? { name: r.organization.name ?? null, short_name: r.organization.short_name ?? null } : null,
          rating: typeof r.rating === "number" ? r.rating : null,
          points: typeof r.points === "number" ? r.points : 0, problem_count: typeof r.problem_count === "number" ? r.problem_count : 0 });
        // pass #54/#57: pacer-gated walk — the cap forbids bigger pages, so the sweep
        // speed lives in adaptive concurrency; hard page cap and short-page detection
        // unchanged
        const walk = await this.sweepWalk(500, p => `/users?page=${p}&page_size=${PS}`, auth.accessToken()!, batch => {
          for (const u of batch) {
            if (!u || typeof u.username !== "string" || seen.has(u.username)) continue;
            seen.add(u.username); out.push(trim(u));
          }
          for (const cb of this.rankingsProgress) cb(out);
        });
        failures += walk.failures;
        complete = walk.stopped && failures === 0;
        // pass #56: only a failure-free sweep may pin — 429-gapped pages would sort wrong
        if (failures === 0) this.rankingsAll = out;
        else logInfo(`rankings sweep incomplete: ${failures} pages failed — resweeping on next visit`);
        logInfo(`rankings sweep ${complete ? "complete" : "partial"}: ${out.length} users`);
        // only a complete sweep is worth caching — a truncated list would sort wrong until refetch
        if (complete && out.length) {
          try { write("delcc-rankings-cache", JSON.stringify({ t: Date.now(), rows: out })); } catch { /* storage full — in-memory cache still applies */ }
        }
        return out;
      })();
      this.rankingsSweep = run;
      void run.finally(() => { this.rankingsProgress = []; if (this.rankingsSweep === run) this.rankingsSweep = null; });
    }
    return this.rankingsSweep;
  }
  // paint from a recent cached sweep instead of re-fetching; stale/malformed entries
  // are ignored and untrusted rows are re-shaped before they reach the table
  private hydrateRankingsCache(): boolean {
    if (this.rankingsAll) return true;
    try {
      const parsed = JSON.parse(read("delcc-rankings-cache")) as { t?: unknown; rows?: unknown };
      if (typeof parsed?.t !== "number" || Date.now() - parsed.t > 15 * 60_000 || !Array.isArray(parsed.rows)) return false;
      const rows = (parsed.rows as any[]).filter(r => r && typeof r.username === "string");
      if (!rows.length) return false;
      this.rankingsAll = rows;
      return true;
    } catch { return false; }
  }
  private async rankings(host: HTMLElement, alive: () => boolean): Promise<void> {
    const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
    // pass #59: inside a contest the Rankings page IS the contest standings (Official's
    // "Kết quả cuộc thi"); a chip switches back to the global user rankings
    if (this.contest && params.get("scope") !== "global") {
      await this.contestRankings(host, params, alive);
      return;
    }
    const requestedPage = Number(params.get("page") ?? "1");
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
      && requestedPage <= Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE) ? requestedPage : 1;
    const search = (params.get("search") ?? "").trim().slice(0,200);
    const visiblePage = search ? 1 : page;
    params.set("page",String(visiblePage));
    if (search) params.set("search",search); else params.delete("search");
    const query = new URLSearchParams({page:String(page),page_size:String(PAGE_SIZE)});
    // /users is server-paged; only /users/{username} supports a documented lookup.
    // Its rank field is a profile title, so list position is computed from the
    // returned page. An exact lookup does not establish a leaderboard position.
    let rows: any[];
    try {
      rows = search ? [await raw(`/users/${encodeURIComponent(search)}`,{token:auth.accessToken()})]
        : list(await raw(`/users?${query}`,{token:auth.accessToken()}));
    } catch(e) { if (search && e instanceof ApiError && e.status === 404) rows = []; else throw e; }
    if (!alive()) return;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString(getLocale()) : "—";
    // column-header sort like Problems — but GLOBAL: first sort fetches every page once
    const SORTS: Record<string, (r: any) => number> = { rating: r => Number(r.rating ?? -1), points: r => Number(r.points ?? -1), solved: r => Number(r.problem_count ?? -1) };
    const savedSort = read("delcc-rankings-sort", "");
    let [sortKey, sortDir] = savedSort.split(":");
    // hasOwnProperty, not `in` (audit B1): "constructor" etc. pass an `in` check and
    // then silently NaN every comparison — a corrupted pref must reset, not zombie
    if (!Object.prototype.hasOwnProperty.call(SORTS, sortKey)) sortKey = "";
    if (sortDir !== "asc" && sortDir !== "desc") sortDir = "desc";
    // web-OJ feel: paint NOW with what's in hand (cached sweep or the fetched page),
    // then re-sort live as each batch of the global sweep lands — never a bare wait
    const sortAll = (data: any[]): any[] =>
      [...data].sort((a, b) => (sortDir === "asc" ? 1 : -1) * (SORTS[sortKey](a) - SORTS[sortKey](b)));
    const sortedPage = (data: any[]): any[] => sortAll(data).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    let display = rows;
    let loadingAll = false;
    if (sortKey && !search) {
      if (this.hydrateRankingsCache()) display = sortedPage(this.rankingsAll!);
      else { display = sortedPage(rows); loadingAll = true; }
    }
    const rowHtml = (r: any, index: number): string => `<tr data-profile="${esc(r.username)}"><td>${search ? "—" : number((page - 1) * PAGE_SIZE + index + 1)}</td><td><a href="#/account?user=${encodeURIComponent(r.username)}">${esc(r.display_name || r.username)}</a><br><small class="tm-muted">@${esc(r.username)}</small></td><td>${esc(r.organization?.name || r.organization?.short_name || "—")}</td><td${ratingStyle(r.rating)}>${r.rating == null ? "—" : esc(fmtRateCol(r.rating))}</td><td>${number(r.points)}</td><td>${number(r.problem_count)}</td></tr>`;
    const arrow = (k: string) => sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : "";
    // pass #59: inside a contest the global view gains the chip back to contest standings
    const lbChips = !this.contest ? "" : `<div class="tm-chip-row" role="group" aria-label="${text("subs.scopeLabel")}"><button type="button" class="tm-chip" data-lb-contest aria-pressed="false">${text("subs.scopeContest")}</button><button type="button" class="tm-chip active" aria-pressed="true">${text("subs.scopeGlobal")}</button></div>`;
    host.innerHTML = this.pageTitle("rankings.eyebrow","rankings.title","rankings.desc","common.refresh") + lbChips + `<section class="tm-card">
      <form class="tm-toolbar tm-card-header"><input name="search" aria-label="${text("rankings.search")}" placeholder="${text("rankings.search")}" value="${esc(search)}" maxlength="200" aria-describedby="tm-rankings-search-hint"><button class="tm-button" type="submit">${text("common.search")}</button>${search ? `<button class="tm-button" type="button" data-action="rankings-all">${text("common.all")}</button>` : ""}</form>
      <p class="tm-card-body tm-muted" id="tm-rankings-search-hint">${text("rankings.searchHint")}</p>${loadingAll ? `<p class="tm-card-body tm-muted" data-rankings-busy role="status">${text("rankings.sortGlobalProgress",{n:String(rows.length)})}</p>` : ""}
      <div class="tm-table-wrap"><table class="tm-table"><thead><tr>${["rankings.rank","rankings.user","rankings.school"].map(k=>`<th scope="col"${k === "rankings.rank" ? ` title="${text("rankings.position")}"` : ""}>${text(k as DictKey)}</th>`).join("")}${[["rating","rankings.rating"],["points","rankings.points"],["solved","rankings.solved"]].map(([k, key]) => `<th scope="col"><button type="button" class="tm-sort-h" data-rsort="${k}" title="${text("rankings.sortGlobal")}">${text(key as DictKey)}${arrow(k)}</button></th>`).join("")}</tr></thead><tbody>${display.map((r,index)=>rowHtml(r,index)).join("")}</tbody></table>${rows.length ? "" : empty("rankings.empty")}</div>
    </section>`;
    host.querySelectorAll<HTMLButtonElement>("[data-rsort]").forEach(btn => btn.onclick = () => {
      const k = btn.dataset.rsort!;
      const next = sortKey === k && sortDir === "asc" ? `${k}:desc` : sortKey === k && sortDir === "desc" ? "" : `${k}:asc`;
      write("delcc-rankings-sort", next);
      if (alive()) void this.render();
    });
    host.querySelector<HTMLFormElement>("form")!.onsubmit = e => {
      e.preventDefault(); if (!alive()) return;
      this.go("rankings",{search:String(new FormData(e.currentTarget as HTMLFormElement).get("search") ?? "").trim().slice(0,200)});
    };
    const all = host.querySelector<HTMLButtonElement>('[data-action="rankings-all"]');
    if (all) all.onclick = () => { if (alive()) this.go("rankings"); };
    const wireRows = (scope: ParentNode): void => {
      scope.querySelectorAll<HTMLElement>("[data-profile]").forEach(row => row.onclick = e => {
        if (!alive() || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey
          || (e.target as Element).closest("a") || window.getSelection()?.toString()) return;
        this.go("account",{user:row.dataset.profile!});
      });
    };
    wireRows(host);
    if (loadingAll) {
      // surgical repaints per landed batch: tbody + busy counter + pager, never the
      // whole card (the sort buttons the user may be pressing stay wired)
      const tbody = host.querySelector("tbody")!;
      const busy = host.querySelector<HTMLElement>("[data-rankings-busy]");
      const repaint = (data: any[]): void => {
        if (!alive() || !tbody.isConnected) return;
        tbody.innerHTML = sortedPage(data).map((r, index) => rowHtml(r, index)).join("");
        wireRows(tbody);
        this.pager(host, visiblePage, search ? 0 : data.length, params);
      };
      try {
        // pass #57: coalesce the per-batch repaints — the pacer lands pages continuously
        // and each repaint re-sorts the whole accumulated list, so a 250 ms trailing
        // throttle keeps the table live at a fraction of the cost (the final paint
        // below is unconditional, nothing can strand stale)
        let lastPaint = 0, pending: any[] | null = null, timer = 0;
        await this.fetchAllUsers(soFar => {
          if (busy) busy.textContent = text("rankings.sortGlobalProgress", { n: String(soFar.length) });
          pending = soFar;
          const now = Date.now();
          if (now - lastPaint >= 250) { lastPaint = now; repaint(soFar); }
          else if (!timer) timer = window.setTimeout(() => {
            timer = 0; lastPaint = Date.now();
            if (pending) repaint(pending);
          }, 250 - (now - lastPaint));
        });
        if (timer) window.clearTimeout(timer);
      } catch { /* keep the fetched page and the busy line as-is */ }
      if (!alive()) return;
      repaint(this.rankingsAll?.length ? this.rankingsAll : rows);
      if (busy) busy.remove();
    }
    const total = search ? 0 : sortKey && this.rankingsAll ? this.rankingsAll.length : rows.length;
    this.pager(host, visiblePage, total, params);
    const lbBack = host.querySelector<HTMLButtonElement>('[data-lb-contest]');
    if (lbBack) lbBack.onclick = () => this.go("rankings", {});
  }

  // pass #59 — contest-scoped standings (Official "Kết quả cuộc thi", He's screenshots).
  // /contests/{key}/leaderboard returns a BARE array (live schema: rank is a STRING,
  // points/cumulative_time numbers in seconds, tiebreaker, is_disqualified,
  // participation_type, rating, problem_cells[] with has_data/penalty/points/time/status
  // "full-score|partial-score|…"). Problem headers (labels + max points) are not in the
  // payload — they pair by index with /contests/{key}/problems. Anatomy: green AC tiles
  // (score + AC time + red non-AC attempt count), amber partial tiles, grey "—",
  // row hover tint, own row tinted + [You] tag, QoL: sticky name columns, sticky header,
  // stickied own row. 30 s quiet re-poll with a fresh "Cập nhật lúc" stamp.
  private async contestRankings(host: HTMLElement, params: URLSearchParams, alive: () => boolean): Promise<void> {
    const key = this.contest!.key;
    let entries: any[] = [], problems: ContestProblem[] = [], denied = false;
    try {
      const [lb, ps] = await Promise.all([
        api.leaderboard(auth.accessToken()!, key),
        api.contestProblems(auth.accessToken()!, key).catch(() => [] as ContestProblem[]),
      ]);
      entries = list(lb); problems = ps;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) denied = true;
      else throw e;
    }
    if (!alive()) return;
    const fmtClock = (v: unknown): string => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return "—";
      const s = Math.round(n);
      return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, "0")).join(":");
    };
    const fmtNum = (value: unknown): string => {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString(getLocale()) : "—";
    };
    const me = String(this.user?.username ?? "");
    const medal = (rank: string): string => { const n = Number(rank); return n === 1 ? " gold" : n === 2 ? " silver" : n === 3 ? " bronze" : ""; };
    const nameMark = (e: any): string =>
      (typeof e.participation_type === "number" && e.participation_type > 0 ? ` <span class="tm-lb-virtual" aria-hidden="true">†</span><span class="sr-only">${text("contests.virtualMode")}</span>` : "") +
      (e.participation_type === -1 ? ` <span class="tm-lb-virtual" aria-hidden="true">‡</span>` : "") +
      (e.is_disqualified ? ` <span class="tm-tag tm-lb-dq">DQ</span>` : "");
    // pass #73/#80 — CARVE COPY (assets__index-Sy2kLOLY.css .leaderboard-* +
    // docs/tmath-contest-ranking-page.md): solid verdict tiles in the carve's dark
    // palette, score-fastest = the fastest AC per problem (Official has it), self row
    // = the carve's 8%-primary mix. The frozen-column split (pass #80) carries the
    // sticky-first-four-columns outdo: info columns live in a lockstep pane, so no
    // paint region ever overlaps a tile.
    const fastest = problems.map((_, i) => {
      let m = Infinity;
      for (const e of entries) {
        const c = (Array.isArray(e?.problem_cells) ? e.problem_cells : [])[i];
        if (c?.has_data && this.scoreClass(String(c.status ?? "")) === "score-full") {
          const t = Number(c.time);
          if (Number.isFinite(t) && t < m) m = t;
        }
      }
      return m;
    });
    const cellHtml = (c: any, i: number, you: boolean): string => {
      if (!c || !c.has_data) return `<td class="score-empty">—</td>`;
      const tone = this.scoreClass(typeof c.status === "string" ? c.status : "");
      const isFull = tone === "score-full";
      const cls = isFull ? (Number(c.time) === fastest[i] ? "score-fastest" : "score-full") : tone === "score-partial" ? "score-partial" : "score-failed";
      const pen = Number(c.penalty);
      // pass #77 (He's outdo): YOUR verdicted tiles are clickable — jump to the
      // contest-scoped Submissions view filtered to that problem's AC results
      const code = String(problems[i]?.code ?? "");
      const jump = you && code ? ` class="${cls} ac-jump" data-ac-jump="${esc(code)}" title="${esc(text("rankings.acJump"))}" tabindex="0" role="link"` : ` class="${cls}"`;
      return `<td ${jump}><strong>${esc(fmtNum(c.points))}</strong><small class="score-time">${esc(fmtClock(c.time))}${Number.isFinite(pen) && pen > 0 ? ` <span class="score-penalty">(${pen})</span>` : ""}</small></td>`;
    };
    // pass #80: each entry renders as a ROW PAIR — the left (info) row and the right
    // (tile) row share the index, so hover/self sync is positional. The frozen left
    // pane IS the sticky-columns outdo (He: keep it), without sticky-cell artifacts.
    const rowHtml = (e: any, i: number): { left: string; right: string } => {
      const username = String(e.username ?? "");
      const you = !!me && username === me;
      const self = you ? " leaderboard-self" : "";
      const left = `<tr class="tm-lb-row${self}"><th scope="row" class="tm-lb-rank-cell"><span class="tm-lb-rank${medal(String(e.rank ?? ""))}">${esc(String(e.rank ?? "—"))}</span></th><td class="tm-lb-user"><a href="#/account?user=${encodeURIComponent(username)}"${ratingStyle(e.rating)}>${esc(String(e.fullname ?? username))}</a>${nameMark(e)}${you ? ` <span class="tm-tag tm-lb-you">${text("rankings.you")}</span>` : ""}</td><td class="tm-lb-total"><strong>${esc(fmtNum(e.points))}</strong></td><td class="tm-lb-time">${esc(fmtClock(e.cumulative_time))}</td></tr>`;
      const cells = Array.isArray(e.problem_cells) ? e.problem_cells : [];
      const right = `<tr class="tm-lb-row${self}">${problems.map((_, k) => cellHtml(cells[k], k, you)).join("")}</tr>`;
      return { left, right };
    };
    const tabWord = text("contests.tabWord");
    // pass #77/#80: the [You] ghost — a strip BELOW the split (never a sticky footer
    // inside it: that floats over the last visible rows — He's clipping), shown only
    // while the real row is out of view (IntersectionObserver on the real row; rebuilt
    // per paint, disposed with the view). Palette = the self-row carve hue.
    let youObserver: IntersectionObserver | null = null;
    let wheelForward: ((ev: WheelEvent) => void) | null = null;
    let scrollSync: (() => void) | null = null;
    // pass #80, THE scramble fix: every 30 s poll rebuilt tbody.innerHTML while the
    // wrap was scrolled/hovered, and the compositor served ONE frame mixing the old
    // tile rasters with the fresh sticky pins — He's "clippings"/scramble that survived
    // every CSS fix (the harness only ever glitched within ~2 s of a poll tick). A poll
    // whose payload is unchanged now touches nothing but the timestamp.
    let lastLb = "";
    const paint = (): void => {
      const stamp = host.querySelector<HTMLElement>("[data-lb-updated]");
      const sig = JSON.stringify(entries);
      if (sig === lastLb) {
        if (stamp) stamp.textContent = text("rankings.updatedAt", { t: new Date().toLocaleTimeString(getLocale()) });
        return;
      }
      lastLb = sig;
      const leftBody = host.querySelector<HTMLTableSectionElement>("[data-lb-left]");
      const rightBody = host.querySelector<HTMLTableSectionElement>("[data-lb-right]");
      const rightPane = host.querySelector<HTMLElement>(".tm-lb-right");
      const leftPane = host.querySelector<HTMLElement>(".tm-lb-left");
      const pairs = entries.map((e, i) => rowHtml(e, i));
      if (leftBody) leftBody.innerHTML = pairs.map(p => p.left).join("");
      if (rightBody) rightBody.innerHTML = pairs.map(p => p.right).join("");
      const you = rightBody?.querySelector("tr.leaderboard-self");
      const ghost = host.querySelector<HTMLDivElement>("[data-lb-ghost]");
      youObserver?.disconnect(); youObserver = null;
      if (you && rightPane && ghost) {
        // pass #83 (He's vision): the ghost is a MIRRORED MINI-SPLIT — the [You] row
        // rendered as a real row in real columns (info pane 600px + tiles pane that
        // follows the right pane's horizontal scroll), not a merged text bar. It reads
        // your scores under whichever problem columns you're looking at.
        const e = entries.find(r => String(r?.username ?? "") === me);
        if (e) {
          const pair = rowHtml(e, entries.indexOf(e));
          const cols = problems.map(() => `<col style="width:100px">`).join("");
          ghost.innerHTML = `<table class="tm-table tm-lb-table" style="width:600px"><colgroup><col style="width:64px"><col style="width:280px"><col style="width:112px"><col style="width:144px"></colgroup><tbody>${pair.left}</tbody></table><div class="tm-lb-ghost-right"><table class="tm-table tm-lb-table" style="width:${problems.length * 100}px;min-width:100%"><colgroup>${cols}</colgroup><tbody>${pair.right}</tbody></table></div>`;
        }
        youObserver = new IntersectionObserver(obs => {
          for (const en of obs) {
            if (!ghost) continue;
            ghost.hidden = en.isIntersecting;
            // pass #83: track WHICH side the row left the view from — above the fold
            // pins the ghost under the header, below pins it to the bottom edge
            // (He: a bottom-only bar is misleading when you're rank 2)
            if (!en.isIntersecting) {
              const above = en.rootBounds != null && en.boundingClientRect.bottom <= en.rootBounds.top + 1;
              ghost.classList.toggle("tm-lb-ghost-top", above);
            }
          }
        }, { root: rightPane, threshold: 0 });
        youObserver.observe(you);
      }
      // hover sync: rows are positional across the panes — entering a row in either
      // pane tints BOTH (the wash renders on the info pane, exactly Official's visual)
      if (leftBody && rightBody) {
        const leftRows = Array.from(leftBody.children) as HTMLElement[];
        const rightRows = Array.from(rightBody.children) as HTMLElement[];
        const setHover = (i: number, on: boolean): void => {
          leftRows[i]?.classList.toggle("tm-hover", on);
          rightRows[i]?.classList.toggle("tm-hover", on);
        };
        for (const [rows, pane] of [[leftRows, leftBody], [rightRows, rightBody]] as const) {
          pane.onmouseover = (ev: Event): void => {
            const tr = (ev.target as HTMLElement).closest("tr");
            const i = tr ? rows.indexOf(tr) : -1;
            if (i >= 0) setHover(i, true);
          };
          pane.onmouseout = (ev: Event): void => {
            const tr = (ev.target as HTMLElement).closest("tr");
            const i = tr ? rows.indexOf(tr) : -1;
            if (i >= 0) setHover(i, false);
          };
        }
      }
      // vertical + horizontal lockstep (He: the left pane MUST scroll the tiles): the
      // right pane is the only real scroller; the left pane never scrolls itself (its
      // sticky thead lagged one frame under a programmatic scrollTop) — wheel input over
      // it is FORWARDED into the right pane and the tbody follows via transform, which
      // the compositor applies without any per-frame sticky repositioning.
      if (rightPane && leftBody && leftPane) {
        if (wheelForward) leftPane.removeEventListener("wheel", wheelForward);
        if (scrollSync) rightPane.removeEventListener("scroll", scrollSync);
        wheelForward = (ev: WheelEvent): void => {
          ev.preventDefault();
          // pass #82: forward only the DOMINANT axis — mice emit tiny diagonal noise on
          // every tick and forwarding it verbatim made the tiles "randomly snap" left
          if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) rightPane.scrollLeft += ev.deltaX;
          else rightPane.scrollTop += ev.deltaY;
        };
        scrollSync = (): void => {
          leftBody.style.transform = `translateY(${-rightPane.scrollTop}px)`;
          // pass #83: the ghost's tile pane rides the same horizontal offset — its
          // columns stay glued to the headers above ("a real column, not a hard merge")
          const gr = host.querySelector<HTMLElement>(".tm-lb-ghost-right");
          if (gr) gr.style.transform = `translateX(${-rightPane.scrollLeft}px)`;
        };
        leftPane.addEventListener("wheel", wheelForward, { passive: false });
        rightPane.addEventListener("scroll", scrollSync);
        // the right pane's horizontal scrollbar costs it ~10 px of viewport the left
        // pane doesn't lose — without this the left edge shows a sliver of the next row
        // the right pane can't (He: "why did it just draw another row")
        leftPane.style.paddingBottom = `${Math.max(0, rightPane.offsetWidth - rightPane.clientWidth)}px`;
        scrollSync();
      }
      // your verdicted tiles jump to the problem's AC submissions (contest scope)
      rightBody?.querySelectorAll<HTMLTableCellElement>("[data-ac-jump]").forEach(td => {
        const jump = (): void => this.go("submissions", { scope: `contest:${key}`, problem: td.dataset.acJump ?? "", result: "AC" });
        td.onclick = jump;
        td.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); jump(); } };
      });
      if (stamp) stamp.textContent = text("rankings.updatedAt", { t: new Date().toLocaleTimeString(getLocale()) });
    };
    const head = problems.map((p, i) => {
      // pass #76: K59 ships numeric labels ("0".."9") — Official renders letters, so a
      // purely numeric label falls back to the "Bài + letter" mapping
      const raw = p.label == null ? "" : String(p.label);
      const label = raw && !/^\d+$/.test(raw) ? raw : `${tabWord} ${this.idxLetters(typeof (p as any).display_index === "number" ? (p as any).display_index : i)}`;
      return `<th class="tm-lb-pcol" scope="col"><span>${esc(label)}</span><small>${esc(text("rankings.maxPoints", { n: fmtNum(p.points ?? 0) }))}</small></th>`;
    }).join("");
    const chips = `<div class="tm-chip-row" role="group" aria-label="${text("subs.scopeLabel")}"><button type="button" class="tm-chip active" aria-pressed="true">${text("subs.scopeContest")}</button><button type="button" class="tm-chip" data-lb-global aria-pressed="false">${text("subs.scopeGlobal")}</button><button type="button" class="tm-chip" data-lb-refresh>↻ ${text("common.refresh")}</button></div>`;
    // pass #80: page + card structure mirrors Official's Ranking page (He's reference):
    // eyebrow BẢNG XẾP HẠNG → h1 = contest name → subtitle; card head "Kết quả cuộc thi"
    // + counter; the Cập nhật-lúc row lives INSIDE the card, above the table.
    host.innerHTML = `<div class="tm-page-title tm-contest-head"><div><div class="tm-eyebrow">${text("rankings.eyebrow")}</div><h1>${esc(this.contest!.name)}</h1><p class="tm-muted">${text("rankings.desc")}</p></div>${chips}</div><section class="tm-card"><div class="tm-card-head"><h2>${text("rankings.contestTitle")}</h2><span class="tm-lb-count">${esc(text("rankings.participants", { n: entries.length }))} · ${esc(text("rankings.problemsInContest", { n: problems.length }))}</span></div><div class="tm-lb-updated" data-lb-updated role="status"></div><div class="tm-lb-split"><div class="tm-lb-left"><table class="tm-table tm-lb-table" style="width:600px"><colgroup><col style="width:64px"><col style="width:280px"><col style="width:112px"><col style="width:144px"></colgroup><thead><tr><th scope="col" title="${text("rankings.position")}">${text("rankings.rank")}</th><th scope="col">${text("rankings.user")}</th><th scope="col">${text("rankings.totalScore")}</th><th scope="col">${text("subs.time")}</th></tr></thead><tbody data-lb-left></tbody></table></div><div class="tm-lb-right"><table class="tm-table tm-lb-table" style="width:${problems.length * 100}px;min-width:100%"><colgroup>${problems.map(() => `<col style="width:100px">`).join("")}</colgroup><thead><tr>${head}</tr></thead><tbody data-lb-right></tbody></table>${entries.length ? "" : empty(denied ? "rankings.hidden" : "rankings.empty")}</div><div class="tm-lb-ghost" data-lb-ghost hidden></div></div></section>`;
    const lbGlobal = host.querySelector<HTMLButtonElement>('[data-lb-global]');
    if (lbGlobal) lbGlobal.onclick = () => this.go("rankings", { scope: "global" });
    const lbRefresh = host.querySelector<HTMLButtonElement>('[data-lb-refresh]');
    if (lbRefresh) lbRefresh.onclick = () => void this.render();
    paint();
    const poll = window.setInterval(() => {
      if (!alive()) { window.clearInterval(poll); return; }
      if (document.hidden) return; // minimized: skip the beat — standings refresh on return
      void api.leaderboard(auth.accessToken()!, key).then(lb => {
        if (!alive()) { window.clearInterval(poll); return; }
        entries = list(lb);
        paint();
      }).catch(() => { /* transient — next tick retries */ });
    }, 30_000);
    const previous = this.disposeView;
    this.disposeView = () => { previous?.(); window.clearInterval(poll); youObserver?.disconnect(); };
  }

  // official ig: eg(value) persists + repaints; the menu updates trigger/check in place, then closes
  private wireThemeMenus(root: ParentNode): void {
    root.querySelectorAll<HTMLDetailsElement>(".tm-theme-menu-root").forEach(menu => {
      const summary = menu.querySelector<HTMLElement>("summary")!;
      menu.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach(b => b.onclick = () => {
        const v = b.dataset.themeChoice as Preferences["theme"];
        this.prefs.theme = v;
        // Repaint tokens in place: editor models, undo history and pending submissions survive.
        write("delcc-tmath-preferences", JSON.stringify(this.prefs)); applyPreferences(this.prefs);
        window.dispatchEvent(new Event("delcc-tmath-theme"));
        summary.innerHTML = themeTrigger(v);
        menu.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach(x => {
          const check = x.querySelector<HTMLElement>(".theme-check");
          if (check) check.hidden = x.dataset.themeChoice !== v;
        });
        menu.open = false;
      });
    });
  }

  private async account(host: HTMLElement, alive: () => boolean): Promise<void> {
    const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
    const requested = params.get("user");
    const token = auth.accessToken()!;
    let session = this.user ?? {}, home: any = null;
    const own = !requested || requested === session.username;
    if (own) {
      const payloads = await Promise.allSettled([api.me(token),api.home(token)]);
      if (!alive()) return;
      if (payloads[0].status === "fulfilled") {
        const payload = payloads[0].value;
        session = {...payload,...(payload?.user ?? payload?.profile ?? {})};
      }
      if (payloads[1].status === "fulfilled") home = payloads[1].value;
    }
    const username = requested || session.username;
    const detail = username ? await raw(`/users/${encodeURIComponent(username)}`,{token}) : {};
    if (!alive()) return;
    const homeUser = home?.user ?? home?.profile;
    const u = own ? {...(homeUser?.username === username ? homeUser : {}),...session,...detail} : detail;
    const solved = list<string>(u.solved_problems), history = list(u.contest_history);
    let submissionCount = "—";
    if (own && username) {
      const suppliedCount = u.submission_count ?? u.stats?.submission_count;
      if (typeof suppliedCount === "number" && Number.isFinite(suppliedCount) && suppliedCount >= 0) submissionCount = String(suppliedCount);
      else {
        try {
          const mine = list(await api.submissions(token,{user:username,page:1,page_size:PAGE_SIZE}));
          submissionCount = mine.length === PAGE_SIZE ? `≥${mine.length}` : String(mine.length);
        } catch { /* unavailable data stays distinct from zero */ }
      }
    }
    if (!alive()) return;
    const name = String(u.display_name || u.displayName || u.username || "?");
    const ICONS: Record<string, string> = {
      solved: `<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>`,
      trophy: `<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>`,
      code: `<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>`,
      zap: `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
    };
    const stat = (key: DictKey, value: unknown, hint = "", icon = "") => `<div class="tm-stat"${hint ? ` title="${esc(hint)}"` : ""}><span>${text(key)}</span><strong>${esc(typeof value === "number" && Number.isFinite(value) ? (fmtN(value, 2) ?? "—") : (value ?? "—"))}</strong>${icon ? `<svg class="tm-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon] ?? ""}</svg>` : ""}</div>`;
    // Rating series straight from contest_history (official "Biến động Rate" card).
    const rated = (history.filter((c: any) => typeof c?.rating === "number" && Number.isFinite(c.rating)) as { rating: number; name?: string }[]).slice().reverse(); // API sends newest-first; chart/table math wants time order
    const fmtN = (v: unknown, maxDigits = 3) => typeof v === "number" && Number.isFinite(v) ? (v as number).toLocaleString(getLocale(), { maximumFractionDigits: maxDigits }) : null;
    const currentRate = typeof u.rating === "number" ? u.rating : (rated.length ? rated[rated.length - 1].rating : null);
    const bestRate = typeof u.max_rating === "number" ? u.max_rating : (rated.length ? Math.max(...rated.map(c => c.rating)) : null);
    const lastDelta = rated.length > 1 ? rated[rated.length - 1].rating - rated[rated.length - 2].rating : null;
    const orgs = [...new Map<string, any>([...(u.organization ? [u.organization] : []), ...(Array.isArray(u.organizations) ? u.organizations : [])]
      .map((o: any) => [String(o?.id ?? o?.name ?? ""), o] as [string, any])).values()]
      .map((o: any) => o?.name || o?.short_name).filter(Boolean) as string[];
    // same palette as ratingStyle() — one color language across the app (official -500 hexes)
    const rateColor = (v: number): string => v < 1000 ? "#6a7282" : v < 1300 ? "#00c758" : v < 1600 ? "#3080ff" : v < 1900 ? "#ac4bff" : v < 2400 ? "#fe6e00" : "#fb2c36";
    const fmtRate = (v: number): string => (v / 1000).toFixed(3);
    const deltas = rated.map((c, i) => i === 0 ? null : (c.rating as number) - (rated[i - 1].rating as number));
    // about pane renders the Markdown subset in ./md — escape-first, scheme-allow-listed (Q01)
    const mdInline = mdInlineRender;
    const rateCell = (v: number | null, delta = false) => {
      if (v === null) return `<strong>${esc("—")}</strong>`;
      if (delta) {
        const cls = v > 0 ? "tm-delta-up" : v < 0 ? "tm-delta-down" : "tm-delta-flat";
        const sign = v > 0 ? "+" : "";
        return `<strong class="${cls}">${sign}${fmtN(v) ?? v}</strong>`;
      }
      return `<strong${ratingStyle(v)}>${fmtRate(v)}</strong>`;
    };
    const rateStats = `<div class="tm-rating-stats"><div><small>${text("account.ratingNow")}</small>${rateCell(currentRate)}</div><div><small>${text("account.ratingBest")}</small>${rateCell(bestRate)}</div><div><small>${text("account.ratingLast")}</small>${rateCell(lastDelta, true)}</div></div>`;
    const rateTag = `<span class="tm-rate-count tm-muted">${esc(fmtN(rated.length) ?? "0")} ${text("account.ratedCount")}</span>`;

    let chartDims = { W: 660, H: 230 };
    const ratedRows = [...rated].reverse(); // official list: newest first
    const rateSection = (withChart: boolean): string => {
      const head = `<header class="tm-rating-head"><h2><svg class="tm-rate-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/></svg>${text("account.ratingChartTitle")}</h2>${rateTag}</header><p class="tm-muted">${text("account.ratingChartDesc")}</p>`;
      const historyTable = `<details class="tm-rate-history"><summary>${text("account.rateHistory")} (${rated.length})</summary><div class="tm-table-wrap"><table class="tm-table"><thead><tr><th>${text("contests.title")}</th><th>${text("account.date")}</th><th>${text("account.rank")}</th><th>${text("account.rate")}</th><th>${text("account.delta")}</th></tr></thead><tbody>${ratedRows.map((c, ri) => { const ci = rated.length - 1 - ri; const d = deltas[ci]; return `<tr><td>${esc(c.name ?? "—")}</td><td>${esc(date((c as any).end_time))}</td><td>${esc((c as any).rank ?? "—")}</td><td${ratingStyle(c.rating)}>${esc(fmtRate(c.rating))}</td>${d === null ? `<td>—</td>` : `<td${d >= 0 ? ` class="up"` : ` class="down"`}>${d > 0 ? "+" : ""}${d}</td>`}</tr>`; }).join("")}</tbody></table></div></details>`;
      if (!withChart) return `<section class="tm-card tm-card-body">${head}${rateStats}<div class="tm-rating-empty"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg><p>${text("account.ratingEmpty")}</p><p class="tm-muted">${text("account.ratingEmptyHint")}</p></div></section>`;
      // official recharts look: y grid + band tint + segmented colored line + dot tooltips
      const W = 660, H = 230, LGUT = 46, RGUT = 12, TOP = 10, BOT = 28;
      chartDims = { W, H };
      const vals = rated.map(c => c.rating as number);
      const lo0 = Math.min(...vals), hi0 = Math.max(...vals);
      const stepRaw = [1250, 625, 250, 125, 50, 25].find(s => (hi0 - lo0) / s <= 4.5) ?? 25;
      const lo = Math.floor(lo0 / stepRaw) * stepRaw, hi = Math.ceil(hi0 / stepRaw) * stepRaw;
      const y = (v: number) => H - BOT - (v - lo) / Math.max(hi - lo, 1) * (H - TOP - BOT);
      const X = (i: number) => LGUT + (i / Math.max(vals.length - 1, 1)) * (W - LGUT - RGUT);
      const PCT = (i: number) => (X(i) / W * 100).toFixed(2);
      let grid = "", yl = "";
      for (let tv = lo; tv <= hi + 1e-9; tv += stepRaw) {
        grid += `<line x1="${LGUT}" y1="${y(tv).toFixed(1)}" x2="${W - RGUT}" y2="${y(tv).toFixed(1)}" class="tm-rate-grid"/>`;
        yl += `<span class="tm-rate-y" style="top:${(y(tv) / H * 100).toFixed(2)}%">${esc(fmtRate(tv))}</span>`;
      }
      // official area+stroke (carve TM/wM): TWO gradients in userSpaceOnUse over the
      // PLOT rect (top gridline -> baseline) — tier bands contribute stopColor at their
      // y-offset with HARD cuts. Pair order matters: at a shared boundary offset the
      // UPPER tier's stop must come FIRST (SVG keeps the last equal stop below the cut);
      // the pass-20 sort inverted every pair, flipping band colors one tier down.
      const tierStops = (opacityFor: (offset: number) => number): string => {
        if (hi - lo < 1e-9) return `<stop offset="0" stop-color="${rateColor(lo)}" stop-opacity="${opacityFor(0)}"/>`;
        const tiers: [number, string][] = [[1000, rateColor(999)], [1300, rateColor(1299)], [1600, rateColor(1599)], [1900, rateColor(1899)], [2400, rateColor(2399)], [Infinity, rateColor(2400)]];
        const stops: { off: number; color: string; bottom: boolean }[] = [];
        let min = -Infinity;
        for (const [max, color] of tiers) {
          const loB = Math.max(min, lo), hiB = Math.min(max, hi);
          if (hiB >= loB) {
            stops.push({ off: (hi - hiB) / (hi - lo), color, bottom: false });
            stops.push({ off: (hi - loB) / (hi - lo), color, bottom: true });
          }
          min = max;
        }
        stops.sort((a, b) => a.off - b.off || (a.bottom === b.bottom ? 0 : a.bottom ? -1 : 1));
        return stops
          .map(s => `<stop offset="${Math.min(1, Math.max(0, s.off)).toFixed(4)}" stop-color="${s.color}" stop-opacity="${opacityFor(s.off).toFixed(3)}"/>`).join("");
      };
      const areaDefs = `<defs><linearGradient id="tm-rate-fill" gradientUnits="userSpaceOnUse" x1="0" y1="${y(hi).toFixed(1)}" x2="0" y2="${(H - BOT).toFixed(1)}">${tierStops(off => 0.3 - off * 0.25)}</linearGradient><linearGradient id="tm-rate-stroke" gradientUnits="userSpaceOnUse" x1="0" y1="${y(hi).toFixed(1)}" x2="0" y2="${(H - BOT).toFixed(1)}">${tierStops(() => 1)}</linearGradient></defs>`;
      const pts = vals.map((v, i) => [Number(X(i)), Number(y(v))] as const);
      let smoothPath = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
        const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
        const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
        const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
        smoothPath += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
      }
      const areaPath = `${smoothPath} L ${pts[pts.length - 1][0].toFixed(1)} ${(H - BOT).toFixed(1)} L ${pts[0][0].toFixed(1)} ${(H - BOT).toFixed(1)} Z`;
      const dotEls = rated.map((c, i) => `<circle class="tm-rate-hit" data-i="${i}" cx="${X(i).toFixed(1)}" cy="${y(vals[i]).toFixed(1)}" r="11" fill="transparent"/>`).join("");
      const nXL = Math.min(8, rated.length);
      const xlabels = Array.from({ length: nXL }, (_v, k) => {
        const i = Math.round(k * (rated.length - 1) / Math.max(nXL - 1, 1));
        const d = new Date((rated as any[])[i].end_time);
        if (Number.isNaN(d.getTime())) return "";
        const shift = k === 0 ? "translateX(0%)" : k === nXL - 1 ? "translateX(-100%)" : "translateX(-50%)";
        return `<span class="tm-rate-x" style="left:${PCT(i)}%;transform:${shift}">${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}</span>`;
      }).join("");
      return `<section class="tm-card tm-card-body">${head}${rateStats}<div class="tm-rating-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${text("account.ratingChartTitle")}">${areaDefs}<path d="${areaPath}" class="tm-rate-area" fill="url(#tm-rate-fill)"/>${grid}<path d="${smoothPath}" class="tm-rate-line" fill="none" stroke="url(#tm-rate-stroke)" stroke-width="2"/>${dotEls}</svg>${yl}${xlabels}<i class="tm-rate-hover" hidden></i><div class="tm-rate-tip" hidden></div></div>${historyTable}</section>`;
    };
    const ratingCard = rateSection(rated.length >= 2);
    const rankUrl = `#/rankings${username ? `?search=${encodeURIComponent(username)}` : ""}`;
    const subUrl = `#/submissions?scope=${own ? "" : "public_practice"}&user=${encodeURIComponent(username ?? "")}&problem=&result=`;
    host.innerHTML = this.pageTitle("account.eyebrow","account.title","account.desc","common.refresh") + `<div class="tm-account-grid"><div class="tm-account-side"><section class="tm-card tm-card-body"><div class="tm-profile-head">${avatarHtml(name, u.gravatar_hash ?? u.gravatarHash ?? (own ? (this.user?.gravatar_hash ?? this.user?.gravatarHash) : undefined) ?? cachedAvatar(String(u.username ?? username ?? "")), 80)}<h2${ratingStyle(u.rating)}>${esc(name)}</h2><p class="tm-muted"><button type="button" class="tm-handle-copy"${ratingStyle(u.rating)} title="${text("account.copyHandle")}" aria-label="${text("account.copyHandle")}">@${esc(u.username ?? username)}</button></p>${u.rank ? `<p class="tm-profile-rank"><span class="tm-badge">${esc(u.rank)}</span></p>` : ""}</div><dl class="tm-profile-dl"><dt class="tm-dl-row"><svg class="tm-dl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>${text("account.rating")}</dt><dd${ratingStyle(u.rating)}><a href="${rankUrl}" class="tm-dl-link"><strong>${esc(u.rating ?? "—")}</strong></a></dd><dt class="tm-dl-row"><svg class="tm-dl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>${text("account.submissions")}</dt><dd><a href="${subUrl}" class="tm-dl-link">${esc(submissionCount)}</a></dd><dt class="tm-dl-row"><svg class="tm-dl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/></svg>${text("account.orgs")}</dt><dd>${orgs.length ? `<ul class="tm-org-list">${orgs.map(o => `<li>${esc(o)}</li>`).join("")}</ul>` : "—"}</dd></dl></section><section class="tm-card tm-card-body tm-about-card"><h2 class="tm-section-title">${text("account.about")}</h2><div class="tm-md">${u.about ? sanitizeAbout(mdInline(u.about)) : `<span class="tm-muted">${text("account.aboutEmpty")}</span>`}</div></section></div>
      <div class="tm-account-main"><section class="tm-account-stats"><h2 class="tm-section-title">${text("account.summary")}</h2><div class="tm-stat-grid">${stat("account.solved",u.problem_count ?? (Array.isArray(u.solved_problems) ? solved.length : null),"","solved")}${stat("account.joined",Array.isArray(u.contest_history) ? history.length : null,"","trophy")}${stat("account.points",u.points,"","code")}${stat("account.ratingPoints",u.performance_points,"","zap")}</div></section>${ratingCard}</div></div>`;

    const tip = host.querySelector<HTMLDivElement>(".tm-rate-tip");
    const wrap = host.querySelector<HTMLDivElement>(".tm-rating-chart");
    if (tip && wrap) {
      host.querySelectorAll<SVGCircleElement>(".tm-rate-hit").forEach(dot => {
        dot.addEventListener("mouseenter", () => {
          const i = Number(dot.dataset.i);
          const r: any = rated[i];
          const d = deltas[i];
          const col = rateColor(r.rating);
          tip.innerHTML = `<b>${esc(r.name ?? "—")}</b><br>${esc(date(r.end_time))} · ${esc(text("account.rank"))} ${esc(r.rank ?? "—")}${d === null ? "" : ` · <b class="${d >= 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d}</b>`}<br><i class="tm-rate-swatch" style="background:${col}"></i>${esc(text("account.rating"))} <b style="color:${col}">${esc(fmtRate(r.rating))}</b>`;
          const wr = wrap.getBoundingClientRect(), dr = dot.getBoundingClientRect();
          const dotX = dr.left + dr.width / 2 - wr.left;
          const dotY = dr.top - wr.top;
          tip.style.left = `${dotX}px`;
          tip.style.top = `${dotY}px`;
          if (dotX > wr.width * 0.72) tip.style.transform = "translate(calc(-100% + 14px), calc(-100% - 12px))";
          else if (dotX < wr.width * 0.28) tip.style.transform = "translate(-14px, calc(-100% - 12px))";
          else tip.style.transform = "translate(-50%, calc(-100% - 12px))";
          tip.hidden = false;
          // HTML overlay dot: SVG circles distort under preserveAspectRatio="none"
          const cx = Number(dot.getAttribute("cx") ?? 0), cy = Number(dot.getAttribute("cy") ?? 0);
          const hov = wrap.querySelector<HTMLElement>(".tm-rate-hover");
          if (hov) {
            hov.style.left = `${(cx / 660 * 100).toFixed(3)}%`;
            hov.style.top = `${(cy / 230 * 100).toFixed(3)}%`;
            hov.style.background = col;
            hov.hidden = false;
          }
        });
        dot.addEventListener("mouseleave", () => { tip.hidden = true; const hov = wrap.querySelector<HTMLElement>(".tm-rate-hover"); if (hov) hov.hidden = true; });
      });
    }

    host.querySelectorAll<HTMLImageElement>(".tm-avatar-img").forEach(img => img.onerror = () => img.remove());
    // QoL (pass #25): click the @handle to copy the bare username — the @ never
    // lands on the clipboard, matching how handles are typed into search boxes
    const handleBtn = host.querySelector<HTMLButtonElement>(".tm-handle-copy");
    if (handleBtn) handleBtn.onclick = async () => {
      const bare = String(u.username ?? username ?? "").trim().replace(/^@/, "");
      if (!bare) return;
      try { await navigator.clipboard.writeText(bare); } catch { return; }
      const was = handleBtn.textContent;
      handleBtn.textContent = `${t("common.copied")} @${bare}`;
      setTimeout(() => { if (handleBtn.isConnected) handleBtn.textContent = was; }, 1200);
    };
    // pass #83: About images load through the isolated shell fetch (asset_fetch) —
    // failures degrade to the plain-link form the fenced pass shipped
    const aboutRoot = host.querySelector<HTMLElement>(".tm-about-card .tm-md");
    if (aboutRoot) wireAboutImages(aboutRoot);
    // avatar via the public profile page (pass #27; audit: also covers the OWN view
    // when /me ships no hash — same bytes the site shows everyone, cached once)
    {
      const otherName = String(u.username ?? username ?? "");
      const wireHash = u.gravatar_hash ?? u.gravatarHash ?? (own ? (this.user?.gravatar_hash ?? this.user?.gravatarHash) : undefined);
      if (otherName && !wireHash && !cachedAvatar(otherName)) {
        void hydrateAvatars([otherName]).then(() => {
          if (!alive()) return;
          const h = cachedAvatar(otherName);
          const av = host.querySelector<HTMLElement>(".tm-profile-head .tm-avatar");
          if (!h || !av || av.querySelector("img")) return;
          av.insertAdjacentHTML("beforeend", avatarImg(h, 80));
          const img = av.querySelector("img");
          if (img) img.onerror = () => img.remove();
        });
      }
    }
  }
}

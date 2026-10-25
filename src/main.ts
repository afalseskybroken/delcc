// delcc-app/src/main.ts — Phase 1 flows, unthemed.
// login → contests → workspace → problem → submit → verdict poll.
// Layout toggle: "baseplate" (tabs, stable for v0.1.0a) vs "wip" (home grid) vs
// "tmath" boots its independent shell in ./tmath; baseplate/wip stay here.
import { api, humanError, ApiError, SessionChangedError, syncClientVersion, clientVersion } from "./lib/api";
import * as auth from "./lib/auth";
import { getLayout, openExternal } from "./lib/transport";
import { checkForUpdate, recordDownload } from "./lib/updater";
import * as cph from "./lib/cph";
import { watchVerdict } from "./lib/verdict";
import DOMPurify from "dompurify";
import { loadProfiles, saveProfiles, activeId, setActiveId, upsertProfile, type Profile } from "./lib/profiles";
import * as vault from "./lib/vault";

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const S: {
  contest: string | null;
  problem: any;
  mode: "contest" | "public" | null;
  part: number | null;
  layout: "baseplate" | "wip" | "tmath";
} = {
  contest: null, problem: null, mode: null, part: null, layout: "baseplate",
};

// F09 view ownership: every open-problem/open-contest/logout bumps the generation;
// a continuation from an older generation may not paint state, run CPH saves, or
// submit. submitCtx is the context that produced the statement ON SCREEN — the
// submit button only ever acts on it, never on whatever S holds right now.
let viewGen = 0;
let submitCtx: { problem: any; contest: string | null; part: number | null; join: string } | null = null;
function bumpView() { viewGen++; submitCtx = null; }

// contests view and problems view each carry a status span; keep both in sync.
function cmsgSet(t: string) {
  $("cmsg").textContent = t;
  const p = document.getElementById("pmsg"); if (p) p.textContent = t;
}

function msg(el: string, t: string, cls = "") { const e = $(el); e.textContent = t; e.className = cls; }

function showView(v: string) {
  const id = v.startsWith("#") ? v.slice(1) : v;
  document.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
  $(id).classList.add("active");
  document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.remove("on"));
  const btn = document.querySelector(`nav.tabs button[data-v="${id}"]`) as HTMLElement;
  if (btn) btn.classList.add("on");
}

// ---------- Editor (lib/editor.ts, bundled Monaco, lazy) ----------
// lane 7: minimap/word-wrap persisted across sessions.
interface EdPrefs { minimap: boolean; wordWrap: "on" | "off" }
const EDITOR_PREFS_KEY = "delcc-editor-prefs";
function loadEditorPrefs(): EdPrefs {
  try {
    const raw = localStorage.getItem(EDITOR_PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { minimap: p.minimap !== false, wordWrap: p.wordWrap === "off" ? "off" : "on" };
    }
  } catch { /* private mode */ }
  return { minimap: true, wordWrap: "on" };
}
function saveEditorPrefs(p: EdPrefs) {
  try { localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}
let editorPrefs: EdPrefs = loadEditorPrefs();
function paintEditorPrefButtons() {
  const mm = $("edMinimap") as HTMLButtonElement | null, wr = $("edWrap") as HTMLButtonElement | null;
  if (mm) mm.className = editorPrefs.minimap ? "on" : "muted";
  if (wr) wr.className = editorPrefs.wordWrap === "on" ? "on" : "muted";
}

let edMod: typeof import("./lib/editor") | null = null;
async function initEditor(language: string) {
  edMod = edMod ?? await import("./lib/editor");
  edMod.mount($("monaco"), edMod.monacoLang(language), () => {
    const m2 = $("vmsg"); if (m2.className !== "err") m2.textContent = "";
  }, editorPrefs);
  paintEditorPrefButtons();
}
const getEditorValue = () => edMod?.getValue() ?? "";

// ---------- Render ----------
function render() {
  const t = auth.getToken();
  const app = $("app")!;
  app.innerHTML = `
  <nav class="tabs">
    ${S.layout === "wip" ? `<button data-v="home">home</button><button data-v="subs">submissions</button>` : ""}
    <button data-v="auth" class="${!t ? "on" : ""}">1 · auth</button>
    <button data-v="contests" class="${t ? "on" : ""}">2 · contests</button>
    <button data-v="problems">3 · problems <span class="muted">${esc(S.contest ?? "")}</span></button>
    <button data-v="solve">4 · solve</button>
    <button data-v="config">5 · config</button>
    ${S.layout !== "wip" ? `<button data-v="subs">6 · submissions</button>` : ""}
    <span id="who" class="muted">${t ? "in as " + esc(activeName()) : ""}</span>
    <button id="logout" ${t ? "" : "disabled"}>log out</button>
  </nav>
  <section id="v-auth" class="view ${!t ? "active" : ""}">
    ${
      S.layout === "wip"
      ? // WIP lane — stepped flow + saved profiles (sketches/login.png). Owned by the new-UI design.
      `<div id="brand"><b>delcc</b> <span class="muted">identifiers · Default profile · sketches/login.png</span></div>
    <h2>login as:</h2>
    <div class="row">
      <span id="pfp" class="pill">?</span>
      <select id="prof"></select>
      <button id="lockBtn" title="lock profile (password always required)">🔒</button>
    </div>
    <div id="profMsg" class="muted"></div>
    <h2>or:</h2>
    <div class="row">
      <span id="phaseLbl" class="muted">username</span>
      <input id="stepUser" placeholder="username" autocomplete="username">
      <input id="stepPass" type="password" placeholder="password" autocomplete="current-password" hidden>
      <button id="showPass" hidden>show</button>
      <button id="nextBtn" title="advance">&gt;</button>
    </div>
    <div class="row"><button id="loginBtn">log in</button></div>
    <div id="authmsg" class="err"></div>
    <div class="row"><button id="oauthBtn">log in with Google</button></div>`
      : // baseplate lane — plain login, no profile machinery.
      `<div id="brand"><b>delcc</b> <span class="muted">baseplate · plain login</span></div>
    <h2>login:</h2>
    <div class="row">
      <span class="muted">user</span>
      <input id="bpUser" placeholder="username" autocomplete="username">
      <span class="muted">pass</span>
      <input id="bpPass" type="password" placeholder="password" autocomplete="current-password">
      <button id="bpShow">show</button>
      <button id="bpLogin">log in</button>
    </div>
    <div class="row"><button id="oauthBtn">log in with Google</button></div>
    <div id="authmsg" class="err"></div>`
    }
  </section>
  <section id="v-contests" class="view ${t ? "active" : ""}">
    <h2>2 · contests — mine (API) + current (home feed)</h2>
    <div class="row"><input id="csearch" placeholder="search"><button id="reloadC" ${t ? "" : "disabled"}>reload contests</button><button id="cprev">‹</button><button id="cnext">›</button><span id="cpage" class="muted">p1</span><span id="cmsg" class="muted"></span></div>
    <div class="row"><input id="ckey" placeholder="contest key (direct open)"><button id="copen">open</button></div>
    <h2>now</h2>
    <table><tbody id="contestsNow"></tbody></table>
    <h2>mine</h2>
    <table><tbody id="contests"></tbody></table>
  </section>
  <section id="v-problems" class="view">
    <h2>3 · problems — join before submit</h2>
    <div class="row"><button id="reloadP" ${t ? "" : "disabled"}>reload public problems</button><button id="joinC" disabled>join contest</button><button id="leaveC" disabled>leave contest</button><span id="pmsg" class="muted">${S.contest ? "contest " + esc(S.contest) : ""}</span></div>
    <div class="row" id="pfilterRow">
      <input id="psearch" placeholder="search" title="server-side /problems?search=">
      <select id="ptype" title="server-side /problems?type=  (options from /problem-topics)"><option value="">type — all</option></select>
      <select id="pgroup" title="groups discovered while paging"><option value="">group — all</option></select>
    </div>
    <table><thead><tr><th>code</th><th>name · group</th><th>types</th><th>pts</th><th>solvers</th></tr></thead><tbody id="problems"></tbody></table>
    <div class="row" id="pScrollRow"><button id="pmore">load next page</button><span id="pstat" class="muted">—</span></div>
  </section>
  <section id="v-solve" class="view">
    <h2>4 · statement + submit</h2>
    <div id="stmt" class="muted">pick a problem.</div>
    <div class="row actions">
      <select id="lang"><option>CPP20</option><option>CPP17</option><option>CPP14</option><option>PY3</option></select>
      <button id="mathToggle" hidden title="flip every formula between rendered math and copyable raw TeX">math raw</button>
      <button id="edMinimap" class="muted" title="toggle the Monaco minimap">minimap</button>
      <button id="edWrap" class="muted" title="toggle word wrap">wrap</button>
      <button id="submit" disabled>submit</button>
      <span id="vmsg"></span>
    </div>
    <div id="monaco" style="height:340px;border:1px solid #333;border-radius:6px;margin-top:6px;"></div>
    <!-- CPH panel: barebones in both lanes; runner is shell-side, honest by construction. -->
    <div class="row" style="margin-top:14px;">
      <button id="cphToggle">CPH ▾</button>
      <span id="cphStatus" class="muted"></span>
      <span class="pill warn" title="results come from a LOCAL compile+run, never from the judge">mock — not judged</span>
    </div>
    <div id="cphPanel" hidden>
      <div class="row">
        <span class="muted">limit (ms)</span>
        <input id="cphLimit" type="number" min="100" max="10000" step="100" value="2000" style="width:80px;">
        <button id="cphAddCase">+ test case</button>
        <button id="cphRunAll">run all</button>
        <button id="cphImport">Import Official TC</button>
        <button id="cphImportMore" hidden>more past TCs</button>
        <button id="cphMock">Mock Submit</button>
        <span class="muted" title="java assumes a public class named Main">paste your own or import official TCs; java expects class Main</span>
      </div>
      <div id="cphMockOut" class="muted" hidden></div>
      <pre id="cphCompileLog" class="err" hidden></pre>
      <div id="cphCases"></div>
    </div>
  </section>
  <section id="v-config" class="view">
    <h2>5 · config — profiles</h2>
    <div class="row">
      <select id="cfgProf"></select>
      <button id="cfgDelete">delete profile</button>
    </div>
    <div class="row">
      <input id="cfgLockPw" type="password" placeholder="new lock password">
      <button id="cfgShow">show</button>
      <button id="cfgSetLock">set lock password</button>
      <button id="cfgClearLock">remove lock</button>
    </div>
    <div id="cfgMsg" class="muted"></div>
  </section>

  <section id="v-subs" class="view">
    <h2>submissions</h2>
    <div class="row">
      <select id="sScope"><option value="">mine</option><option value="public_practice">public practice</option></select>
      <input id="sUser" placeholder="user" title="server-side /submissions?user=">
      <input id="sProblem" placeholder="problem code" title="server-side /submissions?problem=">
      <select id="sResult" title="server-side /submissions?result="><option value="">result — all</option></select>
      <select id="sPageSize" title="rows per page"><option value="10">10</option><option value="20">20</option><option value="30" selected>30</option><option value="50">50</option></select>
      <button id="reloadS" ${t ? "" : "disabled"}>reload</button>
      <button id="sprev">‹</button><button id="snext">›</button><span id="spage" class="muted">p1</span>
      <span id="smsg" class="muted"></span>
    </div>
    <table><thead><tr><th>#</th><th>problem</th><th>user</th><th>lang</th><th>result</th><th>pts</th><th>tc</th><th>time</th><th>mem</th></tr></thead><tbody id="subsBody"></tbody></table>
  </section>

  <!-- WIP home grid (sketches/home.png) -->
  <section id="v-home" class="view">
    <div class="home-wrap">
      <header class="home-top">
        <div id="homeLogo" class="pill" title="home shortcut">delcc</div>
        <nav class="home-tabs">
          <button data-h="problems">problems</button>
          <button data-h="contests">contests</button>
          <button data-h="submissions">submissions</button>
        </nav>
        <div class="home-right">
          <div id="homePfp" class="pill">?</div>
          <div id="homeName" class="muted">profile</div>
          <button id="homeLogout" ${t ? "" : "disabled"}>v</button>
        </div>
      </header>
      <div class="home-banner">
        <h2>Welcome back, <span id="homeUser"></span> — kinda thing idk but sane enough</h2>
      </div>
      <div class="home-grid">
        <div class="home-col">
          <div class="widget">
            <div class="widget-title">current contest</div>
            <div id="homeCurrent" class="widget-body muted">—</div>
          </div>
          <div class="widget">
            <div class="widget-title">recent contests</div>
            <div id="homeRecent" class="widget-body muted">—</div>
          </div>
        </div>
        <div class="home-col">
          <div class="widget wide">
            <div class="widget-title">rtc feed</div>
            <div id="homeRtc" class="widget-body muted">—</div>
          </div>
        </div>
        <div class="home-col">
          <div class="widget">
            <div class="widget-title">profile</div>
            <div id="homeProfile" class="widget-body"><div class="pill">?</div> <span class="muted">profile name</span></div>
          </div>
          <div class="widget">
            <div class="widget-title">clock</div>
            <div id="homeClock" class="widget-body muted">—</div>
          </div>
          <div class="widget">
            <div class="widget-title">public submissions</div>
            <div id="homeSubs" class="widget-body muted">—</div>
          </div>
        </div>
      </div>
    </div>
  </section>`;

  app.querySelectorAll("nav.tabs button").forEach((b) =>
    (b as HTMLElement).onclick = () => {
      const v = (b as HTMLElement).dataset.v!;
      if (v !== "auth" && v !== "config" && !auth.getToken()) {
        app.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
        $("v-auth").classList.add("active");
        app.querySelectorAll("nav.tabs button").forEach((x) => x.classList.remove("on"));
        (app.querySelector('nav.tabs button[data-v="auth"]') as HTMLElement).classList.add("on");
        msg("authmsg", "log in first — quick profile or the stepped flow.", "err");
        return;
      }
      app.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
      const map: any = { home: "v-home", subs: "v-subs", auth: "v-auth", contests: "v-contests", problems: "v-problems", solve: "v-solve", config: "v-config" };
      $(map[v]).classList.add("active");
      if (v === "config") paintCfg();
      if (v === "home") void loadHome();
      if (v === "subs") void loadSubs();
      app.querySelectorAll("nav.tabs button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    });

  wire();
}


// ---------- Wiring ----------
function wire() {
  const tok = () => auth.accessToken();
  wireAuth();
  ($("logout") as HTMLButtonElement).onclick = () => doLogout();
  ($("reloadC") as HTMLButtonElement).onclick = () => { cpage = 1; loadContests(); };
  const openKey = () => {
    const k = ($("ckey") as HTMLInputElement).value.trim();
    if (k) openContest(k);
  };
  ($("copen") as HTMLButtonElement).onclick = openKey;
  ($("ckey") as HTMLInputElement).onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); openKey(); }
  };
  ($("cprev") as HTMLButtonElement).onclick = () => { if (cpage > 1) { cpage--; loadContests(); } };
  ($("cnext") as HTMLButtonElement).onclick = () => { cpage++; loadContests(); };
  ($("csearch") as HTMLInputElement).onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); cpage = 1; loadContests(); }
  };
  ($("reloadP") as HTMLButtonElement).onclick = async () => {
    try {
      S.contest = null; S.mode = "public"; S.part = null; joined = false;
      updateContestButtons();
      setPublicUI(true);
      await relaunchPublic();
    } catch (e) { ($("pmsg") as HTMLElement).textContent = humanError(e); }
  };
  // filters (public lane only): server replaces the list from page 1.
  let psearchTimer: number | undefined;
  ($("psearch") as HTMLInputElement).oninput = () => {
    clearTimeout(psearchTimer);
    psearchTimer = setTimeout(() => void relaunchPublic(), 350) as unknown as number;
  };
  ($("ptype") as HTMLSelectElement).onchange = () => void relaunchPublic();
  ($("pgroup") as HTMLSelectElement).onchange = () => void relaunchPublic();
  ($("pmore") as HTMLButtonElement).onclick = () => { pstate.started = true; void loadProblemsPage(); };
  // infinite scroll: sentinel row under the table pulls the next page.
  pstate.io?.disconnect();
  pstate.io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (en.isIntersecting && S.contest == null && pstate.started) void loadProblemsPage();
    }
  }, { rootMargin: "260px" });
  pstate.io.observe($("pScrollRow"));
  ($("submit") as HTMLButtonElement).onclick = onSubmit;
  ($("lang") as HTMLSelectElement).onchange = () => {
    const v = ($("lang") as HTMLSelectElement).value;
    try { localStorage.setItem("delcc-lang-pref", v); } catch { /* private mode */ }
    if (edMod) edMod.setLang(edMod.monacoLang(v));
    paintCphStatus();
  };
  ($("mathToggle") as HTMLButtonElement).onclick = () => {
    const b = $("mathToggle") as HTMLButtonElement;
    if (mathAutoSkipped) { // big statement — first click here is "render it now", not "go raw"
      mathAutoSkipped = false; mathRendered = true;
      void applyMathMode().then(() => { b.textContent = "math raw"; });
      return;
    }
    mathRendered = !mathRendered; // per-view only — not persisted, see the declaration above
    b.textContent = mathRendered ? "math raw" : "math rendered";
    void applyMathMode();
  };
  ($("edMinimap") as HTMLButtonElement).onclick = () => {
    editorPrefs = { ...editorPrefs, minimap: !editorPrefs.minimap };
    saveEditorPrefs(editorPrefs); paintEditorPrefButtons(); edMod?.setPrefs(editorPrefs);
  };
  ($("edWrap") as HTMLButtonElement).onclick = () => {
    editorPrefs = { ...editorPrefs, wordWrap: editorPrefs.wordWrap === "on" ? "off" : "on" };
    saveEditorPrefs(editorPrefs); paintEditorPrefButtons(); edMod?.setPrefs(editorPrefs);
  };
  wireCph();
  wireConfig();
  ($("joinC") as HTMLButtonElement).onclick = async () => {
    if (!S.contest) return;
    await openContest(S.contest);
  };
  ($("leaveC") as HTMLButtonElement).onclick = async () => {
    try {
      if (S.contest && joined) await api.leave(auth.accessToken()!, S.contest);
    } catch (e) { cmsgSet(humanError(e)); return; }
    S.contest = null; S.mode = "public"; S.part = null; joined = false;
    cmsgSet("left — public list below");
    updateContestButtons();
    ($("reloadP") as HTMLButtonElement).click();
  };
  wireHome();
}

function wireHome() {
  $("v-home")?.querySelectorAll("nav.home-tabs button").forEach((b) =>
    (b as HTMLElement).onclick = () => {
      const h = (b as HTMLElement).dataset.h;
      if (h === "contests") { showView("#v-contests"); void loadContests(); }
      else if (h === "problems") { showView("#v-problems"); if (!pstate.started) ($("reloadP") as HTMLButtonElement).click(); }
      else if (h === "submissions") { showView("#v-subs"); void loadSubs(); }
    });
  ($("homeLogo") as HTMLElement).onclick = () => { showView("#v-home"); void loadHome(); };
  ($("homeLogout") as HTMLButtonElement).onclick = () => doLogout();
  ($("reloadS") as HTMLButtonElement).onclick = () => { subsState.page = 1; void loadSubs(); };
  ($("sprev") as HTMLButtonElement).onclick = () => { if (subsState.page > 1) { subsState.page--; void loadSubs(); } };
  ($("snext") as HTMLButtonElement).onclick = () => { subsState.page++; void loadSubs(); };
  const sResult = $("sResult") as HTMLSelectElement;
  sResult.innerHTML += Object.keys(VERDICT).map((k) => `<option value="${k}">${esc(VERDICT[k])} (${k})</option>`).join("");
  let sDebounce: number | undefined;
  const refilter = () => { clearTimeout(sDebounce); sDebounce = window.setTimeout(() => { subsState.page = 1; void loadSubs(); }, 350); };
  ($("sUser") as HTMLInputElement).oninput = refilter;
  ($("sProblem") as HTMLInputElement).oninput = refilter;
  ($("sScope") as HTMLSelectElement).onchange = () => { subsState.page = 1; void loadSubs(); };
  sResult.onchange = () => { subsState.page = 1; void loadSubs(); };
  ($("sPageSize") as HTMLSelectElement).onchange = () => { subsState.page = 1; void loadSubs(); };
  applySubsFilterPrefs(); // restore last session's filters before the first load
}

// lane 4: persisted subs-table filters — restored at boot, saved on every load.
const SUBS_FILTERS_KEY = "delcc-subs-filters";
interface SubsFilterPrefs { scope: string; user: string; problem: string; result: string; pageSize: string }
function readSubsFilterInputs(): SubsFilterPrefs {
  return {
    scope: ($("sScope") as HTMLSelectElement).value,
    user: ($("sUser") as HTMLInputElement).value,
    problem: ($("sProblem") as HTMLInputElement).value,
    result: ($("sResult") as HTMLSelectElement).value,
    pageSize: ($("sPageSize") as HTMLSelectElement).value,
  };
}
function saveSubsFilterPrefs() {
  try { localStorage.setItem(SUBS_FILTERS_KEY, JSON.stringify(readSubsFilterInputs())); } catch { /* private mode */ }
}
function clearSubsFilterPrefs() {
  try { localStorage.removeItem(SUBS_FILTERS_KEY); } catch { /* private mode */ }
}
function applySubsFilterPrefs() {
  let p: Partial<SubsFilterPrefs> | null = null;
  try { const raw = localStorage.getItem(SUBS_FILTERS_KEY); if (raw) p = JSON.parse(raw); } catch { /* ignore */ }
  if (!p) return;
  if (p.scope != null) ($("sScope") as HTMLSelectElement).value = p.scope;
  if (p.user) ($("sUser") as HTMLInputElement).value = p.user;
  if (p.problem) ($("sProblem") as HTMLInputElement).value = p.problem;
  if (p.result) ($("sResult") as HTMLSelectElement).value = p.result;
  if (p.pageSize) ($("sPageSize") as HTMLSelectElement).value = p.pageSize;
}

// ---------- WIP home grid: current / recent contests, rtc feed, profile, clock, public subs ----------
let clockTimer: number | null = null;
const link = (k: string, label: string) => `<a href="#" data-k="${esc(k)}">${esc(label)}</a>`;
function bindContestLinks(host: HTMLElement) {
  host.querySelectorAll("a[data-k]").forEach((a) =>
    (a as HTMLElement).onclick = (e) => { e.preventDefault(); showView("#v-contests"); void openContest((a as HTMLElement).dataset.k!); });
}
async function loadHome(username?: string) {
  const t = auth.accessToken(); if (!t) return;
  const name = username ?? activeName();
  $("homeUser").textContent = name; $("homeName").textContent = name;
  $("homePfp").textContent = (name[0] || "?").toUpperCase();
  $("homeProfile").innerHTML = `<div class="pill">${esc((name[0] || "?").toUpperCase())}</div> <span>${esc(name)}</span>`;
  if (clockTimer) clearInterval(clockTimer);
  const tick = () => { const el = document.getElementById("homeClock"); if (el) el.textContent = new Date().toLocaleString(); };
  tick(); clockTimer = window.setInterval(tick, 1000);
  try {
    const h: any = await api.home(t);
    const cur = [...(h.current_contests || []), ...(h.future_contests || [])];
    $("homeCurrent").innerHTML = cur.length
      ? cur.slice(0, 6).map((c: any) => `<div>${link(c.key, c.name)} <span class="muted">${esc(String(c.start_time || "").slice(0, 16))}</span></div>`).join("")
      : "no current contest";
    bindContestLinks($("homeCurrent"));
    const rtc = [...(h.recent_comments || []).map((c: any) => `<div><b>${esc(c.author)}</b> on ${esc(c.page_title || c.page)} <span class="muted">${esc(c.time || "")}</span></div>`),
      ...(h.posts || []).map((p: any) => `<div>📰 ${esc(p.title)}</div>`)];
    $("homeRtc").innerHTML = rtc.slice(0, 12).join("") || "nothing yet";
  } catch (e) { $("homeCurrent").textContent = humanError(e); }
  try {
    const mine: any = await api.contests(t, { page: 1, page_size: 5 });
    const arr = Array.isArray(mine) ? mine : (mine?.items || mine?.data || []);
    $("homeRecent").innerHTML = arr.length ? arr.map((c: any) => `<div>${link(c.key, c.name)}</div>`).join("") : "none joined yet";
    bindContestLinks($("homeRecent"));
  } catch (e) { $("homeRecent").textContent = humanError(e); }
  try {
    const subs = await api.submissions(t, { page_size: 8 });
    $("homeSubs").innerHTML = subs.map((x: any) => `<div>#${esc(x.id)} ${esc(x.problem)} · ${esc(x.user)} · <b>${esc(x.result || x.status)}</b></div>`).join("") || "none";
  } catch (e) { $("homeSubs").textContent = humanError(e); }
}

const subsState: { page: number; openId: number | null } = { page: 1, openId: null };

async function loadSubs() {
  const t = auth.accessToken(); if (!t) return;
  $("smsg").textContent = "loading…";
  subsState.openId = null; // filters/page changed — any open detail row is stale, collapse it
  try {
    const scope = ($("sScope") as HTMLSelectElement).value;
    const user = ($("sUser") as HTMLInputElement).value.trim();
    const problem = ($("sProblem") as HTMLInputElement).value.trim();
    const result = ($("sResult") as HTMLSelectElement).value;
    const pageSize = +($("sPageSize") as HTMLSelectElement).value || 30;
    const subs = await api.submissions(t, {
      page: subsState.page, page_size: pageSize,
      ...(scope ? { scope } : {}), ...(user ? { user } : {}),
      ...(problem ? { problem } : {}), ...(result ? { result } : {}),
    });
    paintSubsTable(subs);
    ($("spage") as HTMLElement).textContent = "p" + subsState.page;
    $("smsg").textContent = `${subs.length} shown`;
    saveSubsFilterPrefs();
  } catch (e) {
    $("smsg").textContent = humanError(e); $("subsBody").innerHTML = "";
    // a restored filter that 401s everywhere would otherwise keep reapplying itself forever —
    // drop it so the next visit starts from defaults instead of repeating the same dead end.
    if (e instanceof ApiError && e.status === 401) clearSubsFilterPrefs();
  }
}

function paintSubsTable(subs: any[]) {
  const tb = $("subsBody") as HTMLElement;
  // lane 4: "→ CPH" only makes sense on rows that are actually yours — public_practice
  // rows belong to other users and almost always have detail locked anyway.
  const mine = !($("sScope") as HTMLSelectElement).value;
  tb.innerHTML = subs.map((x: any) => {
    const tc = x.is_terminal === false && x.current_testcase != null ? `#${x.current_testcase}` : "";
    const toCph = mine ? ` <a class="muted" data-cph="${x.id}" data-pcode="${esc(x.problem)}" title="pull this submission's test cases into CPH">→ CPH</a>` : "";
    return `<tr><td><a data-sub="${x.id}">${esc(x.id)}</a></td><td>${esc(x.problem)}${toCph}</td><td>${esc(x.user_display_name || x.user)}</td>` +
      `<td class="muted">${esc(x.language || "")}</td><td>${esc(plain(x.result || x.status))}</td>` +
      `<td>${x.points ?? ""}</td><td class="muted">${esc(tc)}</td><td class="muted">${x.time ?? ""}</td><td class="muted">${x.memory ?? ""}</td></tr>`;
  }).join("") || `<tr><td class="muted">none</td></tr>`;
  tb.querySelectorAll("a[data-sub]").forEach((a) =>
    (a as HTMLElement).onclick = (e) => { e.preventDefault(); void toggleSubDetail(+(a as HTMLElement).dataset.sub!, a.closest("tr")!); });
  tb.querySelectorAll("a[data-cph]").forEach((a) =>
    (a as HTMLElement).onclick = (e) => {
      e.preventDefault();
      const el = a as HTMLElement;
      void cphImportFromSubmission(+el.dataset.cph!, el.dataset.pcode!);
    });
}

// row click -> fetch + expand a detail row beneath it with per-case results. one open at a time.
async function toggleSubDetail(id: number, tr: Element) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains("sub-detail")) { next.remove(); subsState.openId = null; return; }
  tb_closeDetail();
  subsState.openId = id;
  const cols = tr.children.length;
  const row = document.createElement("tr");
  row.className = "sub-detail";
  row.innerHTML = `<td colspan="${cols}" class="muted">loading #${id}…</td>`;
  tr.after(row);
  try {
    const t = auth.accessToken()!;
    const scope = ($("sScope") as HTMLSelectElement).value || undefined;
    const d = await api.submission(t, id, scope);
    if (subsState.openId !== id) return; // user moved on while this was in flight
    if (d.can_view_detail === false || !d.cases?.length) {
      row.innerHTML = `<td colspan="${cols}">#${id} · ${esc(plain(d.result || d.status))}` +
        `${d.can_view_detail === false ? " — no case detail available for this submission." : " — no cases reported."}</td>`;
      return;
    }
    const caseRows = d.cases.map((c: any) =>
      `<tr><td>${c.case_id ?? ""}</td><td class="muted">${c.batch_id ?? ""}</td><td>${esc(plain(c.status))}</td>` +
      `<td class="muted">${c.time ?? ""}</td><td class="muted">${c.memory ?? ""}</td><td>${c.points ?? ""}/${c.total ?? ""}</td></tr>`).join("");
    row.innerHTML = `<td colspan="${cols}">` +
      `<div class="row"><b>#${id}</b> · ${esc(plain(d.result || d.status))} · ${d.case_points}/${d.case_total}pts</div>` +
      `<table class="sub-cases"><thead><tr><th>case</th><th>batch</th><th>status</th><th>time</th><th>mem</th><th>pts</th></tr></thead><tbody>${caseRows}</tbody></table>` +
      `</td>`;
  } catch (e) {
    if (subsState.openId !== id) return;
    row.innerHTML = `<td colspan="${cols}" class="err">${esc(humanError(e))}</td>`;
  }
}
function tb_closeDetail() { $("subsBody")?.querySelector(".sub-detail")?.remove(); }

// ---------- Google sign-in (both lanes; password stays the primary path) ----------
let gAbort: AbortController | null = null;
function wireGoogle() {
  const btn = document.getElementById("oauthBtn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.onclick = async () => {
    if (gAbort) { gAbort.abort(); return; }              // second click cancels
    gAbort = new AbortController();
    btn.textContent = "cancel Google sign-in";
    msg("authmsg", "starting Google sign-in…", "muted");
    try {
      const { googleLogin, GoogleAbort } = await import("./lib/google");
      let tok;
      try {
        tok = await googleLogin({
          signal: gAbort.signal,
          onStatus: (x) => msg("authmsg", x, "muted"),
          onUrl: (u) => void openExternal(u).then((ok) =>
            msg("authmsg", ok ? "browser opened — finish the Google sign-in there." : "couldn't open a browser — open this link yourself: " + u, "muted")),
        });
      } catch (e) {
        if (e instanceof GoogleAbort) { msg("authmsg", "google sign-in cancelled.", "muted"); return; }
        throw e;
      }
      authedId = null;                                    // login must not write into the previous profile
      auth.seed(tok);
      const me: any = await api.me(tok.access_token).catch(() => null);
      const name: string = me?.username ?? me?.user?.username ?? "google";
      if (S.layout === "wip") {
        let p = profiles.find((x) => x.username === name);
        if (!p) p = { id: "p-" + Date.now().toString(36), username: name, locked: false, lockHash: null, savedPwEnc: null, needsReauth: false, token: tok } as Profile;
        else { p.token = tok; p.needsReauth = false; }
        setProfList(upsertProfile(profList(), p)); setActiveId(p.id); authedId = p.id;
        paintProfiles();
      }
      msg("authmsg", "");
      await afterLogin(name);
    } catch (e) { msg("authmsg", humanError(e), "err"); }
    finally { gAbort = null; btn.textContent = "log in with Google"; }
  };
}

// ---------- Auth (Default profile, sketches/login.png) ----------
let joined: boolean = false;

function updateContestButtons() {
  const ok = S.contest != null && joined;
  ($("joinC") as HTMLButtonElement).disabled = !S.contest || ok;
  ($("leaveC") as HTMLButtonElement).disabled = !S.contest;
  ($("submit") as HTMLButtonElement).disabled = !ok;
}

async function openContest(key: string) {
  const gen = ++viewGen;
  S.contest = key; S.mode = "contest"; S.part = null; joined = false; S.problem = null;
  submitCtx = null;
  cmsgSet("joining " + key + "…");
  updateContestButtons();
  setPublicUI(false); // contest lane: fixed list, filters off
  const t = auth.accessToken()!;
  try {
    const j: any = await api.join(t, key);
    if (gen !== viewGen) return; // a newer selection owns the view now
    S.part = j.participation_id ?? j.id ?? null;
    joined = true;
    cmsgSet("joined " + key);
    showView("#v-problems");
  } catch (e) {
    if (gen !== viewGen) return;
    const msg2 = humanError(e);
    if (/already joined|already participated|participation exists|already in/i.test(msg2)) {
      joined = true;
      cmsgSet("already in " + key);
      showView("#v-problems");
    } else {
      cmsgSet("join failed: " + msg2);
      joined = false;
      updateContestButtons();
      return;
    }
  }
  try {
    const list = await api.contestProblems(t, key);
    if (gen !== viewGen) return;
    const arr = Array.isArray(list) ? list : ((list as any).items || (list as any).data || []);
    renderProblems(arr.map((p: any) => ({ ...p, _join: "contest" })));
  } catch (e) { if (gen === viewGen) ($("cmsg") as HTMLElement).textContent = humanError(e); }
  try { await api.workspace(t, key); } catch { /* workspace optional */ }
  if (gen === viewGen) updateContestButtons();
}

// ---------- Auth wiring (baseplate: plain login) ----------
let profiles: Profile[] = loadProfiles();

async function bpLogin(username: string, pw: string) {
  msg("authmsg", "");
  if (!username || !pw) { msg("authmsg", "username and password. that's all baseplate asks.", "err"); return; }
  try {
    await auth.login(username, pw);
    await afterLogin(username);
  } catch (e) { msg("authmsg", humanError(e), "err"); }
}

function wireAuthSimple() {
  const u = $("bpUser") as HTMLInputElement;
  const p = $("bpPass") as HTMLInputElement;
  const show = $("bpShow") as HTMLButtonElement;
  show.textContent = "show";
  show.onclick = () => {
    p.type = p.type === "password" ? "text" : "password";
    show.textContent = p.type === "password" ? "show" : "hide";
  };
  const go = () => void bpLogin(u.value.trim(), p.value);
  ($("bpLogin") as HTMLButtonElement).onclick = go;
  p.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } };
  u.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); p.focus(); } };
  // stored sessions resume via the boot legacy path; nothing else to do here.
}

// ---------- Auth wiring (wip: Default profile, sketches/login.png) ----------
let phase: "user" | "pass" = "user";
let pendingUnlock: string | null = null;
let pendingLockPw: string | null = null; // bridges the two-step unlock so step 2 can (re-)encrypt savedPwEnc

let authedId: string | null = null; // profile that owns the live session
auth.onTokenChange((t) => {
  if (!t || !authedId) return;
  const p = profiles.find((x) => x.id === authedId);
  if (p) { p.token = t; p.needsReauth = false; setProfList(upsertProfile(profList(), p)); }
});

// logout must also kill the profile's stored token, else render() -> wireAuth() logs straight back in.
async function doLogout() {
  bumpView(); // F09: in-flight open/submit continuations die with the session
  const p = profiles.find((x) => x.id === authedId);
  if (p) { p.token = null; setProfList(upsertProfile(profList(), p)); }
  authedId = null; cancelWatch?.(); cancelWatch = null;
  await auth.logout();
  S.contest = S.problem = null; S.mode = null; S.part = null; joined = false;
  // public lane: drop accumulated pages so the next login starts clean
  pstate.started = false; pstate.page = 1; pstate.items = []; pstate.exhausted = false;
  render();
}

async function resumeProfile(p: Profile) {
  authedId = p.id;
  auth.seed(p.token);
  // validates + rotates; listener persists the new pair. A refresh failure is
  // ambiguous (contract has no definitive invalid-refresh response) — keep the
  // credentials and let one authenticated read decide whether the session is dead.
  let dead = false;
  try { await auth.silentRefresh(); }
  catch (e) {
    if (e instanceof SessionChangedError) return; // another login/logout owns the session now
    try { await api.me(auth.accessToken()!); }
    catch (e2) {
      if (e2 instanceof SessionChangedError) return;
      dead = e2 instanceof ApiError && e2.status === 401;
    }
  }
  if (dead) {
    authedId = null;
    p.needsReauth = true; p.token = null;
    setProfList(upsertProfile(profList(), p)); paintProfiles();
    setPhase("pass", passPromptFor(p));
    msg("authmsg", "session expired — password again.", "err");
    showView("#v-auth");
    return;
  }
  await afterLogin(p.username);
}

function profList(): Profile[] { return profiles; }
function setProfList(l: Profile[]) { profiles = l; saveProfiles(l); }
function activeProfile(): Profile | undefined {
  return profiles.find((x) => x.id === activeId()) ?? profiles[0];
}
function activeName(): string { return activeProfile()?.username ?? ""; }

function paintProfiles() {
  const sel = $("prof") as HTMLSelectElement;
  const cur = activeId();
  sel.innerHTML = profiles.map((p) => {
    const marks = `${p.locked ? " 🔒" : ""}${p.needsReauth ? " ⚠" : ""}`;
    return `<option value="${esc(p.id)}" ${p.id === cur ? "selected" : ""}>${esc(p.username)}${marks}</option>`;
  }).join("") || `<option value="">(no saved profiles yet)</option>`;
  const p = profiles.find((x) => x.id === (sel.value || cur));
  ($("pfp") as HTMLElement).textContent = (p?.username || "?").slice(0, 1).toUpperCase();
  const pm = $("profMsg") as HTMLElement;
  if (p?.needsReauth) { pm.textContent = "⚠ stored token died — password again."; pm.className = "warn"; }
  else if (p?.locked) { pm.textContent = "🔒 locked — lock password opens it, login fills itself in."; pm.className = "muted"; }
  else { pm.textContent = ""; pm.className = "muted"; }
}

function setPhase(ph: "user" | "pass", label?: string) {
  phase = ph;
  const pEl = document.getElementById("stepPass") as HTMLInputElement | null;
  if (!pEl) return; // baseplate lane has no stepped flow
  pEl.hidden = ph === "user";
  ($("showPass") as HTMLButtonElement).hidden = ph === "user";
  ($("phaseLbl") as HTMLElement).textContent = ph === "user" ? "username" : (label ?? "password");
  if (ph === "pass" && !label) pEl.placeholder = "password";
  if (ph === "pass") pEl.focus();
}

function passPromptFor(p?: Profile): string {
  if (p?.locked && p.lockHash) return "lock password";
  if (p?.locked) return "new lock password";
  return "password";
}

async function afterLogin(username: string) {
  bumpView(); // fresh session — nothing from the previous one may still commit
  const t = auth.getToken()!;
  const sp = $("stepPass") as HTMLInputElement | null; // baseplate lane has no stepped flow
  if (sp) sp.value = "";
  ($("who") as HTMLElement).textContent = "in as " + username + " · expires in " + t.access_expires_in + "s";
  ($("logout") as HTMLButtonElement).disabled = false;
  ($("reloadC") as HTMLButtonElement).disabled = false;
  ($("reloadP") as HTMLButtonElement).disabled = false;
  setPhase("user");
  joined = false;
  S.contest = null; S.mode = null; S.part = null;
  updateContestButtons();
  if (S.layout === "wip") { showView("#v-home"); void loadHome(username); void loadContests(); return; }
  showView("#v-contests");
  await loadContests();
}

function wireAuth() {
  // baseplate: plain login, no profile machinery. machine lives in the wip lane.
  wireGoogle();
  if (S.layout !== "wip") { wireAuthSimple(); return; }
  paintProfiles();
  const sel = $("prof") as HTMLSelectElement;
  const uEl = $("stepUser") as HTMLInputElement;
  const pEl = $("stepPass") as HTMLInputElement;
  const cur = profiles.find((x) => x.id === activeId()) ?? profiles[0];
  if (cur) {
    uEl.value = cur.username;
    if (cur.token && !cur.locked && !cur.needsReauth) {
      setPhase("user");
      void resumeProfile(cur);
    } else setPhase("pass", passPromptFor(cur));
  }
  sel.onchange = () => {
    const p = profiles.find((x) => x.id === sel.value);
    if (!p) return;
    setActiveId(p.id);
    pendingUnlock = null;
    uEl.value = p.username;
    pEl.value = "";
    paintProfiles();
    if (p.token && !p.locked && !p.needsReauth) {
      void resumeProfile(p);
    } else setPhase("pass", passPromptFor(p));
  };
  ($("lockBtn") as HTMLButtonElement).onclick = async () => {
    const name = uEl.value.trim();
    if (!name) return;
    let p = profiles.find((x) => x.username === name);
    if (!p) {
      if (!pEl.value) {
        msg("authmsg", "type the lock password first — it guards the baked-in login.", "err");
        setPhase("pass", "new lock password");
        return;
      }
      p = { id: "p-" + Date.now().toString(36), username: name, locked: true,
            lockHash: await vault.hashLockPw(pEl.value), savedPwEnc: null, needsReauth: false, token: null };
      pEl.value = "";
    } else if (!p.locked) {
      p.locked = true;
      if (pEl.value) { p.lockHash = await vault.hashLockPw(pEl.value); p.savedPwEnc = null; pEl.value = ""; }
      else if (!p.lockHash) {
        msg("authmsg", "type the lock password first — it guards the baked-in login.", "err");
        setPhase("pass", "new lock password");
        return;
      }
    } else if (p.lockHash) {
      // F03: removing an armed lock proves the lock password first — a click must
      // never strip the gate off a stored session.
      if (!pEl.value) { msg("authmsg", "type the lock password to remove the lock.", "err"); setPhase("pass", "lock password"); return; }
      if (!(await vault.verifyLockPw(pEl.value, p.lockHash))) { msg("authmsg", "wrong lock password — lock stays.", "err"); return; }
      p.locked = false; p.lockHash = null; p.savedPwEnc = null; // locking = forgetting — see lib/vault.ts
      pEl.value = "";
    } else {
      // locked but never armed (no hash): finish arming instead of dropping it bare
      if (!pEl.value) {
        msg("authmsg", "type the lock password first — it guards the baked-in login.", "err");
        setPhase("pass", "new lock password");
        return;
      }
      p.lockHash = await vault.hashLockPw(pEl.value);
      pEl.value = "";
    }
    setProfList(upsertProfile(profList(), p)); setActiveId(p.id);
    paintProfiles(); setPhase("pass", passPromptFor(p));
  };
  ($("showPass") as HTMLButtonElement).onclick = () => {
    pEl.type = pEl.type === "password" ? "text" : "password";
    ($("showPass") as HTMLButtonElement).textContent = pEl.type === "password" ? "show" : "hide";
  };
  ($("nextBtn") as HTMLButtonElement).onclick = () => {
    const p = profiles.find((x) => x.username === uEl.value.trim());
    if (phase === "user" && uEl.value.trim()) { pendingUnlock = null; setPhase("pass", passPromptFor(p)); }
    else void doStepLogin();
  };
  uEl.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setPhase("pass", passPromptFor(profiles.find((x) => x.username === uEl.value.trim())));
    }
  };
  pEl.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); void doStepLogin(); } };
  ($("loginBtn") as HTMLButtonElement).onclick = () => doStepLogin();
}

async function doStepLogin() {
  msg("authmsg", "");
  const name = ($("stepUser") as HTMLInputElement).value.trim();
  const pwEl = $("stepPass") as HTMLInputElement;
  const pw = pwEl.value;
  if (!name) { msg("authmsg", "username first — type it, hit >, then password.", "err"); setPhase("user"); return; }
  if (!pw) { msg("authmsg", "password phase — type it, hit > again.", "err"); setPhase("pass", passPromptFor(profiles.find((x) => x.username === name))); return; }
  try {
    authedId = null;
    let p = profiles.find((x) => x.username === name);
    let usedSaved = false;
    let keyForSave: string | null = null; // lock password to (re-)encrypt savedPwEnc with, if applicable
    if (p?.locked && p.lockHash) {
      if (pendingUnlock !== name) {
        if (!(await vault.verifyLockPw(pw, p.lockHash))) throw new Error("wrong lock password.");
        const saved = p.savedPwEnc ? await vault.decryptWithLockPw(pw, p.savedPwEnc) : null;
        if (!saved) {
          pendingUnlock = name;
          pendingLockPw = pw;
          pwEl.value = "";
          setPhase("pass", "account password");
          msg("authmsg", "lock opened — now the account password, one time.", "");
          return;
        }
        await auth.login(name, saved); usedSaved = true;
        keyForSave = pw;
      } else {
        await auth.login(name, pw);
        keyForSave = pendingLockPw;
        pendingUnlock = null; pendingLockPw = null;
      }
      pwEl.value = "";
    } else {
      await auth.login(name, pw);
    }
    const t = auth.getToken()!;
    if (!p) {
      p = { id: "p-" + Date.now().toString(36), username: name, locked: false,
            lockHash: null, savedPwEnc: null, needsReauth: false, token: t };
    } else {
      p.token = t; p.needsReauth = false;
      // only a locked profile has a key to encrypt with; an unlocked one keeps nothing (lane 2).
      if (!usedSaved) p.savedPwEnc = (p.locked && keyForSave) ? await vault.encryptWithLockPw(keyForSave, pw) : null;
    }
    setProfList(upsertProfile(profList(), p)); setActiveId(p.id); authedId = p.id;
    paintProfiles();
    await afterLogin(name);
  } catch (e) { msg("authmsg", humanError(e), "err"); }
}

// ---------- Config ----------
function paintCfg() {
  const sel = $("cfgProf") as HTMLSelectElement;
  const keep = sel.value;
  sel.innerHTML = profiles.map((p) =>
    `<option value="${esc(p.id)}">${esc(p.username)}${p.locked ? " 🔒" : ""}</option>`).join("")
    || `<option value="">(none)</option>`;
  if (profiles.some((p) => p.id === keep)) sel.value = keep;
}

function wireConfig() {
  paintCfg();
  ($("cfgShow") as HTMLButtonElement).onclick = () => {
    const i = $("cfgLockPw") as HTMLInputElement;
    i.type = i.type === "password" ? "text" : "password";
    ($("cfgShow") as HTMLButtonElement).textContent = i.type === "password" ? "show" : "hide";
  };
  ($("cfgDelete") as HTMLButtonElement).onclick = async () => {
    const id = ($("cfgProf") as HTMLSelectElement).value;
    if (!id) return;
    setProfList(profList().filter((p) => p.id !== id));
    if (activeId() === id) {
      setActiveId(null);
      await doLogout();
      return;
    }
    paintCfg(); paintProfiles();
    msg("cfgMsg", "profile deleted.", "");
  };
  ($("cfgSetLock") as HTMLButtonElement).onclick = async () => {
    const id = ($("cfgProf") as HTMLSelectElement).value;
    const v = ($("cfgLockPw") as HTMLInputElement).value;
    const p = profiles.find((x) => x.id === id);
    if (!p || !v) { msg("cfgMsg", "pick a profile and type the new lock password.", "err"); return; }
    p.locked = true; p.lockHash = await vault.hashLockPw(v);
    p.savedPwEnc = null; // new key — old savedPwEnc (if any) can't be decrypted with it, next login re-saves
    ($("cfgLockPw") as HTMLInputElement).value = "";
    setProfList(upsertProfile(profList(), p));
    paintCfg(); paintProfiles();
    msg("cfgMsg", `lock set on ${p.username}.`, "ok");
  };
  ($("cfgClearLock") as HTMLButtonElement).onclick = async () => {
    const id = ($("cfgProf") as HTMLSelectElement).value;
    const v = ($("cfgLockPw") as HTMLInputElement).value;
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    // F03 (site 2): removing an armed lock proves the lock password first.
    if (p.lockHash) {
      if (!v) { msg("cfgMsg", "type that profile's lock password to remove the lock.", "err"); return; }
      if (!(await vault.verifyLockPw(v, p.lockHash))) { msg("cfgMsg", "wrong lock password — lock stays.", "err"); return; }
      ($("cfgLockPw") as HTMLInputElement).value = "";
    }
    p.locked = false; p.lockHash = null; p.savedPwEnc = null; // locking = forgetting — see lib/vault.ts
    setProfList(upsertProfile(profList(), p));
    paintCfg(); paintProfiles();
    msg("cfgMsg", `lock removed from ${p.username} — saved login was tied to it, log in again next time.`, "ok");
  };
}

// ---------- Contests ----------
let cpage = 1;

async function loadContests() {
  cmsgSet("loading…");
  try {
    const t = auth.accessToken()!;
    const q = ($("csearch") as HTMLInputElement)?.value.trim();
    const list = await api.contests(t, { ...(q ? { search: q } : {}), page: cpage, page_size: 100 });
    const arr = Array.isArray(list) ? list : ((list as any).items || (list as any).data || []);
    ($("contests") as HTMLElement).innerHTML = arr.map((c: any) => {
      const flags = [
        c.mode, c.is_rated ? "rated" : "", c.is_private ? "private" : "",
        c.is_exam_contest ? "exam" : "", c.is_organization_private ? "org" : "",
        c.is_locked ? "locked" : "",
      ].filter(Boolean).join(" · ");
      return `<tr><td><a data-k="${esc(c.key)}">${esc(c.name || c.key)}</a></td>` +
        `<td class="muted">${esc(flags)}</td></tr>`;
    }).join("") || `<tr><td class="muted">none</td></tr>`;
    ($("contests") as HTMLElement).querySelectorAll("a").forEach((a) =>
      (a as HTMLElement).onclick = () => openContest((a as HTMLElement).dataset.k!));
    cmsgSet(arr.length + " contest(s) — joined/mine (API lists no past)");
    ($("cpage") as HTMLElement).textContent = "p" + cpage;
    try {
      const h: any = await api.home(t);
      const now = [...(h.current_contests || []), ...(h.future_contests || [])];
      ($("contestsNow") as HTMLElement).innerHTML = now.map((c: any) =>
        `<tr><td><a data-k="${esc(c.key)}">${esc(c.name || c.key)}</a></td>` +
        `<td class="muted">${esc([c.mode, c.is_rated ? "rated" : ""].filter(Boolean).join(" · "))}</td></tr>`).join("")
        || `<tr><td class="muted">none right now</td></tr>`;
      ($("contestsNow") as HTMLElement).querySelectorAll("a").forEach((a) =>
        (a as HTMLElement).onclick = () => openContest((a as HTMLElement).dataset.k!));
    } catch (e) { ($("contestsNow") as HTMLElement).innerHTML = `<tr><td class="muted">${esc(humanError(e))}</td></tr>`; }
  } catch (e) { ($("cmsg") as HTMLElement).textContent = humanError(e); }
}

// ---------- Problems ----------
// public flow: paged + infinite scroll + server-side filters (search/type/group).
// contest flow: fixed list from /contests/{key}/problems — filters never touch it.
let pstate: {
  started: boolean; loading: boolean; exhausted: boolean; page: number;
  items: any[]; topics: string[];
  io: IntersectionObserver | null;
} = { started: false, loading: false, exhausted: false, page: 1, items: [], topics: [], io: null };

const ROW_HEAD = `<tr><th>code</th><th>name · group</th><th>types</th><th>pts</th><th>solvers</th></tr>`;

function rowHtml(p: any, i: number, list: any[]): string {
  const types = Array.isArray(p.types) ? p.types.slice(0, 4).join(", ") : "";
  const flags = [
    p.partial ? "partial" : "",
    p.is_organization_private ? "org" : "",
    p.user_progress ?? "",
  ].filter(Boolean).join(" · ");
  return `<tr><td><a data-i="${i}">${esc(p.code)}</a></td>` +
    `<td>${esc(p.name || p.title || "")}${p.group ? ` <span class="muted">· ${esc(p.group)}</span>` : ""}` +
    `${flags ? ` <span class="muted">(${esc(flags)})</span>` : ""}</td>` +
    `<td class="muted">${esc(types)}</td>` +
    `<td>${p.points ?? ""}</td>` +
    `<td class="muted">${p.user_count != null ? `<a data-solvers="${esc(p.code)}">${p.user_count}</a>` : ""}</td></tr>`;
}

function wireRows(tbodyId: string, list: any[]) {
  const tb = $(tbodyId) as HTMLElement;
  tb.querySelectorAll("a[data-i]").forEach((a) =>
    (a as HTMLElement).onclick = () => openProblem(list[+((a as HTMLElement).dataset.i!)!]));
  tb.querySelectorAll("a[data-solvers]").forEach((a) =>
    (a as HTMLElement).onclick = (e) => {
      e.preventDefault();
      const code = (a as HTMLElement).dataset.solvers!;
      showView("#v-subs");
      ($("sProblem") as HTMLInputElement).value = code;
      subsState.page = 1; void loadSubs();
    });
}

// contest lane — plain list, no filters
function renderProblems(arr: any[]) {
  const wrapped = arr.map((p: any) => ({ ...p, _join: "contest" }));
  const tb = $("problems") as HTMLElement;
  tb.innerHTML = wrapped.map((p, i) => rowHtml(p, i, wrapped)).join("") || `<tr><td class="muted">none</td></tr>`;
  wireRows("problems", wrapped);
}

// public lane — paged accumulate + filters
function setPublicUI(isPublic: boolean) {
  const fr = $("pfilterRow"), sr = $("pScrollRow");
  if (fr) (fr as HTMLElement).style.display = isPublic ? "" : "none";
  if (sr) (sr as HTMLElement).style.display = isPublic ? "" : "none";
}

function renderPublicProblems() {
  const tb = $("problems") as HTMLElement;
  const items = pstate.items.map((p: any) => ({ ...p, _join: "public" }));
  tb.innerHTML = items.map((p, i) => rowHtml(p, i, items)).join("") || `<tr><td class="muted">nothing loaded — reload or loosen a filter.</td></tr>`;
  wireRows("problems", items);
  paintGroupOptions();
}

function paintGroupOptions() {
  const sel = $("pgroup") as HTMLSelectElement;
  if (!sel) return;
  const keep = sel.value;
  const groups = [...new Set(pstate.items.map((p: any) => p.group).filter(Boolean))] as string[];
  sel.innerHTML = `<option value="">group — all</option>` +
    groups.map((g: string) => `<option value="${esc(g)}" ${g === keep ? "selected" : ""}>${esc(g)}</option>`).join("");
  sel.value = keep;
}

function paintTypeOptions() {
  const sel = $("ptype") as HTMLSelectElement;
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = `<option value="">type — all</option>` +
    pstate.topics.map((t: string) => `<option value="${esc(t)}" ${t === keep ? "selected" : ""}>${esc(t)}</option>`).join("");
  sel.value = keep;
}

function setPstat(t: string) { const e = $("pstat"); if (e) e.textContent = t; }

async function ensureTopics() {
  if (pstate.topics.length) return;
  try {
    const t = auth.accessToken()!;
    pstate.topics = (await api.topics(t)) || [];
    paintTypeOptions();
  } catch { /* topics are sugar; ignore failures */ }
}

function resetPublic() {
  pstate.page = 1; pstate.items = []; pstate.exhausted = false; pstate.started = true;
}

async function loadProblemsPage() {
  const t = auth.accessToken();
  if (!t || !pstate.started || pstate.loading || pstate.exhausted) return;
  pstate.loading = true;
  setPstat(`loading page ${pstate.page}…`);
  try {
    const fr = {
      search: ($("psearch") as HTMLInputElement)?.value.trim() ?? "",
      type: ($("ptype") as HTMLSelectElement)?.value ?? "",
      group: ($("pgroup") as HTMLSelectElement)?.value ?? "",
    };
    const list = await api.problems(t, {
      page: pstate.page, page_size: 50,
      ...(fr.search ? { search: fr.search } : {}),
      ...(fr.type ? { type: fr.type } : {}),
      ...(fr.group ? { group: fr.group } : {}),
    });
    const arr = Array.isArray(list) ? list : ((list as any).items || (list as any).data || []);
    const seen = new Set(pstate.items.map((p: any) => p.code));
    const fresh = arr.filter((p: any) => p?.code && !seen.has(p.code));
    pstate.items = pstate.items.concat(fresh);
    pstate.exhausted = arr.length < 50; // last page is short → nothing beyond
    if (arr.length) pstate.page++;
    renderPublicProblems();
    setPstat(pstate.exhausted
      ? `${pstate.items.length} problems · end of list`
      : `${pstate.items.length} loaded · page ${pstate.page - 1} — scroll for more`);
    void ensureTopics();
  } catch (e) { setPstat("error — " + humanError(e)); }
  finally { pstate.loading = false; }
}

async function relaunchPublic() {
  resetPublic();
  await loadProblemsPage();
}

async function openProblem(p: any) {
  const gen = ++viewGen;
  const contestKey = p._join === "contest" ? S.contest : null;
  S.problem = p;
  submitCtx = null;
  cancelWatch?.(); cancelWatch = null; // F09: a watcher never outlives the problem it judged
  ($("stmt") as HTMLElement).textContent = "loading…";
  ($("submit") as HTMLButtonElement).disabled = true;
  try {
    const t = auth.accessToken()!;
    const inTauri = "__TAURI__" in window;
    const d: any = p._join === "contest"
      ? await api.contestProblem(t, contestKey!, p.code, inTauri)
      : await api.problem(t, p.code, inTauri);
    if (gen !== viewGen) return; // a newer problem/contest owns the view now
    // DOMPurify's default export is a FACTORY arrow (root) => createDOMPurify(root)
    // that carries .sanitize as properties. Calling it with HTML spawns a new
    // instance whose "window" is a string — bail-out arrow leaks as text ("c=>Oo(c)").
    // Always go through .sanitize; fall back to a window-bound instance, then to esc().
    const dompurify: any = (DOMPurify as any).default || DOMPurify;
    const sanitize = (html: string): string => {
      try {
        if (typeof dompurify?.sanitize === "function") return String(dompurify.sanitize(html));
        const inst = typeof dompurify === "function" ? dompurify(window) : dompurify;
        if (typeof inst?.sanitize === "function") return String(inst.sanitize(html));
      } catch { /* fall through to escaped raw */ }
      return `<pre class="muted">${esc(html)}</pre>`;
    };
    const rawStmt: any = d.statement;
    let stmtHtml: string;
    if (typeof rawStmt !== "string" || rawStmt.trim().length === 0) {
      stmtHtml = "<span class=muted>(no statement body)</span>";
    } else if (rawStmt.trim().length < 60 && /[<>{}=()\[\]]/.test(rawStmt.trim())) {
      // short statement that looks like code/debris — show as raw text
      stmtHtml = `<pre class="muted">${esc(rawStmt)}</pre>`;
    } else {
      stmtHtml = sanitize(rawStmt);
    }
    ($("stmt") as HTMLElement).innerHTML = stmtHtml;
    // lane 5 (pass #9): per-view — every fresh problem starts rendered, regardless of
    // whatever was toggled while reading a different problem.
    mathRendered = true;
    void paintStatementMath(); // basic KaTeX pass; raw stays one click away
    showView("#v-solve");
    const langs: string[] = d.allowed_languages || [];
    const sel = $("lang") as HTMLSelectElement;
    if (langs.length) sel.innerHTML = langs.map((l) => `<option>${esc(l)}</option>`).join("");
    const prev = (d as any).latest_submission_id;
    if ((d as any).has_submission && prev != null) {
      ($("vmsg") as HTMLElement).className = "muted";
      ($("vmsg") as HTMLElement).textContent = `previous #${prev} — fetching verdict…`;
      poll(Number(prev), 0);
    } else {
      ($("vmsg") as HTMLElement).textContent = "";
    }
    // editor starts truly empty, no stub content.
    // language default: last-used pref wins ONLY if this problem accepts it,
    // otherwise default to the first ACCEPTED language — never a non-accepted one.
    const accepted: string[] = langs.length
      ? langs
      : Array.from(sel.options).map((o) => o.value || o.text);
    const pref: string = (() => { try { return localStorage.getItem("delcc-lang-pref") || ""; } catch { return ""; } })();
    const first: string = pref && accepted.includes(pref) ? pref : (accepted[0] || sel.value);
    await initEditor(first);
    if (gen !== viewGen) return; // editor mount raced a newer selection
    if (first) sel.value = first;
    // the context that produced the statement on screen is the only thing submit acts on
    submitCtx = { problem: p, contest: contestKey, part: S.part, join: p._join === "contest" ? "contest" : "public" };
    ($("submit") as HTMLButtonElement).disabled = false;
    cphResetFor(p.code);
  } catch (e) { if (gen !== viewGen) return; ($("stmt") as HTMLElement).textContent = humanError(e); showView("#v-solve"); }
}

async function onSubmit() {
  const m = $("vmsg"); m.className = "muted"; m.textContent = "submitting…";
  const src = getEditorValue();
  if (!src.trim()) { m.className = "err"; m.textContent = "422 — empty source. write something first."; return; }
  // F09: submit acts on the context that produced the statement on screen, not on
  // whatever the globals hold right now.
  const ctx = submitCtx;
  if (!ctx || S.problem !== ctx.problem) {
    m.className = "err";
    m.textContent = "the problem changed while loading — open it again, then submit.";
    return;
  }
  try {
    const t = auth.accessToken()!;
    const lang = ($("lang") as HTMLSelectElement).value;
    let sub;
    if (ctx.join === "contest")
      sub = await api.submitContest(t, ctx.contest!, ctx.problem.code, lang, src, ctx.part);
    else
      sub = await api.submitPublic(t, ctx.problem.code, lang, src);
    m.textContent = "submitted #" + sub.submission_id + " — judging…";
    poll(sub.submission_id, 0);
  } catch (e) {
    if (e instanceof ApiError && (e as ApiError).status === 409
        && ctx.join === "contest" && ctx.contest) {
      m.textContent = humanError(e) + " — looking for the existing submission…";
      try {
        const t = auth.accessToken()!;
        const list = await api.contestProblemSubmissions(t, ctx.contest, ctx.problem.code);
        const arr = Array.isArray(list) ? list : ((list as any).items || (list as any).data || []);
        const latest = arr[arr.length - 1] ?? arr[0];
        const id = latest?.submission_id ?? latest?.contest_submission_id ?? latest?.id;
        if (id != null) {
          m.textContent = `existing #${id} — judging…`;
          poll(id, 0);
          return;
        }
      } catch (e2) { m.className = "err"; m.textContent = humanError(e2); return; }
    }
    m.className = "err"; m.textContent = humanError(e);
  }
}

const VERDICT: Record<string, string> = {
  QU: "Queued", W: "Waiting", P: "Pending", G: "Grading", J: "Judging",
  AC: "Accepted", WA: "Wrong Answer", TLE: "Time Limit", MLE: "Memory Limit",
  OLE: "Output Limit", RTE: "Runtime Error", CE: "Compile Error",
  IR: "Invalid", IE: "Internal Error", AB: "Aborted", PD: "Pending",
  SC: "Short Circuited", D: "Done",
};
const plain = (code: unknown) => {
  const c = String(code ?? "").trim();
  return c ? `${VERDICT[c] ?? c} (${c})` : "";
};

// one live poll at a time: opening another problem / logging out cancels the old loop.
// stream-first / poll-fallback lives in lib/verdict.ts; this only paints.
let cancelWatch: (() => void) | null = null;
function paintVerdict(id: number, s: any, via: string, terminal: boolean) {
  const m = $("vmsg");
  const st = String(s.status || ""), disp = String(s.status_display || s.result || "");
  if (!terminal) {
    const tc = s.current_testcase != null ? ` · test ${s.current_testcase}` : "";
    m.className = "muted";
    m.textContent = `#${id} · ${plain(st) || plain(disp) || "Judging"}${tc} — waiting on the judge…${via === "stream" ? " · live" : ""}`;
    return;
  }
  const meta = [s.points != null ? `${s.points}pts` : "", s.time ?? "", s.memory ?? ""].filter(Boolean).join(" · ");
  m.className = /^(AC|Accepted)/i.test(disp || st) ? "ok" : "";
  m.textContent = `#${id} · ${plain(disp) || plain(st)}${meta ? " · " + meta : ""}`.trim();
}
function poll(id: number, _n = 0) {
  cancelWatch?.();
  const m = $("vmsg");
  const inContest = S.problem?._join === "contest";
  cancelWatch = watchVerdict({
    id,
    contestKey: inContest ? S.contest : null,
    participationId: inContest ? (S.part as number | null) : null,
    token: () => auth.accessToken(),
    onState: (s, via, term) => paintVerdict(id, s, via, term),
    onTimeout: () => { m.className = "muted"; m.textContent = `#${id} · still judging after 2m — reopen the problem to re-check.`; },
    onError: (e) => { m.className = "err"; m.textContent = humanError(e); },
  });
}

// boot: learn the compile-time layout (friends can't opt into WIP by accident),
// then the newest official client version, then resume any stored session.
void (async () => {
  try { S.layout = (await getLayout()) as "baseplate" | "wip" | "tmath"; } catch { S.layout = "baseplate"; }
  if (S.layout === "tmath") {
    const { bootTmath } = await import("./tmath");
    await bootTmath();
    return;
  }
  // one-time, silent — nothing to prompt for, see lib/vault.ts
  if (await vault.migrateProfiles(profiles)) saveProfiles(profiles);
  // locked / dead profiles never ride a stored session in
  const ap = activeProfile();
  if (ap?.locked || ap?.needsReauth) auth.seed(null);
  render();
  const v = await syncClientVersion();
  const sig = document.querySelector("#sig .muted");
  if (sig) sig.textContent += ` · client v${v}`;
  void checkUpdateBanner();
  // legacy path: stored session, no profile resumed it
  if (auth.getToken() && !authedId) {
    try { await auth.silentRefresh(); } catch { /* transient — stored token stays, next call retries */ }
    if (auth.accessToken()) { showView("#v-contests"); void loadContests(); }
    else render();
  }
})();


// ---------- update banner: informational only, server-feed check vs delcc's own version lives elsewhere ----------
function paintUpdateBanner(notice: NonNullable<Awaited<ReturnType<typeof checkForUpdate>>>) {
  const el = $("updateBanner") as HTMLElement | null;
  const textEl = $("updateBannerText") as HTMLElement | null;
  if (!el || !textEl) { console.warn("[updater] banner elements missing — skipping"); return; }
  const dev = !("installer_url" in notice.manifest);
  const verb = notice.version ? `v${notice.version}` : "(version missing from feed)";
  const was = notice.prevVersion ? `v${notice.prevVersion}` : "(unknown previous)";
  textEl.textContent = dev
    ? `server now requires client ${verb} (was ${was}) — no installer on this channel.`
    : `tmath's official client moved to ${verb} (was ${was}). delcc already talks to the server fine — this is informational only.`;
  const openBtn = $("updateOpenInstaller") as HTMLButtonElement | null;
  if (openBtn) {
    openBtn.hidden = dev;
    if (!dev) {
      openBtn.onclick = async () => {
        const m = notice.manifest as import("./lib/api").ClientReleaseManifest;
        openBtn.disabled = true;
        try { await openExternal(m.installer_url); void recordDownload(m.platform, m.release_id); }
        finally { openBtn.disabled = false; }
      };
    }
  }
  el.hidden = false;
}
($("updateDismiss") as HTMLButtonElement).onclick = () => { ($("updateBanner") as HTMLElement).hidden = true; };
async function checkUpdateBanner() {
  try {
    const notice = await checkForUpdate();
    if (notice) paintUpdateBanner(notice);
  } catch { /* best-effort — never blocks boot, never forces anything */ }
}

// ---------- CPH: local compile/run panel (both-lane solve view) ----------
interface CphUiState {
  problemCode: string | null;
  cases: cph.CphCase[];
  results: Map<string, cph.CphCaseResult>;
  running: boolean;
}
const cphUi: CphUiState = { problemCode: null, cases: [], results: new Map(), running: false };

function cphResetFor(problemCode: string) {
  cphUi.problemCode = problemCode;
  cphUi.cases = cph.loadCases(problemCode);
  cphUi.results = new Map();
  cphUi.running = false;
  ($("cphCompileLog") as HTMLElement).hidden = true;
  ($("cphMockOut") as HTMLElement).hidden = true; // stale mock verdict from the old problem
  cphImportState.page = 1; cphImportState.exhausted = false; // lane 3: fresh sweep per problem
  const moreBtn = $("cphImportMore") as HTMLButtonElement | null; if (moreBtn) moreBtn.hidden = true;
  void paintCphStatus();
  renderCphCases();
}

function cphCurrentLangKey(): string {
  return cph.cphLangKey(($("lang") as HTMLSelectElement)?.value || "");
}

async function paintCphStatus() {
  const el = $("cphStatus"); if (!el) return;
  const runBtn = $("cphRunAll") as HTMLButtonElement | null;
  const lk = cphCurrentLangKey();
  if (!cph.cphSupported(lk)) {
    el.textContent = "CPH: language not supported here yet.";
    if (runBtn) runBtn.disabled = true;
    return;
  }
  el.textContent = "CPH: checking for a local toolchain…";
  const chains = await cph.detectOnce();
  if (!chains.length && !("__TAURI_INTERNALS__" in window)) {
    el.textContent = "CPH: needs the desktop shell (no local process access in a plain browser).";
    if (runBtn) runBtn.disabled = true;
    return;
  }
  const tc = cph.toolchainFor(lk);
  if (!tc) {
    el.textContent = `CPH: no ${lk} compiler/interpreter found on PATH.`;
    if (runBtn) runBtn.disabled = true;
    return;
  }
  el.textContent = `CPH: ${tc.label} ready (${tc.version}).`;
  if (runBtn) runBtn.disabled = cphUi.running;
}

function renderCphCases() {
  const host = $("cphCases") as HTMLElement | null; if (!host) return;
  const limitPlaceholder = ($("cphLimit") as HTMLInputElement)?.value || "2000";
  host.innerHTML = cphUi.cases.map((c, i) => {
    const r = cphUi.results.get(c.id);
    const cls = r ? (r.verdict === "AC" ? "ok" : r.verdict === "RAN" ? "" : "err") : "";
    const badge = r ? `<span class="pill ${cls}">${esc(r.verdict)}${r.verdict !== "RAN" || r.time_ms != null ? ` · ${r.time_ms}ms` : ""}</span>` : "";
    const showOutput = r && r.verdict !== "AC";
    return `<div class="cph-case" data-id="${c.id}">
      <div class="row"><b>TC ${i + 1}</b> ${badge}<button data-rm="${c.id}">remove</button></div>
      <div class="row">
        <label class="muted"><input type="checkbox" data-en="${c.id}" ${c.enabled !== false ? "checked" : ""}> included in Mock Submit</label>
        <label class="muted" title="overrides the panel limit for this case only">
          <input type="number" min="100" max="10000" step="100" data-tl="${c.id}" placeholder="${limitPlaceholder}"
                 value="${c.timeLimitMs ?? ""}" style="width:64px;"> ms
        </label>
      </div>
      <div class="row">
        <textarea data-field="input" data-id="${c.id}" placeholder="stdin">${esc(c.input)}</textarea>
        <textarea data-field="expected" data-id="${c.id}" placeholder="expected output (optional)">${esc(c.expected || "")}</textarea>
      </div>
      ${showOutput ? `<pre class="cph-out ${cls}">stdout:\n${esc(r!.stdout)}${r!.stderr ? `\nstderr:\n${esc(r!.stderr)}` : ""}</pre>` : ""}
    </div>`;
  }).join("") || `<div class="muted">no test cases yet — add one and paste the sample input (+ expected output, optional).</div>`;

  host.querySelectorAll("button[data-rm]").forEach((b) => (b as HTMLElement).onclick = () => {
    const id = (b as HTMLElement).dataset.rm!;
    cphUi.cases = cphUi.cases.filter((c) => c.id !== id);
    cphUi.results.delete(id);
    if (cphUi.problemCode) cph.saveCases(cphUi.problemCode, cphUi.cases);
    renderCphCases();
  });
  let saveTimer: number | undefined;
  host.querySelectorAll("input[data-tl]").forEach((inp) => (inp as HTMLElement).oninput = () => {
    const el = inp as HTMLInputElement;
    const id = el.dataset.tl!;
    const c = cphUi.cases.find((x) => x.id === id);
    if (!c) return;
    const n = Math.round(+el.value);
    c.timeLimitMs = el.value.trim() === "" || !Number.isFinite(n) ? undefined : Math.min(10000, Math.max(100, n));
    cphUi.results.delete(id); // limit changed — old verdict's timing no longer applies
    if (cphUi.problemCode) cph.saveCases(cphUi.problemCode, cphUi.cases);
  });
  host.querySelectorAll("textarea[data-field]").forEach((ta) => (ta as HTMLElement).oninput = () => {
    const el = ta as HTMLTextAreaElement;
    const id = el.dataset.id!, field = el.dataset.field as "input" | "expected";
    const c = cphUi.cases.find((x) => x.id === id);
    if (!c) return;
    c[field] = el.value;
    cphUi.results.delete(id); // source of truth changed — old verdict is stale
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { if (cphUi.problemCode) cph.saveCases(cphUi.problemCode!, cphUi.cases); }, 400);
  });
  host.querySelectorAll("input[data-en]").forEach((cb) => (cb as HTMLElement).onchange = () => {
    const el = cb as HTMLInputElement;
    const c = cphUi.cases.find((x) => x.id === el.dataset.en!);
    if (!c) return;
    c.enabled = el.checked;
    ($("cphMockOut") as HTMLElement).hidden = true; // mixture changed — stale mock verdict
    if (cphUi.problemCode) cph.saveCases(cphUi.problemCode, cphUi.cases);
    void paintCphIncludedCount();
  });
  paintCphIncludedCount();
}

// how many cases Mock Submit would touch right now
function paintCphIncludedCount() {
  const el = $("cphMockOut"); if (!el) return;
  const n = cphUi.cases.filter((c) => c.enabled !== false).length;
  el.textContent = `${n}/${cphUi.cases.length} case(s) included in Mock Submit`;
  el.hidden = cphUi.cases.length === 0;
}

// shared runner core: compiles + runs `cases`, paints per-case badges, returns the
// response (null on compile failure / error). `silent` lets Mock Submit paint its own
// summary instead of the step-by-step status line.
async function cphExecute(cases: cph.CphCase[], silent: boolean): Promise<cph.CphRunResponse | null> {
  if (cphUi.running) return null;
  const lk = cphCurrentLangKey();
  if (!cph.cphSupported(lk)) { if (!silent) void paintCphStatus(); return null; }
  const tc = cph.toolchainFor(lk);
  if (!tc) { if (!silent) void paintCphStatus(); return null; }
  const src = getEditorValue();
  if (!src.trim()) { if (!silent) ($("cphStatus") as HTMLElement).textContent = "CPH: editor is empty."; return null; }
  cphUi.running = true;
  const runBtn = $("cphRunAll") as HTMLButtonElement; runBtn.disabled = true;
  const mockBtn = $("cphMock") as HTMLButtonElement | null; if (mockBtn) mockBtn.disabled = true;
  const logEl = $("cphCompileLog") as HTMLElement; logEl.hidden = true;
  if (!silent) ($("cphStatus") as HTMLElement).textContent = "CPH: compiling / running…";
  const limitRaw = +($("cphLimit") as HTMLInputElement).value || 2000;
  const limit = Math.min(10000, Math.max(100, limitRaw));
  let response: cph.CphRunResponse | null = null;
  try {
    const res = await cph.runAll(lk, src, cases, limit);
    if (!res.compile_ok) {
      logEl.hidden = false;
      logEl.textContent = res.compile_log || "compile failed (no output captured).";
      if (!silent) ($("cphStatus") as HTMLElement).textContent = "CPH: compile failed.";
    } else {
      // full sweep replaces results; subset sweeps (Mock) merge so untouched badges survive
      if (cases.length === cphUi.cases.length) {
        cphUi.results = new Map(res.results.map((r) => [r.id, r]));
      } else {
        const merged = new Map(cphUi.results);
        for (const r of res.results) merged.set(r.id, r);
        cphUi.results = merged;
      }
      if (!silent) {
        const ac = res.results.filter((r) => r.verdict === "AC").length;
        const ran = res.results.filter((r) => r.verdict === "RAN").length;
        ($("cphStatus") as HTMLElement).textContent =
          `CPH: ${ac}/${res.results.length - ran} passed${ran ? ` (${ran} without expected output)` : ""}.`;
      }
      response = res;
    }
  } catch (e) {
    const msg = "CPH: " + ((e as Error)?.message || String(e));
    if (!silent) ($("cphStatus") as HTMLElement).textContent = msg;
    else { const out = $("cphMockOut") as HTMLElement; out.hidden = false; out.className = "err"; out.textContent = "MOCK: " + msg.slice(5); }
  } finally {
    cphUi.running = false; runBtn.disabled = false;
    if (mockBtn) mockBtn.disabled = false;
    renderCphCases();
  }
  return response;
}

async function runCph() {
  if (!cphUi.cases.length) { ($("cphStatus") as HTMLElement).textContent = "CPH: add a test case first."; return; }
  await cphExecute(cphUi.cases, false);
}

// ---------- mock submit: score the ENABLED cases locally, judge-shaped summary ----------
// Never posts anywhere. The summary says mock out loud — the disclosure is the feature.
async function mockSubmit() {
  const out = $("cphMockOut") as HTMLElement;
  out.hidden = false;
  const enabled = cphUi.cases.filter((c) => c.enabled !== false);
  const scored = enabled.filter((c) => c.expected && c.expected.trim());
  if (!cphUi.cases.length) { out.hidden = true; await runCph(); return; }
  if (!enabled.length) { out.className = "warn"; out.textContent = "MOCK: no cases included — enable some TCs, or use run all."; return; }
  if (!scored.length) { out.className = "warn"; out.textContent = "MOCK: no included case has an expected output — fill expected fields, or use run all."; return; }

  const res = await cphExecute(scored, true);
  if (!res) return;
  const byId = new Map(res.results.map((r) => [r.id, r]));
  let pass = 0, worstMs = 0, wa = 0, re = 0, tle = 0;
  for (const c of scored) {
    const r = byId.get(c.id);
    if (!r) continue;
    worstMs = Math.max(worstMs, r.time_ms);
    if (r.verdict === "AC") pass++;
    else if (r.verdict === "WA") wa++;
    else if (r.verdict === "RE") re++;
    else if (r.verdict === "TLE") tle++;
  }
  const bad: string[] = [];
  if (wa) bad.push(`${wa} WA`); if (re) bad.push(`${re} RE`); if (tle) bad.push(`${tle} TLE`);
  const all = pass === scored.length;
  out.className = all ? "ok" : "err";
  out.textContent =
    `MOCK: ${all ? "AC" : "not AC"} — ${pass}/${scored.length} case(s) accepted` +
    (worstMs ? ` · worst ${worstMs}ms` : "") +
    (bad.length ? ` · ${bad.join(", ")}` : "") +
    " · local run — not judged";
}

function wireCph() {
  ($("cphToggle") as HTMLButtonElement).onclick = () => {
    const panel = $("cphPanel") as HTMLElement;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) void paintCphStatus(); // first open: kick off (cached after) toolchain detection
  };
  ($("cphAddCase") as HTMLButtonElement).onclick = () => {
    cphUi.cases.push(cph.newCase());
    if (cphUi.problemCode) cph.saveCases(cphUi.problemCode, cphUi.cases);
    renderCphCases();
  };
  ($("cphRunAll") as HTMLButtonElement).onclick = () => void runCph();
  ($("cphImport") as HTMLButtonElement).onclick = () => void cphImportCases();
  ($("cphImportMore") as HTMLButtonElement).onclick = () => void cphImportCases();
  ($("cphMock") as HTMLButtonElement).onclick = () => void mockSubmit();
  renderCphCases();
}

// ---------- mock harvest: pull I/Os for this problem out of past submissions ----------
// The judge already serves SubmissionCase.input / .output / .answer to viewable
// submissions (GET /submissions/{id} + /cases[], contract-listed). So "past mine"
// is a legitimate read-only source: feed those I/Os into the local runner and
// score offline. Results stay mock — the banner says so, loudly.
const MOCK_CAP = 40;

function cphNormalizeKey(s: string): string {
  return String(s ?? "").replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trimEnd();
}

function cphCphKeyFor(c: cph.CphCase): string {
  return cphNormalizeKey(c.input) + "\u0000" + cphNormalizeKey(c.expected || "");
}

// Shared by the page-sweep harvester and the single-submission "→ CPH" pull (lane 4):
// extracts importable cases from one submission's cases[], deduping against `seen` and
// respecting whatever's left of the MOCK_CAP budget. Mutates cphUi.cases directly.
function cphIngestCaseList(cs: any[], seen: Set<string>, capRemaining: number): number {
  let added = 0;
  for (const c of cs) {
    if (added >= capRemaining) break;
    const input = c?.input;
    const expected = c?.output ?? c?.answer;
    if (typeof input !== "string" || input.length > 100_000) continue;
    const cand: cph.CphCase = { id: cph.newCase().id, input, expected: typeof expected === "string" ? expected : "" };
    const k = cphCphKeyFor(cand);
    if (seen.has(k)) continue;
    seen.add(k);
    cphUi.cases.push(cand);
    added++;
  }
  return added;
}

// lane 3: page-at-a-time sweep. `cphImportState.page` advances on every call so a second
// click (the "more past TCs" button) continues where the last one left off instead of
// re-scanning page 1; the ≤40-case cap and the ≤6-detail-fetches-per-click throttle both
// stay exactly as before.
const PAGE_SIZE = 20;
const cphImportState: { page: number; exhausted: boolean } = { page: 1, exhausted: false };

async function cphImportCases() {
  const code = S.problem?.code;
  const t = auth.accessToken();
  if (!code || !t) { ($("cphStatus") as HTMLElement).textContent = "CPH: open a problem first, and log in."; return; }
  if (!cphUi.problemCode || cphUi.problemCode !== code) cphResetFor(code);
  const importBtn = $("cphImport") as HTMLButtonElement; importBtn.disabled = true;
  const moreBtn = $("cphImportMore") as HTMLButtonElement | null; if (moreBtn) { moreBtn.disabled = true; moreBtn.hidden = true; }
  ($("cphStatus") as HTMLElement).textContent = `CPH: harvesting past submissions (page ${cphImportState.page})…`;
  const seen = new Set(cphUi.cases.map(cphCphKeyFor));
  let added = 0, scanned = 0, fetched = 0, hitInViewable = false;
  try {
    const mine: any[] = await api.submissions(t, { problem: code, page: cphImportState.page, page_size: PAGE_SIZE });
    cphImportState.exhausted = mine.length < PAGE_SIZE;
    for (const row of mine) {
      if (fetched >= 6 || cphUi.cases.length >= MOCK_CAP) break;
      const id = row.id;
      if (id == null) continue;
      scanned++;
      let d: any;
      try { d = await api.submission(t, Number(id)); }
      catch { continue; } // 403/404 on old/private submissions — just skip
      fetched++;
      if (d && d.can_view_detail === false) continue;
      hitInViewable = true;
      const cs: any[] = Array.isArray(d?.cases) ? d.cases : [];
      added += cphIngestCaseList(cs, seen, MOCK_CAP - cphUi.cases.length);
    }
    cphImportState.page++;
    if (cphUi.problemCode) cph.saveCases(cphUi.problemCode, cphUi.cases);
    renderCphCases();
    const note = [
      added ? `${added} case(s) imported from ${fetched} submission(s)` : "no importable case I/Os found this page",
      hitInViewable ? "" : " (none viewable — details locked)",
      scanned - fetched > 0 ? ` · ${scanned - fetched} submission(s) skipped` : "",
      " — mock — not judged",
    ].filter(Boolean).join("");
    ($("cphStatus") as HTMLElement).textContent = "CPH: " + note;
    // note stays on screen until the next status paint (run, toggle, lang change).
    if (moreBtn) moreBtn.hidden = cphImportState.exhausted || cphUi.cases.length >= MOCK_CAP;
  } catch (e) {
    ($("cphStatus") as HTMLElement).textContent = "CPH: harvest failed — " + humanError(e);
  } finally {
    importBtn.disabled = false;
    if (moreBtn) moreBtn.disabled = false;
  }
}

// lane 4: pull one specific submission's cases, from the submissions tab's "→ CPH" link.
async function cphImportFromSubmission(id: number, problemCode: string) {
  const t = auth.accessToken();
  if (!t) return;
  if (!S.problem || S.problem.code !== problemCode) await openProblem({ code: problemCode });
  else showView("#v-solve"); // already loaded — openProblem's own showView only fires on (re)load
  const panel = $("cphPanel") as HTMLElement; panel.hidden = false;
  void paintCphStatus();
  ($("cphStatus") as HTMLElement).textContent = `CPH: pulling cases from submission #${id}…`;
  try {
    const d: any = await api.submission(t, id); // can_view_detail checked below, before touching cases[]
    if (d?.can_view_detail === false) {
      ($("cphStatus") as HTMLElement).textContent = `CPH: submission #${id} detail is locked — nothing to pull.`;
      return;
    }
    const cs: any[] = Array.isArray(d?.cases) ? d.cases : [];
    const seen = new Set(cphUi.cases.map(cphCphKeyFor));
    const got = cphIngestCaseList(cs, seen, MOCK_CAP - cphUi.cases.length);
    if (cphUi.problemCode) cph.saveCases(cphUi.problemCode, cphUi.cases);
    renderCphCases();
    ($("cphStatus") as HTMLElement).textContent = got
      ? `CPH: ${got} case(s) pulled from #${id} — mock — not judged.`
      : `CPH: submission #${id} had no new importable cases.`;
  } catch (e) {
    ($("cphStatus") as HTMLElement).textContent = "CPH: " + humanError(e);
  }
}

// ---------- statement math: basic KaTeX, raw TeX one click away ----------
// Inline \( … \) and \[ … \] plus $$ … $$ are rendered client-side; the raw source
// stays in each span's title (hover shows it) and the toggle button swaps EVERY
// formula to copyable raw text, so drag-copy gives the original TeX, not glyphs.
type MathSpan = { el: HTMLElement; raw: string; display: boolean };
let stmtMath: MathSpan[] = [];
// pass #9 lane 5 supersedes pass #7's "persist across sessions": a global sticky preference
// and "per view, not pasted onto the next formula" are the same toggle contradicting itself —
// every toggle click would immediately re-persist, so resetting from that same key on each new
// problem is a no-op in practice. Dropped the persistence; mathRendered is per-view only, reset
// to "rendered" on every problem open (see the reset at the top of openProblem's math block).
let mathRendered = true;
let mathAutoSkipped = false; // true while a big statement's KaTeX pass was skipped, not yet rendered
const MATH_SIZE_GUARD = 200_000; // chars of sanitized HTML; long-language statements can be huge

const MATH_DISPLAY_RE = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$/g;
const MATH_INLINE_RE = /\\\(([\s\S]+?)\\\)/g;
const MATH_HINT = /\\\(|\\\[|\$\$/;

let katexMod: any = null;
async function ensureKatex() {
  if (!katexMod) {
    katexMod = await import("katex");
    await import("katex/dist/katex.min.css");
  }
  return katexMod.default ?? katexMod;
}

function collectMath(root: HTMLElement): void {
  stmtMath = [];
  const skip = (n: Node) => (n as Text).parentElement?.closest("pre, code, kbd");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  let n = walker.nextNode() as Text | null;
  while (n) {
    const v = n.nodeValue || "";
    if (!skip(n) && MATH_HINT.test(v)) hits.push(n);
    n = walker.nextNode() as Text | null;
  }
  for (const t of hits) {
    const txt = t.nodeValue || "";
    const frag = document.createDocumentFragment();
    let last = 0;
    // fresh regex each node: lastIndex state from a /g regex would leak across uses
    for (const [re, display] of [[MATH_DISPLAY_RE, true], [MATH_INLINE_RE, false]] as const) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt))) {
        if (m.index < last) continue; // inside an earlier match — skip
        if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
        const raw = (m[1] ?? m[2] ?? "").trim();
        const span = document.createElement("span");
        span.className = "dmath" + (display ? " dmath-b" : "");
        span.dataset.raw = raw;
        span.title = raw;
        span.textContent = raw; // fallback so a skipped/pre-KaTeX span is never blank
        frag.appendChild(span);
        stmtMath.push({ el: span, raw, display });
        last = m.index + m[0].length;
        if (last >= txt.length) break;
      }
      if (!last) continue;
    }
    if (!stmtMath.length) continue; // nothing matched in this node (hint was a false positive)
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    if (t.parentElement) t.parentElement.replaceChild(frag, t);
  }
}

async function applyMathMode(): Promise<void> {
  if (!stmtMath.length) return;
  if (!mathRendered) {
    for (const s of stmtMath) s.el.textContent = s.raw; // raw TeX, drag-copyable
    return;
  }
  try {
    const k = await ensureKatex();
    for (const s of stmtMath) {
      try {
        k.render(s.raw, s.el, { displayMode: s.display, throwOnError: false });
        s.el.title = s.raw;
      } catch {
        s.el.textContent = s.raw; // one bad formula never takes the statement down
      }
    }
  } catch {
    for (const s of stmtMath) s.el.textContent = s.raw; // bundle hiccup — stay raw, honest
  }
}

async function paintStatementMath(): Promise<void> {
  const stmt = $("stmt") as HTMLElement;
  const btn = $("mathToggle") as HTMLButtonElement | null;
  if (!stmt) return;
  collectMath(stmt);
  if (btn) btn.hidden = stmtMath.length === 0;
  mathAutoSkipped = false;
  if (!stmtMath.length) return;
  // lane 5 perf guard: a huge statement (long-language problems especially) skips the
  // automatic KaTeX pass — spans already show raw TeX (collectMath's fallback), never
  // blank. The toggle button still renders it on demand, one click, same as always.
  if (stmt.innerHTML.length > MATH_SIZE_GUARD) {
    mathAutoSkipped = true;
    if (btn) btn.textContent = "render math (large statement)";
    return;
  }
  if (btn) btn.textContent = mathRendered ? "math raw" : "math rendered";
  await applyMathMode();
}

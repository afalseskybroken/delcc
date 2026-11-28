// delcc-app/src/tmath/community.ts
// pass #181 — the remaining low-hanging Official surfaces, on documented verbs:
// code-shares (revision-gated publish/stop/list/source), organizations, schoolyears,
// achievements and the settings password-check endpoint. No invented fields.
import { api } from "../lib/api";
import * as auth from "../lib/auth";
import { text, esc, button, loading, errorBox, empty, date } from "./ui";
import "./community.css";

export interface CommunityContext {
  view: "share" | "community";
  params: URLSearchParams;
  contestKey: string;
  participationId: number | null;
  username: string;
  navigate: (params: Record<string, string>) => void;
}

const pageOf = (params: URLSearchParams): number => {
  const n = Number(params.get("page") ?? "1");
  return Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000 ? n : 1;
};
const clean = (value: string | null, cap: number): string =>
  value && value.length <= cap && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
const token = () => { const v = auth.accessToken(); if (!v) throw new Error(text("errors.unauthorized")); return v; };
const SOURCE_CAP = 65_536;

export function mountCommunity(host: HTMLElement, ctx: CommunityContext): () => void {
  let disposed = false;
  const alive = () => !disposed && host.isConnected;
  const stop = () => { disposed = true; };
  const set = (html: string): void => { if (alive()) host.innerHTML = html; };
  const retry = (action: string, fn: () => void): void => {
    host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.onclick = fn;
  };

  async function share(): Promise<void> {
    const key = ctx.contestKey;
    if (!key) { set(empty("errors.invalid")); return; }
    try {
      const state = await api.codeShareState(token(), key);
      if (!alive()) return;
      const cap = state.revision;
      const own = `<section class="tm-card tm-share-own"><div class="tm-card-head"><h2>${text("share.ownTitle")}</h2><span class="tm-chip${state.active ? " active" : ""}">${state.active ? text("share.active") : text("share.inactive")}</span></div>` +
        `<p class="tm-muted">${text("share.revision")}: ${esc(cap)}</p>` +
        (state.item ? `<p>${esc(state.item.problem_name || state.item.problem_code)} · ${esc(state.item.language_key)}</p>` : "") +
        (state.can_share_code && ctx.participationId != null
          ? `<form class="tm-share-form" data-share-form><label>${text("share.problem")}<input name="code" maxlength="128" required></label><label>${text("share.language")}<input name="language" maxlength="10" value="CPP17" required></label><textarea name="source" maxlength="${SOURCE_CAP}" placeholder="// ${esc(text("share.sourceHint"))}" required></textarea><button type="submit" class="tm-button primary"${!state.can_share_code ? " disabled" : ""}>${text("share.publish")}</button></form>`
          : `<p class="tm-muted">${text("share.cannotPublish")}</p>`) +
        (state.active ? `<button type="button" class="tm-button destructive" data-action="share-stop">${text("share.stop")}</button>` : "") +
        `</section>`;
      set(`<section class="tm-page-title"><div><div class="tm-eyebrow">TMATH / STUDENT</div><h1>${text("share.title")}</h1><p class="tm-muted">${esc(state.contest_key || key)}</p></div></section>${own}<section class="tm-card tm-share-list" aria-busy="true">${loading()}</section>`);
      const form = host.querySelector<HTMLFormElement>("[data-share-form]");
      if (form) form.onsubmit = async event => {
        event.preventDefault();
        const data = new FormData(form);
        const code = String(data.get("code") ?? "").slice(0, 128);
        const language = String(data.get("language") ?? "").slice(0, 10);
        const source = String(data.get("source") ?? "").slice(0, SOURCE_CAP);
        if (!code || !language || !source) return;
        const buttonEl = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
        buttonEl.disabled = true;
        try {
          await api.putCodeShare(token(), key, {
            expected_revision: cap, participation_id: ctx.participationId!,
            problem_code: code, language_key: language, source,
          });
          void share();
        } catch (e) {
          if (alive()) form.insertAdjacentHTML("beforeend", errorBox(e));
          buttonEl.disabled = false;
        }
      };
      const stopBtn = host.querySelector<HTMLButtonElement>('[data-action="share-stop"]');
      if (stopBtn) stopBtn.onclick = async () => {
        stopBtn.disabled = true;
        try { await api.stopCodeShare(token(), key, cap); if (alive()) void share(); }
        catch (e) { if (alive()) { host.querySelector(".tm-share-own")!.insertAdjacentHTML("beforeend", errorBox(e)); stopBtn.disabled = false; } }
      };
      await list(state.can_view_shared_codes);
    } catch (e) {
      if (!alive()) return;
      set(errorBox(e) + button("common.retry", "retry"));
      retry("retry", () => void share());
    }
  }

  async function list(canView: boolean): Promise<void> {
    const target = host.querySelector<HTMLElement>(".tm-share-list");
    if (!target || !canView) { if (target) target.innerHTML = empty("share.noPermission"); return; }
    const page = pageOf(ctx.params);
    const student = clean(ctx.params.get("student"), 150);
    const problem = clean(ctx.params.get("problem_code"), 128);
    try {
      const data = await api.codeShares(token(), ctx.contestKey, { student, problem_code: problem, page, page_size: 20 });
      if (!alive()) return;
      const items: any[] = Array.isArray(data?.items) ? data.items : [];
      target.innerHTML = `<form class="tm-share-filters" data-share-filter><label>${text("share.student")}<input name="student" maxlength="150" value="${esc(student)}"></label><label>${text("share.problem")}<input name="problem_code" maxlength="128" value="${esc(problem)}"></label><button type="submit" class="tm-button">${text("homework.apply")}</button></form>` +
        (items.length ? `<div class="tm-table-wrap"><table class="tm-table"><thead><tr><th>${text("share.student")}</th><th>${text("share.problem")}</th><th>${text("share.language")}</th><th>${text("share.revision")}</th><th>${text("homework.dueAt")}</th></tr></thead><tbody>${items.map(s => `<tr><td><button type="button" class="tm-hw-open" data-share-open="${esc(s.student_id)}" data-share-rev="${esc(s.revision)}">${esc(s.display_name || s.username)}</button></td><td>${esc(s.problem_name || s.problem_code)}</td><td>${esc(s.language_key)}</td><td>${esc(s.revision)}</td><td>${esc(date(s.expires_at))}</td></tr>`).join("")}</tbody></table></div>` : empty("common.empty")) +
        `<div class="tm-hw-pager">${page > 1 ? `<button type="button" class="tm-button" data-share-page="${page - 1}">${text("common.previous")}</button>` : ""}${data?.has_more ? `<button type="button" class="tm-button" data-share-page="${page + 1}">${text("common.next")}</button>` : ""}</div>`;
      target.querySelector<HTMLFormElement>("[data-share-filter]")!.onsubmit = event => {
        event.preventDefault();
        const f = new FormData(event.currentTarget as HTMLFormElement);
        const s = String(f.get("student") ?? "").slice(0, 150);
        const p = String(f.get("problem_code") ?? "").slice(0, 128);
        ctx.navigate({ view: "share", contest: ctx.contestKey, ...(s ? { student: s } : {}), ...(p ? { problem_code: p } : {}) });
      };
      target.querySelectorAll<HTMLButtonElement>("[data-share-page]").forEach(b => b.onclick = () =>
        ctx.navigate({ view: "share", contest: ctx.contestKey, page: b.dataset.sharePage ?? "1", ...(student ? { student } : {}), ...(problem ? { problem_code: problem } : {}) }));
      target.querySelectorAll<HTMLButtonElement>("[data-share-open]").forEach(b => b.onclick = () =>
        void source(Number(b.dataset.shareOpen), Number(b.dataset.shareRev)));
    } catch (e) {
      if (!alive()) return;
      target.innerHTML = errorBox(e) + button("common.retry", "retry");
      retry("retry", () => void list(canView));
    }
  }

  async function source(studentId: number, revision: number): Promise<void> {
    try {
      const s = await api.codeShare(token(), ctx.contestKey, studentId, Number.isSafeInteger(revision) && revision > 0 ? revision : undefined);
      if (!alive()) return;
      const code = typeof s.source === "string" ? s.source : "";
      const shown = code.slice(0, SOURCE_CAP * 4);
      set(`<section class="tm-page-title"><div><h1>${text("share.sourceTitle")}</h1><p class="tm-muted">${esc(s.username)} · ${esc(s.problem_name || s.problem_code)} · r${esc(s.revision)}</p></div><button type="button" class="tm-button" data-action="share-back">${text("share.back")}</button></section><pre class="tm-share-source">${esc(shown)}</pre>`);
      retry("share-back", () => void share());
    } catch (e) {
      if (!alive()) return;
      set(errorBox(e) + button("common.retry", "retry"));
      retry("retry", () => void source(studentId, revision));
    }
  }

  async function communityView(): Promise<void> {
    const section = ["achievements", "years", "organizations", "account", "site", "classes"].includes(ctx.params.get("section") ?? "")
      ? ctx.params.get("section")! : "achievements";
    const tabs = ["achievements", "years", "organizations", "account", "site", "classes"].map(s =>
      `<button type="button" class="tm-chip${s === section ? " active" : ""}" data-community-tab="${s}">${text(`community.${s}` as "community.years")}</button>`).join("");
    set(`<section class="tm-page-title"><div><div class="tm-eyebrow">TMATH / STUDENT</div><h1>${text("community.title")}</h1></div><div class="tm-chip-row">${tabs}</div></section><section class="tm-card" aria-busy="true">${loading()}</section>`);
    host.querySelectorAll<HTMLButtonElement>("[data-community-tab]").forEach(b => b.onclick = () =>
      ctx.navigate({ view: "community", section: b.dataset.communityTab ?? "achievements" }));
    const body = host.querySelector<HTMLElement>(".tm-card")!;
    try {
      if (section === "achievements") {
        const [all, featured] = await Promise.all([api.achievements(), api.achievementsFeatured()]);
        if (!alive()) return;
        const rows = (v: any): any[] => Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : [];
        const featuredHtml = rows(featured).length
          ? `<p>${text("community.featured")}: ${rows(featured).map((a: any) => esc(a?.name ?? a?.title ?? "")).filter(Boolean).join(" · ")}</p>` : "";
        const allHtml = rows(all).length
          ? `<ul class="tm-community-list">${rows(all).map((a: any) => `<li>${esc(a?.name ?? a?.title ?? JSON.stringify(a).slice(0, 120))}</li>`).join("")}</ul>`
          : empty("common.empty");
        body.innerHTML = `<div class="tm-card-head"><h2>${text("community.achievements")}</h2></div>${featuredHtml}${allHtml}`;
      } else if (section === "years") {
        const data = await api.years();
        if (!alive()) return;
        const rows = Array.isArray(data) ? data : Array.isArray((data as any)?.items) ? (data as any).items : [];
        body.innerHTML = `<div class="tm-card-head"><h2>${text("community.years")}</h2></div>` +
          (rows.length ? `<ul class="tm-community-list">${rows.map((y: unknown) => `<li>${esc(typeof y === "object" && y !== null ? String((y as Record<string, unknown>).name ?? (y as Record<string, unknown>).year ?? "") : String(y ?? ""))}</li>`).join("")}</ul>` : empty("common.empty"));
      } else if (section === "organizations") {
        const data = await api.organizations(token(), { page: pageOf(ctx.params), page_size: 20 });
        if (!alive()) return;
        body.innerHTML = `<div class="tm-table-wrap"><table class="tm-table"><thead><tr><th>${text("community.orgName")}</th><th>${text("community.orgMembers")}</th><th>${text("community.orgOpen")}</th></tr></thead><tbody>${data.map(o => `<tr><td><button type="button" class="tm-hw-open" data-org="${esc(o.id)}">${esc(o.name)}</button></td><td>${esc(o.member_count ?? "—")}</td><td>${o.is_open ? text("common.yes") : text("common.no")}</td></tr>`).join("")}</tbody></table></div>`;
        body.querySelectorAll<HTMLButtonElement>("[data-org]").forEach(b => b.onclick = () => void orgDetail(Number(b.dataset.org)));
      } else if (section === "site") {
        const b = await api.bootstrap(token());
        if (!alive()) return;
        const site = b?.site && typeof b.site === "object" ? b.site : {};
        const navTabs: any[] = Array.isArray(b?.nav_tabs) ? b.nav_tabs : [];
        const navTree: any[] = Array.isArray(b?.nav_tree) ? b.nav_tree : [];
        const kv = (v: unknown): string => typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? esc(String(v)) : esc(JSON.stringify(v) ?? "");
        body.innerHTML = `<div class="tm-card-head"><h2>${text("community.siteTitle")}</h2></div>` +
          `<p class="tm-muted">${text("community.siteNote")}</p>` +
          `<dl class="tm-profile-dl">${Object.entries(site).map(([k, v]) => `<dt class="tm-dl-row">${esc(k)}</dt><dd>${kv(v)}</dd>`).join("") || `<dd>${empty("common.empty")}</dd>`}</dl>` +
          (navTabs.length ? `<h3 class="tm-section-title">${text("community.navTabs")}</h3><ul class="tm-community-list">${navTabs.map((t2: any) => `<li>${kv(t2?.name ?? t2?.title ?? t2)}</li>`).join("")}</ul>` : "") +
          (navTree.length ? `<h3 class="tm-section-title">${text("community.navTree")}</h3><p class="tm-muted">${text("community.navTreeNote", { n: String(navTree.length) })}</p>` : "");
      } else if (section === "classes") {
        const page = pageOf(ctx.params);
        const data = await api.problemClasses(token(), { page, page_size: 20 });
        if (!alive()) return;
        const rows: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
        body.innerHTML = `<div class="tm-card-head"><h2>${text("community.classesTitle")}</h2><span class="tm-rate-count tm-muted">${text("community.classesNote")}</span></div>` +
          `<form class="tm-share-form" data-class-request><label>${text("community.classId")}<input type="number" name="class_id" min="1" step="1" required></label><label>${text("community.classReason")}<input type="text" name="reason" maxlength="4000"></label><button type="submit" class="tm-button primary">${text("community.classRequest")}</button></form><div role="status" data-class-result></div>` +
          (rows.length ? `<div class="tm-table-wrap"><table class="tm-table"><thead><tr>${Object.keys(rows[0]).map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${rows.map((r2) => `<tr>${Object.values(r2).map((v) => `<td>${esc(typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : empty("common.empty")) +
          `<h3 class="tm-section-title">${text("community.classRequests")}</h3>`;
        const form = body.querySelector<HTMLFormElement>("[data-class-request]")!;
        const result = body.querySelector<HTMLElement>("[data-class-result]")!;
        form.onsubmit = async event => {
          event.preventDefault();
          const f = new FormData(form);
          const cid = Number(f.get("class_id"));
          if (!Number.isSafeInteger(cid) || cid < 1) return;
          try { await api.problemClassRequest(token(), cid, String(f.get("reason") ?? "")); result.textContent = text("community.classRequested"); }
          catch (e) { result.innerHTML = errorBox(e); }
        };
        // the requests queue: whatever the server returns, rendered defensively,
        // with the vote/revocation actions keyed on its own field names.
        try {
          const rq = await api.problemClassRequests(token(), { page: 1, page_size: 20 });
          if (!alive()) return;
          const items: any[] = Array.isArray(rq) ? rq : Array.isArray(rq?.items) ? rq.items : [];
          if (items.length) {
            body.insertAdjacentHTML("beforeend", `<div class="tm-table-wrap"><table class="tm-table"><thead><tr><th>#</th><th>${text("community.classReason")}</th><th>${text("community.classVote")}</th></tr></thead><tbody>${items.map((r2) => {
              const id = Number(r2?.id ?? r2?.request_id ?? 0);
              const grant = Number(r2?.grant_id ?? 0);
              const reason = esc(String(r2?.reason ?? ""));
              return `<tr><td>${id ? esc(String(id)) : "—"}</td><td>${reason || "—"}</td><td>${id ? `<button type="button" class="tm-button" data-vote-yes="${id}">${text("community.voteYes")}</button> <button type="button" class="tm-button" data-vote-no="${id}">${text("community.voteNo")}</button>` : ""}${grant ? ` <button type="button" class="tm-button destructive" data-revoke="${grant}">${text("community.revoke")}</button>` : ""}</td></tr>`;
            }).join("")}</tbody></table></div>`);
            body.querySelectorAll<HTMLButtonElement>("[data-vote-yes]").forEach(b => b.onclick = async () => {
              b.disabled = true;
              try { await api.problemClassVote(token(), Number(b.dataset.voteYes), "approve"); b.textContent = text("community.voted"); }
              catch (e) { b.disabled = false; b.insertAdjacentHTML("afterend", errorBox(e)); }
            });
            body.querySelectorAll<HTMLButtonElement>("[data-vote-no]").forEach(b => b.onclick = async () => {
              b.disabled = true;
              try { await api.problemClassVote(token(), Number(b.dataset.voteNo), "reject"); b.textContent = text("community.voted"); }
              catch (e) { b.disabled = false; b.insertAdjacentHTML("afterend", errorBox(e)); }
            });
            body.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach(b => b.onclick = async () => {
              b.disabled = true;
              try { await api.problemClassRevocation(token(), Number(b.dataset.revoke)); b.textContent = text("community.voted"); }
              catch (e) { b.disabled = false; b.insertAdjacentHTML("afterend", errorBox(e)); }
            });
          } else body.insertAdjacentHTML("beforeend", empty("common.empty"));
        } catch { /* the requests queue is optional — the classes list stands alone */ }
      } else {
        body.innerHTML = `<form class="tm-share-form" data-verify><label>${text("community.password")}<input type="password" name="password" required></label><button type="submit" class="tm-button primary">${text("community.verify")}</button></form><div role="status" data-verify-result></div>`;
        body.querySelector<HTMLFormElement>("[data-verify]")!.onsubmit = async event => {
          event.preventDefault();
          const pw = String(new FormData(event.currentTarget as HTMLFormElement).get("password") ?? "");
          if (!pw) return;
          const result = body.querySelector<HTMLElement>("[data-verify-result]")!;
          result.textContent = text("common.loading");
          try { await api.verifyPassword(token(), pw); result.textContent = text("community.verified"); }
          catch (e) { result.innerHTML = errorBox(e); }
        };
      }
    } catch (e) {
      if (!alive()) return;
      body.innerHTML = errorBox(e) + button("common.retry", "retry");
      retry("retry", () => void communityView());
    }
  }

  async function orgDetail(id: number): Promise<void> {
    try {
      const o = await api.organization(token(), id);
      if (!alive()) return;
      set(`<section class="tm-page-title"><div><div class="tm-eyebrow">TMATH / STUDENT</div><h1>${esc(o.name)}</h1><p class="tm-muted">${esc(o.short_name)}</p></div><button type="button" class="tm-button" data-action="community-back">${text("community.back")}</button></section><section class="tm-card"><p>${esc(o.about || "")}</p><p class="tm-muted">${text("community.created")}: ${esc(date(o.creation_date))} · ${esc(o.member_count ?? "—")} ${text("community.orgMembers")}</p></section>`);
      retry("community-back", () => void communityView());
    } catch (e) {
      if (!alive()) return;
      set(errorBox(e) + button("common.retry", "retry"));
      retry("retry", () => void orgDetail(id));
    }
  }

  void (ctx.view === "share" ? share() : communityView()).catch(e => { if (alive()) set(errorBox(e)); });
  return stop;
}

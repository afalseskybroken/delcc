// delcc-app/src/tmath/homework.ts
// pass #181 — the Official 1.1.1 homework surface. Seven documented calls, twelve
// wire shapes. This is a new VIEW on the same verbs the contest lane already uses:
// no new stream (the spec has none), no local status invention (state / progress /
// submit_blocked_reason are rendered SERVER-VERBATIM), escape-first everywhere.
import {
  api, type HomeworkProblem, type HomeworkProblemDetail, type HomeworkSubmission, type HomeworkSubmissionDetail,
  type ProblemDetail, type ContestProblemDetail, type SubmitResponse,
} from "../lib/api";
import * as auth from "../lib/auth";
import { text, esc, button, loading, errorBox, empty, date } from "./ui";
import type { Preferences } from "./preferences";
import { logError } from "../lib/applog";
import "./homework.css";

export interface HomeworkNav {
  (params: Record<string, string>): void;
}
export interface HomeworkMountSolve {
  (host: HTMLElement, args: {
    code: string; contestKey: string | null; participationId: number | null;
    username: string; preferences: Preferences; onSubmissions: () => void;
    loadDetail: () => Promise<ProblemDetail | ContestProblemDetail>;
    submit: (language: string, source: string) => Promise<SubmitResponse>;
    draftScope: string;
  }): () => void;
}
export interface HomeworkContext {
  view: "list" | "problem" | "history" | "detail" | "source";
  params: URLSearchParams;
  activeContest: string; // the contest the shell is currently inside (Official blocks homework then)
  username: string;
  preferences: Preferences;
  navigate: HomeworkNav;
  returnToContest: () => void;
  mountSolve: HomeworkMountSolve;
  detailHtml: (submission: any) => string;
}

const pageOf = (params: URLSearchParams): number => {
  const n = Number(params.get("page") ?? "1");
  return Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000 ? n : 1;
};
const cleanKey = (value: string | null): string =>
  value && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
const cleanCode = (value: string | null): string =>
  value && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : "";
const paramOf = (params: URLSearchParams, key: string, cap: number): string => {
  const v = params.get(key) ?? "";
  return v.length <= cap && !/[\u0000-\u001f\u007f]/.test(v) ? v : "";
};
const resultPill = (s: HomeworkSubmission): string =>
  `<span class="tm-result-pill${s.result === "AC" ? " ok" : !s.is_terminal ? " pending" : " bad"}">${esc(s.result ?? s.status ?? "—")}${!s.is_terminal && s.current_testcase ? ` · #${esc(s.current_testcase)}` : ""}</span>`;
const progress = (value: string): string => {
  const key = `homework.progress.${value}` as "homework.progress.solved";
  return esc(text(key));
};
const stateLabel = (value: string): string => esc(text(`homework.state.${value}` as "homework.state.open"));

export function mountHomework(host: HTMLElement, ctx: HomeworkContext): () => void {
  let disposed = false;
  let poll: number | null = null;
  let disposeSolve: (() => void) | null = null;
  const alive = () => !disposed && host.isConnected;
  const key = cleanKey(ctx.params.get("contest"));
  const code = cleanCode(ctx.params.get("code"));
  const page = pageOf(ctx.params);
  const token = () => { const value = auth.accessToken(); if (!value) throw new Error(text("errors.unauthorized")); return value; };
  const back = (extra: Record<string, string> = {}): void => {
    const next: Record<string, string> = { ...extra };
    if (key) next.contest = key;
    ctx.navigate(next);
  };
  const stop = (): void => {
    disposed = true;
    if (poll != null) window.clearInterval(poll);
    poll = null;
    disposeSolve?.();
    disposeSolve = null;
  };
  const wireRetry = (action: string, fn: () => void): void => {
    host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.onclick = fn;
  };
  const setBusy = (html: string): void => { if (alive()) host.innerHTML = html; };

  // Official 1.1.1 blocks homework navigation while a contest is live; the card
  // offers the way back instead of pretending the surface is available.
  if (ctx.activeContest) {
    host.innerHTML = `<section class="tm-page-title tm-hw-title"><div><div class="tm-eyebrow">TMATH / STUDENT</div><h1>${text("homework.title")}</h1></div></section><div class="tm-card tm-hw-blocked" role="status"><h2>${text("homework.blockedTitle")}</h2><p class="tm-muted">${text("homework.blockedBody")}</p><button type="button" class="tm-button primary" data-action="return-contest">${text("homework.returnContest")}</button></div>`;
    host.querySelector<HTMLButtonElement>('[data-action="return-contest"]')!.onclick = ctx.returnToContest;
    return stop;
  }

  const itemRow = (p: HomeworkProblem, showContest: boolean): string =>
    `<tr><td><button type="button" class="tm-hw-open" data-hw-code="${esc(p.code)}" title="${esc(p.name)}">${esc(p.code)}</button></td>` +
    `<td>${esc(p.name)}</td>` +
    (showContest ? `<td><a href="#/homework?contest=${encodeURIComponent(p.contest_key)}">${esc(p.contest_name)}</a></td>` : "") +
    `<td>${esc(p.points)}${p.partial ? ` <span class="tm-tag">${text("homework.partial")}</span>` : ""}</td>` +
    `<td>${progress(p.user_progress)}</td>` +
    `<td title="${esc(p.best_points ?? "")}">${esc(p.best_points ?? "—")}</td>` +
    `<td>${esc(p.submission_count)}</td>` +
    `<td title="${esc(p.homework_due_at)}">${esc(date(p.homework_due_at))}</td>` +
    `<td>${p.can_submit ? "—" : esc(p.submit_blocked_reason ?? text("homework.cannotSubmit"))}</td></tr>`;
  const wireOpen = (): void => {
    host.querySelectorAll<HTMLButtonElement>("[data-hw-code]").forEach(b => b.onclick = () =>
      back({ code: b.dataset.hwCode ?? "", view: "problem" }));
  };

  async function renderList(): Promise<void> {
    const search = paramOf(ctx.params, "search", 200);
    const contest = paramOf(ctx.params, "contest", 128);
    const filters = `<form class="tm-hw-filters" data-hw-filters><label>${text("homework.search")}<input name="search" maxlength="200" value="${esc(search)}"></label><label>${text("homework.contestFilter")}<input name="contest" maxlength="128" value="${esc(contest)}"></label><button type="submit" class="tm-button">${text("homework.apply")}</button></form>`;
    setBusy(`<section class="tm-page-title tm-hw-title"><div><div class="tm-eyebrow">TMATH / STUDENT</div><h1>${text("homework.title")}</h1><p class="tm-muted">${text("homework.subtitle")}</p></div></section>${filters}<section class="tm-card tm-hw-card" aria-busy="true">${loading()}</section>`);
    host.querySelector<HTMLFormElement>("[data-hw-filters]")!.onsubmit = event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const next: Record<string, string> = {};
      const s = String(form.get("search") ?? "").slice(0, 200);
      const c = String(form.get("contest") ?? "").slice(0, 128);
      if (s) next.search = s;
      if (c) next.contest = c;
      ctx.navigate(next);
    };
    try {
      if (contest) {
        const data = await api.homeworkContext(token(), contest, { page, page_size: 20 });
        if (!alive()) return;
        if (!cleanKey(data?.contest_key) || data.contest_key !== contest) throw new Error(text("errors.invalid"));
        const blocked = data.submit_blocked_reason ? `<p class="tm-hw-reason" role="status">${esc(data.submit_blocked_reason)}</p>` : "";
        const windowText = `${esc(date(data.homework_start_time))} → ${esc(date(data.homework_due_at))}`;
        host.querySelector<HTMLElement>(".tm-hw-card")!.innerHTML =
          `<div class="tm-card-head"><h2>${esc(data.contest_name)}</h2><span class="tm-chip${data.state === "open" ? " active" : ""}">${stateLabel(data.state)}</span></div>` +
          `<p class="tm-muted">${text("homework.window")}: ${windowText}</p>${blocked}` +
          `<button type="button" class="tm-button" data-action="hw-history">${text("homework.history")}</button>` +
          (data.items.length ? `<div class="tm-table-wrap"><table class="tm-table tm-hw-table"><thead><tr><th>${text("homework.problem")}</th><th>${text("homework.title")}</th><th>${text("account.points")}</th><th>${text("homework.progress")}</th><th>${text("homework.best")}</th><th>${text("homework.attempts")}</th><th>${text("homework.dueAt")}</th><th>${text("homework.cannotSubmit")}</th></tr></thead><tbody>${data.items.map(p => itemRow(p, false)).join("")}</tbody></table></div>`
            : empty("homework.noItems")) +
          pager(data.has_more);
        host.querySelector<HTMLButtonElement>('[data-action="hw-history"]')!.onclick = () => back({ view: "history" });
      } else {
        const data = await api.homework(token(), { page, page_size: 20, search, contest });
        if (!alive()) return;
        host.querySelector<HTMLElement>(".tm-hw-card")!.innerHTML =
          (data.items.length ? `<div class="tm-table-wrap"><table class="tm-table tm-hw-table"><thead><tr><th>${text("homework.problem")}</th><th>${text("homework.title")}</th><th>${text("homework.contest")}</th><th>${text("account.points")}</th><th>${text("homework.progress")}</th><th>${text("homework.best")}</th><th>${text("homework.attempts")}</th><th>${text("homework.dueAt")}</th><th>${text("homework.cannotSubmit")}</th></tr></thead><tbody>${data.items.map(p => itemRow(p, true)).join("")}</tbody></table></div>` : empty("homework.noItems")) + pager(data.has_more);
      }
      wireOpen();
      wirePager();
    } catch (e) {
      if (!alive()) return;
      host.querySelector<HTMLElement>(".tm-hw-card")!.innerHTML = errorBox(e) + button("common.retry", "retry");
      wireRetry("retry", () => void renderList());
    }
  }

  function pager(hasMore: boolean): string {
    return `<div class="tm-hw-pager">${page > 1 ? `<button type="button" class="tm-button" data-hw-page="${page - 1}">${text("common.previous")}</button>` : ""}<span class="tm-muted">${page}</span>${hasMore ? `<button type="button" class="tm-button" data-hw-page="${page + 1}">${text("common.next")}</button>` : ""}</div>`;
  }
  function wirePager(): void {
    host.querySelectorAll<HTMLButtonElement>("[data-hw-page]").forEach(b => b.onclick = () => {
      const next: Record<string, string> = { page: b.dataset.hwPage ?? "1", view: ctx.view };
      if (ctx.params.get("search")) next.search = ctx.params.get("search")!;
      if (ctx.params.get("problem")) next.problem = ctx.params.get("problem")!;
      back(next);
    });
  }

  async function renderProblem(): Promise<void> {
    if (!key || !code) { setBusy(empty("errors.invalid")); return; }
    setBusy(`${loading()}<div id="tm-hw-solve"></div>`);
    try {
      const detail = await api.homeworkProblem(token(), key, code);
      if (!alive()) return;
      if (detail.code !== code || detail.contest_key !== key) throw new Error(text("errors.invalid"));
      const reason = detail.submit_blocked_reason ? `<p class="tm-hw-reason" role="status">${esc(detail.submit_blocked_reason)}</p>` : "";
      host.innerHTML = `<section class="tm-page-title tm-hw-title"><div><div class="tm-eyebrow">${text("homework.eyebrow")} · ${esc(detail.contest_name)}</div><h1>${esc(detail.name)}</h1><p class="tm-muted">${text("homework.window")}: ${esc(date(detail.homework_start_time))} → ${esc(date(detail.homework_due_at))}</p></div><button type="button" class="tm-button" data-action="hw-history">${text("homework.history")}</button></section><section class="tm-card tm-hw-meta"><span class="tm-chip${detail.state === "open" ? " active" : ""}">${stateLabel(detail.state)}</span><span>${text("homework.progress")}: ${progress(detail.user_progress)}</span><span>${text("homework.best")}: ${esc(detail.best_points ?? "—")}</span><span>${text("homework.attempts")}: ${esc(detail.submission_count)}</span></section>${reason}<div id="tm-hw-solve"></div>`;
      host.querySelector<HTMLButtonElement>('[data-action="hw-history"]')!.onclick = () => back({ view: "history", problem: code });
      const solveHost = host.querySelector<HTMLElement>("#tm-hw-solve")!;
      disposeSolve = ctx.mountSolve(solveHost, {
        code, contestKey: key, participationId: null, username: ctx.username, preferences: ctx.preferences,
        onSubmissions: () => back({ view: "history", problem: code }),
        loadDetail: async () => detail as unknown as ProblemDetail | ContestProblemDetail,
        submit: (language, source) => api.submitHomework(token(), key, code, language, source),
        draftScope: `homework:${key}`,
      });
    } catch (e) {
      if (!alive()) return;
      host.innerHTML = errorBox(e) + button("common.retry", "retry") + button("homework.backList", "hw-back");
      wireRetry("retry", () => void renderProblem());
      wireRetry("hw-back", () => ctx.navigate({}));
    }
  }

  async function renderHistory(): Promise<void> {
    if (!key) { setBusy(empty("errors.invalid")); return; }
    const problem = paramOf(ctx.params, "problem", 128);
    setBusy(`${loading()}<div id="tm-hw-history"></div>`);
    const load = async (): Promise<void> => {
      try {
        const data = await api.homeworkSubmissions(token(), key, { page, page_size: 20, problem });
        if (!alive()) return;
        host.innerHTML = `<section class="tm-page-title tm-hw-title"><div><div class="tm-eyebrow">TMATH / STUDENT</div><h1>${text("homework.history")}</h1></div><button type="button" class="tm-button" data-action="hw-back">${text("homework.backList")}</button></section>` +
          `<form class="tm-hw-filters" data-hw-filter><label>${text("homework.problem")}<input name="problem" maxlength="128" value="${esc(problem)}"></label><button type="submit" class="tm-button">${text("homework.apply")}</button></form>` +
          `<section class="tm-card tm-hw-card">${data.items.length ? `<div class="tm-table-wrap"><table class="tm-table tm-hw-table"><thead><tr><th>#</th><th>${text("homework.problem")}</th><th>${text("homework.submittedAt")}</th><th>${text("homework.language")}</th><th>${text("homework.result")}</th><th>${text("account.points")}</th><th></th></tr></thead><tbody>${data.items.map(s => `<tr><td><button type="button" class="tm-sub-id" data-hw-source="${esc(s.id)}"${s.can_view_source ? "" : " disabled"}>#${esc(s.id)}</button></td><td><button type="button" class="tm-hw-open" data-hw-code="${esc(s.problem)}">${esc(s.problem_name || s.problem)}</button></td><td title="${esc(s.date)}">${esc(date(s.date))}</td><td>${esc(s.language ?? "—")}</td><td>${resultPill(s)}</td><td>${esc(s.points ?? "—")}</td><td><button type="button" class="tm-icon-button" data-hw-detail="${esc(s.id)}"${s.is_terminal && s.can_view_detail ? "" : " disabled"} aria-label="${text("subs.details")}">${text("subs.details")}</button></td></tr>`).join("")}</tbody></table></div>` : empty("common.empty")}${pager(data.has_more)}</section>`;
        host.querySelector<HTMLFormElement>("[data-hw-filter]")!.onsubmit = event => {
          event.preventDefault();
          const p = String(new FormData(event.currentTarget as HTMLFormElement).get("problem") ?? "").slice(0, 128);
          back({ view: "history", ...(p ? { problem: p } : {}) });
        };
        host.querySelector<HTMLButtonElement>('[data-action="hw-back"]')!.onclick = () => back({});
        wireOpen(); wirePager();
        host.querySelectorAll<HTMLButtonElement>("[data-hw-source]").forEach(b => b.onclick = () => back({ view: "source", sub: b.dataset.hwSource ?? "" }));
        host.querySelectorAll<HTMLButtonElement>("[data-hw-detail]").forEach(b => b.onclick = () => back({ view: "detail", sub: b.dataset.hwDetail ?? "" }));
        if (data.items.some(s => !s.is_terminal) && poll == null) {
          poll = window.setInterval(() => {
            if (!alive()) { if (poll != null) window.clearInterval(poll); poll = null; return; }
            void load();
          }, 10_000);
        } else if (!data.items.some(s => !s.is_terminal) && poll != null) {
          window.clearInterval(poll); poll = null;
        }
      } catch (e) {
        if (!alive()) return;
        setBusy(errorBox(e) + button("common.retry", "retry") + button("homework.backList", "hw-back"));
        wireRetry("retry", () => void load());
        wireRetry("hw-back", () => back({}));
      }
    };
    await load();
  }

  async function renderDetail(): Promise<void> {
    if (!key || !/^\d+$/.test(ctx.params.get("sub") ?? "")) { setBusy(empty("errors.invalid")); return; }
    const id = Number(ctx.params.get("sub"));
    const load = async (): Promise<void> => {
      try {
        const s: HomeworkSubmissionDetail = await api.homeworkSubmission(token(), key, id);
        if (!alive()) return;
        host.innerHTML = `<section class="tm-page-title tm-hw-title"><div><div class="tm-eyebrow">TMATH / STUDENT</div><h1>#${esc(s.id)} · ${esc(s.problem_name || s.problem)}</h1></div><button type="button" class="tm-button" data-action="hw-back">${text("homework.backHistory")}</button></section><section class="tm-card tm-hw-card">${ctx.detailHtml(s)}</section>`;
        host.querySelector<HTMLButtonElement>('[data-action="hw-back"]')!.onclick = () => back({ view: "history", problem: s.problem });
        if (!s.is_terminal) {
          poll = window.setTimeout(() => void load(), 10_000) as unknown as number;
        }
      } catch (e) {
        if (!alive()) return;
        setBusy(errorBox(e) + button("common.retry", "retry"));
        wireRetry("retry", () => void load());
      }
    };
    await load();
  }

  async function renderSource(): Promise<void> {
    if (!key || !/^\d+$/.test(ctx.params.get("sub") ?? "")) { setBusy(empty("errors.invalid")); return; }
    const id = Number(ctx.params.get("sub"));
    setBusy(`<section class="tm-page-title tm-hw-title"><div><div class="tm-eyebrow">TMATH / STUDENT</div><h1>${text("homework.sourceTitle")}</h1><p class="tm-muted">#${esc(id)}</p></div><button type="button" class="tm-button" data-action="hw-back">${text("homework.backHistory")}</button></section><div role="status" data-hw-source-body>${loading()}</div>`);
    host.querySelector<HTMLButtonElement>('[data-action="hw-back"]')!.onclick = () => back({ view: "history" });
    try {
      const data = await api.homeworkSubmissionSource(token(), key, id);
      if (!alive()) return;
      const body = host.querySelector<HTMLElement>("[data-hw-source-body]")!;
      if (typeof data?.source !== "string" || !data.source) { body.innerHTML = empty("subs.noSourceProvided"); return; }
      const CAP = 262_144;
      const truncated = data.source.length > CAP;
      const shown = truncated ? data.source.slice(0, CAP) : data.source;
      const lines = shown.split("\n").length;
      body.removeAttribute("role");
      body.innerHTML = `<div class="tm-source-viewer" tabindex="0" role="region" aria-label="${esc(text("subs.sourceAria", { n: String(id) }))}"><pre class="tm-source-gutter" aria-hidden="true">${Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</pre><pre class="tm-source-code"><code>${esc(shown)}</code></pre></div>${truncated ? `<p class="tm-muted" role="status">${esc(text("subs.sourceTruncated"))}</p>` : ""}`;
    } catch (e) {
      if (!alive()) return;
      host.querySelector<HTMLElement>("[data-hw-source-body]")!.innerHTML = errorBox(e) + button("common.retry", "retry");
      wireRetry("retry", () => void renderSource());
    }
  }

  const start = (): Promise<void> => {
    if (ctx.view === "problem") return renderProblem();
    if (ctx.view === "history") return renderHistory();
    if (ctx.view === "detail") return renderDetail();
    if (ctx.view === "source") return renderSource();
    return renderList();
  };
  void start().catch(e => { if (alive()) { logError(`homework view: ${e instanceof Error ? e.message : String(e)}`); setBusy(errorBox(e)); } });
  return stop;
}

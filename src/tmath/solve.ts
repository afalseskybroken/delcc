import { api, type ProblemDetail, type ContestProblemDetail, type SubmissionDetail } from "../lib/api";
import * as auth from "../lib/auth";
import * as cph from "../lib/cph";
import { watchVerdict } from "../lib/verdict";
import { t } from "../i18n";
import type { Preferences } from "./preferences";
import { read, write } from "./preferences";
import { esc, text, button, loading, errorBox, copyText } from "./ui";
import { renderStatement, type StatementResult } from "./statement";
import type { createEditor } from "./editor";
import "./solve.css";

export interface SolveArgs {
  code: string;
  contestKey: string | null;
  participationId: number | null;
  username: string;
  preferences: Preferences;
  onSubmissions: () => void;
}

const MAX_CASES = 40;
const MAX_CASE_TEXT = 100_000;
type Editor = ReturnType<typeof createEditor>;

// If browser storage is full/disabled, preserve drafts across in-app navigation.
// These values live only in this WebView and are keyed by account/contest/problem.
const unsavedDrafts = new Map<string, string>();
const warnUnsaved = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
function keepUnsaved(key: string, value: string | null): void {
  if (value === null) unsavedDrafts.delete(key); else unsavedDrafts.set(key,value);
  window.removeEventListener("beforeunload",warnUnsaved);
  if (unsavedDrafts.size) window.addEventListener("beforeunload",warnUnsaved);
}

export function mountSolve(host: HTMLElement, args: SolveArgs): () => void {
  let disposed = false, language = "", statement: StatementResult | null = null;
  let editor: Editor | null = null, fallback: HTMLTextAreaElement | null = null;
  let stopWatch: (() => void) | null = null, submitting = false, running = false;
  let editorLoading = false, switchingLanguage = false, dirty = false, revision = 0;
  let switchingSource: string | null = null;
  let stopping = false, submittedHere = 0;
  let detectDone = false, draftTimer: ReturnType<typeof setTimeout> | null = null;
  let problem: ProblemDetail | ContestProblemDetail;
  // limit seeds from the problem payload itself: TL seconds -> ms, ML KB -> MB
  // (ContestProblemDetail carries both as required fields; public detail too)
  const problemTlMs = (): number => Math.max(100, Math.min(10000, Math.round(Number((problem as {time_limit?: unknown})?.time_limit) * 1000) || 2000));
  const problemMemMb = (): number => {
    const kb = Number((problem as {memory_limit?: unknown})?.memory_limit);
    return Number.isFinite(kb) && kb > 0 ? Math.max(16, Math.min(4096, Math.round(kb / 1024))) : 256;
  };
  let cases: cph.CphCase[] = [];
  let activeCaseId = "";
  let caseTab: "input" | "output" | "options" = "input";
  // per-TC tab memory (audit #32): jumping to a case reopens its last tab, Input first
  const caseTabMemory = new Map<string, "input" | "output" | "options">();
  // visit order (audit #33): removing a TC lands on the most recently visited survivor
  const caseHistory: string[] = [];
  const runMarks = new Map<string, string>();
  // audit #36: per-case actuals live in each case's Output tab, not the console;
  // lastScore feeds the Test-case count pill ("2/3 · 4/40")
  const lastResults = new Map<string, { stdout: string; stderr: string; time_ms: number; exit_code?: number | null }>();
  let lastScore: { passed: number; total: number } | null = null;
  let rawMath = read("delcc-math-mode") === "raw";
  const listeners = new AbortController();
  const drafts = new Map<string, string>();
  const storagePrefix = `delcc-tmath-draft:${encodeURIComponent(args.username)}:${encodeURIComponent(args.contestKey ?? "public")}:${encodeURIComponent(args.code)}:`;
  const langKey = `${storagePrefix}language`;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  // Monaco emits synchronous callbacks while replacing source/language. Disposal
  // during those callbacks must save the outgoing draft, never a half-switched model.
  const source = () => switchingSource ?? editor?.getValue() ?? fallback?.value ?? "";
  const draftKey = (key: string) => `${storagePrefix}${encodeURIComponent(key)}`;
  const loadDraft = (key: string) => drafts.get(key) ?? unsavedDrafts.get(draftKey(key)) ?? read(draftKey(key));
  const saved = () => {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    if (!language || !fallback) return;
    const value = source(); drafts.set(language,value);
    try {
      localStorage.setItem(draftKey(language),value); localStorage.setItem(langKey,language);
      keepUnsaved(draftKey(language),null);
      dirty = false;
      if (!disposed) { const status = $("[data-draft]"); if (status) { status.textContent = t("problem.draftSaved"); status.className = "tm-muted"; } const sb = $('[data-action="save-now"]'); if (sb) sb.textContent = t("problem.saveNow"); }
    } catch {
      keepUnsaved(draftKey(language),value);
      dirty = true;
      if (!disposed) { const status = $("[data-draft]"); if (status) { status.textContent = t("problem.unsaved"); status.className = "tm-error"; } const sb = $('[data-action="save-now"]'); if (sb) sb.textContent = t("problem.retrySave"); }
    }
  };
  const changed = () => {
    if (disposed || switchingLanguage) return;
    dirty = true; revision++;
    const status = $("[data-draft]"); if (status) status.textContent = "";
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(saved,200);
    const result = $("[data-local-summary]");
    if (result?.textContent) { result.textContent = t("cph.stale"); result.className = "tm-status"; }
  };
  const token = () => { const value = auth.accessToken(); if (!value) throw new Error(t("errors.unauthorized")); return value; };

  function controls(): void {
    if (disposed || !fallback) return;
    const canSubmit = !("can_submit" in problem) || problem.can_submit !== false;
    $("[data-submit]").toggleAttribute("disabled", submitting || !language || !canSubmit || ("statement_hidden" in problem && !!problem.statement_hidden));
    $("[data-language]").toggleAttribute("disabled",submitting || !language);
    const available = !!language && cph.cphSupported(cph.cphLangKey(language)) && !!cph.toolchainFor(cph.cphLangKey(language));
    host.querySelectorAll<HTMLButtonElement>("[data-run]").forEach(b => b.disabled = running || !available);
    const compileBtn = host.querySelector<HTMLButtonElement>('[data-action="compile"]');
    if (compileBtn) compileBtn.disabled = running || !available;
    const compileLabel = host.querySelector<HTMLElement>("[data-compile-label]");
    if (compileLabel) compileLabel.textContent = t(language === "PY3" ? "cph.syntaxCheck" : "cph.compile"); // official: PY3 has no compile step
    const stopBtn = host.querySelector<HTMLButtonElement>('[data-action="stop"]');
    if (stopBtn) stopBtn.disabled = !running || stopping; // official: Dừng is live only while a job runs
    paintSubmissionsLeft();
    const editorPresent = !!editor && !$("[data-monaco]").hidden;
    (["editor-undo","editor-redo","editor-find"] as const).forEach(a => { const b = host.querySelector<HTMLButtonElement>(`[data-action="${a}"]`); if (b) b.disabled = !editorPresent; });
    host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("[data-cases] input,[data-cases] textarea,[data-cases] button,[data-add-case],[data-remove-case],[data-import-samples],[data-action=export-cases],[data-action=import-cases]").forEach(b => b.disabled = running);
    $("[data-add-case]").toggleAttribute("disabled", running || cases.length >= MAX_CASES);
    const removeCase = host.querySelector<HTMLButtonElement>("[data-remove-case]");
    if (removeCase) removeCase.toggleAttribute("disabled", running || !cases.length);
    $("[data-import-samples]").toggleAttribute("disabled", running || !statement?.samples.length || cases.length >= MAX_CASES);
    // official barebone surfaces the no-toolchain hint inline under the run strip
    const runHint = host.querySelector<HTMLElement>("[data-run-hint]");
    if (runHint) {
      const missing = detectDone && !available;
      runHint.hidden = !missing;
      if (missing) runHint.textContent = t("problem.runUnavailable");
    }
  }

  function persistCases(): void {
    // Same store/schema as baseplate and WIP: samples are visible there too.
    cph.saveCases(args.code,cases); revision++;
    const summary = $("[data-local-summary]");
    if (summary?.textContent) { summary.textContent = t("cph.stale"); summary.className = "tm-status"; }
  }

  function paintCases(): void {
    if (!cases.some(c => c.id === activeCaseId)) activeCaseId = cases[0]?.id ?? "";
    const hi = caseHistory.indexOf(activeCaseId);
    if (hi >= 0) caseHistory.splice(hi, 1);
    if (activeCaseId) caseHistory.unshift(activeCaseId);
    const mark = (id: string): string => runMarks.has(id) ? ` · ${runMarks.get(id)}` : "";
    // seeds straight from the problem payload (audit #31): TL seconds -> ms, ML KB -> MB;
    // panel and per-case placeholders share them, so limits always mirror the statement
    const defaultTl = problemTlMs(), defaultMl = problemMemMb();
    // verdict + time ride the dropdown option names (audit #32 killed the strip as
    // duplicate) — "Test case 3 · AC · 12 ms" says everything in one place
    $("[data-cases]").innerHTML = `<div class="tm-case-picker"><label class="tm-field"><span class="tm-field-head"><span>${text("cph.casePick")}</span><span class="tm-count-pill" data-case-count title="${text("cph.caseLimit",{n:MAX_CASES})}"></span></span><select data-case-select aria-label="${text("cph.casePick")}">${cases.map((c,i) => `<option value="${esc(c.id)}"${c.id === activeCaseId ? " selected" : ""}>${text("subs.testcase")} ${i+1}${mark(c.id)}</option>`).join("")}</select></label></div>${cases.length ? (() => {
      const c = cases.find(c=>c.id===activeCaseId)!;
      return `<div class="tm-case-tabs" role="tablist"><button type="button" role="tab" aria-selected="${caseTab === "input"}" data-case-tab="input">Input</button><button type="button" role="tab" aria-selected="${caseTab === "output"}" data-case-tab="output">${text("cph.tabOutput")}</button><button type="button" role="tab" aria-selected="${caseTab === "options"}" data-case-tab="options">${text("problem.options")}</button></div><div data-case-pane="input"${caseTab === "input" ? "" : " hidden"}><label class="tm-field">Input<textarea data-input spellcheck="false" maxlength="${MAX_CASE_TEXT}">${esc(c.input)}</textarea></label></div><div data-case-pane="output"${caseTab === "output" ? "" : " hidden"}><label class="tm-field"><span class="tm-field-head"><span>${text("problem.expected")}</span><label class="tm-check"><input type="checkbox" data-score${c.expected != null ? " checked" : ""}>${text("cph.check")}</label></span><textarea data-expected spellcheck="false" maxlength="${MAX_CASE_TEXT}"${c.expected == null ? " disabled" : ""}>${esc(c.expected ?? "")}</textarea></label>${(() => {
        const last = lastResults.get(c.id);
        return last ? `<div class="tm-case-actual"><b>${text("problem.actual")}</b> <span class="tm-muted">${[`${last.time_ms} ms`, exitLine(last.exit_code)].filter(Boolean).join(" · ")}</span><pre class="tm-output-box">${esc(last.stdout)}</pre>${last.stderr ? `<pre class="tm-output-box">${esc(last.stderr)}</pre>` : ""}</div>` : "";
      })()}</div><div data-case-pane="options"${caseTab === "options" ? "" : " hidden"}><div class="tm-case-opts"><label class="tm-field">${text("cph.limit")}<input type="number" data-case-tl min="100" max="10000" step="100" value="${c.timeLimitMs ?? ""}" placeholder="${defaultTl}"></label><label class="tm-field">${text("cph.memLimit")}<input type="number" data-case-ml min="16" max="4096" step="16" value="${c.memoryLimitMb ?? ""}" placeholder="${defaultMl}"></label></div></div>`;
    })() : `<p class="tm-muted">${text("cph.noCases")}</p>`}<p class="tm-muted">${text("cph.blankExpected")}</p>`;
    $("[data-case-count]").textContent = `${lastScore ? `${lastScore.passed}/${lastScore.total} · ` : ""}${cases.length} / ${MAX_CASES}`;
    $("[data-case-count]").classList.toggle("accepted", !!lastScore && lastScore.passed === lastScore.total);
    $<HTMLSelectElement>("[data-case-select]").onchange = e => {
      activeCaseId = (e.currentTarget as HTMLSelectElement).value;
      caseTab = caseTabMemory.get(activeCaseId) ?? "input"; // last-visited tab, Input first
      paintCases();
    };
    host.querySelectorAll<HTMLButtonElement>("[data-case-tab]").forEach(b => b.onclick = () => {
      caseTab = b.dataset.caseTab === "options" ? "options" : b.dataset.caseTab === "output" ? "output" : "input";
      caseTabMemory.set(activeCaseId, caseTab);
      host.querySelectorAll<HTMLButtonElement>("[data-case-tab]").forEach(x => x.setAttribute("aria-selected",String(x.dataset.caseTab === caseTab)));
      host.querySelectorAll<HTMLElement>("[data-case-pane]").forEach(p => { p.hidden = p.dataset.casePane !== caseTab; });
    });
    if (!cases.length) return;
    const c = cases.find(c=>c.id===activeCaseId)!;
    $("[data-input]").oninput = e => { c.input = (e.currentTarget as HTMLTextAreaElement).value; persistCases(); };
    $("[data-expected]").oninput = e => { c.expected = (e.currentTarget as HTMLTextAreaElement).value; persistCases(); };
    $("[data-score]").onchange = e => {
      const check = (e.currentTarget as HTMLInputElement).checked;
      const output = $<HTMLTextAreaElement>("[data-expected]")!;
      c.expected = check ? output.value : null; output.disabled = !check; persistCases();
    };
    // per-case overrides (audit #30): blank = inherit the panel limits
    $<HTMLInputElement>("[data-case-tl]").oninput = e => {
      const el = e.currentTarget as HTMLInputElement;
      if (!el.value.trim()) delete c.timeLimitMs;
      else c.timeLimitMs = Math.max(100, Math.min(10000, Number(el.value) || defaultTl));
      persistCases();
    };
    $<HTMLInputElement>("[data-case-ml]").oninput = e => {
      const el = e.currentTarget as HTMLInputElement;
      if (!el.value.trim()) delete c.memoryLimitMb;
      else c.memoryLimitMb = Math.max(16, Math.min(4096, Number(el.value) || defaultMl));
      persistCases();
    };
    controls();
  }

  function addSamples(): void {
    let added = 0;
    for (const s of statement?.samples ?? []) {
      if (cases.length >= MAX_CASES) break;
      if (s.input.length > MAX_CASE_TEXT || s.output.length > MAX_CASE_TEXT) continue;
      if (cases.some(c=>c.input===s.input && c.expected===s.output)) continue;
      cases.push({...cph.newCase(), input:s.input, expected:s.output, enabled:true}); added++;
    }
    persistCases(); paintCases(); $("[data-local-summary]").textContent = t("cph.sampleImported",{n:added});
  }

  // ---- pass #11: Compile / Stop / submit confirm / submissions-left (official oE parity) ----
  // pass #29: run output lives in the first layer's Output tab (official barebone
  // anatomy, carve @q_/Z_: Input tab = stdin, Output tab = the run log pre)
  const setIoTab = (tab: "input" | "output"): void => {
    host.querySelectorAll<HTMLButtonElement>("[data-io-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.ioTab === tab)));
    host.querySelectorAll<HTMLElement>("[data-io-pane]").forEach(p => { p.hidden = p.dataset.ioPane !== tab; });
  };
  const showOutput = () => setIoTab("output");
  const exitLine = (code: number | null | undefined) => code == null ? "" : t("cph.exitCode", { n: code });
  // audit #35: the Output tab is the ONE run console — every mode (Compile, Run,
  // Run current/all TCs) writes stdout/stderr + a single "N ms · Exit code: X" tail
  const fmtResult = (r: { verdict: string; stdout: string; stderr: string; time_ms: number; exit_code?: number | null }): string =>
    `${r.stdout}${r.stderr ? `\n\nstderr:\n${r.stderr}` : ""}${r.verdict === "TLE" ? `\n\n${t("cph.stoppedTimeout")}` : ""}${r.verdict === "CANCELLED" ? `\n\n${t("cph.cancelled")}` : ""}\n\n${[`${r.time_ms} ms`, exitLine(r.exit_code)].filter(Boolean).join(" · ")}`;

  function paintSubmissionsLeft(): void {
    const el = host.querySelector<HTMLElement>("[data-submissions-left]"); if (!el) return;
    const p = problem as { remaining_submissions?: unknown; max_submissions?: unknown };
    if (typeof p.remaining_submissions !== "number") { el.hidden = true; return; }
    const left = Math.max(0, p.remaining_submissions - submittedHere);
    el.hidden = false;
    el.textContent = left === 0 ? t("problem.submissionsNone") : t("problem.submissionsLeft", { left, max: typeof p.max_submissions === "number" ? p.max_submissions : "—" });
  }

  async function compileSource(): Promise<void> {
    if (running || disposed || switchingLanguage) return;
    const summary = $("[data-local-summary]");
    if (!source().trim()) { summary.textContent = t("problem.emptySource"); return; }
    const lang = cph.cphLangKey(language);
    if (!cph.cphSupported(lang) || !cph.toolchainFor(lang)) { summary.textContent = t("problem.runUnavailable"); return; }
    running = true; stopping = false; controls(); summary.className = "tm-status"; summary.textContent = t("cph.busy");
    showOutput();
    const out = $("[data-manual-stdout]"); out.innerHTML = `<span class="tm-run-dot"></span>${esc(t("cph.busy"))}`;
    try {
      const r = await cph.compileOnly(lang, source());
      if (disposed) return;
      $("[data-compile]").textContent = r.compile_log;
      out.textContent = [r.compile_log.trim(), r.cancelled ? t("cph.cancelled") : [exitLine(r.exit_code), `${r.time_ms} ms`].filter(Boolean).join(" · ")].filter(Boolean).join("\n\n");
      summary.textContent = [r.cancelled ? t("cph.cancelled") : r.compile_ok ? exitLine(0) : "CE", `${r.time_ms} ms`].filter(Boolean).join(" · ");
    } catch(e) {
      if (!disposed) { const m = e instanceof Error ? e.message : String(e); summary.className = "tm-error"; summary.textContent = `${t("cph.failed")} · ${m}`; out.textContent = m; }
    }
    finally { running = false; stopping = false; if (!disposed) controls(); }
  }

  async function stopLocal(): Promise<void> {
    if (!running || stopping || disposed) return;
    stopping = true; controls();
    try { await cph.stopRun(); } catch { /* the running job's own promise settles the UI */ }
  }

  // official iE: submit goes through a confirm dialog (Radix Dialog; Esc / outside click = back)
  function confirmSubmit(): void {
    if (submitting || disposed || switchingLanguage || !language) return;
    if (host.querySelector("dialog[data-confirm-submit]")) return;
    const dlg = document.createElement("dialog");
    dlg.className = "tm-confirm"; dlg.setAttribute("data-confirm-submit", ""); dlg.setAttribute("aria-labelledby", "tm-confirm-title");
    dlg.innerHTML = `<h2 id="tm-confirm-title">${text("problem.confirmTitle")}</h2><p>${text("problem.confirmBody", { name: String(problem.name ?? args.code) })}</p><div class="tm-confirm-actions"><button type="button" class="tm-button" data-confirm="back">${text("common.back")}</button><button type="button" class="tm-button primary" data-confirm="yes">${text("problem.confirmYes")}</button></div>`;
    host.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
    dlg.querySelector<HTMLButtonElement>('[data-confirm="back"]')!.onclick = () => dlg.close();
    dlg.querySelector<HTMLButtonElement>('[data-confirm="yes"]')!.onclick = () => { dlg.close(); void submit(); };
    dlg.showModal();
  }

  async function run(mode: "all" | "case" | "stdin"): Promise<void> {
    if (running || disposed || switchingLanguage) return;
    const summary = $("[data-local-summary]");
    // The existing native runner returns RAN (unscored) for blank expected output.
    const manual = mode === "stdin";
    const active = cases.find(c => c.id === activeCaseId);
    const selected = manual
      ? [{ ...cph.newCase(), id: "tm-manual-stdin", input: $<HTMLTextAreaElement>("[data-manual-stdin]")?.value ?? "", expected: null, enabled: true }]
      : mode === "case" ? (active ? [active] : [])
      : cases; // Run all TCs means ALL cases (audit #31 — the Include checkbox is gone)
    if (!selected.length) { summary.textContent = t("cph.noCases"); return; }
    if (!source().trim()) { summary.textContent = t("problem.emptySource"); return; }
    const lang = cph.cphLangKey(language);
    if (!cph.cphSupported(lang) || !cph.toolchainFor(lang)) { summary.textContent = t("problem.runUnavailable"); return; }
    const limit = problemTlMs(); // panel fields are gone (audit #32) — problem payload is the base
    const memLimit = problemMemMb();
    const startRevision = revision;
    running = true; stopping = false; controls(); summary.className = "tm-status"; summary.textContent = t("problem.running");
    // single-run modes (stdin / current TC) own the console; Run-all never clots it
    const single = manual || mode === "case";
    if (single) { showOutput(); $("[data-manual-stdout]").innerHTML = `<span class="tm-run-dot"></span>${esc(t("cph.busy"))}`; }
    $("[data-compile]").textContent = "";
    runMarks.clear(); lastResults.clear(); lastScore = null;
    try {
      const result = await cph.runAll(lang,source(),selected.map(c=>({...c})),limit,memLimit);
      if (disposed) return;
      $("[data-compile]").textContent = result.compile_log;
      const scored = selected.filter(c => typeof c.expected === "string" && c.expected.trim().length > 0);
      const passed = result.results.filter(r=>r.verdict === "AC").length;
      const sumMs = result.results.reduce((a, r) => a + (r.time_ms || 0), 0);
      if (scored.length) lastScore = { passed, total: scored.length }; // rides the count pill
      // the status line carries only anomalies — the score is in the pill
      const bits: string[] = [];
      if (!result.compile_ok) bits.push("CE");
      else if (!scored.length) bits.push(`Σ ${sumMs} ms`);
      if (result.cancelled) bits.push(t("cph.cancelled"));
      if (startRevision !== revision) bits.push(t("cph.stale"));
      summary.textContent = bits.join(" · ");
      runMarks.clear();
      // RAN is noise (audit #34): unscored cases carry only their time in the title
      for (const r of result.results) if (r.id !== "tm-manual-stdin") {
        runMarks.set(r.id, r.verdict === "RAN" ? `${r.time_ms} ms` : `${r.verdict} · ${r.time_ms} ms`);
        lastResults.set(r.id, { stdout: r.stdout, stderr: r.stderr, time_ms: r.time_ms, exit_code: r.exit_code });
      }
      const manualOut = $("[data-manual-stdout]");
      if (single) {
        if (!result.compile_ok) manualOut.textContent = [result.compile_log.trim() || "CE", result.cancelled ? t("cph.cancelled") : ""].filter(Boolean).join("\n\n");
        else {
          const rows = mode === "stdin"
            ? (result.results.some(r => r.id === "tm-manual-stdin") ? [result.results.find(r => r.id === "tm-manual-stdin")!] : [])
            : result.results.filter(r => r.id !== "tm-manual-stdin");
          manualOut.textContent = rows.length ? rows.map(r => fmtResult({ verdict: r.verdict, stdout: r.stdout, stderr: r.stderr, time_ms: r.time_ms, exit_code: r.exit_code })).join("\n\n") : result.cancelled ? t("cph.cancelled") : "";
        }
      }
      paintCases();
      if (disposed) return;
    } catch(e) { if (!disposed) { const m = e instanceof Error ? e.message : String(e); summary.className = "tm-error"; summary.textContent = `${t("cph.failed")} · ${m}`; if (single) $("[data-manual-stdout]").textContent = m; } }
    finally { running = false; stopping = false; if (!disposed) controls(); }
  }

  function paintVerdict(s: SubmissionDetail, terminal: boolean): void {
    if (disposed) return;
    const box = $("[data-verdict]"); box.className = "tm-status";
    box.textContent = `#${s.id} · ${terminal ? s.result ?? s.status_display ?? s.status : t("problem.judging")}${!terminal && s.current_testcase != null ? ` · ${t("subs.testcase")} ${String(s.current_testcase)}` : ""}${s.points != null ? ` · ${t("subs.score")}: ${String(s.points)}` : ""}`;
  }

  async function submit(): Promise<void> {
    if (submitting || disposed || switchingLanguage || !language) return;
    const code = source();
    if (!code.trim()) { $("[data-verdict]").textContent = t("problem.emptySource"); return; }
    if (("can_submit" in problem && !problem.can_submit) || ("statement_hidden" in problem && problem.statement_hidden)) return;
    submitting = true; saved(); controls();
    const box = $("[data-verdict]"); box.className = "tm-status"; box.textContent = t("problem.submitting");
    stopWatch?.(); stopWatch = null;
    try {
      const result = args.contestKey
        ? await api.submitContest(token(),args.contestKey,args.code,language,code,args.participationId)
        : await api.submitPublic(token(),args.code,language,code);
      if (disposed) return;
      if (!Number.isSafeInteger(result.submission_id) || result.submission_id <= 0) throw new Error(t("errors.invalid"));
      box.textContent = `#${result.submission_id} · ${t("problem.judging")}`;
      submittedHere++; paintSubmissionsLeft(); // official decrements the counter on an accepted submission
      stopWatch = watchVerdict({ id:result.submission_id, contestKey:args.contestKey, participationId:args.participationId,
        token:auth.accessToken, onState:(s,_via,terminal)=>paintVerdict(s,terminal),
        onTimeout:()=>{ if (!disposed) box.textContent = `#${result.submission_id} · ${t("problem.judgeTimeout")}`; },
        onError:e=>{ if (!disposed) box.innerHTML = errorBox(e); },
      });
    } catch(e) { if (!disposed) box.innerHTML = errorBox(e); }
    finally { submitting = false; controls(); }
  }

  async function mountEditor(): Promise<void> {
    if (editor || editorLoading || disposed) return;
    editorLoading = true;
    try {
      const { createEditor } = await import("./editor");
      if (disposed) return;
      const value = fallback!.value;
      $("[data-monaco]").hidden = false;
      const created = createEditor($("[data-monaco]"),value,language,args.preferences,changed);
      if (disposed) { created.dispose(); return; }
      editor = created;
      fallback!.hidden = true; $("[data-editor-message]").replaceChildren();
    } catch {
      if (!disposed) {
        $("[data-monaco]").hidden = true; fallback!.hidden = false;
        $("[data-editor-message]").innerHTML = `<p class="tm-muted">${text("problem.editorFallback")}</p>${button("problem.retryEditor","retry-editor")}`;
        $<HTMLButtonElement>('[data-action="retry-editor"]').onclick = () => void mountEditor();
      }
    } finally { editorLoading = false; }
  }

  function splitter(): void {
    const split = $("[data-split]"), grip = $("[data-splitter]");
    let value = Number(read("delcc-tmath-split","42.5"));
    const set = (n: number) => {
      value = Math.max(25,Math.min(75,Number.isFinite(n) ? n : 42.5));
      split.style.setProperty("--tm-statement-width",`${value}fr`); split.style.setProperty("--tm-editor-width",`${100-value}fr`);
      grip.setAttribute("aria-valuenow",String(Math.round(value)));
    };
    set(value);
    grip.onpointerdown = e => { grip.setPointerCapture(e.pointerId); split.dataset.dragging = ""; };
    grip.onpointermove = e => { if (!grip.hasPointerCapture(e.pointerId)) return; const rect = split.getBoundingClientRect(); set((e.clientX-rect.left)/rect.width*100); };
    grip.onpointerup = e => { if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId); delete split.dataset.dragging; write("delcc-tmath-split",String(value)); };
    grip.onlostpointercapture = () => { delete split.dataset.dragging; };
    grip.onkeydown = e => { if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return; e.preventDefault(); set(value+(e.key === "ArrowLeft" ? -2 : 2)); write("delcc-tmath-split",String(value)); };
  }

  async function load(): Promise<void> {
    host.innerHTML = loading();
    try {
      problem = args.contestKey ? await api.contestProblem(token(),args.contestKey,args.code,true) : await api.problem(token(),args.code,true);
      if (disposed) return;
      const allowed = Array.isArray(problem.allowed_languages) ? problem.allowed_languages.filter((l): l is string=>typeof l === "string" && !!l) : [];
      const storedLang = read(langKey); language = allowed.includes(storedLang) ? storedLang : allowed[0] ?? "";
      const hidden = "statement_hidden" in problem && problem.statement_hidden;
      const statementSource = hidden ? t("problem.hidden") : problem.statement || t("problem.noStatement");
      const canSubmit = !("can_submit" in problem) || problem.can_submit !== false;
      // official statement anatomy (byte-traced from the 1.0.9 bundle): limits
      // live in one tinted 2-column grid of four cells, then the article.
      const ioCell = (side: "input" | "output"): string => {
        const m = problem.io_method as { method?: unknown; input?: unknown; output?: unknown } | null | undefined;
        if (m?.method === "standard") return side === "input" ? "stdin" : "stdout";
        const v = (typeof m?.[side] === "string" ? (m[side] as string) : "").trim();
        if (m?.method === "file") return v ? `File: ${esc(v)}` : text("problem.notProvided");
        return !m?.method && v ? esc(v) : text("problem.notProvided");
      };
      const limitCell = (v: unknown, unit: string): string =>
        typeof v === "number" && Number.isFinite(v) && v > 0 ? `${v} ${unit}` : text("problem.notProvided");
      const modeLabel = text(args.contestKey ? "problem.modeContest" : "problem.modePractice");
      // honest file-I/O note: the local runner speaks stdin only; file-method problems get the hint line
      const ioMethod = problem.io_method as { method?: unknown } | null | undefined;
      const fileMethodHint = ioMethod?.method === "file" ? `<p class="tm-muted">${text("cph.fileUnsupported")}</p>` : "";
      const fileName = (key: string): string => { const k = (key || "").toUpperCase(); return /^PY|^PYPY/.test(k) ? "main.py" : /^JAVA/.test(k) ? "Main.java" : /^(PAS|FPC)/.test(k) ? "main.pas" : "main.cpp"; };
      const KNOWN_LANGS = ["C","C11","CPP03","CPP11","CPP14","CPP17","CPP20","JAVA8","MONOCS","PAS","PY2","PY3","PYPY3","TEXT"];
      // official c_ display-name map (carve langName): select shows "C++17", value stays the key.
      const LANG_NAMES: Record<string, string> = { C: "C", C11: "C11", CPP03: "C++03", CPP11: "C++11", CPP14: "C++14", CPP17: "C++17", CPP20: "C++20", JAVA8: "Java 8", MONOCS: "C#", PAS: "Pascal", PY2: "Python 2", PY3: "Python 3", PYPY3: "PyPy 3", TEXT: "Text" };
      const langLabel = (l: string) => LANG_NAMES[l] ?? l;
      const langOptions = [...allowed, ...KNOWN_LANGS.filter(k => !allowed.includes(k))].map(l => { const ok = allowed.includes(l); return `<option value="${esc(l)}"${l === language ? " selected" : ""}${ok ? "" : ` disabled class="tm-disallowed" title="${text("problem.languageDisallowed")}"`}>${esc(langLabel(l))}</option>`; }).join("");
      const titleBlock = args.contestKey
        ? `<div class="tm-problem-heading"><h2>${esc(problem.name ?? args.code)}</h2><span class="tm-muted">${esc(args.code)}</span></div>`
        : `<div class="tm-page-title"><div><div class="tm-eyebrow">${text("problem.solveEyebrow")}</div><h1>${esc(problem.name ?? args.code)}</h1><p class="tm-muted">${esc(args.code.toUpperCase())} · ${esc(typeof problem.points === "number" ? String(problem.points) : "—")} ${text("problem.pointsSuffix")}</p></div><div class="tm-page-title-actions"><button type="button" class="tm-button" data-action="problems-list">${text("problems.backToList")}</button><button type="button" class="tm-button" data-action="my-subs">${text("problems.mySubs")}</button></div></div>`;
      host.innerHTML = `<section class="tm-solve-view">${titleBlock}<div class="tm-solve" data-split><section class="tm-pane"><header class="tm-pane-header"><span>${text("problem.statement")}</span><details class="tm-menu"><summary aria-label="${text("problem.options")}">${text("problem.options")}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="tm-menu-body"><button class="tm-button ghost" type="button" data-math aria-pressed="${!rawMath}">${text(rawMath ? "problem.mathRaw" : "problem.mathRendered")}</button>${button("problem.copy","copy-statement")}${button("problem.saveMarkdown","save-statement")}${button("subs.title","submissions")}</div></details></header><div class="tm-pane-body"><dl class="tm-problem-limits" aria-label="${text("problem.limitsIo")}"><div class="tm-limit-cell"><dt>${text("problem.timeLimit")}</dt><dd>${limitCell(problem.time_limit, text("problem.seconds"))}</dd></div><div class="tm-limit-cell"><dt>${text("problem.memoryLimit")}</dt><dd>${limitCell(problem.memory_limit, "KB")}</dd></div><div class="tm-limit-cell"><dt>${text("problem.ioInput")}</dt><dd>${ioCell("input")}</dd></div><div class="tm-limit-cell"><dt>${text("problem.ioOutput")}</dt><dd>${ioCell("output")}</dd></div></dl><div class="tm-statement" data-statement></div></div></section><div class="tm-splitter" data-splitter role="separator" tabindex="0" aria-label="${text("problem.resize")}" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" aria-controls="tm-solve-editor"></div><section class="tm-pane" id="tm-solve-editor"><header class="tm-pane-header tm-editor-header"><div class="tm-editor-title"><span class="tm-editor-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg></span><span class="tm-editor-filename" data-filename>${esc(fileName(language))}</span><select data-language aria-label="${text("problem.language")}">${langOptions}</select></div><div class="tm-editor-actions"><button type="button" class="tm-icon-button" data-action="editor-undo" aria-label="${text("problem.undo")}" title="${text("problem.undo")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button><button type="button" class="tm-icon-button" data-action="editor-redo" aria-label="${text("problem.redo")}" title="${text("problem.redo")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button><button type="button" class="tm-icon-button" data-action="editor-find" aria-label="${text("problem.findReplace")}" title="${text("problem.findReplace")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg></button><button type="button" class="tm-icon-button" data-action="editor-save" aria-label="${text("problem.saveSource")}" title="${text("problem.saveSource")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg></button></div></header><div class="tm-editor-container"><div class="tm-editor" data-monaco aria-label="${text("problem.source")}" hidden></div><textarea class="tm-source-fallback" data-source aria-label="${text("problem.source")}" spellcheck="false"></textarea></div><div data-editor-message></div><div class="tm-mode-strip"><span class="tm-tag tm-mode-label">${modeLabel}</span><span data-draft class="tm-muted" role="status" aria-live="polite"></span><button type="button" class="tm-button ghost" data-action="save-now">${text("problem.saveNow")}</button></div><section class="tm-io-first"><div class="tm-io-head"><div class="tm-case-tabs tm-io-tabs" role="tablist" aria-label="${text("cph.stdinLabel")}"><button type="button" role="tab" aria-selected="true" data-io-tab="input">Input</button><button type="button" role="tab" aria-selected="false" data-io-tab="output">Output</button></div><button type="button" class="tm-button" data-action="toggle-cph-options" aria-expanded="false" aria-controls="tm-cph-options">${text("problem.options")}</button></div>${fileMethodHint}<div data-io-pane="input"><textarea data-manual-stdin spellcheck="false" maxlength="65536" aria-label="${text("cph.stdinLabel")}" placeholder="${text("cph.stdinPlaceholder")}"></textarea></div><div data-io-pane="output" hidden><pre data-manual-stdout class="tm-output-box" role="log" tabindex="0">${text("cph.notRun")}</pre></div><div class="tm-io-strip"><button type="button" class="tm-button" data-action="compile"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg> <span data-compile-label>${text("cph.compile")}</span></button><button type="button" class="tm-button primary" data-run="stdin"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg> ${text("cph.runStdin")}</button><button type="button" class="tm-button" data-action="stop" disabled><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/></svg> ${text("cph.stop")}</button><button type="button" class="tm-button primary" data-submit>${text("problem.submit")}</button></div><p class="tm-muted" data-run-hint role="status" hidden></p><p class="tm-muted" data-submissions-left role="status" hidden></p><div data-local-summary role="status" aria-live="polite"></div></section><div class="tm-solve-feedback" data-verdict role="status" aria-live="polite">${!allowed.length ? text("problem.noLanguages") : !canSubmit ? text("problem.submitDenied") : ""}</div><details class="tm-runner" id="tm-cph-options"><summary><b>${text("cph.title")}</b></summary><div class="tm-toolbar"><button type="button" class="tm-button" data-run="case"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg> ${text("cph.runCase")}</button><button type="button" class="tm-button primary" data-run="all"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg> ${text("cph.runAll")}</button></div><div class="tm-toolbar"><button type="button" class="tm-button" data-import-samples>${text("cph.importSamples")}</button><button type="button" class="tm-button" data-add-case>${text("problem.addTest")}</button><button type="button" class="tm-button" data-remove-case>${text("problem.removeTest")}</button><button type="button" class="tm-button" data-action="export-cases">${text("cph.exportCases")}</button><button type="button" class="tm-button" data-action="import-cases">${text("cph.importCases")}</button><input type="file" accept=".json,application/json" hidden data-pool-file aria-hidden="true" tabindex="-1"></div><div data-cases></div><details class="tm-compile"><summary>${text("cph.compileLog")}</summary><pre data-compile></pre></details></details></section></div></section>`;
      fallback = $<HTMLTextAreaElement>("[data-source]"); fallback.value = loadDraft(language); fallback.oninput = changed;
      const render = () => { statement?.dispose(); statement = renderStatement($("[data-statement]"), statementSource, {rawMath}); };
      render();
      const menu = $<HTMLDetailsElement>("details.tm-menu");
      menu.querySelectorAll("button").forEach(b => b.addEventListener("click", () => { menu.open = false; }));
      $<HTMLButtonElement>("[data-math]").onclick = () => { rawMath = !rawMath; write("delcc-math-mode",rawMath ? "raw" : "rendered"); render(); const b = $("[data-math]"); b.textContent = t(rawMath ? "problem.mathRaw" : "problem.mathRendered"); b.setAttribute("aria-pressed",String(!rawMath)); };
      $<HTMLButtonElement>('[data-action="copy-statement"]').onclick = e => { void copyText(statementSource,e.currentTarget as HTMLElement); };
      $<HTMLButtonElement>('[data-action="save-statement"]').onclick = () => {
        const url = URL.createObjectURL(new Blob([statementSource],{type:"text/markdown;charset=utf-8"}));
        const a = document.createElement("a"); a.href = url; a.download = `${args.code.replace(/[^a-zA-Z0-9_-]/g,"_")}.md`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
      };
      $<HTMLButtonElement>('[data-action="submissions"]').onclick = () => { saved(); args.onSubmissions(); };
      const listBtn = $('[data-action="problems-list"]');
      if (listBtn) listBtn.onclick = () => { saved(); location.hash = "#/problems"; };
      const mySubsBtn = $('[data-action="my-subs"]');
      if (mySubsBtn) mySubsBtn.onclick = () => { saved(); args.onSubmissions(); };
      $<HTMLButtonElement>("[data-submit]").onclick = () => confirmSubmit();
      const compileBtn0 = host.querySelector<HTMLButtonElement>('[data-action="compile"]'); if (compileBtn0) compileBtn0.onclick = () => void compileSource();
      const stopBtn0 = host.querySelector<HTMLButtonElement>('[data-action="stop"]'); if (stopBtn0) stopBtn0.onclick = () => void stopLocal();
      $<HTMLSelectElement>("[data-language]").onchange = e => {
        if (disposed || switchingLanguage) return;
        const select = e.currentTarget as HTMLSelectElement;
        const next = select.value; if (!allowed.includes(next) || next === language) return;
        const previousLanguage = language, previousSource = source(), value = loadDraft(next);
        saved(); switchingSource = previousSource; switchingLanguage = true;
        try {
          editor?.setLanguage(next,value);
          if (disposed) return;
          // Commit only after both Monaco operations succeed. No destination
          // draft is written while the model still belongs to the old language.
          language = next; fallback!.value = value;
        } catch {
          if (disposed) return;
          // A failed replacement may leave Monaco partially changed. Preserve the
          // outgoing source in the plain editor and recover through the existing retry.
          editor?.dispose(); editor = null;
          language = previousLanguage; select.value = previousLanguage;
          fallback!.value = previousSource; fallback!.hidden = false;
          $("[data-monaco]").hidden = true;
          $("[data-editor-message]").innerHTML = `<p class="tm-muted">${text("problem.editorFallback")}</p>${button("problem.retryEditor","retry-editor")}`;
          $<HTMLButtonElement>('[data-action="retry-editor"]').onclick = () => void mountEditor();
        } finally { switchingLanguage = false; switchingSource = null; }
        if (disposed) return;
        revision++; saved(); controls();
        const fn = $("[data-filename]"); if (fn) fn.textContent = fileName(language);
        const summary = $("[data-local-summary]"); if (summary.textContent) summary.textContent = t("cph.stale");
      };
      // Persisted local data is untrusted. Cap work and normalize IDs before rendering.
      const ids = new Set<string>();
      cases = cph.loadCases(args.code).filter(c => c && typeof c.input === "string" && c.input.length <= MAX_CASE_TEXT && (c.expected == null || (typeof c.expected === "string" && c.expected.length <= MAX_CASE_TEXT))).slice(0,MAX_CASES).map(c => {
        const id = typeof c.id === "string" && c.id && !ids.has(c.id) ? c.id : cph.newCase().id; ids.add(id);
        return {id,input:c.input,expected:c.expected ?? null,enabled:c.enabled !== false,
          ...(typeof c.timeLimitMs === "number" && Number.isFinite(c.timeLimitMs) ? {timeLimitMs:Math.max(100,Math.min(10_000,c.timeLimitMs))} : {}),
          ...(typeof c.memoryLimitMb === "number" && Number.isFinite(c.memoryLimitMb) ? {memoryLimitMb:Math.max(16,Math.min(4096,c.memoryLimitMb))} : {})};
      });
      paintCases();
      $<HTMLButtonElement>("[data-import-samples]").onclick = addSamples;
      // case-pool round-trip (lane 2 backend by Claude pass #10; UI by Nyx): export writes the
      // canonical {delcc-cases v1} JSON; import validates/dedupes/caps through cph.importCasePool.
      // (local on() helper: wire() is declared further down in this block — TDZ, not reusable here)
      const onPool = (sel: string, fn: () => void) => { const b = host.querySelector<HTMLButtonElement>(sel); if (b) b.onclick = fn; };
      onPool('[data-action="export-cases"]', () => {
        const blob = new Blob([cph.exportCasePool(args.code)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `delcc-cases-${args.code}.json`;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4_000);
      });
      onPool('[data-action="import-cases"]', () => $("[data-pool-file]").click());
      $<HTMLInputElement>("[data-pool-file]").onchange = async e => {
        const f = (e.currentTarget as HTMLInputElement).files?.[0];
        if (!f || disposed) return;
        const summary = $("[data-local-summary]");
        try {
          const r = cph.importCasePool(args.code, await f.text());
          cases = cph.loadCases(args.code);
          runMarks.clear();
          paintCases();
          if (summary && !disposed) { summary.textContent = t("cph.importResult", { added: r.added, skipped: r.skipped }); summary.className = "tm-status"; }
        } catch {
          if (summary && !disposed) { summary.textContent = t("cph.importFailed"); summary.className = "tm-status"; }
        }
        (e.currentTarget as HTMLInputElement).value = "";
      };
      $<HTMLButtonElement>("[data-add-case]").onclick = () => {
        if (cases.length >= MAX_CASES) return;
        const added = { ...cph.newCase(), expected: null, enabled: true };
        cases.push(added); persistCases();
        activeCaseId = added.id; caseTab = "input"; paintCases(); // audit #32 QoL: land inside the new case
      };
      // pass #25: Remove lives beside Add (audit) and drops the ACTIVE case
      const removeCaseBtn = host.querySelector<HTMLButtonElement>("[data-remove-case]");
      if (removeCaseBtn) removeCaseBtn.onclick = () => {
        const active = cases.find(x => x.id === activeCaseId);
        if (!active) return;
        cases = cases.filter(x => x !== active);
        // land on the most recently visited survivor, not TC1 (audit #33)
        activeCaseId = caseHistory.find(id => id !== active.id && cases.some(c => c.id === id)) ?? cases[0]?.id ?? "";
        caseTab = activeCaseId ? (caseTabMemory.get(activeCaseId) ?? "input") : "input";
        persistCases(); paintCases();
      };
      const optsT = $<HTMLButtonElement>('[data-action="toggle-cph-options"]');
      const cphBox = $<HTMLDetailsElement>("#tm-cph-options");
      if (optsT && cphBox) optsT.onclick = () => { cphBox.open = !cphBox.open; optsT.setAttribute("aria-expanded", String(cphBox.open)); };
      host.querySelectorAll<HTMLButtonElement>("[data-io-tab]").forEach(b => b.onclick = () => setIoTab(b.dataset.ioTab === "output" ? "output" : "input"));
      const wire = (sel: string, fn: () => void) => { const b = host.querySelector<HTMLButtonElement>(sel); if (b) b.onclick = fn; };
      wire('[data-action="editor-undo"]', () => editor?.runAction("undo"));
      wire('[data-action="editor-redo"]', () => editor?.runAction("redo"));
      wire('[data-action="editor-find"]', () => editor?.runAction("findReplace"));
      wire('[data-action="editor-save"]', () => saved());
      wire('[data-action="save-now"]', () => saved());
      host.querySelectorAll<HTMLButtonElement>("[data-run]").forEach(b=>b.onclick=()=>{ void run(b.dataset.run as "all" | "case" | "stdin"); });
      splitter(); void mountEditor();
      void cph.detectOnce().catch(()=>[]).then(()=>{ if (!disposed) { detectDone = true; controls(); } });
    } catch(e) {
      if (!disposed) { host.innerHTML = errorBox(e) + button("common.retry","retry"); $<HTMLButtonElement>('[data-action="retry"]').onclick = () => void load(); }
    }
  }

  window.addEventListener("beforeunload",e=>{ if (dirty) { saved(); if (dirty) { e.preventDefault(); e.returnValue = ""; } } },{signal:listeners.signal});
  window.addEventListener("pagehide",saved,{signal:listeners.signal});
  void load();
  return () => {
    if (disposed) return;
    disposed = true; saved(); listeners.abort(); stopWatch?.(); statement?.dispose(); editor?.dispose();
    // Existing HTTP and bounded native CPH bridges have no cancellation command.
    // Late continuations must not touch a replacement view.
  };
}

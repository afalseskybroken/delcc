const { JSDOM } = require("jsdom");
const dom = new JSDOM(`<!doctype html><html><body data-persona="tmath"><div id="app"></div></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;
for (const k of ["window","document","localStorage","sessionStorage","HTMLElement","Node","Element","Event","MouseEvent","KeyboardEvent","CustomEvent","DOMParser","getComputedStyle","HTMLInputElement","HTMLButtonElement","HTMLTextAreaElement","HTMLDialogElement","MutationObserver","Text","DocumentFragment","SVGElement"]) {
  try { Object.defineProperty(globalThis, k, { value: k === "window" ? w : k === "document" ? w.document : w[k], configurable: true, writable: true }); } catch (e) { console.log("skip", k); }
}
globalThis.AbortController = w.AbortController; globalThis.AbortSignal = w.AbortSignal;
for (const k of Object.getOwnPropertyNames(w)) { if (!(k in globalThis)) { try { Object.defineProperty(globalThis, k, { get: () => w[k], configurable: true }); } catch {} } }
Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true });
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0); globalThis.cancelAnimationFrame = (i) => clearTimeout(i);
w.requestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.ResizeObserver = w.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
w.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
// jsdom has no <dialog> modal API: minimal stand-in (wiring check only — real ::backdrop/Esc/focus-trap are NOT covered here)
w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
w.HTMLDialogElement.prototype.close = function () { if (!this.hasAttribute("open")) return; this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = () => `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const calls = [], pending = {};
const problem = { code: "A", name: "A+B <b>x</b>", points: 10, partial: false, statement: "# Hi\n\nadd", allowed_languages: ["CPP17", "PY3"], io_method: { method: "standard" }, version_update: 1, time_limit: 1, memory_limit: 256, has_submission: false, max_submissions: 5, remaining_submissions: 3, can_submit: true };
const tcs = [{ lang_key: "cpp", label: "C++", binary: "g++", version: "g++ 13" }, { lang_key: "python", label: "Python", binary: "python3", version: "Python 3.12" }];
w.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "cph_detect") return Promise.resolve(tcs);
    if (cmd === "cph_compile" || cmd === "cph_run") return new Promise((resolve, reject) => { pending[cmd] = { resolve, reject, args }; });
    if (cmd === "cph_stop") return Promise.resolve(true);
    if (cmd === "get_layout") return Promise.resolve("tmath");
    if (cmd === "api_fetch") {
      const { method, path } = args;
      let status = 200, body = {};
      if (method === "GET" && /^\/problems\/A(\?|$)/.test(path)) body = problem;
      else if (method === "POST" && /\/problems\/A\/submit/.test(path)) body = { submission_id: 7 };
      else if (path.startsWith("/auth/refresh")) body = { access_token: jwt(), refresh_token: "r2", expires_in: 3600, token_type: "Bearer" };
      return Promise.resolve(JSON.stringify({ status, body: JSON.stringify(body) }));
    }
    return Promise.resolve(JSON.stringify({ status: 200, body: "{}" }));
  },
};
require("./bundle.cjs");
const { mountSolve, auth, t } = globalThis.__h;

const results = []; const ok = (name, cond, extra) => { results.push([!!cond, name]); console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "   <-- " + (extra ?? ""))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch {} await sleep(10); } return f(); };
const $ = (s) => w.document.querySelector(s);
const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
const cmds = (c) => calls.filter((x) => x.cmd === c);

(async () => {
  auth.seed({ access_token: jwt(), refresh_token: "r", expires_in: 3600, token_type: "Bearer" });
  const host = $("#app");
  const dispose = mountSolve(host, { code: "A", contestKey: null, participationId: null, username: "u", preferences: { theme: "light", locale: "en-US", statementFont: "x", statementSize: 16, editorFont: "x", editorSize: 14, minimap: false, wordWrap: true }, onSubmissions() {} });
  await waitFor(() => $('[data-action="compile"]'), 5000);
  await waitFor(() => !$('[data-run="stdin"]').disabled, 3000); // detect finished
  const strip = $(".tm-io-strip");
  const order = [...strip.children].map((b) => b.getAttribute("data-action") || (b.hasAttribute("data-run") ? "run" : b.hasAttribute("data-submit") ? "submit" : "?"));
  ok("strip order is Compile, Run, Stop, Submit", order.join() === "compile,run,stop,submit", order.join());
  ok("Run is the primary/solid button (official default variant)", $('[data-run="stdin"]').classList.contains("primary"));
  ok("Stop is disabled while idle", $('[data-action="stop"]').disabled);
  ok("Compile label = Compile for CPP17", $("[data-compile-label]").textContent === t("cph.compile"), $("[data-compile-label]").textContent);
  ok("submissions-left line visible: 3/5", !$("[data-submissions-left]").hidden && $("[data-submissions-left]").textContent === t("problem.submissionsLeft", { left: 3, max: 5 }), $("[data-submissions-left]").textContent);
  ok("toolchain detected via snake_case lang_key => Compile enabled", !$('[data-action="compile"]').disabled);

  const src = $("[data-source]"); src.value = "int main(){}"; src.dispatchEvent(new w.Event("input", { bubbles: true }));

  // ---- Compile, then Stop mid-compile ----
  click($('[data-action="compile"]'));
  await waitFor(() => pending.cph_compile);
  ok("Compile invokes cph_compile with camelCase req", JSON.stringify(pending.cph_compile.args) === JSON.stringify({ req: { langKey: "cpp", binary: "g++", source: "int main(){}" } }), JSON.stringify(pending.cph_compile.args));
  ok("while compiling: Stop enabled, Compile/Run disabled", !$('[data-action="stop"]').disabled && $('[data-action="compile"]').disabled && $('[data-run="stdin"]').disabled);
  ok("Output tab auto-selected and shows busy text", !$('[data-io-pane="output"]').hidden && $('[data-io-tab="output"]').classList.contains("current") && $("[data-manual-stdout]").textContent === t("cph.busy"), $("[data-manual-stdout]").textContent);
  click($('[data-action="stop"]'));
  await waitFor(() => cmds("cph_stop").length === 1);
  ok("Stop invokes cph_stop and disables itself (no double-stop)", cmds("cph_stop").length === 1 && $('[data-action="stop"]').disabled);
  click($('[data-action="stop"]')); await sleep(20);
  ok("second Stop click while stopping is ignored", cmds("cph_stop").length === 1);
  pending.cph_compile.resolve({ compile_ok: false, compile_log: "", exit_code: null, time_ms: 40, cancelled: true }); delete pending.cph_compile;
  await waitFor(() => !$('[data-action="compile"]').disabled);
  ok("cancelled compile shows 'Task cancelled.' and UI recovers", $("[data-manual-stdout]").textContent.includes(t("cph.cancelled")) && $('[data-action="stop"]').disabled && !$('[data-run="stdin"]').disabled, $("[data-manual-stdout]").textContent);

  // ---- Compile success with warnings / failure ----
  click($('[data-action="compile"]')); await waitFor(() => pending.cph_compile);
  pending.cph_compile.resolve({ compile_ok: true, compile_log: "warning: unused", exit_code: 0, time_ms: 80, cancelled: false }); delete pending.cph_compile;
  await waitFor(() => !$('[data-action="compile"]').disabled);
  const out1 = $("[data-manual-stdout]").textContent;
  ok("compile ok: log + 'Exit code: 0'", out1.includes("warning: unused") && out1.includes(t("cph.exitCode", { n: 0 })), out1);
  ok("compile log also lands in the runner panel", $("[data-compile]").textContent === "warning: unused");
  click($('[data-action="compile"]')); await waitFor(() => pending.cph_compile);
  pending.cph_compile.resolve({ compile_ok: false, compile_log: "main.cpp:1: error: boom", exit_code: 1, time_ms: 80, cancelled: false }); delete pending.cph_compile;
  await waitFor(() => !$('[data-action="compile"]').disabled);
  ok("compile error: log + Exit code 1, summary says CE", $("[data-manual-stdout]").textContent.includes("error: boom") && $("[data-manual-stdout]").textContent.includes(t("cph.exitCode", { n: 1 })) && $("[data-local-summary]").textContent.includes("CE"), $("[data-manual-stdout]").textContent + " | " + $("[data-local-summary]").textContent);

  // ---- Run (stdin): TLE shows the official timeout line + exit code; compile failure shows the log ----
  $('[data-io-tab="input"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const stdin = $("[data-manual-stdin]"); stdin.value = "1 2\n";
  click($('[data-run="stdin"]')); await waitFor(() => pending.cph_run);
  ok("Run invokes cph_run with the typed stdin", pending.cph_run.args.req.cases[0].input === "1 2\n" && pending.cph_run.args.req.langKey === "cpp", JSON.stringify(pending.cph_run.args).slice(0, 200));
  ok("Run auto-switches to Output and shows busy", !$('[data-io-pane="output"]').hidden && $("[data-manual-stdout]").textContent === t("cph.busy"));
  pending.cph_run.resolve({ compile_ok: true, compile_log: "", cancelled: false, results: [{ id: "tm-manual-stdin", verdict: "TLE", stdout: "", stderr: "", time_ms: 2000, exit_code: null }] }); delete pending.cph_run;
  await waitFor(() => !$('[data-run="stdin"]').disabled);
  ok("TLE output carries the official 'stopped: time limit' line", $("[data-manual-stdout]").textContent.includes(t("cph.stoppedTimeout")), $("[data-manual-stdout]").textContent);
  click($('[data-run="stdin"]')); await waitFor(() => pending.cph_run);
  pending.cph_run.resolve({ compile_ok: true, compile_log: "", cancelled: false, results: [{ id: "tm-manual-stdin", verdict: "RAN", stdout: "3\n", stderr: "", time_ms: 5, exit_code: 0 }] }); delete pending.cph_run;
  await waitFor(() => !$('[data-run="stdin"]').disabled);
  ok("normal run: stdout + Exit code: 0", $("[data-manual-stdout]").textContent.includes("3") && $("[data-manual-stdout]").textContent.includes(t("cph.exitCode", { n: 0 })), $("[data-manual-stdout]").textContent);
  click($('[data-run="stdin"]')); await waitFor(() => pending.cph_run);
  pending.cph_run.resolve({ compile_ok: false, compile_log: "main.cpp: error: nope", cancelled: false, results: [] }); delete pending.cph_run;
  await waitFor(() => !$('[data-run="stdin"]').disabled);
  ok("Run on a CE shows the compiler log in Output (was invisible before)", $("[data-manual-stdout]").textContent.includes("error: nope"), $("[data-manual-stdout]").textContent);
  click($('[data-run="stdin"]')); await waitFor(() => pending.cph_run);
  click($('[data-action="stop"]')); await sleep(20);
  pending.cph_run.resolve({ compile_ok: true, compile_log: "", cancelled: true, results: [{ id: "tm-manual-stdin", verdict: "CANCELLED", stdout: "", stderr: "", time_ms: 300, exit_code: null }] }); delete pending.cph_run;
  await waitFor(() => !$('[data-run="stdin"]').disabled);
  ok("Stop during Run => 'Task cancelled.' in Output + summary", $("[data-manual-stdout]").textContent.includes(t("cph.cancelled")) && $("[data-local-summary]").textContent.includes(t("cph.cancelled")), $("[data-manual-stdout]").textContent);
  ok("Stop re-disabled after job settles", $('[data-action="stop"]').disabled);
  click($('[data-run="stdin"]')); await waitFor(() => pending.cph_run);
  pending.cph_run.reject("a local run is already in progress"); delete pending.cph_run;
  await waitFor(() => !$('[data-run="stdin"]').disabled);
  ok("backend error never leaves Output stuck on 'busy'", $("[data-manual-stdout]").textContent.includes("already in progress"), $("[data-manual-stdout]").textContent);

  // ---- Submit goes through the confirm dialog ----
  const submits = () => calls.filter((c) => c.cmd === "api_fetch" && c.args.method === "POST" && /\/submit/.test(c.args.path)).length;
  click($("[data-submit]")); await sleep(30);
  const dlg = $("dialog[data-confirm-submit]");
  ok("Submit opens the confirm dialog instead of submitting", !!dlg && dlg.hasAttribute("open") && submits() === 0);
  ok("dialog shows title, problem name (escaped), Back + confirm", !!dlg && dlg.textContent.includes(t("problem.confirmTitle")) && dlg.querySelector("p").textContent.includes("A+B <b>x</b>") && !dlg.querySelector("p b"), dlg && dlg.innerHTML);
  click($("[data-submit]")); await sleep(10);
  ok("no second dialog while one is open", w.document.querySelectorAll("dialog[data-confirm-submit]").length === 1);
  click(dlg.querySelector('[data-confirm="back"]')); await sleep(10);
  ok("Back closes + removes the dialog, nothing submitted", !$("dialog[data-confirm-submit]") && submits() === 0);
  click($("[data-submit]")); await sleep(10);
  const d2 = $("dialog[data-confirm-submit]"); click(d2); await sleep(10); // backdrop click: target is the dialog itself
  ok("backdrop click closes the dialog, nothing submitted", !$("dialog[data-confirm-submit]") && submits() === 0);
  click($("[data-submit]")); await sleep(10);
  click($('dialog[data-confirm-submit] [data-confirm="yes"]'));
  await waitFor(() => submits() === 1);
  ok("Confirm submits exactly once", submits() === 1 && !$("dialog[data-confirm-submit]"));
  await waitFor(() => $("[data-submissions-left]").textContent === t("problem.submissionsLeft", { left: 2, max: 5 }), 1000);
  ok("submissions-left decrements after an accepted submission: 2/5", $("[data-submissions-left]").textContent === t("problem.submissionsLeft", { left: 2, max: 5 }), $("[data-submissions-left]").textContent);

  dispose();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 60000).unref();

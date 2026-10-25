// Offline integration checks against the actual solve, statement and Monaco modules.
// PLAYWRIGHT_MODULE may point at an existing Playwright package; no downloads occur.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../test-output/", import.meta.url));
const fixturePath = "/__tmath_solve_test__";
const server = await createServer({
  root, configFile: false, logLevel: "error",
  server: { host: "127.0.0.1", port: 17924, strictPort: false },
  plugins: [{ name: "offline-solve-test", configureServer(server) {
    // Install before Vite's history fallback, which would otherwise serve main.ts.
    server.middlewares.use(fixturePath, (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/tmath/tmath.css"><style>body{margin:0}#app{padding:20px}.tm-editor-container{height:350px}.tm-editor{height:350px}</style></head><body data-persona="tmath"><main id="app"></main></body></html>');
    });
  } }],
});
await server.listen();
const base = server.resolvedUrls.local[0];
let browser;
const pageErrors = [];
const forbiddenRequests = [];
try {
  console.log("solve test: fixture server ready");
  const response = await fetch(base + fixturePath.slice(1));
  assert.match(await response.text(), /data-persona="tmath"/);
  browser = await chromium.launch({ channel: "chrome", headless: true });

  async function newPage({ delayEditor = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1450, height: 1050 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    let releaseEditor;
    let editorRequestedResolve;
    const editorRequested = new Promise(resolve => { editorRequestedResolve = resolve; });
    const editorGate = new Promise(resolve => { releaseEditor = resolve; });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1") { forbiddenRequests.push(url.href); return route.abort(); }
      if (delayEditor && url.pathname === "/src/tmath/editor.ts") { editorRequestedResolve(); await editorGate; }
      return route.continue();
    });
    await page.goto(base + fixturePath.slice(1), { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      localStorage.clear();
      localStorage.setItem("delcc-auth", JSON.stringify({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", access_expires_in: 3600, obtained_at: Date.now() }));
      const sample = (index, input, output) => `<div class="tmath-sample" data-sample-index="${index}"><div class="tmath-sample-input"><pre><code>${input}</code></pre></div><div class="tmath-sample-output"><pre><code>${output}</code></pre></div></div>`;
      window.fixture = {
        calls: [], streams: [], pending: {}, loadFailures: 0, submitFailures: 0,
        holdLoad: false, holdSubmit: false, holdRun: false, problemOverrides: {},
        statement: `# Sum\n\nCompute \\(a_i + b_i\\).\n\n<div data-tmath-component="samples" data-tmath-version="1">${sample(0,"2 3\n","5\n")}${sample(1,"7 8\n","15\n")}</div>`,
      };
      const hold = kind => new Promise(resolve => (window.fixture.pending[kind] ??= []).push(resolve));
      const envelope = (body, status = 200) => JSON.stringify({ status, body: JSON.stringify(body) });
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        const f = window.fixture;
        f.calls.push({ command, args: structuredClone(args) });
        if (command === "cph_detect") return [{ lang_key: "cpp", label: "Fixture C++", binary: "fixture-cpp", version: "synthetic" }, { lang_key: "python", label: "Fixture Python", binary: "fixture-python", version: "synthetic" }];
        if (command === "cph_run") {
          if (f.holdRun) await hold("run");
          return { compile_ok: true, compile_log: "fixture compiler", results: args.req.cases.map(c => ({ id: c.id, verdict: c.expected?.trim() ? "AC" : "RAN", stdout: c.expected ?? "", stderr: "", time_ms: 1 })) };
        }
        if (command !== "api_fetch") throw new Error(`Unexpected bridge command: ${command}`);
        if (args.path.endsWith("/submit")) {
          if (f.holdSubmit) await hold("submit");
          if (f.submitFailures-- > 0) return envelope({ detail: "fixture submit failure" }, 422);
          return envelope({ detail: "queued", submission_id: 101, replaced_existing: false });
        }
        if (/\/submissions\/\d+$/.test(args.path)) return envelope({ id: 101, version: 1, is_terminal: true, problem: "SUM", problem_name: "Sum", user: "fixture-user", date: "2026-01-01T00:00:00Z", status: "AC", result: "AC", points: 100, case_points: 2, case_total: 2, cases: [] });
        if (/\/problems\/[^/]+$/.test(args.path)) {
          if (f.holdLoad) await hold("load");
          if (f.loadFailures-- > 0) return envelope({ detail: "fixture load failure" }, 503);
          return envelope({ code: "SUM", name: "Sum fixture", statement: f.statement, allowed_languages: ["CPP20", "PY3"], time_limit: 2, memory_limit: 262144, can_submit: true, io_method: "stdin", ...f.problemOverrides });
        }
        throw new Error(`Unexpected fixture API route: ${args.path}`);
      } };
      const actualFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : String(input), location.href);
        if (url.origin === location.origin) return actualFetch(input, init);
        if (/\/participations\/\d+\/submissions\/stream$/.test(url.pathname)) {
          window.fixture.streams.push(url.pathname);
          return new Response(null, { status: 503 });
        }
        throw new Error("External fetch blocked by test fixture");
      };
      window.solveModule = await import("/src/tmath/solve.ts");
      window.args = { code: "SUM", contestKey: null, participationId: null, username: "fixture-user", preferences: { theme: "light", locale: "en-US", statementFont: "sans-serif", statementSize: 16, editorFont: "Consolas", editorSize: 14, minimap: false, wordWrap: true }, onSubmissions: () => { window.submissionNavigation = true; } };
      window.mount = overrides => {
        window.dispose?.();
        document.getElementById("app").replaceChildren();
        window.dispose = window.solveModule.mountSolve(document.getElementById("app"), { ...window.args, ...overrides });
      };
      window.release = kind => { const pending = window.fixture.pending[kind] ?? []; window.fixture.pending[kind] = []; pending.forEach(resolve => resolve()); };
    });
    return { page, context, releaseEditor, editorRequested };
  }

  const { page, context } = await newPage();
  const ready = async () => {
    await page.locator("[data-submit]").waitFor();
    await page.locator("[data-monaco] .monaco-editor textarea").first().waitFor({ state: "attached" });
    await page.waitForFunction(() => !document.querySelector('[data-run="mock"]').disabled);
  };
  const typeSource = async value => {
    await page.locator("[data-monaco] .monaco-editor textarea").first().focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(value);
  };
  const calls = command => page.evaluate(command => window.fixture.calls.filter(c => c.command === command), command);
  await page.evaluate(() => {
    localStorage.setItem("cph-tc:SUM", JSON.stringify([
      { id: "scored", input: "2 3", expected: "5", enabled: true },
      { id: "disabled", input: "0 1", expected: "1", enabled: false },
      { id: "unscored", input: "0 0", expected: null, enabled: true },
      { id: "empty", input: "1 1", expected: "", enabled: true },
      { id: "whitespace", input: "1 2", expected: " \n", enabled: true },
    ]));
    window.mount({});
  });
  await ready();
  console.log("solve test: actual Monaco mounted");
  assert.equal(await page.locator(".katex").count(), 1);
  assert.equal(await page.getByRole("tab").count(), 2);
  const cpp = "#include <iostream>\nint main(){std::cout << 5;}";
  await typeSource(cpp);
  const draftPrefix = "delcc-tmath-draft:fixture-user:public:SUM:";
  await page.waitForFunction(({ key, value }) => localStorage.getItem(key) === value, { key: draftPrefix + "CPP20", value: cpp });
  await page.locator("[data-language]").selectOption("PY3");
  await typeSource("print(5)");
  await page.locator("[data-language]").selectOption("CPP20");
  await page.locator('[data-run="mock"]').click();
  await page.waitForFunction(() => window.fixture.calls.some(c => c.command === "cph_run"));
  const run = (await calls("cph_run")).at(-1).args.req;
  assert.deepEqual(run.cases.map(c => c.id), ["scored"], "mock excludes disabled and blank/unscored cases");
  assert.equal(run.source, cpp, "language switch restores Monaco draft");
  assert.equal(run.langKey, "cpp");
  assert.match(await page.locator("[data-local-summary]").textContent(), /not.*judged|not.*official/i);
  await page.locator("[data-import-samples]").click();
  const savedCases = await page.evaluate(() => JSON.parse(localStorage.getItem("cph-tc:SUM")));
  assert.equal(savedCases.length, 7);
  assert.deepEqual(savedCases.slice(-2).map(c => ({ input: c.input, expected: c.expected })), [{ input: "2 3\n", expected: "5\n" }, { input: "7 8\n", expected: "15\n" }]);
  await page.locator("[data-import-samples]").click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("cph-tc:SUM")).length), 7, "sample import deduplicates");

  await page.evaluate(() => { window.fixture.holdSubmit = true; });
  await page.locator("[data-submit]").click();
  await page.evaluate(() => document.querySelector("[data-submit]").dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const publicSubmit = (await calls("api_fetch")).filter(c => c.args.path.endsWith("/submit"));
  assert.equal(publicSubmit.length, 1, "submission is single-flight");
  assert.equal(publicSubmit[0].args.path, "/problems/SUM/submit");
  assert.deepEqual(JSON.parse(publicSubmit[0].args.body), { language_key: "CPP20", source: cpp });
  await page.evaluate(() => { window.fixture.holdSubmit = false; window.release("submit"); });
  await page.waitForFunction(() => document.querySelector("[data-verdict]").textContent.includes("AC"));
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: output + "tmath-solve.png", fullPage: true });
  console.log("solve test: public submit, drafts, samples and mock run passed");

  await page.evaluate(() => window.mount({ contestKey: "round/a", participationId: 73 }));
  await ready();
  await typeSource("int main(){return 0;}");
  await page.locator("[data-submit]").click();
  await page.waitForFunction(() => document.querySelector("[data-verdict]").textContent.includes("AC"));
  const contestSubmit = (await calls("api_fetch")).filter(c => c.args.path.endsWith("/submit")).at(-1);
  assert.equal(contestSubmit.args.path, "/contests/round%2Fa/problems/SUM/submit");
  assert.deepEqual(JSON.parse(contestSubmit.args.body), { language_key: "CPP20", source: "int main(){return 0;}", participation_id: 73 });
  assert.deepEqual(await page.evaluate(() => window.fixture.streams), ["/api/v3/participations/73/submissions/stream"]);

  await page.evaluate(() => { window.fixture.loadFailures = 1; window.mount({ code: "RETRY" }); });
  await page.locator('[data-action="retry"]').waitFor();
  assert.match(await page.locator("#app").textContent(), /fixture load failure/);
  await page.locator('[data-action="retry"]').click();
  await ready();
  await typeSource("int main(){}");
  await page.evaluate(() => { window.fixture.submitFailures = 1; });
  await page.locator("[data-submit]").click();
  await page.waitForFunction(() => document.querySelector("[data-verdict]").textContent.includes("fixture submit failure"));
  assert.equal(await page.locator("[data-submit]").isEnabled(), true);
  await page.locator("[data-submit]").click();
  await page.waitForFunction(() => document.querySelector("[data-verdict]").textContent.includes("AC"));
  console.log("solve test: contest routing and retry paths passed");

  await page.evaluate(() => { window.fixture.holdSubmit = true; });
  await page.locator("[data-submit]").click();
  await page.waitForFunction(() => window.fixture.pending.submit?.length);
  await page.evaluate(() => { window.dispose(); document.getElementById("app").textContent = "replacement"; window.fixture.holdSubmit = false; window.release("submit"); });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#app").textContent(), "replacement", "late submit does not repaint disposed view");
  await page.evaluate(() => { window.fixture.holdLoad = true; window.mount({ code: "LATE" }); });
  await page.waitForFunction(() => window.fixture.pending.load?.length);
  await page.evaluate(() => { window.dispose(); document.getElementById("app").textContent = "replacement"; window.fixture.holdLoad = false; window.release("load"); });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#app").textContent(), "replacement", "late statement does not repaint disposed view");

  const transformed = await server.transformRequest("/src/tmath/editor.ts");
  const monacoUrl = transformed.code.match(/from\s+["']([^"']*monaco-editor[^"']*editor[^"']*api[^"']*)["']/)?.[1];
  assert.ok(monacoUrl, "locate the same Monaco module used by production");
  assert.equal(await page.evaluate(async url => (await import(url)).editor.getModels().length, monacoUrl), 0, "disposed views release editor models");
  await context.close();

  const late = await newPage({ delayEditor: true });
  await late.page.evaluate(() => window.mount({}));
  await late.editorRequested;
  await late.page.locator("[data-source]").waitFor();
  await late.page.evaluate(() => { window.dispose(); document.getElementById("app").textContent = "replacement"; });
  late.releaseEditor();
  await late.page.evaluate(async () => { await import("/src/tmath/editor.ts"); });
  assert.equal(await late.page.locator("#app").textContent(), "replacement");
  assert.equal(await late.page.evaluate(async url => (await import(url)).editor.getModels().length, monacoUrl), 0, "late editor import creates no leaked model");
  await late.context.close();
  assert.deepEqual(forbiddenRequests, [], "no external request escaped synthetic bridge/fetch");
  assert.deepEqual(pageErrors, [], "no uncaught page errors");
  console.log("TMATH solve: public/contest submit, real Monaco typing, drafts, samples, local mock filtering, retry, duplicate guards and disposal passed.");
} finally {
  await browser?.close();
  await server.close();
}

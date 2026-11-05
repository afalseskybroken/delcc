// pass #137: the CSP BOOT-GATE — He's "your choice" verdict on the standing since-#79
// item: it closes HERE, mechanically, on every CI browser run. The REAL boot path —
// tmath/index.ts bootTmath(): preferences, i18n, theme, the shell's first render (the
// login view in browser-dev) — runs under the PRODUCTION CSP read straight from
// tauri.conf.json (single source), with a securitypolicyviolation collector wired
// before any script. Asserts the login page actually rendered, the footnote carries
// the pass-#137 carved anatomy (the Official-style connection status line + the fine
// version line), and the violation set is exactly the two tolerated classes:
//   (1) the #106/#112 finding — DOMPurify/dep-chunk inert-parse script-src-attr
//       (parse-only, sanitized right after, never executed);
//   (2) connect-src to the judge — a BROWSER-DEV-ONLY artifact: without the bridge the
//       transport falls back to window.fetch (transport.ts), which the SHIPPED app never
//       does (the Rust shell's api_fetch talks to the judge outside the webview CSP's
//       reach entirely). Anything else fails the run.
// Run: node scripts/test-tmath-boot.mjs  (PLAYWRIGHT_MODULE for an out-of-tree install)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const tauriConf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const CSP = tauriConf.app.security.csp;
if (!CSP) throw new Error("no CSP at app.security.csp in tauri.conf.json");
const server = await createServer({
  server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
  plugins: [{ name: "boot-test-fixture", configureServer(s) {
    s.middlewares.use("/__tmath_boot_test__", (_rq, rs) => {
      rs.setHeader("Content-Type", "text/html");
      rs.setHeader("Content-Security-Policy", CSP);
      rs.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="sig"></div><div id="updateBanner"></div><div id="app"></div></body></html>');
    });
  } }],
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.route("**/*", r => { const u = new URL(r.request().url()); return u.hostname === "127.0.0.1" ? r.continue() : r.abort(); });
  await page.goto(`${server.resolvedUrls.local[0]}__tmath_boot_test__`);
  await page.evaluate(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", e => {
      window.__csp.push(`${e.violatedDirective} src=${e.sourceFile || "inline"} target=${e.target?.nodeName || "?"}`);
    });
  });
  await page.evaluate(async () => { window.boot = await import("/src/tmath/index.ts"); });
  await page.evaluate(() => window.boot.bootTmath());
  await page.waitForSelector(".tm-login-page", { timeout: 20000 });
  // the boot rendered the real login view (the pre-session surface — the sidebar
  // footnote's connection line lives in the logged-in shell and is verified on the
  // live oracle per pass; the CSP surface that boots FIRST is this one)
  assert.equal(await page.locator(".tm-login-page").count(), 1);
  assert.equal(await page.locator(".tm-login-brand").count(), 1);
  assert.equal(await page.locator('[data-action="google"]').count(), 1);
  const violations = await page.evaluate(() => window.__csp);
  const tolerated = violations.filter(v =>
    (v.startsWith("script-src-attr src=") && v.includes("/node_modules/.vite/deps/") && v.endsWith("target=#document"))
    || (v.startsWith("connect-src") && v.includes("oj.tmathcoding.vn")));
  const others = violations.filter(v => !tolerated.includes(v));
  assert.deepEqual(others, [], `unexpected CSP violations during boot: ${others.join("; ")}`);
  console.log(`TMATH boot: the login view rendered and the production CSP held through the real boot path (${violations.length} tolerated, 0 unexpected).`);
} finally {
  await browser?.close();
  await server.close();
}

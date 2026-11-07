// pass #144: the TOOLS CLOSE/REOPEN PROBE — the W8-11 lifecycle regression lock (the
// wave-8 audit's "close/reopen browser test"). Drives the REAL tools panel through the
// real module: open → graph tab → draw (the AGE embed mounts) → close → reopen → tab →
// draw again. Asserts the reopened panel hosts a CONNECTED AGE canvas — the pre-#142
// bug rendered into the DETACHED old React root (blank new panel); the close button now
// unmounts both roots, so exactly one live scope exists at any time.
// Run: node scripts/test-tmath-tools.mjs  (PLAYWRIGHT_MODULE for an out-of-tree install)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({
  server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
  plugins: [{ name: "tools-test-fixture", configureServer(s) {
    s.middlewares.use("/__tmath_tools_test__", (_rq, rs) => {
      rs.setHeader("Content-Type", "text/html");
      rs.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div></body></html>');
    });
  } }],
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.route("**/*", r => { const u = new URL(r.request().url()); return u.hostname === "127.0.0.1" ? r.continue() : r.abort(); });
  await page.goto(`${server.resolvedUrls.local[0]}__tmath_tools_test__`);
  await page.evaluate(async () => { window.tools = await import("/src/tmath/tools.ts"); });

  const drawAndAssert = async (label) => {
    await page.evaluate(() => {
      window.tools.openToolsPanel();
      document.querySelector('.tm-tools-tabs [data-tab="graph"]').click();
    });
    await page.waitForSelector('[data-pane="graph"]', { state: "visible", timeout: 10000 });
    await page.click('[data-graph-draw]');
    await page.waitForSelector('[data-pane="graph"] .tm-age-scope canvas', { timeout: 20000 });
    const state = await page.evaluate(() => {
      const scopes = [...document.querySelectorAll(".tm-age-scope")];
      return {
        scopes: scopes.length,
        connected: scopes.filter(s => s.isConnected).length,
        inPane: !!document.querySelector('[data-pane="graph"] .tm-age-scope canvas'),
      };
    });
    assert.equal(state.scopes, 1, `${label}: exactly one AGE scope in the document`);
    assert.equal(state.connected, 1, `${label}: the AGE scope is connected to the live panel`);
    assert.ok(state.inPane, `${label}: the canvas lives in the CURRENT graph pane`);
  };

  await drawAndAssert("first open");
  await page.click("[data-tools-close]");
  await page.waitForSelector(".tm-tools-panel", { state: "detached", timeout: 10000 });
  await drawAndAssert("reopen");
  // one more cycle for good measure — the retained-root bug compounded per cycle
  await page.click("[data-tools-close]");
  await page.waitForSelector(".tm-tools-panel", { state: "detached", timeout: 10000 });
  await drawAndAssert("second reopen");

  console.log("PASS tools close/reopen: the AGE host re-mounts into the live panel every cycle (1 connected scope, 3 cycles)");
} finally {
  await browser?.close();
  await server.close();
}

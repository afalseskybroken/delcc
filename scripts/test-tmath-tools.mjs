// pass #144: the TOOLS CLOSE/REOPEN PROBE — the W8-11 lifecycle regression lock (the
// wave-8 audit's "close/reopen browser test"). Drives the REAL tools panel through the
// real module: open → graph tab → draw (the AGE embed mounts) → close → reopen → tab →
// draw again. Asserts the reopened panel hosts a CONNECTED AGE canvas — the pre-#142
// bug rendered into the DETACHED old React root (blank new panel); the close button now
// unmounts both roots, so exactly one live scope exists at any time.
// pass #145: the RESIZE cycle (He, "GENUINELY UI BREAKING" on window maximize) — a
// maximized panel grown/shrunk with the window must keep the graph box inside its
// scroll container (the pre-#145 body cap clipped the canvas behind an inner
// scrollbar), the canvas bitmap must track its layout box, and a hard shrink must
// leave the painted graph inside the canvas (resizeGraph re-clamps misplaced nodes).
// Failures dump the captured page errors + console output + the AGE error surface.
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
  // pass #145 (the audit's flake report: "stack trace, cause not captured"): every
  // page error and console message is captured, and a failure prints them plus the
  // panel's own AGE error surface before the assert throws.
  const pageErrors = [];
  const consoleLines = [];
  page.on("pageerror", e => pageErrors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") consoleLines.push(`${m.type()}: ${m.text()}`); });
  const fail = async (label, err) => {
    const ageError = await page.evaluate(() => document.querySelector("[data-age-error]")?.textContent ?? null).catch(() => null);
    console.error(`FAIL ${label}\npage errors: ${JSON.stringify(pageErrors.slice(-8), null, 1)}\nconsole: ${JSON.stringify(consoleLines.slice(-12), null, 1)}\nAGE error surface: ${ageError}`);
    throw err;
  };
  await page.route("**/*", r => { const u = new URL(r.request().url()); return u.hostname === "127.0.0.1" ? r.continue() : r.abort(); });
  await page.goto(`${server.resolvedUrls.local[0]}__tmath_tools_test__`);
  await page.evaluate(async () => { window.tools = await import("/src/tmath/tools.ts"); });

  const drawAndAssert = async (label) => {
    try {
      await page.evaluate(() => {
        window.tools.openToolsPanel();
        document.querySelector('.tm-tools-tabs [data-tab="graph"]').click();
      });
      await page.waitForSelector('[data-pane="graph"]', { state: "visible", timeout: 10000 });
      await page.click('[data-graph-draw]');
      await page.waitForSelector('[data-pane="graph"] .tm-age-scope canvas', { timeout: 40000 });
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
    } catch (err) { await fail(label, err); }
  };

  await drawAndAssert("first open");
  await page.click("[data-tools-close]");
  await page.waitForSelector(".tm-tools-panel", { state: "detached", timeout: 10000 });
  await drawAndAssert("reopen");
  // one more cycle for good measure — the retained-root bug compounded per cycle
  await page.click("[data-tools-close]");
  await page.waitForSelector(".tm-tools-panel", { state: "detached", timeout: 10000 });
  await drawAndAssert("second reopen");

  // ---- pass #145: the resize cycle on the still-open third panel ----
  try {
    await page.evaluate(() => document.querySelector("[data-tools-max]").click()); // panel maximized class
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);

    const geo = () => page.evaluate(() => {
      const panel = document.querySelector(".tm-tools-panel");
      const body = panel.querySelector('[data-pane="graph"]');
      const box = panel.querySelector(".tm-graph-box");
      const canvas = document.querySelector('[data-pane="graph"] .tm-age-scope canvas');
      const bb = canvas.getBoundingClientRect();
      // where did the graph actually land? (non-transparent pixel bounding box)
      const c = document.createElement("canvas");
      c.width = canvas.width; c.height = canvas.height;
      const cx = c.getContext("2d");
      cx.drawImage(canvas, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      return {
        bodyH: body.clientHeight, bodyScroll: body.scrollHeight,
        boxBottom: Math.round(box.getBoundingClientRect().bottom),
        bodyBottom: Math.round(body.getBoundingClientRect().bottom),
        bitmap: [canvas.width, canvas.height], rect: [Math.round(bb.width), Math.round(bb.height)],
        dpr: devicePixelRatio, paint: maxX < 0 ? null : [minX, minY, maxX, maxY],
      };
    });

    await page.setViewportSize({ width: 1920, height: 1080 }); // maximize the window
    await page.waitForTimeout(500);
    const grown = await geo();
    assert.ok(grown.boxBottom <= grown.bodyBottom + 1, `grow: the graph box stays inside its scroll container (box ${grown.boxBottom} vs body ${grown.bodyBottom})`);
    assert.ok(grown.bodyScroll <= grown.bodyH + 1, `grow: no inner scrollbar (scrollHeight ${grown.bodyScroll} vs client ${grown.bodyH})`);
    assert.ok(Math.abs(grown.bitmap[0] - grown.rect[0] * grown.dpr) < 2 && Math.abs(grown.bitmap[1] - grown.rect[1] * grown.dpr) < 2, `grow: the bitmap tracks the layout box (bitmap ${grown.bitmap} vs rect ${grown.rect} x dpr ${grown.dpr})`);

    await page.setViewportSize({ width: 1280, height: 420 }); // hard shrink
    await page.waitForTimeout(500);
    const shrunk = await geo();
    assert.ok(shrunk.bodyScroll <= shrunk.bodyH + 1, `shrink: no inner scrollbar (scrollHeight ${shrunk.bodyScroll} vs client ${shrunk.bodyH})`);
    assert.ok(shrunk.paint, "shrink: the graph painted");
    assert.ok(shrunk.paint[2] < shrunk.bitmap[0] && shrunk.paint[3] < shrunk.bitmap[1], `shrink: the painted graph stays inside the re-clamped canvas (paint ${shrunk.paint} vs bitmap ${shrunk.bitmap})`);

    // restore from maximized: the pinned inset yields and nothing clips
    await page.evaluate(() => document.querySelector("[data-tools-max]").click());
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    const restored = await geo();
    assert.ok(restored.boxBottom <= restored.bodyBottom + 1 && restored.bodyScroll <= restored.bodyH + 1, "restore: the floating panel keeps the box inside its container");

    console.log("PASS tools close/reopen: the AGE host re-mounts into the live panel every cycle (1 connected scope, 3 cycles)");
    console.log("PASS tools resize: maximized panel tracks the window with no inner clip (grow 1920x1080, hard shrink 1280x420, restore), bitmap tracks the box, painted graph re-clamped");
  } catch (err) { await fail("resize cycle", err); }
} finally {
  await browser?.close();
  await server.close();
}

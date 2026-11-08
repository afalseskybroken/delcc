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
  // pass #145 continued (CI's first run): vite transforms the ~40-module AGE graph ON
  // DEMAND at the first dynamic import — on a 2-core runner that exceeded the 40s
  // mount wait (no page error, no AGE error surface, no canvas: the transform was
  // still running). Pre-warm the lazy chunk trees here, where there is no timeout;
  // the behavioral asserts below stay strict against a warm module graph. The URLs
  // are the EXPLICIT entry files: a browser-native extensionless import bypasses
  // vite's URL rewriting and re-resolves the whole tree under unhashed URLs (16.9s
  // locally vs 39ms for index.ts), and a cold .vite cache makes that first transform
  // trip the dep-optimizer PAGE RELOAD — the reload destroys this evaluate's context,
  // so it is caught and the tools import below runs on the reloaded page (the server
  // keeps its transform cache, so no second discovery pass happens).
  try {
    await page.evaluate(async () => {
      await import("/src/vendor/age/index.ts");
      await import("/src/tmath/sketch.tsx");
    });
  } catch { /* the dep-optimizer reload mid-warm — the import below re-boots */ }
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

  // ---- pass #146: the hex column is a NIBBLE STREAM (He's "2 bytes?!" bug) ----
  try {
    await page.click("[data-tools-close]");
    await page.waitForSelector(".tm-tools-panel", { state: "detached", timeout: 10000 });
    await page.evaluate(() => window.tools.openToolsPanel());
    await page.evaluate(() => document.querySelector('.tm-tools-tabs [data-tab="bytes"]').click());
    await page.waitForSelector('[data-pane="bytes"]', { state: "visible", timeout: 10000 });
    const hexCase = async (input, wantDetail, wantHex) => {
      await page.evaluate((v) => {
        const el = document.querySelector("[data-bytes-hex]");
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, input);
      // the editor repaint is debounced 200ms behind an async import — wait for the
      // byte count the regex demands to appear before asserting the settled state
      const wantText = wantDetail.source.replaceAll("\\b", "");
      await page.waitForFunction(
        (w) => (document.querySelector("[data-bytes-detail]")?.textContent ?? "").includes(w),
        wantText, { timeout: 8000 },
      );
      const got = await page.evaluate(() => ({
        detail: document.querySelector("[data-bytes-detail]").textContent,
        hex: document.querySelector("[data-bytes-hex]").value,
      }));
      assert.match(got.detail, wantDetail, `hex "${input}": byte count`);
      assert.equal(got.hex, wantHex, `hex "${input}": auto-separation`);
    };
    await hexCase("ffffff", /\b3 bytes\b/, "ff ff ff"); // He's exact case: 3 ff = 3 bytes
    await hexCase("ff ff ff", /\b3 bytes\b/, "ff ff ff"); // already-spaced input unchanged
    await hexCase("fffff", /\b2 bytes\b/, "ff ff f"); // a trailing lone nibble stays visible, half a byte
    await hexCase("0xFF 00", /\b2 bytes\b/, "ff 00"); // 0x prefixes still honored
    console.log("PASS tools bytes: the hex column is a nibble stream (ffffff = ff ff ff = 3 bytes, auto-separated every 2 chars, odd nibble visible)");
  } catch (err) { await fail("bytes nibble stream", err); }

  // ---- pass #147: the f(x) plot — constant-size numbers + zoom/pan ----
  try {
    await page.click("[data-tools-close]");
    await page.waitForSelector(".tm-tools-panel", { state: "detached", timeout: 10000 });
    await page.evaluate(() => window.tools.openToolsPanel());
    await page.evaluate(() => document.querySelector('.tm-tools-tabs [data-tab="calc"]').click());
    await page.waitForSelector('[data-pane="calc"]', { state: "visible", timeout: 10000 });
    await page.click("[data-plot-open]");
    await page.waitForSelector("[data-plot-canvas]", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(600); // first render + sample

    const plotGeo = () => page.evaluate(() => {
      const c = document.querySelector("[data-plot-canvas]");
      const r = c.getBoundingClientRect();
      return {
        bitmap: [c.width, c.height], rect: [Math.round(r.width), Math.round(r.height)],
        dpr: devicePixelRatio,
        xmin: document.querySelector("[data-plot-xmin]").value,
        xmax: document.querySelector("[data-plot-xmax]").value,
      };
    });

    // the mechanism lock: the bitmap follows the box x dpr — labels draw in CSS px,
    // so their SIZE is constant no matter how big the panel is
    const g0 = await plotGeo();
    assert.ok(Math.abs(g0.bitmap[0] - g0.rect[0] * g0.dpr) < 2 && Math.abs(g0.bitmap[1] - g0.rect[1] * g0.dpr) < 2, `plot: the bitmap tracks the box x dpr (bitmap ${g0.bitmap} vs rect ${g0.rect} x dpr ${g0.dpr})`);

    // wheel zoom at the center: the span shrinks, the inputs stay the source of truth
    const box = await page.locator("[data-plot-canvas]").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(400); // re-sample
    const gz = await plotGeo();
    const spanZ = parseFloat(gz.xmax) - parseFloat(gz.xmin);
    assert.ok(Math.abs(spanZ - 16) < 0.5, `wheel zoom: the span shrank 20 -> ~16 (got [${gz.xmin}, ${gz.xmax}])`);
    assert.ok(Math.abs(gz.bitmap[0] - gz.rect[0] * gz.dpr) < 2, "wheel zoom: the bitmap still tracks the box after the re-render");

    // drag pan: dragging right moves the window left
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const gp = await plotGeo();
    const centerZ = (parseFloat(gz.xmin) + parseFloat(gz.xmax)) / 2;
    const centerP = (parseFloat(gp.xmin) + parseFloat(gp.xmax)) / 2;
    assert.ok(centerP < centerZ, `drag pan: the window center moved left (${centerZ} -> ${centerP})`);

    // double-click resets to the default window
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    const gr = await plotGeo();
    assert.equal(gr.xmin, "-10", "dblclick reset: x min back to -10");
    assert.equal(gr.xmax, "10", "dblclick reset: x max back to 10");

    console.log("PASS tools plot: bitmap tracks the box x dpr (constant-size numbers), wheel zoom 20->16 around the cursor, drag pan shifts the window, dblclick resets");
  } catch (err) { await fail("plot zoom", err); }
} finally {
  await browser?.close();
  await server.close();
}

// scripts/probe-sketch.mjs — tools-panel probe of record (visual + wiring): boots the
// vite dev server on a no-auth harness, then walks ALL FOUR tabs —
//   Graph: root/relabel controls present, dead tool row hidden, canvases fill the pane
//   Calculator: the #114 button pad — clicks 1 + 2 = and checks the live result
//   Bytes: the hexcanvas editor mounts and reports the byte count
//   Sketch: Excalidraw styles loaded (root fills the host)
// writes its own harness page (deleted in finally), kills its vite tree.
// Usage: PLAYWRIGHT_MODULE="D:\\txploitd\\pw-standalone\\node_modules\\playwright" node scripts/probe-sketch.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PW = process.env.PLAYWRIGHT_MODULE ?? "D:\\txploitd\\pw-standalone\\node_modules\\playwright";
const PORT = process.env.PROBE_PORT ?? "5273";
const OUT = "probe-out";
mkdirSync(OUT, { recursive: true });

const HARNESS = "probe-harness.html";
writeFileSync(HARNESS, `<!doctype html>
<html><head><meta charset="utf-8"><title>delcc tools probe</title></head>
<body><div id="app"></div>
<script type="module">
  import "./src/tmath/tmath.css";
  import { applyScheme } from "./src/lib/scheme";
  applyScheme("tmath", "dark");
  document.body.dataset.persona = "tmath";
  const { openToolsPanel } = await import("./src/tmath/tools");
  openToolsPanel();
<\/script></body></html>`);

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", PORT, "--strictPort"], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DELCC_LAYOUT: "tmath" }, // the shipping persona layout is compile-time
});
const viteOut = [];
vite.stdout.on("data", d => viteOut.push(String(d)));
vite.stderr.on("data", d => viteOut.push(String(d)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let exitCode = 0;
let fail = null;
let histAfterCheck = null; // { chips, clearChip } — filled by the calc section
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    ready = viteOut.join("").replace(/\x1b\[[0-9;]*m/g, "").includes("Local:");
  }
  if (!ready) throw new Error("vite dev server did not start:\n" + viteOut.join(""));
  console.log("[probe] vite up");

  const { chromium } = await import(pathToFileURL(PW + "/index.mjs").href);
  // the ms-playwright cache is empty on this box and Edge is absent — drive system
  // Chrome instead of downloading a pinned chromium (same engine, fine for a probe)
  const browser = await chromium.launch({ channel: process.env.PROBE_CHANNEL ?? "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("response", r => { if (r.status() === 404 && !r.url().includes("favicon")) errors.push("404: " + r.url()); });

  await page.goto(`http://localhost:${PORT}/probe-harness.html`, { waitUntil: "domcontentloaded" });
  const panel = page.locator(".tm-tools-panel");
  await panel.waitFor({ state: "visible", timeout: 15000 });
  console.log("[probe] panel open");

  const rect = sel => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height) };
  }, sel);

  // ---------- GRAPH (default tab) ----------
  // poll (waitForSelector's visibility heuristic false-negatives on the stacked
  // absolutely-positioned canvases) and dump the host state if it never mounts
  let graphWait = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    graphWait = await page.evaluate(() => {
      const host = document.querySelector("[data-graph-host]");
      const cs = [...(host?.querySelectorAll("canvas") ?? [])];
      const b = cs[0]?.getBoundingClientRect();
      return { canvases: cs.length, first: b ? `${Math.round(b.width)}x${Math.round(b.height)}` : null };
    });
    if (graphWait.canvases >= 3 && graphWait.first !== "0x0" && graphWait.first !== null) break;
  }
  if (!graphWait || graphWait.canvases < 3) {
    const dump = await page.evaluate(() => document.querySelector("[data-graph-host]")?.innerHTML.slice(0, 300) ?? "NO HOST");
    throw new Error("graph canvases never mounted: " + JSON.stringify(graphWait) + " host=" + dump);
  }
  console.log("[probe] graph mount:", JSON.stringify(graphWait));
  await sleep(1400); // mount + the #115 settled re-parse
  const graph = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const visible = el => !!el && el.offsetParent !== null;
    const toolRow = [...(q("[data-graph-host]")?.querySelectorAll("div") ?? [])]
      .find(d => d.className.includes("justify-between") && d.className.includes("items-end"));
    const dlRow = [...(q("[data-graph-host]")?.querySelectorAll("div") ?? [])]
      .find(d => d.className.includes("justify-end"));
    const host = q("[data-graph-host]");
    const box = q("[data-graph-box]");
    const badge = q("[data-graph-stats]");
    const canvases = [...(host?.querySelectorAll("canvas") ?? [])].map(c => {
      const b = c.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    });
    // the badge must sit INSIDE the box (corner overlay), not below the column
    const bb = box?.getBoundingClientRect();
    const gb = badge?.getBoundingClientRect();
    const badgeInBox = !!bb && !!gb && gb.right <= bb.right + 1 && gb.bottom <= bb.bottom + 1 && gb.top >= bb.top - 1;
    // nodes centered? sample the canvas ink centroid vs canvas center
    const canvas = host?.querySelector("canvas");
    let centroid = null;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      const { width: W, height: H } = canvas;
      const img = ctx.getImageData(0, 0, W, H).data;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) {
        const a = img[(y * W + x) * 4 + 3];
        if (a > 40) { sx += x; sy += y; n++; }
      }
      if (n > 20) centroid = { x: Math.round(sx / n / W * 100), y: Math.round(sy / n / H * 100) };
    }
    return {
      rootsInput: visible(q("[data-graph-roots]")),
      relabelSelect: visible(q("[data-graph-relabel]")),
      hintPresent: !!q("[data-pane='graph'] .tm-tools-sub"),
      physicsGone: !q("[data-graph-neigh]"),
      toolRowHidden: !toolRow || !visible(toolRow),
      downloadHidden: !dlRow || !visible(dlRow),
      boxBorder: box ? getComputedStyle(box).borderTopWidth : null,
      badgeInBox,
      badgeText: badge?.textContent ?? null,
      hostRect: host ? { w: Math.round(host.getBoundingClientRect().width), h: Math.round(host.getBoundingClientRect().height) } : null,
      canvases,
      centroidPct: centroid,
    };
  });
  console.log("[probe] graph:", JSON.stringify(graph));
  await page.screenshot({ path: `${OUT}/graph.png` });

  // ---------- CALCULATOR keypad ----------
  await page.locator('[data-tab="calc"]').click();
  await page.waitForSelector("[data-calc-pad]", { timeout: 5000 });
  for (const key of ['[data-key="1"]', '[data-key="+"]', '[data-key="2"]', '[data-action="eval"]']) {
    await page.locator(`[data-pane="calc"] ${key}`).first().click();
    await sleep(60);
  }
  const calc = await page.evaluate(() => {
    const expr = document.querySelector("[data-calc-expr]");
    const out = document.querySelector("[data-calc-out]");
    const grid = document.querySelector(".tm-calc-grid");
    return {
      keys: document.querySelectorAll("[data-calc-pad] .tm-calc-key").length,
      expression: expr?.value ?? null,
      result: out?.textContent ?? null,
      gridCols: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : null,
      wideSpans: !!document.querySelector(".tm-calc-zero") && !!document.querySelector(".tm-calc-eq"),
      histClearChip: !!document.querySelector("[data-hist-clear]"),
    };
  });
  // the #116 clear-history chip: one click wipes the record
  await page.locator('[data-hist-clear]').first().click();
  const histAfter = await page.evaluate(() => ({
    chips: document.querySelectorAll("[data-calc-hist] .tm-tools-hist").length,
    clearChip: !!document.querySelector("[data-hist-clear]"),
  }));
  histAfterCheck = histAfter;
  console.log("[probe] calc:", JSON.stringify({ ...calc, histAfter }));
  await page.screenshot({ path: `${OUT}/calc.png` });

  // ---------- PLOT (pass #118): the f(x) button → multigraph panel ----------
  // He: "make f(x) a button to invoke plot … multigraphing (f(x) + g(x) + other
  // graphs) … 2nd (arc funcs for sin/cos/tan, ln for log) … time to outdo them".
  await page.locator('[data-pane="calc"] [data-plot-open]').click();
  await page.waitForSelector('[data-pane="calc"] [data-plot-panel]:not([hidden])', { timeout: 5000 });
  await sleep(700); // first render + the debounced repaint settle
  const plot1 = await page.evaluate(() => {
    const panel = document.querySelector('[data-pane="calc"] [data-plot-panel]');
    const cv = panel.querySelector('[data-plot-canvas]');
    const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const near = (r, g, b, tol) => { let n = 0; for (let i = 0; i < img.length; i += 4) { const d = (img[i]-r)**2 + (img[i+1]-g)**2 + (img[i+2]-b)**2; if (d < tol*tol) n++; } return n; };
    return {
      rows: panel.querySelectorAll('.tm-plot-row').length,
      blue: near(78, 161, 255, 70),   // curve ƒ
      orange: near(245, 158, 11, 70), // curve g
      note: panel.querySelector('[data-plot-note]').textContent,
    };
  });
  // 2nd: the sin chip swaps to sin⁻¹( (asin() and back; the swap is what inserts
  const before2nd = await page.evaluate(() => document.querySelector('[data-pane="calc"] .tm-calc-fns [data-key="sin("]')?.dataset.key ?? null);
  await page.locator('[data-pane="calc"] [data-action="2nd"]').click();
  const after2nd = await page.evaluate(() => {
    const chip = document.querySelector('[data-pane="calc"] .tm-calc-fns [data-key="asin("]');
    return { key: chip?.dataset.key ?? null, label: chip?.textContent ?? null };
  });
  await page.locator('[data-pane="calc"] .tm-calc-fns [data-key="asin("]').click();
  const secondInsert = await page.evaluate(() => document.querySelector('[data-calc-expr]').value);
  await page.locator('[data-pane="calc"] [data-action="2nd"]').click();
  const restored2nd = await page.evaluate(() => document.querySelector('[data-pane="calc"] .tm-calc-fns [data-key="sin("]')?.dataset.key ?? null);
  // add a third curve, eye off the first, delete the third
  await page.locator('[data-pane="calc"] [data-plot-add]').click();
  const rows3 = await page.evaluate(() => document.querySelectorAll('[data-pane="calc"] .tm-plot-row').length);
  await page.locator('[data-pane="calc"] .tm-plot-row:nth-child(3) [data-plot-fn]').fill('x/3');
  await sleep(700);
  const inkOf = (r, g, b) => page.evaluate(([R, G, B]) => {
    const cv = document.querySelector('[data-pane="calc"] [data-plot-canvas]');
    const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) { const d = (img[i]-R)**2 + (img[i+1]-G)**2 + (img[i+2]-B)**2; if (d < 70*70) n++; }
    return n;
  }, [r, g, b]);
  const greenInk = await inkOf(52, 211, 153); // curve h
  await page.locator('[data-pane="calc"] .tm-plot-row:nth-child(1) [data-plot-eye]').click();
  await sleep(700);
  const blueAfterEye = await inkOf(78, 161, 255);
  const rowsEye = await page.evaluate(() => document.querySelectorAll('[data-pane="calc"] .tm-plot-row').length);
  await page.locator('[data-pane="calc"] .tm-plot-row:nth-child(3) [data-plot-del]').click();
  const rowsAfterDel = await page.evaluate(() => document.querySelectorAll('[data-pane="calc"] .tm-plot-row').length);
  const plot = { plot1, before2nd, after2nd, secondInsert, restored2nd, rows3, greenInk, blueAfterEye, rowsEye, rowsAfterDel };
  console.log("[probe] plot:", JSON.stringify(plot));
  await sleep(400);
  await page.screenshot({ path: `${OUT}/plot.png` }); // open panel, two curves + range line
  await page.locator('[data-pane="calc"] [data-plot-open]').click(); // close again

  // ---------- BYTES hex editor ----------
  await page.locator('[data-tab="bytes"]').click();
  // pass #116 ghost check: two successive loads must leave EXACTLY one editor whose
  // byte count matches the latest columns (the old code stacked a stale one)
  await page.locator('[data-pane="bytes"] [data-bytes-text]').fill("delcc hex");
  await page.waitForSelector("[data-bytes-dump] hexcanvas-editor", { timeout: 30000 });
  await sleep(700);
  await page.locator('[data-pane="bytes"] [data-bytes-text]').fill("gg");
  await sleep(700);
  const bytes = await page.evaluate(() => {
    const host = document.querySelector("[data-bytes-dump]");
    const detail = document.querySelector("[data-bytes-detail]");
    return {
      editorCount: host?.querySelectorAll("hexcanvas-editor").length ?? 0,
      editorMounted: !!host?.querySelector("hexcanvas-editor"),
      editorSize: host ? { w: Math.round(host.getBoundingClientRect().width), h: Math.round(host.getBoundingClientRect().height) } : null,
      detail: detail?.textContent ?? null,
    };
  });
  console.log("[probe] bytes:", JSON.stringify(bytes));
  await page.screenshot({ path: `${OUT}/bytes.png` });

  // ---------- SKETCH ----------
  await page.locator('[data-tab="sketch"]').click();
  await page.waitForSelector("[data-sketch-host] .excalidraw", { timeout: 30000 });
  await sleep(1200);
  const sketch = { host: await rect("[data-sketch-host]"), root: await rect("[data-sketch-host] .excalidraw") };
  console.log("[probe] sketch:", JSON.stringify(sketch));
  await page.screenshot({ path: `${OUT}/sketch.png` });

  if (calc.result !== "= 3") fail = "calculator keypad eval failed: " + JSON.stringify(calc);
  if (calc.gridCols !== 5 || !calc.wideSpans) fail = "numpad layout not canonical: " + JSON.stringify(calc);
  if (plot.plot1.rows !== 2 || plot.plot1.blue < 50 || plot.plot1.orange < 50) fail = "plot multigraph failed: " + JSON.stringify(plot.plot1);
  if (plot.before2nd !== "sin(" || plot.after2nd.key !== "asin(" || plot.after2nd.label !== "sin⁻¹(" || !plot.secondInsert.endsWith("asin(") || plot.restored2nd !== "sin(") fail = "2nd modifier failed: " + JSON.stringify({ b: plot.before2nd, a: plot.after2nd, ins: plot.secondInsert, r: plot.restored2nd });
  if (plot.rows3 !== 3 || plot.greenInk < 50) fail = "plot add/third curve failed: " + JSON.stringify({ rows3: plot.rows3, green: plot.greenInk });
  if (plot.blueAfterEye > 0 || plot.rowsEye !== 3) fail = "plot eye-off failed: " + JSON.stringify({ blue: plot.blueAfterEye, rows: plot.rowsEye });
  if (plot.rowsAfterDel !== 2) fail = "plot del failed: rows=" + plot.rowsAfterDel;
  if (!calc.histClearChip || histAfterCheck.chips !== 0 || histAfterCheck.clearChip) fail = "history clear failed: " + JSON.stringify(histAfterCheck);
  if (!graph.rootsInput || !graph.relabelSelect || !graph.hintPresent) fail = "graph controls missing: " + JSON.stringify(graph);
  if (!graph.physicsGone) fail = "edge-physics stub checkbox still present";
  if (!graph.toolRowHidden) fail = "AGE tool row still visible (crescent source)";
  if (!graph.downloadHidden) fail = "broken Download row still visible";
  if (graph.boxBorder !== "1px") fail = "bounding box border missing: " + JSON.stringify(graph.boxBorder);
  if (!graph.badgeInBox || !/vertices/.test(graph.badgeText ?? "")) fail = "stats badge not inside the box: " + JSON.stringify(graph);
  if (!bytes.editorMounted || bytes.editorCount !== 1 || !/2/.test(bytes.detail ?? "")) fail = "hex editor ghost/stale: " + JSON.stringify(bytes);
  if (errors.length) console.log("[probe] page errors:\n" + errors.slice(0, 12).join("\n"));
  else console.log("[probe] no console/page errors");
  await browser.close();
} catch (e) {
  console.error("[probe] FAIL:", e.message ?? e);
  fail = String(e.message ?? e);
} finally {
  try { rmSync(HARNESS); } catch { /* already gone */ }
  if (vite.pid && process.platform === "win32") {
    spawn("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    vite.kill("SIGTERM");
    await sleep(300);
    vite.kill("SIGKILL");
  }
}
if (fail) { console.error("[probe] VERDICT: FAIL —", fail); process.exit(1); }
console.log("[probe] VERDICT: PASS");

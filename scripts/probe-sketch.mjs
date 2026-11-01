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
    return {
      keys: document.querySelectorAll("[data-calc-pad] .tm-calc-key").length,
      expression: expr?.value ?? null,
      result: out?.textContent ?? null,
    };
  });
  console.log("[probe] calc:", JSON.stringify(calc));
  await page.screenshot({ path: `${OUT}/calc.png` });

  // ---------- BYTES hex editor ----------
  await page.locator('[data-tab="bytes"]').click();
  await page.locator('[data-pane="bytes"] [data-bytes-text]').fill("delcc hex");
  await page.waitForSelector("[data-bytes-dump] hexcanvas-editor", { timeout: 30000 });
  await sleep(600);
  const bytes = await page.evaluate(() => {
    const host = document.querySelector("[data-bytes-dump]");
    const detail = document.querySelector("[data-bytes-detail]");
    return {
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
  if (!graph.rootsInput || !graph.relabelSelect || !graph.hintPresent) fail = "graph controls missing: " + JSON.stringify(graph);
  if (!graph.physicsGone) fail = "edge-physics stub checkbox still present";
  if (!graph.toolRowHidden) fail = "AGE tool row still visible (crescent source)";
  if (!graph.downloadHidden) fail = "broken Download row still visible";
  if (graph.boxBorder !== "1px") fail = "bounding box border missing: " + JSON.stringify(graph.boxBorder);
  if (!graph.badgeInBox || !/vertices/.test(graph.badgeText ?? "")) fail = "stats badge not inside the box: " + JSON.stringify(graph);
  if (!bytes.editorMounted || !/9/.test(bytes.detail ?? "")) fail = "hex editor not mounted/count wrong: " + JSON.stringify(bytes);
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

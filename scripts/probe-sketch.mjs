// scripts/probe-sketch.mjs — pass #113 visual probe: boots the vite dev server, opens the
// tools panel in a real browser, clicks through the Graph and Sketch tabs, screenshots
// each, and dumps the pane geometry (host boxes, AGE canvas stack, Excalidraw root).
// Usage: PLAYWRIGHT_MODULE="D:\\txploitd\\pw-standalone\\node_modules\\playwright" node scripts/probe-sketch.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PW = process.env.PLAYWRIGHT_MODULE ?? "D:\\txploitd\\pw-standalone\\node_modules\\playwright";
const PORT = process.env.PROBE_PORT ?? "5273";
const OUT = "probe-out";
mkdirSync(OUT, { recursive: true });

// the harness mounts the panel without auth/server; written at root (vite serves root
// files), removed again in the finally block so the repo never carries it
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
  page.on("response", r => { if (r.status() === 404) errors.push("404: " + r.url()); });
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(`http://localhost:${PORT}/probe-harness.html`, { waitUntil: "domcontentloaded" });

  // the harness opens the panel itself; give it a beat
  const panel = page.locator(".tm-tools-panel");
  await panel.waitFor({ state: "visible", timeout: 15000 });
  console.log("[probe] panel open");

  const dump = async tag => {
    const geo = await page.evaluate(() => {
      const r = el => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const panel = document.querySelector(".tm-tools-panel");
      const host = document.querySelector("[data-graph-host]");
      const scope = host?.firstElementChild;
      const rootFlex = scope?.querySelector(":scope > .h-screen, :scope > div");
      const canvases = [...(scope?.querySelectorAll("canvas") ?? [])].map(r);
      const sketchHost = document.querySelector("[data-sketch-host]");
      const excal = document.querySelector(".excalidraw");
      return {
        panel: r(panel),
        ageHost: r(host),
        ageScope: r(scope),
        ageRoot: r(rootFlex),
        ageCanvases: canvases,
        sketchHost: r(sketchHost),
        excalRoot: r(excal),
      };
    });
    console.log(`[probe] ${tag}:`, JSON.stringify(geo));
    return geo;
  };

  // GRAPH tab (default active on open)
  await page.locator('[data-tab="graph"]').click();
  await page.waitForSelector("[data-graph-host] canvas", { timeout: 10000 });
  await sleep(1200); // let AGE settle + draw
  await dump("graph");
  await page.screenshot({ path: `${OUT}/graph.png` });

  // SKETCH tab
  await page.locator('[data-tab="sketch"]').click();
  await page.waitForSelector("[data-sketch-host] .excalidraw", { timeout: 20000 });
  await sleep(1500); // let Excalidraw finish mounting
  const sketchState = await page.evaluate(() => {
    const host = document.querySelector("[data-sketch-host]");
    const wm = document.querySelector(".excalidraw .watermark, .excalidraw [class*='watermark']");
    const hint = [...document.querySelectorAll(".excalidraw span, .excalidraw div")].find(el =>
      (el.textContent ?? "").includes("To move canvas"));
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return { host: r(host), watermark: r(wm), hintEl: r(hint), hintFont: hint ? getComputedStyle(hint).fontSize : null };
  });
  console.log("[probe] sketch:", JSON.stringify(sketchState));
  await dump("sketch");
  await page.screenshot({ path: `${OUT}/sketch.png` });

  if (errors.length) {
    console.log("[probe] page errors:\n" + errors.slice(0, 12).join("\n"));
  } else {
    console.log("[probe] no console/page errors");
  }
  await browser.close();
} catch (e) {
  console.error("[probe] FAIL:", e.message ?? e);
  exitCode = 1;
} finally {
  try { rmSync(HARNESS); } catch { /* already gone */ }
  // with shell:true the direct kill only stops cmd.exe — kill the whole process tree
  if (vite.pid && process.platform === "win32") {
    spawn("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    vite.kill("SIGTERM");
    await sleep(300);
    vite.kill("SIGKILL");
  }
}
process.exit(exitCode);

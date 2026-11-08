// src/tmath/tools.ts — pass #104 (He's tools batch): the offline tools panel.
// Official 1.1.0 ships a floating tools window (graph/sketch/calculator/ASCII); ours
// outdoes the pieces He named — a real expression calculator (trig, constants,
// bitwise/shifts, roots, modulo, DEG/RAD, base display, function graphing) and a
// hex/encoding suite in place of the ASCII lookups. GENUINELY offline: every result
// below is computed in this module — there is no fetch/invoke/import of anything
// remote, no fonts, no CDNs (the doctrine line; He flagged Official's "offline" claim
// as unverifiable).
import { t } from "../i18n";
import { esc } from "./ui";
import { logError } from "../lib/applog";
import "./tools.css";

type Tab = "calc" | "bytes" | "graph" | "sketch";

let panel: HTMLElement | null = null;
// pass #113: Graph opens first — Official's tools panel leads with the graph tool
// (carve: default tab graph), ours led with the calculator and left the canvas cold
let active: Tab = "graph";

// ---------- expression evaluator (recursive descent, C-like precedence) ----------
// tokens: numbers (dec/hex 0x/bin 0b/oct 0o), identifiers, operators, parens, comma
const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, round: Math.round,
  sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp, sign: Math.sign,
  ln: Math.log, log: Math.log, log2: Math.log2, log10: Math.log10,
  min: Math.min, max: Math.max,
  root: (x: number, n: number) => (x < 0 && Math.abs(n % 2) === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)),
  mod: (a: number, b: number) => a % b,
  gcd: (a: number, b: number) => { a = Math.abs(Math.trunc(a)); b = Math.abs(Math.trunc(b)); while (b) { [a, b] = [b, a % b]; } return a; },
  lcm: (a: number, b: number) => { const g = FUNCS.gcd(a, b); return g === 0 ? 0 : Math.abs(Math.trunc(a) * Math.trunc(b)) / g; },
};
const CONSTS: Record<string, number> = { pi: Math.PI, "π": Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };

export function evalExpr(src: string, angleDeg: boolean, x?: number): number {
  const s = src.trim();
  let i = 0;
  const peek = () => s[i];
  const skip = () => { while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "_")) i++; };
  // angle mode is name-based: DEG wraps the trig family in AND out
  const callFn = (name: string, args: number[]): number => {
    if (angleDeg) {
      if (name === "sin") return Math.sin(args[0] * Math.PI / 180);
      if (name === "cos") return Math.cos(args[0] * Math.PI / 180);
      if (name === "tan") return Math.tan(args[0] * Math.PI / 180);
      if (name === "asin") return Math.asin(args[0]) * 180 / Math.PI;
      if (name === "acos") return Math.acos(args[0]) * 180 / Math.PI;
      if (name === "atan") return Math.atan(args[0]) * 180 / Math.PI;
      if (name === "atan2") return Math.atan2(args[0], args[1]) * 180 / Math.PI;
    }
    const f = FUNCS[name];
    if (!f) throw new Error(`unknown function: ${name}`);
    return f(...args);
  };
  const number = (): number => {
    const m = /^(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected character '${peek() ?? "end"}'`);
    i += m[0].length;
    if (/^0x/i.test(m[0])) return parseInt(m[0].slice(2), 16);
    if (/^0b/i.test(m[0])) return parseInt(m[0].slice(2), 2);
    if (/^0o/i.test(m[0])) return parseInt(m[0].slice(2), 8);
    return parseFloat(m[0]);
  };
  const primary = (): number => {
    skip();
    const c = peek();
    if (c === "(") { i++; const v = expr(0); skip(); if (peek() !== ")") throw new Error("missing )"); i++; return v; }
    if (c === "-") { i++; return -primary(); }
    if (c === "+") { i++; return primary(); }
    if (c === "~") { i++; return ~Math.trunc(primary()); }
    if (c && /[0-9.]/.test(c)) return number();
    const id = /^[a-zA-Z_π][a-zA-Z_0-9π]*/.exec(s.slice(i));
    if (id) {
      const name = id[0];
      i += name.length;
      skip();
      if (name === "x" && x !== undefined) return x;
      if (peek() === "(") {
        i++; skip();
        const args: number[] = [];
        if (peek() !== ")") { args.push(expr(0)); skip(); while (peek() === ",") { i++; args.push(expr(0)); skip(); } }
        if (peek() !== ")") throw new Error("missing )");
        i++;
        if (name === "if") return args.length === 3 && args[0] !== 0 ? args[1] : args.length === 3 ? args[2] : callFn(name, args);
        return callFn(name, args);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new Error(`unknown identifier: ${name}`);
    }
    throw new Error("expected a value");
  };
  const pow = (): number => {
    const base = primary(); skip();
    if (peek() === "^") { i++; return Math.pow(base, unaryF()); }
    return base;
  };
  const unaryF = (): number => {
    skip();
    const c = peek();
    if (c === "-") { i++; return -unaryF(); }
    if (c === "+") { i++; return unaryF(); }
    if (c === "~") { i++; return ~Math.trunc(unaryF()); }
    return pow();
  };
  const binary = (level: number): number => {
    if (level >= BINOPS.length) return unaryF();
    let left = binary(level + 1);
    for (;;) {
      skip();
      const op = BINOPS[level].find(o => s.startsWith(o, i));
      if (!op) return left;
      i += op.length;
      left = apply(op, left, binary(level + 1));
    }
  };
  const apply = (op: string, a: number, b: number): number => {
    switch (op) {
      case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b;
      case "%": return a % b; case "^": return Math.pow(a, b);
      case "&": return Math.trunc(a) & Math.trunc(b); case "|": return Math.trunc(a) | Math.trunc(b);
      case "xor": case "^|": return Math.trunc(a) ^ Math.trunc(b);
      case "<<": return Math.trunc(a) << Math.trunc(b); case ">>": return Math.trunc(a) >> Math.trunc(b);
      default: throw new Error(`bad operator ${op}`);
    }
  };
  // precedence low -> high; "xor" spelled as a word ( ^ is power, C-like)
  const BINOPS: string[][] = [["|", "xor"], ["&"], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]];
  function expr(_level: number): number { return binary(0); }
  const value = expr(0);
  skip();
  if (i < s.length) throw new Error(`unexpected '${s[i]}'`);
  if (!Number.isFinite(value) && !Number.isNaN(value)) return value;
  if (Number.isNaN(value)) throw new Error("not a number");
  return value;
}

const fmtNum = (v: number, base: string): string => {
  if (!Number.isFinite(v)) return String(v);
  const rounded = Math.round(v * 1e12) / 1e12;
  if (base === "hex" || base === "oct" || base === "bin") {
    if (!Number.isInteger(rounded)) return `${rounded} (not an integer — base display needs a whole number)`;
    const n = Math.abs(Math.trunc(rounded));
    const digits = base === "hex" ? n.toString(16).toUpperCase() : base === "oct" ? n.toString(8) : n.toString(2);
    const p = base === "hex" ? "0x" : base === "oct" ? "0o" : "0b";
    return (rounded < 0 ? "-" : "") + p + digits;
  }
  return String(rounded);
};

// pass #111: the scoped AGE stylesheet (utilities + theme vars, preflight contained)
import "../vendor/age/age.css";

// ---------- the panel ----------
let pushAge: (() => void) | null = null; // pass #111: the AGE bridge push, set when the panes wire
let pushSketch: (() => void) | null = null; // pass #112: the Excalidraw sketch mount/update
// pass #147: pane wiring can register window-resize responders (the plot's bitmap
// re-fit joins #145's panel re-clamp) — the close handler drains this list so a
// reopen never stacks listeners from a dead panel.
const panelResizeCleanups: (() => void)[] = [];
export function openToolsPanel(): void {
  // pass #109 (He, live note "make the theme"): AGE reads darkMode from localStorage at its
  // own mount — same origin, so we set it from delcc's current scheme before the iframe loads.
  // pass #110 (He: "make the color scheme actually fit us?"): the CHROME palette is changed
  // AT THE SOURCE of the vendored AGE (patches/age-c11b36ad.patch — tailwindcss-themer
  // values mapped to delcc’s tokens), correct by construction; this key only drives the
  // canvas colors.
  try { localStorage.setItem("darkMode", String(document.documentElement.classList.contains("dark"))); } catch { /* no storage — AGE keeps its default */ }
  if (panel) { panel.classList.remove("minimized"); (panel as HTMLElement).style.display = ""; if (active === "graph") pushAge?.(); if (active === "sketch") pushSketch?.(); return; }
  panel = document.createElement("div");
  panel.className = "tm-tools-panel";
  panel.innerHTML = `<span class="tm-tools-resize" data-tools-resize aria-label="${esc(t("tools.resize"))}" title="${esc(t("tools.resize"))}"></span><span class="tm-tools-resize-corner" data-tools-resize-corner aria-label="${esc(t("tools.resize"))}" title="${esc(t("tools.resize"))}"></span><div class="tm-tools-head"><span class="tm-tools-grip" data-tools-drag>${esc(t("tools.title"))}</span><button type="button" class="tm-icon-button" data-tools-max aria-label="${esc(t("tools.maximize"))}" title="${esc(t("tools.maximize"))}">⤢</button><button type="button" class="tm-icon-button" data-tools-min aria-label="${esc(t("tools.minimize"))}" title="${esc(t("tools.minimize"))}">—</button><button type="button" class="tm-icon-button" data-tools-close aria-label="${esc(t("tools.close"))}" title="${esc(t("tools.close"))}">×</button></div>
<div class="tm-tools-tabs"><button type="button" class="tm-button" data-tab="calc">${esc(t("tools.tabCalc"))}</button><button type="button" class="tm-button" data-tab="bytes">${esc(t("tools.tabBytes"))}</button><button type="button" class="tm-button" data-tab="graph">${esc(t("tools.tabGraph"))}</button><button type="button" class="tm-button" data-tab="sketch">${esc(t("tools.tabSketch"))}</button></div>
<div class="tm-tools-body" data-pane="calc">
  <div class="tm-tools-row"><input class="tm-tools-input" data-calc-expr spellcheck="false" placeholder="sin(pi/4) + 0xff &amp; 0b1010 | 3 &lt;&lt; 2"><select class="tm-drafts-select" data-calc-base><option value="dec">DEC</option><option value="hex">HEX</option><option value="oct">OCT</option><option value="bin">BIN</option></select><button type="button" class="tm-button" data-calc-angle>RAD</button></div>
  <div class="tm-tools-result" data-calc-out>—</div>
  <div class="tm-calc-pad" data-calc-pad><div class="tm-calc-fns"><button type="button" class="tm-button tm-calc-key tm-calc-2nd" data-action="2nd" title="${esc(t("tools.calc2nd"))}">2nd</button><button type="button" class="tm-button tm-calc-key" data-key="sin(">sin(</button><button type="button" class="tm-button tm-calc-key" data-key="cos(">cos(</button><button type="button" class="tm-button tm-calc-key" data-key="tan(">tan(</button><button type="button" class="tm-button tm-calc-key" data-key="asin(">asin(</button><button type="button" class="tm-button tm-calc-key" data-key="ln(">ln(</button><button type="button" class="tm-button tm-calc-key" data-key="log(">log(</button><button type="button" class="tm-button tm-calc-key" data-key="sqrt(">sqrt(</button><button type="button" class="tm-button tm-calc-key" data-key="abs(">abs(</button><button type="button" class="tm-button tm-calc-key" data-key="floor(">floor(</button><button type="button" class="tm-button tm-calc-key" data-key="gcd(">gcd(</button><button type="button" class="tm-button tm-calc-key" data-key="pi">π</button><button type="button" class="tm-button tm-calc-key" data-key="e">e</button><button type="button" class="tm-button tm-calc-key" data-key="tau">τ</button><button type="button" class="tm-button tm-calc-key" data-action="clear">C</button></div><div class="tm-calc-grid"><button type="button" class="tm-button tm-calc-key" data-action="clear">C</button><button type="button" class="tm-button tm-calc-key" data-action="back">⌫</button><button type="button" class="tm-button tm-calc-key" data-key="(">(</button><button type="button" class="tm-button tm-calc-key" data-key=")">)</button><button type="button" class="tm-button tm-calc-key" data-key="/">÷</button><button type="button" class="tm-button tm-calc-key" data-key="7">7</button><button type="button" class="tm-button tm-calc-key" data-key="8">8</button><button type="button" class="tm-button tm-calc-key" data-key="9">9</button><button type="button" class="tm-button tm-calc-key" data-key="^">^</button><button type="button" class="tm-button tm-calc-key" data-key="*">×</button><button type="button" class="tm-button tm-calc-key" data-key="4">4</button><button type="button" class="tm-button tm-calc-key" data-key="5">5</button><button type="button" class="tm-button tm-calc-key" data-key="6">6</button><button type="button" class="tm-button tm-calc-key" data-action="ans">Ans</button><button type="button" class="tm-button tm-calc-key" data-key="-">−</button><button type="button" class="tm-button tm-calc-key" data-key="1">1</button><button type="button" class="tm-button tm-calc-key" data-key="2">2</button><button type="button" class="tm-button tm-calc-key" data-key="3">3</button><button type="button" class="tm-button tm-calc-key" data-key=".">.</button><button type="button" class="tm-button tm-calc-key" data-key="+">+</button><button type="button" class="tm-button tm-calc-key tm-calc-zero" data-key="0">0</button><button type="button" class="tm-button tm-calc-key tm-calc-eq" data-action="eval">=</button></div></div>
  <div class="tm-tools-sub"><button type="button" class="tm-button tm-plot-open" data-plot-open>${esc(t("tools.plotFn"))}</button></div>
  <div class="tm-plot-panel" data-plot-panel hidden><div class="tm-plot-rows" data-plot-rows></div><div class="tm-tools-row wrap"><button type="button" class="tm-button tm-plot-add" data-plot-add>+ ${esc(t("tools.plotAdd"))}</button><label class="tm-tools-inline">x min <input class="tm-tools-mini" data-plot-xmin value="-10"></label><label class="tm-tools-inline">x max <input class="tm-tools-mini" data-plot-xmax value="10"></label><button type="button" class="tm-button" data-plot-redraw>${esc(t("tools.plot"))}</button></div><canvas class="tm-tools-canvas" data-plot-canvas width="760" height="280" title="${esc(t("tools.plotZoomHint"))}"></canvas><div class="tm-tools-sub" data-plot-note></div></div>
  <div class="tm-tools-history" data-calc-hist></div>
</div>
<div class="tm-tools-body" data-pane="bytes" hidden>
  <div class="tm-tools-cols"><div class="tm-tools-col"><b>${esc(t("tools.text"))}</b><textarea class="tm-tools-area" data-bytes-text spellcheck="false"></textarea></div><div class="tm-tools-col"><b>${esc(t("tools.hex"))}</b><textarea class="tm-tools-area mono" data-bytes-hex spellcheck="false" placeholder="48 65 6c 6c 6f"></textarea></div></div>
  <div class="tm-tools-row wrap"><button type="button" class="tm-button" data-conv="b64enc">Base64 →</button><button type="button" class="tm-button" data-conv="b64dec">← Base64</button><button type="button" class="tm-button" data-conv="urlenc">URL →</button><button type="button" class="tm-button" data-conv="urldec">← URL</button><button type="button" class="tm-button" data-conv="htmenc">HTML →</button><button type="button" class="tm-button" data-conv="htmdec">← HTML</button><button type="button" class="tm-button" data-conv="utf8hex">UTF-8 hex →</button><button type="button" class="tm-button" data-conv="binstr">Binary →</button><button type="button" class="tm-button" data-conv="lower">hex →</button><button type="button" class="tm-button" data-conv="applyhex">${esc(t("tools.bytesApply"))}</button></div>
  <div class="tm-hex-host" data-bytes-dump></div>
  <div class="tm-tools-result" data-bytes-detail></div>
</div>
<div class="tm-tools-body" data-pane="graph" hidden>
  <div class="tm-tools-cols"><div class="tm-tools-col narrow"><b>${esc(t("tools.graphEdges"))}</b><textarea class="tm-tools-area mono" data-graph-edges spellcheck="false" placeholder="1 2 4&#10;2 3 2&#10;3 1 5">1 2 4
2 3 2
3 1 5</textarea><input class="tm-tools-input" data-graph-roots spellcheck="false" placeholder="${esc(t("tools.graphRootPh"))}" aria-label="${esc(t("tools.graphRoot"))}" title="${esc(t("tools.graphRoot"))}"><button type="button" class="tm-button primary" data-graph-draw>${esc(t("tools.graphDraw"))}</button><div class="tm-tools-sub">${esc(t("tools.graphHint"))}</div><div class="tm-tools-checks"><label class="tm-tools-inline"><input type="checkbox" data-graph-directed> ${esc(t("tools.graphDirected"))}</label><label class="tm-tools-inline"><input type="checkbox" data-graph-tree> ${esc(t("tools.treeLayout"))}</label><label class="tm-tools-inline"><input type="checkbox" data-graph-lock> ${esc(t("tools.lockPositions"))}</label></div><label class="tm-tools-inline">${esc(t("tools.graphRelabel"))} <select class="tm-drafts-select" data-graph-relabel><option value="0">${esc(t("tools.graphRelabelKeep"))}</option><option value="-1">${esc(t("tools.graphRelabelZero"))}</option><option value="1">${esc(t("tools.graphRelabelOne"))}</option></select></label></div><div class="tm-tools-col"><div class="tm-graph-box" data-graph-box><div class="tm-age-host" data-graph-host></div><div class="tm-graph-badge" data-graph-stats></div><p class="tm-age-error" data-age-error hidden role="alert"></p></div></div></div>
</div></div>`;
  // pass #112: the sketch pane is appended in JS as a DIRECT child of the panel — the
  // template nesting bit us twice (a pane inside the graph pane body vanishes with it).
  const sketchPane = document.createElement("div");
  sketchPane.className = "tm-tools-body";
  sketchPane.dataset.pane = "sketch";
  sketchPane.hidden = true;
  sketchPane.innerHTML = `<div class="tm-sketch-host" data-sketch-host></div>`;
  panel.appendChild(sketchPane);
  document.body.appendChild(panel);
  // drag by the header — disabled while maximized (the panel is viewport-pinned then)
  const head = panel.querySelector<HTMLElement>("[data-tools-drag]")!;
  head.onpointerdown = e => {
    if (panel!.classList.contains("maximized")) return;
    const r = panel!.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      panel!.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dx))}px`;
      panel!.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dy))}px`;
      panel!.style.right = "auto"; panel!.style.bottom = "auto";
    };
    head.onpointermove = move;
    head.onpointerup = () => { head.onpointermove = null; head.onpointerup = null; };
  };
  // pass #109 (He, live note "tool pane resizing?"): left-edge grip resizes the panel;
  // pass #113: the AGE canvas lives in THIS document since #111 — it re-measures on the
  // window resize event (the old code still dispatched into the long-gone iframe).
  const rz = panel.querySelector<HTMLElement>("[data-tools-resize]")!;
  // pass #110 (He: "we need vertical"): the top-left corner resizes BOTH axes — the panel
  // is bottom-anchored, so dragging up grows it upward; bodies flex-fill (see CSS).
  const rzCorner = panel.querySelector<HTMLElement>("[data-tools-resize-corner]")!;
  rzCorner.onpointerdown = e => {
    if (panel!.classList.contains("maximized")) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const r = panel!.getBoundingClientRect();
    const startW = r.width, startH = r.height;
    rzCorner.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      panel!.style.width = `${Math.min(window.innerWidth - 40, Math.max(560, startW + (startX - ev.clientX)))}px`;
      panel!.style.height = `${Math.min(window.innerHeight - 88, Math.max(340, startH + (startY - ev.clientY)))}px`;
      panel!.setAttribute("data-user-height", "");
      window.dispatchEvent(new Event("resize"));
    };
    rzCorner.onpointermove = move;
    rzCorner.onpointerup = () => { rzCorner.onpointermove = null; rzCorner.onpointerup = null; };
  };
  rz.onpointerdown = e => {
    if (panel!.classList.contains("maximized")) return;
    const startX = e.clientX, startW = panel!.getBoundingClientRect().width;
    rz.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      panel!.style.width = `${Math.min(window.innerWidth - 40, Math.max(560, startW + (startX - ev.clientX)))}px`;
      window.dispatchEvent(new Event("resize"));
    };
    rz.onpointermove = move;
    rz.onpointerup = () => { rz.onpointermove = null; rz.onpointerup = null; };
  };
  // pass #145 (He, "GENUINELY UI BREAKING"): the grips bake viewport-clamped px into
  // the panel's inline style; after the WINDOW resizes (maximize, restore) those px
  // can overflow the viewport or waste the new space — a gripped panel stayed frozen
  // at its old size inside a grown window (probe-verified). Re-clamp on every window
  // resize: keep the user's size when it still fits, clamp when it doesn't, and keep
  // a dragged panel reachable. The maximized class is CSS-pinned and skips this.
  const reclamp = (): void => {
    const p = panel;
    if (!p || p.classList.contains("maximized")) return;
    const r = p.getBoundingClientRect();
    if (p.style.width || p.style.height) {
      p.style.width = `${Math.max(560, Math.min(r.width, window.innerWidth - 40))}px`;
      p.style.height = `${Math.max(340, Math.min(r.height, window.innerHeight - 88))}px`;
    }
    if (p.style.left || p.style.top) {
      p.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, parseFloat(p.style.left)))}px`;
      p.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, parseFloat(p.style.top)))}px`;
    }
  };
  window.addEventListener("resize", reclamp);
  panel.querySelector<HTMLElement>("[data-tools-close]")!.onclick = () => {
    // pass #142 (wave-8 W8-11): close DISPOSES the live roots. The AGE and sketch React
    // roots are module-level and used to survive the panel removal — a reopen mounted
    // into the NEW host while the old root still held the old one (blank panel), and
    // AGE's animation loop kept rendering into a detached canvas at 90 FPS with its
    // window keydown listener still attached. Both unmounts are dynamic imports so the
    // lazy chunks stay lazy.
    void import("../vendor/age").then(m => m.unmountAge()).catch(() => {});
    void import("./sketch").then(m => m.unmountSketch()).catch(() => {});
    window.removeEventListener("resize", reclamp);
    panelResizeCleanups.splice(0).forEach(f => f());
    panel?.remove();
    panel = null;
  };
  panel.querySelector<HTMLElement>("[data-tools-min]")!.onclick = () => panel!.classList.toggle("minimized");
  // pass #107 (Official parity): maximize pins the panel to the viewport; the glyph flips
  const maxBtn = panel.querySelector<HTMLButtonElement>("[data-tools-max]")!;
  maxBtn.onclick = () => {
    const p = panel!;
    const maximized = p.classList.toggle("maximized");
    if (maximized) {
      p.style.left = ""; p.style.top = ""; p.style.right = ""; p.style.bottom = ""; // a dragged position must not fight the pinned inset
      // pass #145: an inline grip size would beat the class's width:auto (over-
      // constrained left+right+width) — park it for the restore, the pinned inset
      // owns the size while maximized
      if (p.style.width || p.style.height) { p.dataset.userW = p.style.width; p.dataset.userH = p.style.height || ""; p.style.width = ""; p.style.height = ""; }
    } else {
      if (p.dataset.userW) { p.style.width = p.dataset.userW; p.style.height = p.dataset.userH ?? ""; delete p.dataset.userW; delete p.dataset.userH; }
      reclamp(); // the parked size must fit the viewport it returns to
    }
    maxBtn.textContent = maximized ? "⤡" : "⤢";
    maxBtn.title = maximized ? t("tools.restore") : t("tools.maximize");
    maxBtn.setAttribute("aria-label", maxBtn.title);
    window.dispatchEvent(new Event("resize")); // the AGE canvas re-measures to the new host height
  };
  panel.querySelectorAll<HTMLButtonElement>(".tm-tools-tabs [data-tab]").forEach(b => b.onclick = () => {
    active = b.dataset.tab as Tab;
    panel!.querySelectorAll<HTMLElement>(".tm-tools-tabs [data-tab]").forEach(x => x.classList.toggle("active", x === b));
    panel!.querySelectorAll<HTMLElement>(".tm-tools-body").forEach(p => { p.hidden = p.dataset.pane !== active; });
    if (active === "graph") pushAge?.(); // mount/update on first show
    if (active === "sketch") pushSketch?.();
  });
  panel!.querySelector<HTMLElement>(`.tm-tools-tabs [data-tab="${active}"]`)!.classList.add("active");
  panel!.querySelectorAll<HTMLElement>(".tm-tools-body").forEach(p => { p.hidden = p.dataset.pane !== active; });
  wireCalc(panel!);
  wireBytes(panel!);
  pushAge = wireGraph(panel!);
  // pass #113: the graph must be VISIBLE on first open (Official renders it immediately) —
  // the wire alone never mounted the canvas; it sat empty until the first Draw click
  if (active === "graph") pushAge();
  let sketchMounted = false;
  pushSketch = (): void => {
    void import("./sketch").then((m) => {
      const dark = document.documentElement.classList.contains("dark");
      if (!sketchMounted) { void m.mountSketch(panel!.querySelector<HTMLElement>("[data-sketch-host]")!, dark); sketchMounted = true; }
      else { void m.updateSketchTheme(dark); }
    }).catch((e) => {
      const h = panel!.querySelector<HTMLElement>("[data-sketch-host]");
      if (h) h.textContent = "sketch mount failed: " + String(e);
    });
  };
}

// ---------- calculator wiring ----------
const calcHistory: string[] = [];
// pass #114: insert at the caret (keeps the selection edge), then re-run the live eval
function insertAtCaret(input: HTMLInputElement, s: string): void {
  const st = input.selectionStart ?? input.value.length;
  const en = input.selectionEnd ?? st;
  input.value = input.value.slice(0, st) + s + input.value.slice(en);
  input.selectionStart = input.selectionEnd = st + s.length;
  input.focus();
  input.dispatchEvent(new Event("input"));
}
function wireCalc(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("[data-calc-expr]")!;
  const out = root.querySelector<HTMLElement>("[data-calc-out]")!;
  const base = root.querySelector<HTMLSelectElement>("[data-calc-base]")!;
  const angle = root.querySelector<HTMLButtonElement>("[data-calc-angle]")!;
  let deg = false;
  let ans = 0; // pass #114: the keypad's Ans — last finite result, decimal literal
  angle.onclick = () => { deg = !deg; angle.textContent = deg ? "DEG" : "RAD"; if (input.value.trim()) run(); };
  // pass #125 (He: "a little bit of buffering time before History is logged"): typing
  // evals live but only LOGS once the expression has held for a beat (1.2 s without a
  // further edit) — a keystroke walk (1, 12, 123…) leaves one entry, not four. The =
  // key is a deliberate act and logs immediately.
  let histTimer: ReturnType<typeof setTimeout> | null = null;
  let histPending = "";
  const pushHistory = (v: string, line: string): void => {
    calcHistory.unshift(`${v} = ${line}`);
    if (calcHistory.length > 30) calcHistory.pop();
    renderHistory();
  };
  const scheduleHistory = (v: string, line: string): void => {
    histPending = v;
    if (histTimer) clearTimeout(histTimer);
    histTimer = setTimeout(() => {
      histTimer = null;
      if (input.value.trim() === histPending) pushHistory(histPending, line);
    }, 1200);
  };
  const run = (explicit = false): void => {
    const v = input.value.trim();
    if (!v) { out.textContent = "—"; return; }
    try {
      const r = evalExpr(v, deg);
      const line = fmtNum(r, base.value);
      out.textContent = `= ${line}`;
      if (Number.isFinite(r)) ans = r;
      if (input.dataset.last !== v && Number.isFinite(r)) {
        input.dataset.last = v;
        if (explicit) pushHistory(v, line); else scheduleHistory(v, line);
      }
    } catch (e) { out.textContent = e instanceof Error ? e.message : String(e); out.classList.add("tm-error"); return; }
    out.classList.remove("tm-error");
  };
  // pass #116 (He: "What if we want to delete history?"): a clear chip heads the row —
  // wipes the record (the results already on screen are just display state).
  // pass #125 (He): each entry grows its own × — restore and delete are separate
  // targets, so a mis-tap on a chip can never erase it.
  const renderHistory = (): void => {
    const hist = root.querySelector<HTMLElement>("[data-calc-hist]")!;
    hist.innerHTML = (calcHistory.length
      ? `<button type="button" class="tm-tools-hist tm-tools-hist-clear" data-hist-clear>${esc(t("tools.histClear"))}</button>`
      : "") + calcHistory.map((h, i) => `<span class="tm-hist-item"><button type="button" class="tm-tools-hist" data-hist-i="${i}">${esc(h)}</button><button type="button" class="tm-hist-del" data-hist-del="${i}" title="${esc(t("tools.histDelOne"))}" aria-label="${esc(t("tools.histDelOne"))}">×</button></span>`).join("");
    hist.querySelectorAll<HTMLButtonElement>(".tm-tools-hist[data-hist-i]").forEach(b => b.onclick = () => { input.value = b.textContent!.split(" = ")[0] ?? ""; input.focus(); });
    hist.querySelectorAll<HTMLButtonElement>("[data-hist-del]").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.histDel);
      if (Number.isInteger(i) && i >= 0 && i < calcHistory.length) { calcHistory.splice(i, 1); renderHistory(); }
    });
    const clear = hist.querySelector<HTMLButtonElement>("[data-hist-clear]");
    if (clear) clear.onclick = () => { calcHistory.length = 0; renderHistory(); };
  };
  input.oninput = () => run();
  base.onchange = () => run();
  // pass #114: the button pad — He ("Calculator should have UI-rendered button for the
  // numbers and things"). Keys insert at the caret; Ans replays the last finite result;
  // ⌫ deletes the selection or one char; C clears; = runs the same eval as live typing.
  const pad = root.querySelector<HTMLElement>("[data-calc-pad]")!;
  // pass #118 (He: "polishing to the top row, 2nd (will invoke the arc func. for
  // sin/cos/tan, ln() for log(), and thing like that)"): the 2nd modifier lives as the
  // FIRST chip of the functions strip; while lit, the strip swaps to the inverse set —
  // sin→sin⁻¹( (asin), cos→acos, tan→atan, log↔ln, sqrt→∛( (cbrt), floor→ceil. Every
  // target is already in FUNCS, so this is a pure label/insert swap, no engine change.
  const MAP2ND: Record<string, { key: string; label: string }> = {
    "sin(": { key: "asin(", label: "sin⁻¹(" },
    "asin(": { key: "sin(", label: "sin(" },
    "cos(": { key: "acos(", label: "cos⁻¹(" },
    "acos(": { key: "cos(", label: "cos(" },
    "tan(": { key: "atan(", label: "tan⁻¹(" },
    "atan(": { key: "tan(", label: "tan(" },
    "ln(": { key: "log(", label: "log(" },
    "log(": { key: "ln(", label: "ln(" },
    "sqrt(": { key: "cbrt(", label: "∛(" },
    "floor(": { key: "ceil(", label: "ceil(" },
  };
  let second = false;
  const apply2nd = (): void => {
    pad.querySelectorAll<HTMLButtonElement>(".tm-calc-fns .tm-calc-key").forEach(b => {
      const k = b.dataset.key;
      if (k == null) return;
      if (second && MAP2ND[k]) {
        b.dataset.origKey = k;
        b.dataset.origLabel = b.textContent ?? k;
        b.dataset.key = MAP2ND[k].key;
        b.textContent = MAP2ND[k].label;
      } else if (!second && b.dataset.origKey) {
        b.dataset.key = b.dataset.origKey;
        b.textContent = b.dataset.origLabel ?? b.dataset.origKey;
        delete b.dataset.origKey;
        delete b.dataset.origLabel;
      }
    });
  };
  pad.querySelectorAll<HTMLButtonElement>(".tm-calc-key").forEach(b => b.onclick = () => {
    if (b.dataset.key != null) { insertAtCaret(input, b.dataset.key); return; }
    const act = b.dataset.action;
    if (act === "back") {
      const s = input.selectionStart ?? input.value.length;
      const e2 = input.selectionEnd ?? s;
      input.value = s === e2 && s > 0
        ? input.value.slice(0, s - 1) + input.value.slice(e2)
        : input.value.slice(0, s) + input.value.slice(e2);
      input.selectionStart = input.selectionEnd = s === e2 ? Math.max(0, s - 1) : s;
      input.focus();
      input.dispatchEvent(new Event("input"));
    } else if (act === "2nd") {
      second = !second;
      b.classList.toggle("active", second);
      apply2nd();
    } else if (act === "clear") {
      input.value = "";
      input.focus();
      input.dispatchEvent(new Event("input"));
    } else if (act === "eval") run(true); // the = key: deliberate — log immediately
    else if (act === "ans") insertAtCaret(input, fmtNum(ans, "dec"));
  });
  // ---------- pass #118: the multigraph plot panel ----------
  // He: "make f(x) a button to invoke plot … multigraphing (f(x) + g(x) + other
  // graphs) … time to outdo them". The single-curve f(x) row collapses into a button;
  // the panel it opens carries colored named curves (ƒ g h p q r s u), visibility
  // eyes, add/remove, nice-tick labeled axes, an outlier-resistant y-range, a live
  // crosshair readout, and per-curve honest errors. State persists locally
  // (delcc-tmath-plot-v2); the angle mode follows the calculator's RAD/DEG toggle.
  const PLOT_LS = "delcc-tmath-plot-v2";
  const PLOT_MAX = 8;
  const PLOT_COLORS = ["#4ea1ff", "#f59e0b", "#34d399", "#f472b6", "#a78bfa", "#22d3ee", "#fb7185", "#a3e635"];
  const PLOT_NAMES = ["ƒ", "g", "h", "p", "q", "r", "s", "u"];
  type PlotFn = { expr: string; on: boolean };
  let plotFns: PlotFn[] = [{ expr: "sin(x)", on: true }, { expr: "x^2/4 - 2", on: true }];
  const plotPanel = root.querySelector<HTMLElement>("[data-plot-panel]")!;
  const plotRows = plotPanel.querySelector<HTMLElement>("[data-plot-rows]")!;
  const plotCanvas = plotPanel.querySelector<HTMLCanvasElement>("[data-plot-canvas]")!;
  const plotNote = plotPanel.querySelector<HTMLElement>("[data-plot-note]")!;
  const plotXmin = plotPanel.querySelector<HTMLInputElement>("[data-plot-xmin]")!;
  const plotXmax = plotPanel.querySelector<HTMLInputElement>("[data-plot-xmax]")!;
  try {
    const saved = JSON.parse(localStorage.getItem(PLOT_LS) ?? "null") as { fns?: PlotFn[]; xmin?: string; xmax?: string } | null;
    if (saved && Array.isArray(saved.fns) && saved.fns.length <= PLOT_MAX
      && saved.fns.every(f => !!f && typeof f.expr === "string" && typeof f.on === "boolean")) plotFns = saved.fns;
    if (saved && typeof saved.xmin === "string") plotXmin.value = saved.xmin;
    if (saved && typeof saved.xmax === "string") plotXmax.value = saved.xmax;
  } catch { /* corrupt or absent — the defaults stand */ }
  const persistPlot = (): void => {
    try { localStorage.setItem(PLOT_LS, JSON.stringify({ fns: plotFns, xmin: plotXmin.value, xmax: plotXmax.value })); } catch { /* private mode — session only */ }
  };
  const fmtTick = (v: number): string => {
    if (Math.abs(v) < 1e-12) return "0";
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
    return String(Math.round(v * 1e6) / 1e6);
  };
  const fmtVal = (v: number): string => {
    if (!Number.isFinite(v)) return "—";
    if (v !== 0 && (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-4)) return v.toExponential(3);
    return String(Math.round(v * 1e4) / 1e4);
  };
  const niceStep = (span: number): number => {
    const raw = span / 8;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
  };
  const N_PLOT = 600;
  // the crosshair redraws read this cache — pointer moves never re-sample the curves
  let plotSamples: { ys: number[]; color: string }[] = [];
  let plotView = { xmin: -10, xmax: 10, ymin: -1, ymax: 1 };
  const drawPlot = (crossX?: number): void => {
    const ctx = plotCanvas.getContext("2d")!;
    // pass #147 (He: "the scaling on the graph is off — the numbers should stay
    // constant regardless of the scale"): the bitmap was a FIXED 760x280 that CSS
    // stretched to the panel, so every tick label was bitmap-scaled smear on a wide
    // window. The bitmap now follows the element box times devicePixelRatio and all
    // math runs in CSS pixels — the font stays a constant 10px at any panel size.
    const rect = plotCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (!rect.width || !rect.height) return;
    if (plotCanvas.width !== bw || plotCanvas.height !== bh) { plotCanvas.width = bw; plotCanvas.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width, H = rect.height;
    const { xmin, xmax, ymin, ymax } = plotView;
    const px = (x: number): number => (x - xmin) / (xmax - xmin) * W;
    const py = (y: number): number => H - (y - ymin) / (ymax - ymin) * H;
    const css = getComputedStyle(plotCanvas);
    const ink = css.color || "#888";
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = ink; ctx.fillStyle = ink;
    ctx.font = "10px " + (css.fontFamily || "sans-serif");
    const sx = niceStep(xmax - xmin), sy = niceStep(ymax - ymin);
    ctx.globalAlpha = 0.18; ctx.lineWidth = 1; ctx.beginPath();
    for (let gx = Math.ceil(xmin / sx) * sx; gx <= xmax; gx += sx) { ctx.moveTo(px(gx), 0); ctx.lineTo(px(gx), H); }
    for (let gy = Math.ceil(ymin / sy) * sy; gy <= ymax; gy += sy) { ctx.moveTo(0, py(gy)); ctx.lineTo(W, py(gy)); }
    ctx.stroke();
    ctx.globalAlpha = 0.55; ctx.beginPath();
    if (ymin < 0 && ymax > 0) { ctx.moveTo(0, py(0)); ctx.lineTo(W, py(0)); }
    if (xmin < 0 && xmax > 0) { ctx.moveTo(px(0), 0); ctx.lineTo(px(0), H); }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (let gx = Math.ceil(xmin / sx) * sx; gx <= xmax; gx += sx) ctx.fillText(fmtTick(gx), px(gx), H - 2);
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    for (let gy = Math.ceil(ymin / sy) * sy; gy <= ymax; gy += sy) ctx.fillText(fmtTick(gy), 2, py(gy) + 2);
    ctx.lineWidth = 1.6;
    for (const s of plotSamples) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k <= N_PLOT; k++) {
        const y = s.ys[k];
        if (!Number.isFinite(y) || y < ymin - (ymax - ymin) * 2 || y > ymax + (ymax - ymin) * 2) { pen = false; continue; }
        const X = px(xmin + (xmax - xmin) * k / N_PLOT), Y = py(y);
        if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
      }
      ctx.stroke();
    }
    if (crossX !== undefined && crossX >= xmin && crossX <= xmax) {
      ctx.globalAlpha = 0.4; ctx.strokeStyle = ink;
      ctx.beginPath(); ctx.moveTo(px(crossX), 0); ctx.lineTo(px(crossX), H); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };
  let rowErrs: (string | null)[] = [];
  let plotTimer: ReturnType<typeof setTimeout> | null = null;
  const schedulePlot = (): void => { if (plotTimer) clearTimeout(plotTimer); plotTimer = setTimeout(renderPlot, 250); };
  const renderPlot = (): void => {
    const xmin = parseFloat(plotXmin.value), xmax = parseFloat(plotXmax.value);
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || !(xmax > xmin)) {
      plotNote.textContent = t("tools.plotErrRange"); plotSamples = []; drawPlot(); return;
    }
    plotSamples = []; rowErrs = plotFns.map(() => null);
    const all: number[] = [];
    const errs: string[] = [];
    plotFns.forEach((f, i) => {
      if (!f.on || !f.expr.trim()) return;
      const ys: number[] = [];
      for (let k = 0; k <= N_PLOT; k++) {
        const x = xmin + (xmax - xmin) * k / N_PLOT;
        try {
          const y = evalExpr(f.expr, deg, x);
          ys.push(y);
          if (Number.isFinite(y)) all.push(y);
        } catch (e) {
          ys.push(NaN);
          if (!rowErrs[i]) rowErrs[i] = e instanceof Error ? e.message : String(e);
        }
      }
      if (rowErrs[i]) errs.push(`${PLOT_NAMES[i]}: ${rowErrs[i]}`);
      plotSamples.push({ ys, color: PLOT_COLORS[i % PLOT_COLORS.length] });
    });
    // err rings on the chips — an expression that cannot parse is said, never swallowed
    plotRows.querySelectorAll<HTMLElement>(".tm-plot-row").forEach((r, i) => {
      const err = !!(plotFns[i]?.on && rowErrs[i]);
      r.classList.toggle("err", err);
      const chip = r.querySelector<HTMLElement>(".tm-plot-chip");
      if (chip) chip.title = err ? rowErrs[i]! : "";
    });
    if (!plotSamples.length || !all.length) {
      plotNote.textContent = errs[0] ?? t("tools.plotErrNone");
      plotSamples = plotSamples.filter(s => s.ys.some(Number.isFinite));
      drawPlot();
      return;
    }
    let ymin = Math.min(...all), ymax = Math.max(...all);
    // outlier-resistant range: a lone spike (tan near its pole) must not flatten
    // every other curve — when min/max dwarf the 1–99% band, the band wins
    if (all.length >= 20) {
      const sorted = [...all].sort((a, b) => a - b);
      const p1 = sorted[Math.floor(sorted.length * 0.01)];
      const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99) + 1)];
      if (Number.isFinite(p1) && Number.isFinite(p99) && p99 > p1 && ymax - ymin > 30 * (p99 - p1)) { ymin = p1; ymax = p99; }
    }
    if (!(ymax - ymin > 1e-9)) { ymin -= 1; ymax += 1; }
    const padY = (ymax - ymin) * 0.08; ymin -= padY; ymax += padY;
    plotView = { xmin, xmax, ymin, ymax };
    drawPlot();
    plotNote.textContent = `x ∈ [${fmtTick(xmin)}, ${fmtTick(xmax)}]  y ∈ [${fmtTick(ymin)}, ${fmtTick(ymax)}] · ${deg ? "DEG" : "RAD"}`
      + (errs.length ? ` · ${errs.join(" · ")}` : "");
  };
  const renderRows = (): void => {
    plotRows.innerHTML = plotFns.map((f, i) =>
      `<div class="tm-plot-row"><span class="tm-plot-chip" style="background:${PLOT_COLORS[i % PLOT_COLORS.length]}">${PLOT_NAMES[i]}</span><input class="tm-tools-input mono" data-plot-fn spellcheck="false" value="${esc(f.expr)}" placeholder="sin(x)" aria-label="${esc(t("tools.plotFn"))} ${PLOT_NAMES[i]}"><button type="button" class="tm-button tm-plot-mini${f.on ? "" : " off"}" data-plot-eye title="${esc(t("tools.plotEye"))}" aria-label="${esc(t("tools.plotEye"))}">${f.on ? "◉" : "○"}</button><button type="button" class="tm-button tm-plot-mini" data-plot-del title="${esc(t("tools.plotRemove"))}" aria-label="${esc(t("tools.plotRemove"))}">×</button></div>`).join("");
    plotRows.querySelectorAll<HTMLInputElement>("[data-plot-fn]").forEach((inp, i) => {
      inp.oninput = () => { plotFns[i].expr = inp.value; persistPlot(); schedulePlot(); };
    });
    plotRows.querySelectorAll<HTMLButtonElement>("[data-plot-eye]").forEach((b, i) => {
      b.onclick = () => { plotFns[i].on = !plotFns[i].on; persistPlot(); renderRows(); schedulePlot(); };
    });
    plotRows.querySelectorAll<HTMLButtonElement>("[data-plot-del]").forEach((b, i) => {
      b.onclick = () => { plotFns.splice(i, 1); persistPlot(); renderRows(); renderPlot(); };
    });
  };
  const plotOpen = root.querySelector<HTMLButtonElement>("[data-plot-open]")!;
  plotOpen.onclick = () => {
    plotPanel.hidden = !plotPanel.hidden;
    plotOpen.classList.toggle("active", !plotPanel.hidden);
    if (!plotPanel.hidden) { renderRows(); renderPlot(); }
  };
  plotPanel.querySelector<HTMLButtonElement>("[data-plot-add]")!.onclick = () => {
    if (plotFns.length >= PLOT_MAX) return;
    plotFns.push({ expr: "", on: true });
    persistPlot(); renderRows();
    const inputs = plotRows.querySelectorAll<HTMLInputElement>("[data-plot-fn]");
    (inputs[inputs.length - 1] ?? null)?.focus();
  };
  plotXmin.onchange = plotXmax.onchange = () => { persistPlot(); renderPlot(); };
  plotPanel.querySelector<HTMLButtonElement>("[data-plot-redraw]")!.onclick = () => renderPlot();
  // pass #147 (He: "add graph zooming (will need it)"): wheel zooms X around the
  // cursor, drag pans X, double-click resets to the default window. The x-min/x-max
  // inputs stay the SINGLE source of truth — zoom/pan rewrite them (persisted, so
  // Plot and the note stay truthful) — and every step re-samples the curves over the
  // new window, because the sample cache is range-bound. Y keeps the auto-fit (the
  // outlier-resistant range is a feature; a y-zoom would fight it).
  const setRange = (a: number, b: number): void => {
    plotXmin.value = String(parseFloat(a.toPrecision(12)));
    plotXmax.value = String(parseFloat(b.toPrecision(12)));
  };
  let dragX: number | null = null;
  let panRaf = false;
  const panTo = (clientX: number): void => {
    const r = plotCanvas.getBoundingClientRect();
    if (!r.width || dragX === null) return;
    const dx = (clientX - dragX) / r.width * (plotView.xmax - plotView.xmin);
    if (Math.abs(clientX - dragX) < 2) return; // a click is not a pan
    dragX = clientX;
    setRange(plotView.xmin - dx, plotView.xmax - dx);
    if (!panRaf) { // re-sampling 600 points per curve per event is fine; per FRAME is the ceiling
      panRaf = true;
      requestAnimationFrame(() => { panRaf = false; renderPlot(); });
    }
  };
  plotCanvas.style.cursor = "grab";
  plotCanvas.onpointerdown = e => {
    if (plotPanel.hidden || !plotSamples.length) return;
    dragX = e.clientX;
    plotCanvas.setPointerCapture(e.pointerId);
    plotCanvas.style.cursor = "grabbing";
  };
  plotCanvas.onpointerup = () => { if (dragX !== null) { dragX = null; persistPlot(); } plotCanvas.style.cursor = "grab"; };
  plotCanvas.onpointercancel = () => { dragX = null; plotCanvas.style.cursor = "grab"; };
  // pass #149 (He: "mouse have bare wheel being zoom instead of scroll, that's
  // something we have to consider") — building on #148's touchpad fix: the wheel is
  // now GESTURE-SHAPED. A mouse notch is a big discrete jump (Chrome pixel-mode
  // ~100-120, line-mode 3x16=48); a touchpad two-finger swipe is a STREAM of tiny
  // pixel deltas. So: bare wheel zooms ONLY when the normalized delta is notch-sized
  // (|dy| >= 40) — dose-proportional, so even a fast flick that crosses the line adds
  // at most a ~1.1x nudge instead of an explosion; smaller bare deltas are the
  // touchpad's and scroll through natively. CTRL+wheel zooms at any size (his box's
  // ctrl+swipe), and a pinch that emits ctrl+wheel rides the same path.
  plotCanvas.onwheel = e => {
    const dy = (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY);
    if (!e.ctrlKey && Math.abs(dy) < 40) return; // the touchpad's stream — native scroll
    if (plotPanel.hidden || !plotSamples.length) return;
    e.preventDefault();
    const r = plotCanvas.getBoundingClientRect();
    if (!r.width) return;
    const f = Math.exp(Math.max(-240, Math.min(240, dy)) * 0.002);
    const cx = plotView.xmin + (e.clientX - r.left) / r.width * (plotView.xmax - plotView.xmin);
    const xmin = cx - (cx - plotView.xmin) * f, xmax = cx + (plotView.xmax - cx) * f;
    // the float format itself is the boundary: past ~1e12 of span or under ~1e-9 the
    // ticks and samples stop being meaningful — stop there instead of degrading
    if (!(xmax - xmin > 1e-9) || xmax - xmin > 1e12) return;
    setRange(xmin, xmax);
    persistPlot();
    renderPlot();
  };
  plotCanvas.ondblclick = () => {
    setRange(-10, 10);
    persistPlot();
    renderPlot();
  };
  // the crosshair: a vertical line + live per-curve values at the pointer, evaluated
  // straight from the expressions — the curves themselves re-draw from the sample cache
  plotCanvas.onpointermove = e => {
    if (plotPanel.hidden) return;
    if (dragX !== null) { panTo(e.clientX); return; } // the pan owns the pointer while held
    if (!plotSamples.length) return;
    const r = plotCanvas.getBoundingClientRect();
    if (!r.width) return;
    const x = plotView.xmin + (e.clientX - r.left) / r.width * (plotView.xmax - plotView.xmin);
    drawPlot(x);
    const parts = [`x = ${fmtVal(x)}`];
    plotFns.forEach((f, i) => {
      if (!f.on || !f.expr.trim()) return;
      try { parts.push(`${PLOT_NAMES[i]} = ${fmtVal(evalExpr(f.expr, deg, x))}`); } catch { parts.push(`${PLOT_NAMES[i]} = —`); }
    });
    plotNote.textContent = parts.join("  ·  ");
  };
  plotCanvas.onpointerleave = () => { if (!plotPanel.hidden) renderPlot(); };
  // pass #147: the plot re-fits its bitmap when the panel resizes — the grips and the
  // maximize toggle dispatch window resize, a real window resize fires it natively
  const onPlotResize = (): void => { if (plotPanel.isConnected && !plotPanel.hidden && plotSamples.length) drawPlot(); };
  window.addEventListener("resize", onPlotResize);
  panelResizeCleanups.push(() => window.removeEventListener("resize", onPlotResize));
}

// ---------- bytes & encodings wiring ----------
// pass #114 (He: "Hex seems like it could use a hex editor out there, as just
// reinventing the wheel is painful"): the hand-rolled .byte-span dump is replaced by
// @hexcanvas/element (<hexcanvas-editor>, MIT, zero runtime deps) — real cursor,
// selection, overwrite/insert editing, undo, search. The lazy import keeps it out of
// the main chunk; the theme rides the inherited --tmath-* custom properties.
type HexEditorElement = HTMLElement & { source: unknown };
let hexBuffer: import("@hexcanvas/core").MemoryBinaryBuffer | null = null;
function wireBytes(root: HTMLElement): void {
  const text = root.querySelector<HTMLTextAreaElement>("[data-bytes-text]")!;
  const hex = root.querySelector<HTMLTextAreaElement>("[data-bytes-hex]")!;
  const dump = root.querySelector<HTMLElement>("[data-bytes-dump]")!;
  const detail = root.querySelector<HTMLElement>("[data-bytes-detail]")!;
  const bytesOf = (): Uint8Array => new TextEncoder().encode(text.value);
  // pass #116 (He: "HexTool is this mess" — stale rows + ghosted ASCII for a 2-byte
  // input): swapping .source on a LIVE editor kept stale render state. The editor is
  // now RECREATED per load (a fresh element is deterministic), repaints are debounced
  // so typing doesn't thrash the canvas, and the buffer itself updates SYNCHRONOUSLY
  // (Apply edits can never race a pending repaint).
  let hexCore: typeof import("@hexcanvas/core") | null = null;
  let hexLoadTimer: ReturnType<typeof setTimeout> | null = null;
  // pass #146: the bytes the NEXT paint must show. paintEditor's own capture can be
  // stale — two in-flight imports (the open's paint + the first edit's paint) resolve
  // out of order, and the first buffer init used to win with its OPEN-TIME bytes (the
  // regression lock's single synthetic keystroke displayed "0 bytes" and stayed there
  // until the next one). The paint always rebuilds from the latest columns instead.
  let latestBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const paintEditor = (bytes: Uint8Array): void => {
    latestBytes = bytes;
    void Promise.all([import("@hexcanvas/element"), import("@hexcanvas/core")]).then(([el, core]) => {
      if (!dump.isConnected) return; // the panel closed while loading
      hexCore = core;
      hexBuffer = new core.MemoryBinaryBuffer(latestBytes.slice());
      const editor = document.createElement("hexcanvas-editor") as HexEditorElement;
      dump.textContent = "";
      dump.appendChild(editor);
      (editor as { source: unknown }).source = core.fromBinaryBuffer(hexBuffer);
      detail.textContent = t("tools.bytesCount", { n: String(hexBuffer.length) });
    }).catch(() => {
      detail.textContent = t("tools.bytesCount", { n: String(latestBytes.length) }) + " — hex editor unavailable";
    });
  };
  const loadEditor = (bytes: Uint8Array): void => {
    if (hexCore) hexBuffer = new hexCore.MemoryBinaryBuffer(bytes.slice());
    if (hexLoadTimer) clearTimeout(hexLoadTimer);
    if (hexCore) hexLoadTimer = setTimeout(() => paintEditor(bytes), 200);
    else paintEditor(bytes); // first load — nothing to debounce past
  };
  const syncFromText = (): void => {
    const bytes = bytesOf();
    hex.value = [...bytes].map(b => b.toString(16).padStart(2, "0")).join(" ");
    loadEditor(bytes);
  };
  const syncFromHex = (): void => {
    const cleaned = hex.value.replace(/0x/gi, " ").replace(/[^0-9a-fA-F\s]/g, " ");
    // pass #146 (He: "HOW THE FUCK COULD IT BE 2 BYTES WHILE ARE 3 INSTANCE OF [FF]?"):
    // a whitespace-separated token was treated as ONE whole byte — "ffffff" (three ff)
    // went through parseInt as 0xFFFFFF and the Uint8Array truncation kept the low
    // byte, so three ff became ONE FF (two lines of it: exactly the 2 bytes in his
    // dump). The hex column is a NIBBLE STREAM: every 2 hex chars are one byte, however
    // they are spaced; a trailing lone nibble is half a byte and is dropped.
    const nibbles = cleaned.replace(/\s+/g, "");
    const byteList: number[] = [];
    for (let i = 0; i + 1 < nibbles.length; i += 2) byteList.push(parseInt(nibbles.slice(i, i + 2), 16));
    const bytes = new Uint8Array(byteList);
    text.value = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    loadEditor(bytes);
  };
  // pass #146 (He: "make the separation happen automatically every 2 char"): the hex
  // column reformats ITSELF as you type — every 2 hex chars get a space, so "ffffff"
  // becomes "ff ff ff" on screen and can never read as one number again. Line breaks
  // are preserved (Enter stays a separator) and the caret rides its nibble offset
  // through the rewrite, so typing mid-text does not jump.
  const formatHex = (): void => {
    const el = hex;
    const caret = el.selectionStart ?? el.value.length;
    const nibbleCount = (s: string): number => s.replace(/[^0-9a-fA-F]/g, "").length;
    const target = nibbleCount(el.value.slice(0, caret));
    // the SAME stream the parser sees: 0x prefixes are stripped before grouping, or a
    // formatted "0 FF 00" would re-parse as the nibbles 0f f0 on the next keystroke
    el.value = el.value.split("\n").map(line =>
      line.replace(/0x/gi, " ").replace(/[^0-9a-fA-F]+/g, " ").trim().replace(/([0-9a-fA-F]{2})/g, "$1 ").replace(/ {2,}/g, " ").trimEnd().toLowerCase()
    ).join("\n");
    let seen = 0, pos = 0;
    const v = el.value;
    while (pos < v.length && seen < target) { if (/[0-9a-fA-F]/.test(v[pos])) seen++; pos++; }
    el.setSelectionRange(pos, pos);
  };
  const hexChanged = (): void => { syncFromHex(); formatHex(); };
  text.oninput = syncFromText;
  hex.oninput = hexChanged;
  syncFromText();
  root.querySelectorAll<HTMLButtonElement>("[data-conv]").forEach(b => b.onclick = () => {
    const kind = b.dataset.conv!;
    try {
      if (kind === "b64enc") text.value = btoa(String.fromCharCode(...new TextEncoder().encode(text.value)));
      else if (kind === "b64dec") text.value = new TextDecoder().decode(Uint8Array.from(atob(text.value.trim()), c => c.charCodeAt(0)));
      else if (kind === "urlenc") text.value = encodeURIComponent(text.value);
      else if (kind === "urldec") text.value = decodeURIComponent(text.value.replace(/\+/g, "%20"));
      else if (kind === "htmenc") text.value = [...text.value].map(ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? (ch.charCodeAt(0) > 127 ? `&#x${ch.codePointAt(0)!.toString(16)};` : ch))).join("");
      else if (kind === "htmdec") { const d = document.createElement("div"); d.innerHTML = text.value; text.value = d.textContent ?? ""; }
      else if (kind === "utf8hex") text.value = [...bytesOf()].map(x => x.toString(16).padStart(2, "0")).join(" ");
      else if (kind === "binstr") text.value = [...bytesOf()].map(x => x.toString(2).padStart(8, "0")).join(" ");
      else if (kind === "lower") { hex.value = hex.value.toLowerCase(); hexChanged(); return; }
      else if (kind === "applyhex") { // pass #114: the editor's edits flow back to the columns
        if (!hexBuffer) return;
        const bytes = hexBuffer.toUint8Array();
        hex.value = [...bytes].map(b => b.toString(16).padStart(2, "0")).join(" ");
        text.value = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        syncFromText();
        return;
      }
      syncFromText();
    } catch (e) { detail.textContent = e instanceof Error ? e.message : String(e); }
  });
}

// ---------- graph wiring (pass #111): Official-style integration — OUR compact column
// drives the vendored AGE React canvas (GraphCanvas + engine, MIT, c11b36ad, delcc
// palette + font-path patches, scoped stylesheet). React mounts lazily on first show.
function wireGraph(root: HTMLElement): () => void {
  const edges = root.querySelector<HTMLTextAreaElement>("[data-graph-edges]")!;
  const roots = root.querySelector<HTMLInputElement>("[data-graph-roots]")!;
  const relabel = root.querySelector<HTMLSelectElement>("[data-graph-relabel]")!;
  const stats = root.querySelector<HTMLElement>("[data-graph-stats]")!;
  const ageData = (): import("../vendor/age").AgeData => ({
    edgesText: edges.value,
    rootsText: roots.value, // pass #114: roots/isolated — tree layering depth-start
    labelOffset: parseInt(relabel.value, 10) || 0, // pass #114: displayed relabel
    directed: root.querySelector<HTMLInputElement>("[data-graph-directed]")?.checked ?? false,
    tree: root.querySelector<HTMLInputElement>("[data-graph-tree]")?.checked ?? false,
    lock: root.querySelector<HTMLInputElement>("[data-graph-lock]")?.checked ?? false,
    dark: document.documentElement.classList.contains("dark"),
  });
  const updateStats = (): void => {
    let maxId = 0, m = 0;
    for (const line of edges.value.split(/\n+/)) {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const u = parseInt(parts[0] ?? "", 10), v = parseInt(parts[1] ?? "", 10);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      m++;
      maxId = Math.max(maxId, u, v);
    }
    stats.textContent = t("tools.graphStats", { n: String(maxId), m: String(m) });
  };
  let mounted = false;
  // pass #130 (T2, He: "AGE just refused to load, out of the blue, no repro"): the mount
  // was a bare `void import(...).then(...)` — a failed chunk load or a throwing
  // mountAge/updateAge died as an UNHANDLED rejection the app never showed, which is
  // exactly why the refusal could happen with no report. INSTRUMENT FIRST (per the lane
  // note: no behavior change, no retries, no fallbacks — every failure path now (a) logs
  // to Settings → Logs with the stage and the error, (b) surfaces inline in the graph
  // box; a later successful push clears the inline error). The next occurrence reports
  // itself; the autopsy waits for that evidence.
  const ageFail = (stage: string, e: unknown): void => {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logError(`AGE ${stage} failed: ${msg}`);
    const errBox = root.querySelector<HTMLElement>("[data-age-error]");
    if (errBox) {
      errBox.hidden = false;
      errBox.textContent = `${t("tools.ageFail")} [${stage}] ${msg}`;
    }
  };
  const ageOk = (): void => {
    const errBox = root.querySelector<HTMLElement>("[data-age-error]");
    if (errBox) { errBox.hidden = true; errBox.textContent = ""; }
  };
  const push = (): void => {
    void import("../vendor/age").then((age) => {
      if (!mounted) {
        try {
          age.mountAge(root.querySelector<HTMLElement>("[data-graph-host]")!, ageData());
        } catch (e) { ageFail("mount", e); return; }
        mounted = true;
        ageOk();
        // pass #115: the first parse can race the panel layout — nodes get placed for a
        // stale canvas size, then clamped into the top-left corner (resetPos only
        // clamps, it never re-centers). One settled re-measure + re-parse places the
        // graph for the real box.
        window.dispatchEvent(new Event("resize"));
        setTimeout(() => { window.dispatchEvent(new Event("resize")); push(); }, 250);
      } else {
        try {
          age.updateAge(ageData());
        } catch (e) { ageFail("update", e); return; }
        ageOk();
      }
    }).catch((e) => ageFail("chunk-load", e));
  };
  root.querySelector<HTMLButtonElement>("[data-graph-draw]")!.onclick = () => { updateStats(); push(); };
  edges.onchange = () => { updateStats(); push(); };
  roots.onchange = push; // pass #114: roots/isolated change re-parses (tree depth-start)
  relabel.onchange = push; // pass #114: displayed relabel
  for (const box of ["[data-graph-directed]", "[data-graph-tree]", "[data-graph-lock]"]) {
    root.querySelector<HTMLInputElement>(box)!.onchange = push;
  }
  updateStats();
  return push; // the tab switch and the reopen path call this on first show
}

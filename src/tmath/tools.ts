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
import "./tools.css";

type Tab = "calc" | "bytes" | "graph";

let panel: HTMLElement | null = null;
let active: Tab = "calc";

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

// ---------- the panel ----------
export function openToolsPanel(): void {
  if (panel) { panel.classList.remove("minimized"); (panel as HTMLElement).style.display = ""; return; }
  panel = document.createElement("div");
  panel.className = "tm-tools-panel";
  panel.innerHTML = `<div class="tm-tools-head"><span class="tm-tools-grip" data-tools-drag>${esc(t("tools.title"))}</span><button type="button" class="tm-icon-button" data-tools-min aria-label="—">—</button><button type="button" class="tm-icon-button" data-tools-close aria-label="×">×</button></div>
<div class="tm-tools-tabs"><button type="button" class="tm-button" data-tab="calc">${esc(t("tools.tabCalc"))}</button><button type="button" class="tm-button" data-tab="bytes">${esc(t("tools.tabBytes"))}</button><button type="button" class="tm-button" data-tab="graph">${esc(t("tools.tabGraph"))}</button></div>
<div class="tm-tools-body" data-pane="calc">
  <div class="tm-tools-row"><input class="tm-tools-input" data-calc-expr spellcheck="false" placeholder="sin(pi/4) + 0xff &amp; 0b1010 | 3 &lt;&lt; 2"><select class="tm-drafts-select" data-calc-base><option value="dec">DEC</option><option value="hex">HEX</option><option value="oct">OCT</option><option value="bin">BIN</option></select><button type="button" class="tm-button" data-calc-angle>RAD</button></div>
  <div class="tm-tools-result" data-calc-out>—</div>
  <div class="tm-tools-sub"><b>f(x) =</b> <input class="tm-tools-input" data-calc-fn spellcheck="false" placeholder="x^2 · sin(x)"> <label class="tm-tools-inline">x min <input class="tm-tools-mini" data-calc-xmin value="-10"></label> <label class="tm-tools-inline">x max <input class="tm-tools-mini" data-calc-xmax value="10"></label> <button type="button" class="tm-button" data-calc-plot>${esc(t("tools.plot"))}</button></div>
  <canvas class="tm-tools-canvas" data-calc-canvas width="760" height="240" hidden></canvas>
  <div class="tm-tools-history" data-calc-hist></div>
</div>
<div class="tm-tools-body" data-pane="bytes" hidden>
  <div class="tm-tools-cols"><div class="tm-tools-col"><b>${esc(t("tools.text"))}</b><textarea class="tm-tools-area" data-bytes-text spellcheck="false"></textarea></div><div class="tm-tools-col"><b>${esc(t("tools.hex"))}</b><textarea class="tm-tools-area mono" data-bytes-hex spellcheck="false" placeholder="48 65 6c 6c 6f"></textarea></div></div>
  <div class="tm-tools-row wrap"><button type="button" class="tm-button" data-conv="b64enc">Base64 →</button><button type="button" class="tm-button" data-conv="b64dec">← Base64</button><button type="button" class="tm-button" data-conv="urlenc">URL →</button><button type="button" class="tm-button" data-conv="urldec">← URL</button><button type="button" class="tm-button" data-conv="htmenc">HTML →</button><button type="button" class="tm-button" data-conv="htmdec">← HTML</button><button type="button" class="tm-button" data-conv="utf8hex">UTF-8 hex →</button><button type="button" class="tm-button" data-conv="binstr">Binary →</button><button type="button" class="tm-button" data-conv="lower">hex →</button></div>
  <pre class="tm-tools-dump" data-bytes-dump></pre>
  <div class="tm-tools-result" data-bytes-detail>${esc(t("tools.clickByte"))}</div>
</div>
<div class="tm-tools-body" data-pane="graph" hidden>
  <div class="tm-tools-cols"><div class="tm-tools-col narrow"><b>${esc(t("tools.graphEdges"))}</b><textarea class="tm-tools-area mono" data-graph-edges spellcheck="false" placeholder="1 2 4&#10;2 3 2&#10;3 1 5">1 2 4
2 3 2
3 1 5</textarea><label class="tm-tools-inline"><input type="checkbox" data-graph-directed> ${esc(t("tools.graphDirected"))}</label><div class="tm-tools-row"><label class="tm-tools-inline">${esc(t("tools.graphStart"))} <input class="tm-tools-mini" data-graph-start value="1"></label><label class="tm-tools-inline">${esc(t("tools.graphEnd"))} <input class="tm-tools-mini" data-graph-end value="3"></label></div><button type="button" class="tm-button primary" data-graph-draw>${esc(t("tools.graphDraw"))}</button><div class="tm-tools-result" data-graph-stats></div></div><div class="tm-tools-col"><canvas class="tm-tools-canvas" data-graph-canvas width="560" height="420"></canvas></div></div>
</div>`;
  document.body.appendChild(panel);
  // drag by the header
  const head = panel.querySelector<HTMLElement>("[data-tools-drag]")!;
  head.onpointerdown = e => {
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
  panel.querySelector<HTMLElement>("[data-tools-close]")!.onclick = () => { panel?.remove(); panel = null; };
  panel.querySelector<HTMLElement>("[data-tools-min]")!.onclick = () => panel!.classList.toggle("minimized");
  panel.querySelectorAll<HTMLButtonElement>(".tm-tools-tabs [data-tab]").forEach(b => b.onclick = () => {
    active = b.dataset.tab as Tab;
    panel!.querySelectorAll<HTMLElement>(".tm-tools-tabs [data-tab]").forEach(x => x.classList.toggle("active", x === b));
    panel!.querySelectorAll<HTMLElement>(".tm-tools-body").forEach(p => { p.hidden = p.dataset.pane !== active; });
  });
  panel!.querySelector<HTMLElement>(`.tm-tools-tabs [data-tab="${active}"]`)!.classList.add("active");
  panel!.querySelectorAll<HTMLElement>(".tm-tools-body").forEach(p => { p.hidden = p.dataset.pane !== active; });
  wireCalc(panel!);
  wireBytes(panel!);
  wireGraph(panel!);
}

// ---------- calculator wiring ----------
const calcHistory: string[] = [];
function wireCalc(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("[data-calc-expr]")!;
  const fnInput = root.querySelector<HTMLInputElement>("[data-calc-fn]")!;
  const out = root.querySelector<HTMLElement>("[data-calc-out]")!;
  const base = root.querySelector<HTMLSelectElement>("[data-calc-base]")!;
  const angle = root.querySelector<HTMLButtonElement>("[data-calc-angle]")!;
  let deg = false;
  angle.onclick = () => { deg = !deg; angle.textContent = deg ? "DEG" : "RAD"; if (input.value.trim()) run(); };
  const run = (): void => {
    const v = input.value.trim();
    if (!v) { out.textContent = "—"; return; }
    try {
      const r = evalExpr(v, deg);
      const line = fmtNum(r, base.value);
      out.textContent = `= ${line}`;
      if (input.dataset.last !== v && Number.isFinite(r)) {
        input.dataset.last = v;
        calcHistory.unshift(`${v} = ${line}`);
        if (calcHistory.length > 30) calcHistory.pop();
        const hist = root.querySelector<HTMLElement>("[data-calc-hist]")!;
        hist.innerHTML = calcHistory.map(h => `<button type="button" class="tm-tools-hist">${esc(h)}</button>`).join("");
        hist.querySelectorAll<HTMLButtonElement>(".tm-tools-hist").forEach(b => b.onclick = () => { input.value = b.textContent!.split(" = ")[0] ?? ""; input.focus(); });
      }
    } catch (e) { out.textContent = e instanceof Error ? e.message : String(e); out.classList.add("tm-error"); return; }
    out.classList.remove("tm-error");
  };
  input.oninput = run;
  base.onchange = run;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-calc-canvas]")!;
  const plot = (): void => {
    const f = fnInput.value.trim();
    if (!f) { canvas.hidden = true; return; }
    canvas.hidden = false;
    const ctx = canvas.getContext("2d")!;
    const xmin = parseFloat(root.querySelector<HTMLInputElement>("[data-calc-xmin]")!.value) || -10;
    const xmax = parseFloat(root.querySelector<HTMLInputElement>("[data-calc-xmax]")!.value) || 10;
    if (!(xmax > xmin)) { out.textContent = "x max must be greater than x min"; return; }
    const N = 400, ys: number[] = [];
    let ymin = Infinity, ymax = -Infinity;
    for (let k = 0; k <= N; k++) {
      const x = xmin + (xmax - xmin) * k / N;
      let y: number;
      try { y = evalExpr(f, deg, x); } catch { y = NaN; }
      ys.push(y);
      if (Number.isFinite(y)) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    }
    if (!Number.isFinite(ymin)) { out.textContent = "f(x) produced no finite values on this range"; return; }
    if (ymax - ymin < 1e-9) { ymin -= 1; ymax += 1; }
    const pad = (ymax - ymin) * 0.08; ymin -= pad; ymax += pad;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const px = (x: number): number => (x - xmin) / (xmax - xmin) * W;
    const py = (y: number): number => H - (y - ymin) / (ymax - ymin) * H;
    ctx.strokeStyle = getComputedStyle(canvas).color || "#888";
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    for (let gx = Math.ceil(xmin); gx <= Math.floor(xmax); gx++) { ctx.moveTo(px(gx), 0); ctx.lineTo(px(gx), H); }
    for (let gy = Math.ceil(ymin); gy <= Math.floor(ymax); gy++) { ctx.moveTo(0, py(gy)); ctx.lineTo(W, py(gy)); }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue("--tmath-primary") || "#4ea1ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let pen = false;
    for (let k = 0; k <= N; k++) {
      const y = ys[k];
      if (!Number.isFinite(y) || y < ymin - (ymax - ymin) * 2 || y > ymax + (ymax - ymin) * 2) { pen = false; continue; }
      const X = px(xmin + (xmax - xmin) * k / N), Y = py(y);
      if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
    }
    ctx.stroke();
    ctx.fillStyle = getComputedStyle(canvas).color || "#888";
    ctx.font = "10px sans-serif";
    ctx.fillText(`x ∈ [${xmin}, ${xmax}]  y ∈ [${Math.round(ymin * 100) / 100}, ${Math.round(ymax * 100) / 100}]`, 6, 12);
  };
  root.querySelector<HTMLButtonElement>("[data-calc-plot]")!.onclick = plot;
  fnInput.onchange = plot;
}

// ---------- bytes & encodings wiring ----------
function wireBytes(root: HTMLElement): void {
  const text = root.querySelector<HTMLTextAreaElement>("[data-bytes-text]")!;
  const hex = root.querySelector<HTMLTextAreaElement>("[data-bytes-hex]")!;
  const dump = root.querySelector<HTMLElement>("[data-bytes-dump]")!;
  const detail = root.querySelector<HTMLElement>("[data-bytes-detail]")!;
  const bytesOf = (): Uint8Array => new TextEncoder().encode(text.value);
  const renderDump = (bytes: Uint8Array): void => {
    const rows: string[] = [];
    for (let o = 0; o < bytes.length; o += 16) {
      const slice = bytes.slice(o, o + 16);
      const hexPart = [...slice].map(b => `<span class="byte" data-b="${b}" data-o="${o}">${b.toString(16).padStart(2, "0")}</span>`).join(" ");
      const ascii = [...slice].map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("");
      rows.push(`<div class="row"><span class="off">${o.toString(16).padStart(6, "0")}</span>${hexPart}<span class="asc">${esc(ascii)}</span></div>`);
    }
    dump.innerHTML = rows.length ? rows.join("") : "—";
    dump.onclick = e => {
      const b0 = (e.target as HTMLElement).closest<HTMLElement>(".byte");
      if (!b0) return;
      const b = Number(b0.dataset.b), off = Number(b0.dataset.o);
      detail.textContent = t("tools.byteDetail", { off: String(off), hex: `0x${b.toString(16).padStart(2, "0")}`, dec: String(b), oct: `0o${b.toString(8)}`, bin: b.toString(2).padStart(8, "0"), ascii: b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·" });
    };
  };
  const syncFromText = (): void => {
    const bytes = bytesOf();
    hex.value = [...bytes].map(b => b.toString(16).padStart(2, "0")).join(" ");
    renderDump(bytes);
  };
  const syncFromHex = (): void => {
    const cleaned = hex.value.replace(/0x/gi, " ").replace(/[^0-9a-fA-F\s]/g, " ");
    const pairs = cleaned.split(/\s+/).filter(Boolean);
    if (pairs.length % 2 === 1) pairs.pop();
    const bytes = new Uint8Array(pairs.map(p => parseInt(p, 16)));
    text.value = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    renderDump(bytes);
  };
  text.oninput = syncFromText;
  hex.oninput = syncFromHex;
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
      else if (kind === "lower") { hex.value = hex.value.toLowerCase(); syncFromHex(); return; }
      syncFromText();
    } catch (e) { detail.textContent = e instanceof Error ? e.message : String(e); }
  });
}

// ---------- graph wiring ----------
function wireGraph(root: HTMLElement): void {
  const edges = root.querySelector<HTMLTextAreaElement>("[data-graph-edges]")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-graph-canvas]")!;
  const stats = root.querySelector<HTMLElement>("[data-graph-stats]")!;
  const draw = (): void => {
    const directed = root.querySelector<HTMLInputElement>("[data-graph-directed]")!.checked;
    const start = root.querySelector<HTMLInputElement>("[data-graph-start]")!.value.trim();
    const end = root.querySelector<HTMLInputElement>("[data-graph-end]")!.value.trim();
    const list: { u: number; v: number; w: number | null }[] = [];
    let maxId = 0;
    for (const line of edges.value.split(/\n+/)) {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const u = parseInt(parts[0] ?? "", 10), v = parseInt(parts[1] ?? "", 10);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const w = parts.length > 2 && Number.isFinite(parseFloat(parts[2]!)) ? parseFloat(parts[2]!) : null;
      list.push({ u, v, w });
      maxId = Math.max(maxId, u, v);
    }
    stats.textContent = t("tools.graphStats", { n: String(maxId), m: String(list.length) });
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!maxId) return;
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 40;
    const pos = new Map<number, { x: number; y: number }>();
    for (let v = 1; v <= maxId; v++) {
      const a = (v - 1) / maxId * Math.PI * 2 - Math.PI / 2;
      pos.set(v, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    }
    const fg = getComputedStyle(canvas).color || "#ccc";
    const accent = getComputedStyle(canvas).getPropertyValue("--tmath-primary")?.trim() || "#4ea1ff";
    const bad = "#f87171";
    ctx.lineWidth = 1.6;
    for (const { u, v, w } of list) {
      const p = pos.get(u)!, q = pos.get(v)!;
      if (!p || !q) continue;
      const isPath = (String(u) === start && String(v) === end) || (!directed && String(v) === start && String(u) === end);
      ctx.strokeStyle = isPath ? bad : fg;
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      if (directed) {
        const a = Math.atan2(q.y - p.y, q.x - p.x);
        const hx = q.x - Math.cos(a) * 14, hy = q.y - Math.sin(a) * 14;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(hx + Math.cos(a + Math.PI / 2.6) * 8, hy + Math.sin(a + Math.PI / 2.6) * 8);
        ctx.lineTo(hx + Math.cos(a - Math.PI / 2.6) * 8, hy + Math.sin(a - Math.PI / 2.6) * 8);
        ctx.closePath(); ctx.fillStyle = ctx.strokeStyle as string; ctx.fill();
      }
      if (w != null) {
        ctx.fillStyle = accent; ctx.font = "12px sans-serif";
        ctx.fillText(String(w), (p.x + q.x) / 2 + 6, (p.y + q.y) / 2 - 6);
      }
      ctx.globalAlpha = 1;
    }
    ctx.font = "12px sans-serif";
    for (const [v, p] of pos) {
      const isStart = String(v) === start, isEnd = String(v) === end;
      ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = isStart ? "#166534" : isEnd ? bad : getComputedStyle(canvas).backgroundColor || "#111";
      ctx.fill();
      ctx.strokeStyle = isStart || isEnd ? accent : fg; ctx.lineWidth = 1.8; ctx.stroke();
      ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(v), p.x, p.y);
    }
  };
  root.querySelector<HTMLButtonElement>("[data-graph-draw]")!.onclick = draw;
  edges.onchange = draw;
  draw();
}

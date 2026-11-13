// delcc-app/src/lib/debug-tip.ts
// pass #162: the Debug Mode's hover panel — the implementation side. The payloads
// ride a WeakMap (no attribute size limits, no escaping concerns for the display:
// the panel renders the JSON via textContent, so it is data, never markup). The
// hover pair is document-delegated and gates on the Debug Mode toggle LIVE.
export const debugStore = new WeakMap<Element, unknown>();

export function attachDebug(el: Element, obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;
  debugStore.set(el, obj);
  el.setAttribute("data-debug-hover", "");
}

let debugPanel: HTMLElement | null = null;
// pass #173b (He: "Shouldn't there be a way to pin the DebugMode tooltip statically
// to actually scroll it?"): the hover panel has pointer-events:none, so the wheel
// could never reach it and a mouse move away killed it. CLICK on a payload element
// now PINS the panel: it freezes where it is, gains pointer-events (scrollable with
// the wheel), survives hover changes, and unpins on Escape, on a click outside the
// payload element, or on clicking the same element again. The hover handlers defer
// to a pinned panel entirely except to re-pin onto a different payload element.
let pinnedFor: Element | null = null;
const panelSize = { w: 0, h: 0 };

function ensureDebugPanel(): HTMLElement {
  if (debugPanel) return debugPanel;
  debugPanel = document.createElement("div");
  debugPanel.className = "tm-debug-tip";
  // pass #165 (W12-L4): no role — a hover-only developer panel must not be a live
  // region (role=status announces every repaint); aria-hidden keeps it out of the tree.
  debugPanel.setAttribute("aria-hidden", "true");
  document.body.appendChild(debugPanel);
  return debugPanel;
}

function hideDebugPanel(): void {
  debugPanel?.remove();
  debugPanel = null;
  pinnedFor = null;
}

function setPinned(el: Element | null): void {
  if (!el) { hideDebugPanel(); return; }
  pinnedFor = el;
  const panel = ensureDebugPanel();
  const obj = debugStore.get(el);
  if (obj === undefined) { hideDebugPanel(); return; }
  panel.classList.add("tm-debug-tip-pinned");
  panel.style.pointerEvents = "auto";
  panel.textContent = JSON.stringify(sortKeys(obj), null, 2);
  panelSize.w = panel.offsetWidth;
  panelSize.h = panel.offsetHeight;
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) sorted[k] = sortKeys(v);
  return sorted;
}

let wired = false;

export function wireDebugHover(): void {
  if (wired) return;
  wired = true;
  document.addEventListener("mouseover", e => {
    if (!debugFieldsOnGate()) { hideDebugPanel(); return; }
    const el = (e.target as Element | null)?.closest?.("[data-debug-hover]");
    // pass #173b: a pinned panel ignores hover entirely — the click below unpins.
    if (pinnedFor) return;
    const obj = el ? debugStore.get(el) : undefined;
    if (obj === undefined) { hideDebugPanel(); return; }
    const panel = ensureDebugPanel();
    panel.textContent = JSON.stringify(sortKeys(obj), null, 2);
    // pass #165 (W12-L4): the size reads ONCE per show, not per mousemove (layout thrash)
    panelSize.w = panel.offsetWidth;
    panelSize.h = panel.offsetHeight;
  });
  // pass #173b: the pin toggle. Click on a payload element pins (or re-pins onto a
  // different one); clicking the SAME element again, any non-payload click, or
  // Escape unpins. The capture-phase keydown survives any focused element. Pinned
  // = pointer-events on (wheel-scrollable) + hover/move deferral above.
  document.addEventListener("click", e => {
    if (!debugFieldsOnGate()) return;
    const el = (e.target as Element | null)?.closest?.("[data-debug-hover]");
    if (el) {
      if (el === pinnedFor) hideDebugPanel();
      else setPinned(el);
      return;
    }
    if (pinnedFor) hideDebugPanel();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && pinnedFor) hideDebugPanel();
  }, true);
  document.addEventListener("mousemove", e => {
    if (!debugPanel || pinnedFor) return;
    const w = panelSize.w || debugPanel.offsetWidth, h = panelSize.h || debugPanel.offsetHeight;
    // pass #165 (W12-L4): the lower clamp — Math.min alone produced negative left/top
    // when the viewport was narrower than the panel (the panel flew off-screen).
    debugPanel.style.left = `${Math.max(0, Math.min(e.clientX + 18, window.innerWidth - w - 12))}px`;
    debugPanel.style.top = `${Math.max(0, Math.min(e.clientY + 14, window.innerHeight - h - 12))}px`;
  });
}

// the gate is injected (the preferences module owns the toggle state)
let gate: () => boolean = () => false;
export function setDebugGate(fn: () => boolean): void {
  gate = fn;
}
function debugFieldsOnGate(): boolean {
  return gate();
}

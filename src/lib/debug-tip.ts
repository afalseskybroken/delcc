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

function ensureDebugPanel(): HTMLElement {
  if (debugPanel) return debugPanel;
  debugPanel = document.createElement("div");
  debugPanel.className = "tm-debug-tip";
  debugPanel.setAttribute("role", "status");
  document.body.appendChild(debugPanel);
  return debugPanel;
}

function hideDebugPanel(): void {
  debugPanel?.remove();
  debugPanel = null;
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
    const obj = el ? debugStore.get(el) : undefined;
    if (obj === undefined) { hideDebugPanel(); return; }
    const panel = ensureDebugPanel();
    panel.textContent = JSON.stringify(sortKeys(obj), null, 2);
  });
  document.addEventListener("mousemove", e => {
    if (!debugPanel) return;
    const w = debugPanel.offsetWidth, h = debugPanel.offsetHeight;
    debugPanel.style.left = `${Math.min(e.clientX + 18, window.innerWidth - w - 12)}px`;
    debugPanel.style.top = `${Math.min(e.clientY + 14, window.innerHeight - h - 12)}px`;
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

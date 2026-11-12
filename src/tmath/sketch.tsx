// src/tmath/sketch.tsx — pass #112 (He: "Same for Excalidraw at this point"): the sketch
// tab mounts Excalidraw (MIT, 0.18.1) directly in the tools panel — the same component
// integration pattern the #111 AGE pass established (React is already in the tree).
// The scene persists locally (localStorage "delcc-sketch-scene", elements only, debounced,
// quota handled honestly); the theme follows delcc's scheme on every mount/update.
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
// pass #113 (He's screenshot: giant padlock + raw hint text): the component ships its
// own stylesheet — without it the whole UI renders unstyled at default sizes. The 0.18
// export resolves dev/prod automatically; everything is bundled local (CSP already
// allows 'self' styles and 'self data:' fonts — no new surface, nothing remote).
import "@excalidraw/excalidraw/index.css";

const SCENE_KEY = "delcc-sketch-scene";
let root: Root | null = null;
let hostEl: HTMLElement | null = null;

type Scene = { elements: readonly import("@excalidraw/excalidraw/element/types").ExcalidrawElement[] };

const loadScene = (): Scene | null => {
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    if (!raw) return null;
    // pass #144 (wave-8 W8-L12): preflight the raw bytes — a quota-sized or corrupt
    // scene value used to be JSON.parsed whole before anything rejected it.
    if (raw.length > 16 * 1024 * 1024) return null;
    const parsed = JSON.parse(raw) as Scene;
    return Array.isArray(parsed.elements) ? parsed : null;
  } catch {
    return null; // corrupt scene — start fresh, the raw bytes stay until the next save
  }
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleSave = (elements: readonly unknown[]): void => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SCENE_KEY, JSON.stringify({ elements }));
    } catch {
      // quota — the drawing stays usable in-session; saving resumes when space allows
      console.warn("delcc sketch: scene too large to save locally");
    }
  }, 500);
};

// pass #164 (wave-11 W11-L18): the font loader's last-resort fallback is the esm.sh
// CDN (verified in the installed chunk: ASSETS_FALLBACK_URL is pushed UNCONDITIONALLY
// after any configured asset paths). Pointing EXCALIDRAW_ASSET_PATH at the app's OWN
// same-origin copy (public/excalidraw/fonts — the five core families, 0.3 MB) makes
// the shipped fonts load from 'self' (CSP font-src 'self' data:) and keeps the CDN
// unreachable in the shipped app (the CSP refuses it — the miss falls to system
// fonts). Browser-dev (no CSP) may still fetch the CDN for the SKIPPED families
// (Xiaolai CJK / Virgil / Lilita — 13 MB+ of subsets not worth shipping): disclosed
// in SECURITY.md, dev-only.
if (typeof (window as { EXCALIDRAW_ASSET_PATH?: unknown }).EXCALIDRAW_ASSET_PATH !== "string") {
  (window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
    new URL("excalidraw/", document.baseURI).href;
}

async function render(dark: boolean): Promise<void> {
  if (!root || !hostEl) return;
  const { Excalidraw } = await import("@excalidraw/excalidraw");
  const saved = loadScene();
  root.render(
    createElement(Excalidraw, {
      theme: dark ? "dark" : "light",
      initialData: saved ? { elements: saved.elements } : undefined,
      onChange: (elements: readonly import("@excalidraw/excalidraw/element/types").ExcalidrawElement[]) => scheduleSave(elements),
      gridModeEnabled: false,
    }),
  );
}

export async function mountSketch(host: HTMLElement, dark: boolean): Promise<void> {
  hostEl = host;
  if (!root) root = createRoot(host);
  await render(dark);
}

export async function updateSketchTheme(dark: boolean): Promise<void> {
  if (root && hostEl) await render(dark);
}

export function unmountSketch(): void {
  root?.unmount();
  root = null;
  hostEl = null;
}

// src/tmath/sketch.tsx — pass #112 (He: "Same for Excalidraw at this point"): the sketch
// tab mounts Excalidraw (MIT, 0.18.1) directly in the tools panel — the same component
// integration pattern the #111 AGE pass established (React is already in the tree).
// The scene persists locally (localStorage "delcc-sketch-scene", elements only, debounced,
// quota handled honestly); the theme follows delcc's scheme on every mount/update.
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";

const SCENE_KEY = "delcc-sketch-scene";
let root: Root | null = null;
let hostEl: HTMLElement | null = null;

type Scene = { elements: readonly import("@excalidraw/excalidraw/element/types").ExcalidrawElement[] };

const loadScene = (): Scene | null => {
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    if (!raw) return null;
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

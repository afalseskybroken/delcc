// src/vendor/age/embed.tsx — pass #111: the bridge between delcc's tools panel and AGE's
// React components (He: "rip how Official integrate AGE and rewrite it based on that" —
// Official renders the editor's components in their own compact panel instead of iframing
// the whole app; this is delcc's version of that). GraphCanvas + its engine are AGE's
// (MIT, vendored at c11b36ad with the delcc palette + font-path patches); the compact
// control column around it is ours. This file is excluded from tsc (upstream typing
// friction) — vite transpiles it; the delcc side talks to it through age-embed.d.ts.
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { GraphCanvas } from "./components/GraphCanvas";
import { parseGraphInputEdges } from "./components/parseGraphInput";
import { getDefaultGraph } from "./components/utils";
import type { Settings, TestCases } from "./types";

export interface AgeData {
  edgesText: string;
  directed: boolean;
  tree: boolean;
  lock: boolean;
  physics: boolean;
  dark: boolean;
}

function defaults(dark: boolean): Settings {
  // upstream defaults (App.tsx) minus the localStorage reads — delcc drives what it drives
  return {
    language: "en",
    drawMode: "node",
    expandedCanvas: false,
    markBorder: "double",
    markColor: 1,
    settingsFormat: "modes",
    labelOffset: 0,
    darkMode: dark,
    nodeRadius: 21,
    fontSize: 15,
    nodeBorderWidthHalf: 1,
    edgeBorderWidthHalf: 1,
    edgeLength: 80,
    edgeLabelSeparation: 14,
    penThickness: 1,
    penTransparency: 0,
    eraserRadius: 10,
    tension: 1.6,
    nodeRepulsion: 0.24,
    testCaseBoundingBoxes: true,
    showComponents: false,
    showEBCC: false,
    showVBCC: false,
    showBridges: false,
    showMSTs: false,
    treeMode: false,
    bipartiteMode: false,
    gridMode: false,
    lockMode: false,
    markedNodes: false,
    fixedMode: false,
    multiedgeMode: true,
    edgePhysics: true,
  };
}

function buildTestCases(edgesText: string): TestCases {
  const parsed = parseGraphInputEdges("", edgesText, "", 1);
  const m: TestCases = new Map();
  m.set(1, {
    graphEdges: parsed.graph ?? getDefaultGraph(),
    graphParChild: getDefaultGraph(),
    inputFormat: "edges",
  });
  return m;
}

function AgeCanvas(props: {
  cases: TestCases;
  directed: boolean;
  dark: boolean;
  tree: boolean;
  lock: boolean;
  physics: boolean;
}) {
  const [settings] = useState<Settings>(() => ({
    ...defaults(props.dark),
    treeMode: props.tree,
    lockMode: props.lock,
    edgePhysics: props.physics,
  }));
  // our checkboxes are authoritative on every bridge re-render
  settings.treeMode = props.tree;
  settings.lockMode = props.lock;
  settings.edgePhysics = props.physics;
  settings.darkMode = props.dark;
  return (
    <GraphCanvas testCases={props.cases} directed={props.directed} settings={settings} setSettings={() => { /* the embed keeps panel-owned settings authoritative */ }} />
  );
}

let root: Root | null = null;
let hostEl: HTMLElement | null = null;

function render(data: AgeData): void {
  if (!root || !hostEl) return;
  const cases = buildTestCases(data.edgesText);
  root.render(
    <div className={`tm-age-scope ${data.dark ? "dark" : "light"} bg-ovr text-text w-full h-full overflow-hidden no-scrollbar`}>
      <AgeCanvas
        cases={cases}
        directed={data.directed}
        dark={data.dark}
        tree={data.tree}
        lock={data.lock}
        physics={data.physics}
      />
    </div>,
  );
}

export function mountAge(host: HTMLElement, data: AgeData): void {
  hostEl = host;
  if (!root) root = createRoot(host);
  render(data);
}

export function updateAge(data: AgeData): void {
  if (root) render(data);
}

export function unmountAge(): void {
  root?.unmount();
  root = null;
  hostEl = null;
}

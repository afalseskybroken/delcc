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
  rootsText: string; // pass #114: roots + isolated vertices — tree layering starts here
  labelOffset: number; // pass #114: displayed relabel (Official's Đổi nhãn số)
  directed: boolean;
  tree: boolean;
  lock: boolean;
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

function buildTestCases(rootsText: string, edgesText: string): TestCases {
  // roots/isolated vertices come in as arg 1 (pass #114) — they land FIRST in the node
  // set, which is what the tree layering uses as its depth-start (Official's
  // "Đỉnh gốc / đỉnh rời" semantics)
  const parsed = parseGraphInputEdges(rootsText, edgesText, "", 1);
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
  labelOffset: number;
}) {
  const [settings] = useState<Settings>(() => ({
    ...defaults(props.dark),
    treeMode: props.tree,
    lockMode: props.lock,
  }));
  // our checkboxes are authoritative on every bridge re-render
  settings.treeMode = props.tree;
  settings.lockMode = props.lock;
  settings.darkMode = props.dark;
  settings.labelOffset = props.labelOffset; // pass #114: the relabel combobox
  // pass #115: the edge-physics toggle is GONE from the panel — AGE's physics only
  // bends parallel edges (indices 2–9), inert for plain graphs, so exposing it was a
  // stub. edgePhysics stays at AGE's upstream default (true).
  return (
    <GraphCanvas testCases={props.cases} directed={props.directed} settings={settings} setSettings={() => { /* the embed keeps panel-owned settings authoritative */ }} />
  );
}

let root: Root | null = null;
let hostEl: HTMLElement | null = null;

function render(data: AgeData): void {
  if (!root || !hostEl) return;
  const cases = buildTestCases(data.rootsText, data.edgesText);
  root.render(
    <div className={`tm-age-scope ${data.dark ? "dark" : "light"} bg-ovr text-text w-full h-full overflow-hidden no-scrollbar`}>
      <AgeCanvas
        cases={cases}
        directed={data.directed}
        dark={data.dark}
        tree={data.tree}
        lock={data.lock}
        labelOffset={data.labelOffset}
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

export { resetGraphView, getGraphView, zoomGraphView, panGraphView } from "./components/animateGraph";

export function unmountAge(): void {
  root?.unmount();
  root = null;
  hostEl = null;
}

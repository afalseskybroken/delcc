import { ParsedGraph } from "../types";
import { padNode, sortNodes } from "./utils";

/* function isConvertibleToNum(s: string): boolean {
  for (const c of s) {
    if (!(c >= "0" && c <= "9")) {
      return false;
    }
  }
  return true;
} */

interface LeetcodeParsed {
  status: "ok" | "bad";
  edges: Array<string[]>;
}

function parseLeetcodeStyle(s: string): LeetcodeParsed {
  if (s.length >= 4 && s[0] === "[" && s[1] === "[") {
    if (s[s.length - 1] === "]" && s[s.length - 2] === "]") {
      return {
        status: "ok",
        edges: s
          .substring(2, s.length - 2)
          .split("],[")
          .map((t) => t.split(",")),
      };
    }
  }
  return {
    status: "bad",
    edges: [],
  };
}

export function parseGraphInputParentChild(
  roots: string,
  parent: string,
  child: string,
  labels: string,
  nodeLabels: string,
  testCaseNumber: number,
): ParsedGraph {
  const p = parent
    .trim()
    .split(/\s+/)
    .filter((u) => u.length);

  const c = child
    .trim()
    .split(/\s+/)
    .filter((u) => u.length);

  const l = labels
    .trim()
    .split(/\s+/)
    .filter((u) => u.length);

  const nl = nodeLabels
    .trim()
    .split(/\s+/)
    .filter((u) => u.length);

  const edgeCnt = Math.min(p.length, c.length);

  // pass #141 (wave-8 W8-L07): nodeSeen replaces the O(n) `nodes.includes` scans; the
  // adjacency/reverse appends push in place — the whole-array spreads copied the
  // accumulated list on every edge. Order and (non-)dedup semantics unchanged.
  const nodeSeen = new Set<string>();
  let nodes = new Array<string>();
  let adj = new Map<string, string[]>();
  let rev = new Map<string, string[]>();
  let edgeToPos = new Map<string, number>();
  let edges = new Array<string>();
  let edgeLabels = new Map<string, string>();

  roots
    .trim()
    .split(/\s+/)
    .map((u) => {
      const pu = padNode(u, testCaseNumber, "parentChild");
      if (u.length && !nodeSeen.has(pu)) {
        nodeSeen.add(pu);
        nodes.push(pu);
        adj.set(pu, []);
      }
    });

  for (let i = 0; i < edgeCnt; i++) {
    const pi = padNode(p[i], testCaseNumber, "parentChild");
    const ci = padNode(c[i], testCaseNumber, "parentChild");
    if (pi === ci && !nodeSeen.has(pi)) {
      nodeSeen.add(pi);
      nodes.push(pi);
      adj.set(pi, []);
    } else {
      if (!nodeSeen.has(pi)) {
        nodeSeen.add(pi);
        nodes.push(pi);
        adj.set(pi, [ci]);
      } else {
        adj.get(pi)!.push(ci);
      }

      if (!nodeSeen.has(ci)) {
        nodeSeen.add(ci);
        nodes.push(ci);
        adj.set(ci, []);
      }

      let edgeBase = "";

      if (pi <= ci) {
        edgeBase = [pi, ci].join(" ");
      } else {
        edgeBase = [ci, pi].join(" ");
      }

      if (edgeToPos.get(edgeBase) === undefined) {
        edgeToPos.set(edgeBase, 0);
      } else {
        edgeToPos.set(edgeBase, edgeToPos.get(edgeBase)! + 1);
      }

      edges.push([pi, ci, edgeToPos.get(edgeBase)].join(" "));

      if (i < l.length) {
        edgeLabels.set([pi, ci, edgeToPos.get(edgeBase)].join(" "), l[i]);
      }
    }
  }

  for (const [u, vs] of adj.entries()) {
    if (!rev.has(u)) {
      rev.set(u, []);
    }
    for (const v of vs) {
      // pass #141 (W8-L07): push in place — the spread copied the accumulated list per edge
      if (rev.has(v)) {
        rev.get(v)!.push(u);
      } else {
        rev.set(v, [u]);
      }
    }
  }

  const sortedNodes = sortNodes(nodes, false);

  const len = Math.min(sortedNodes.length, nl.length);

  let mp = new Map<string, string>();

  for (let i = 0; i < len; i++) {
    if (nl[i] !== "_") {
      mp.set(sortedNodes[i], nl[i]);
    }
  }

  return {
    status: "OK",
    graph: {
      nodes,
      adj,
      rev,
      edges,
      edgeLabels,
      nodeLabels: mp,
    },
  };
}

export function parseGraphInputEdges(
  roots: string,
  input: string,
  nodeLabels: string,
  testCaseNumber: number,
): ParsedGraph {
  const leetcodes = new Array<string[]>();

  const raw = input
    .split("\n")
    .map((s) => {
      const sTrimmed = s.trim().split(/\s+/);
      const leet = parseLeetcodeStyle(sTrimmed[0]);
      if (sTrimmed.length == 1 && leet.status === "ok") {
        for (const l of leet.edges) {
          leetcodes.push(l);
        }
        return [""];
      }
      return sTrimmed;
    })
    .filter((nodes) => nodes[0].length);

  for (const s of leetcodes) {
    if (s[0].length) {
      raw.push(s);
    }
  }

  let nodes = new Array<string>();
  // pass #141 (wave-8 W8-L07): membership Sets ride beside the ordered arrays —
  // `nodes.includes()` and per-edge adjacency `includes()` + whole-array spreads were
  // O(n²)/O(n·deg) on large graphs (each edge rescanned/copied the accumulated data).
  // The Map/Set shapes the rest of the parser consumes are unchanged.
  const nodeSeen = new Set<string>();
  const adjSeen = new Map<string, Set<string>>();
  const adj = new Map<string, string[]>();
  let rev = new Map<string, string[]>();
  let edgeToPos = new Map<string, number>();
  let edges = new Array<string>();
  let edgeLabels = new Map<string, string>();

  roots
    .trim()
    .split(/\s+/)
    .map((u) => {
      const pu = padNode(u, testCaseNumber, "edges");
      if (u.length && !nodeSeen.has(pu)) {
        nodeSeen.add(pu);
        nodes.push(pu);
        adjSeen.set(pu, new Set());
        adj.set(pu, []);
      }
    });

  for (const e of raw) {
    if (e.length == 1) {
      const pu = padNode(e[0], testCaseNumber, "edges");
      if (!nodeSeen.has(pu)) {
        nodeSeen.add(pu);
        nodes.push(pu);
        adjSeen.set(pu, new Set());
        adj.set(pu, []);
      }
    } else if (e.length <= 3) {
      const pu = padNode(e[0], testCaseNumber, "edges");
      const pv = padNode(e[1], testCaseNumber, "edges");
      if (pu === pv && !nodeSeen.has(pu)) {
        nodeSeen.add(pu);
        nodes.push(pu);
        adjSeen.set(pu, new Set());
        adj.set(pu, []);
      } else {
        if (!nodeSeen.has(pu)) {
          nodeSeen.add(pu);
          nodes.push(pu);
          adjSeen.set(pu, new Set([pv]));
          adj.set(pu, [pv]);
        } else if (!adjSeen.get(pu)!.has(pv)) {
          adjSeen.get(pu)!.add(pv);
          adj.get(pu)!.push(pv);
        }

        if (!nodeSeen.has(pv)) {
          nodeSeen.add(pv);
          nodes.push(pv);
          adjSeen.set(pv, new Set());
          adj.set(pv, []);
        }

        let edgeBase = "";

        if (pu <= pv) {
          edgeBase = [pu, pv].join(" ");
        } else {
          edgeBase = [pv, pu].join(" ");
        }

        if (edgeToPos.get(edgeBase) === undefined) {
          edgeToPos.set(edgeBase, 0);
        } else {
          edgeToPos.set(edgeBase, edgeToPos.get(edgeBase)! + 1);
        }

        edges.push([pu, pv, edgeToPos.get(edgeBase)].join(" "));

        if (e.length === 3) {
          edgeLabels.set([pu, pv, edgeToPos.get(edgeBase)].join(" "), e[2]);
        }
      }
    } else {
      return {
        status: "BAD",
      };
    }
  }

  for (const [u, vs] of adj.entries()) {
    if (!rev.has(u)) {
      rev.set(u, []);
    }
    for (const v of vs) {
      // pass #141 (W8-L07): push in place — the spread copied the accumulated list per edge
      if (rev.has(v)) {
        rev.get(v)!.push(u);
      } else {
        rev.set(v, [u]);
      }
    }
  }

  const sortedNodes = sortNodes(nodes, false);

  const nl = nodeLabels
    .trim()
    .split(/\s+/)
    .filter((u) => u.length);

  const len = Math.min(sortedNodes.length, nl.length);

  let mp = new Map<string, string>();

  for (let i = 0; i < len; i++) {
    if (nl[i] !== "_") {
      mp.set(sortedNodes[i], nl[i]);
    }
  }

  return {
    status: "OK",
    graph: {
      nodes,
      adj,
      rev,
      edges,
      edgeLabels,
      nodeLabels: mp,
    },
  };
}

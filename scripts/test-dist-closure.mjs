// delcc-app/scripts/test-dist-closure.mjs
// pass #175 (wave-13 Low): the slim plugin (vite.config.ts) deletes dist files at
// build time; the browser suites run against the DEV server, so a regex mistake
// there would ship an unreachable-asset regression untested. This gate walks the
// BUILT bundle: every /assets/... reference in index.html and in every emitted
// .js/.css must resolve to a file on disk, every relative chunk reference
// (./x.js, ../y/z.js — Monaco's language chunks are referenced ONLY this way)
// must resolve against the referencing file's directory, and the KaTeX CSS must carry no
// woff/ttf font references (the woff2-only rewrite held) and no Excalidraw locale
// chunk outside delcc's three languages may exist. Exit 0 = closure holds.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (!existsSync(root)) {
  console.error("dist-closure: dist/ missing — run the build first");
  process.exit(1);
}

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(root);

const rel = new Set(files.map((f) => f.slice(root.length + 1).replace(/\\/g, "/")));
const referenced = new Set();
let checked = 0;
for (const f of files) {
  if (!/\.(html|js|css)$/.test(f)) continue;
  const text = readFileSync(f, "utf8");
  checked++;
  for (const m of text.matchAll(/(?:from\s*["']|import\s*\(\s*["']|["'\(])(\.?\/ ?)?(assets\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g)) {
    referenced.add(m[2]);
  }
  // pass #176 (wave-14 P2): relative chunk refs — Monaco's language chunks are
  // referenced only as "./x.js", which the /assets/ pass never sees. Resolve
  // each against the referencing file's directory; a ref escaping dist/ is not
  // a dist-closure concern and is skipped.
  for (const m of text.matchAll(/["'](\.{1,2}\/[A-Za-z0-9._/-]+\.(?:js|css|wasm|json))["']/g)) {
    const rrp = join(dirname(f), m[1]).slice(root.length + 1).replace(/\\/g, "/");
    if (!rrp.startsWith("..")) referenced.add(rrp);
  }
}
let missing = [];
let slimDead = 0;
// pass #176: absence is judged against the slim's own contract, not blanket-failed.
// (a) Excalidraw's locale map KEYS ("./locales/xx-YY.json" inside percentages-*.js)
//     are names, never emitted files — dead branches for every language, by design.
// (b) Excalidraw locale CHUNKS outside the kept languages are deleted by the slim
//     (the vite.config.ts rule, mirrored verbatim; the KEEP set is read from there
//     so the two cannot drift). A kept-language chunk that is absent IS a failure.
// (c) everything else absent = broken.
let keep = new Set(["en", "vi-VN", "zh-CN"]);
try {
  const km = /KEEP_EXCALIDRAW_LOCALES\s*=\s*new Set\(\[([^\]]+)\]\)/.exec(readFileSync(join(root, "..", "vite.config.ts"), "utf8"));
  if (km) keep = new Set(km[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
} catch { /* standalone dist — the default stands */ }
const chunkRule = /^assets\/([a-z]{2}(?:-[A-Z]{2})?)-[A-Z0-9]{8}-[A-Za-z0-9_-]+\.js$/;
for (const r of referenced) {
  if (rel.has(r)) continue;
  // every ./locales/*.json ref is an Excalidraw map KEY, never an emitted file
  // (the set includes non-locale names like percentages.json)
  if (/^assets\/locales\/[A-Za-z0-9_-]+\.json$/.test(r)) { slimDead++; continue; }
  const cm = chunkRule.exec(r);
  if (cm && !keep.has(cm[1])) { slimDead++; continue; }
  missing.push(r);
}
// the slim invariants
const katexCss = files.filter((f) => /katex.*\.css$/.test(f));
const badFontRefs = [];
for (const f of katexCss) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/url\(([^)]*\.(?:woff|ttf))\)/g)) badFontRefs.push(`${f.slice(root.length + 1)}: ${m[1]}`);
}
const strayLocales = files.filter((f) => /assets\/[a-z]{2}(-[A-Z]{2})?-[A-Z0-9]{8}-/.test(f) && !/\/(en|vi-VN|zh-CN)-[A-Z0-9]{8}-/.test(f));

if (missing.length || badFontRefs.length || strayLocales.length) {
  console.error("dist-closure FAILED:");
  if (missing.length) console.error("  referenced but absent:", missing.slice(0, 12), missing.length > 12 ? `(+${missing.length - 12} more)` : "");
  if (badFontRefs.length) console.error("  katex css woff/ttf refs:", badFontRefs.slice(0, 6));
  if (strayLocales.length) console.error("  stray locale chunks:", strayLocales.slice(0, 6));
  process.exit(1);
}
console.log(`dist-closure: ${checked} built files scanned, ${referenced.size} asset references (${slimDead} slim-dead locale refs, by design), all live refs resolve; slim invariants hold (woff2-only katex, 3 locales)`);

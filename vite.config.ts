import { defineConfig, type Plugin } from "vite";

// pass #171 (He: "slimming down delcc"): the dist ships bytes the shipped webview can
// never reach. Two dead-weight classes, both removed AT BUILD TIME (not post-hoc file
// surgery) so every future build stays consistent:
//
// 1. KaTeX font fallbacks. katex.min.css declares @font-face with
//    woff2/woff/ttf sources; WebView2 is Chromium and always picks woff2 (first in
//    every src list), so the woff and ttf copies (~956 KB across 41 files) are
//    unreachable in the shipped app AND in browser-dev (the same engine). The plugin
//    rewrites every built CSS asset's KaTeX @font-face src to woff2-only and drops
//    the .woff/.ttf emissions. The files stay in node_modules — nothing upstream
//    changes, nothing is patched in place.
//
// 2. Excalidraw locales beyond delcc's own language surface (en, vi-VN, zh-CN).
//    @excalidraw/excalidraw emits 51 locale chunks (~1.0 MB); its loader
//    (dist/prod/index.js, the translation bootstrap) try/catches the dynamic import
//    and falls back to the English strings on failure — verified, so a dropped
//    locale degrades to English inside the sketch tab, it cannot crash. delcc's UI
//    ships exactly three languages; the sketch's internal picker offering 51 is not
//    a promised surface. The picker itself still lists every language (the labels
//    are inline); picking a dropped one logs a console error and renders English.
//    Disclosed in SECURITY.md (pass #171 note).
//
// The plugin reports the bytes it removed so the gate log carries the number.
const KEEP_EXCALIDRAW_LOCALES = new Set(["en", "vi-VN", "zh-CN"]);

function slimDelccDist(): Plugin {
  let katexFontBytes = 0;
  let katexFontsRemoved = 0;
  let localeBytes = 0;
  let localesRemoved = 0;
  let cssRewritten = 0;
  return {
    name: "delcc-slim-dist",
    generateBundle(_opts, bundle) {
      // 1a. rewrite every KaTeX @font-face in the built CSS to woff2-only
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !(file.fileName.endsWith(".css"))) continue;
        let css = String(file.source);
        if (!css.includes("KaTeX_")) continue;
        // the katex src list shape: url(fonts/KaTeX_X.woff2) format("woff2"),url(...woff) format("woff"),url(...ttf) format("truetype")
        // (KaTeX_Size3 carries a data:-URL woff2 first — the second pass strips those tails too)
        let out = css.replace(
          /url\(([^)]+\.woff2)\)\s*format\("woff2"\),url\(([^)]+\.woff)\)\s*format\("woff"\),url\(([^)]+\.ttf)\)\s*format\("truetype"\)/g,
          (_m, woff2: string) => `url(${woff2}) format("woff2")`,
        );
        out = out.replace(/,url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, "");
        if (out !== css) {
          css = out;
          cssRewritten++;
          file.source = css;
        }
      }
      // 1b. drop the woff/ttf emissions (KaTeX's are the only ones with that shape)
      for (const name of Object.keys(bundle)) {
        if (/KaTeX_.*\.(woff|ttf)$/.test(name)) {
          katexFontBytes += bundle[name].type === "asset" ? (bundle[name].source as Uint8Array).byteLength : 0;
          katexFontsRemoved++;
          delete bundle[name];
        }
      }
      // 2. drop the Excalidraw locale chunks outside delcc's language surface
      for (const name of Object.keys(bundle)) {
        const m = /^assets\/([a-z]{2}(?:-[A-Z]{2})?)-[A-Z0-9]{8}-[A-Za-z0-9_-]+\.js$/.exec(name);
        if (!m) continue;
        if (KEEP_EXCALIDRAW_LOCALES.has(m[1])) continue;
        const f = bundle[name];
        localeBytes += f.type === "asset" || f.type === "chunk" ? f.code.length : 0;
        localesRemoved++;
        delete bundle[name];
      }
    },
    buildEnd() {
      if (katexFontsRemoved || localesRemoved) {
        this.info(
          `delcc-slim-dist: katex fonts removed ${katexFontsRemoved} (${(katexFontBytes / 1024).toFixed(0)} KiB), ` +
          `excalidraw locales removed ${localesRemoved} (${(localeBytes / 1024).toFixed(0)} KiB), ` +
          `css @font-face rewritten in ${cssRewritten} asset(s)`,
        );
      }
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [slimDelccDist()],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 4000, // bundled Monaco is ~3 MB, loaded lazily on first problem open
    target: "es2021",
  },
});

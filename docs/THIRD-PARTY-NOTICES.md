# Third-party notices

delcc ships no official TMath code or assets. It does bundle third-party
open-source libraries, credited here with their licenses.

## The tools panel

- **[Another Graph Editor](https://github.com/anAcc22/another_graph_editor)**
  (MIT) — the graph tab. Since pass #111 AGE is vendored as SOURCE under
  `src/vendor/age/` (upstream commit `c11b36ad704b71831a70ccea43af5f52ff9a62f5`,
  2026-05-27) and transpiled by vite directly — the React components render
  inside delcc's tools panel, no iframe. **A source patch we maintain** —
  [`patches/age-c11b36ad.patch`](../patches/age-c11b36ad.patch) — remaps both
  AGE themes (tailwindcss-themer values, per-key: the neutral surfaces only)
  to delcc's own tokens from `src/lib/scheme.ts` and points the font paths at
  `/age/`, so the embedded editor's chrome matches delcc in light and dark by
  construction — He's pass-#110 ruling: we hold the source, so we change the
  palette there instead of shimming at runtime. The scoped stylesheet
  `src/vendor/age/age.css` is the build artifact of that patched source with
  every selector prefixed `.tm-age-scope`; it carries a clearly-marked delcc
  appendix (pass #113) that overrides upstream's standalone layout — the canvas
  wrapper fills the panel pane instead of floating at half-viewport size, and
  the JetBrainsMono `@font-face` URLs point at the bundled `/age/` fonts.
  The vendoring recipe: clone upstream, `git checkout c11b36ad`, apply the
  patch, build, scope the emitted CSS, copy the font files to `public/age/`,
  and neuter the service-worker registration — the SW file is not shipped;
  Tauri's custom protocol is not a SW host. The same app the official client's
  graph tool embeds — the offline contract holds: everything runs inside the
  panel, nothing is fetched. **Also modified in-tree beyond the recorded patch**
  (pass #142, wave-8 W8-L07 + W8-11 — MIT-compatible delcc changes): the graph
  input parsers ride Set membership + in-place pushes instead of O(n²) scans
  (`parseGraphInput.ts`, both parsers, order and dedup semantics unchanged), and
  `animateGraph`/`GraphCanvas` gained a cancellation return so the 90 FPS render
  loop and its window keydown listener stop on unmount; the patch file is due a
  regeneration to fold these hunks in (queued).
- **[Excalidraw](https://github.com/excalidraw/excalidraw)** (MIT, 0.18.1) — the
  sketch tab (Vẽ nháp), the same library the official client's sketch tool loads.
  Rendered as a React component inside the tools panel (lazy chunk) together
  with its own stylesheet (`@excalidraw/excalidraw/index.css`, pass #113 — the
  component ships its styles, and without the import it renders unstyled),
  fonts served from the bundle — no CDN. The scene persists locally in
  delcc-sketch-scene (localStorage, elements only, debounced).
- The official client's graph tool loads this same editor by name
  ("Đang mở Another Graph Editor…"); its sketch tab loads Excalidraw
  (also MIT) — delcc's sketch tab runs on that same basis.
- **[@hexcanvas/core + @hexcanvas/element](https://github.com/htcom-code/hexcanvas)**
  (MIT, 0.2.0) — the Bytes & encodings tab's hex view (pass #114). He's ruling:
  a hex editor is a wheel we should not reinvent — this is a framework-free
  `<hexcanvas-editor>` web component (canvas renderer, cursor, selection,
  overwrite/insert editing, undo, search; zero runtime dependencies) used
  unmodified, loaded lazily so it stays out of the main chunk. delcc only
  themes it through the documented `--hexcanvas-*` custom properties and feeds
  it a `MemoryBinaryBuffer`; the "Apply edits" button is delcc's own glue.

Everything else in delcc's frontend is first-party. The other bundled runtime
dependencies (DOMPurify, KaTeX, Monaco, Tauri's JS API) are used unmodified per
their own licenses (Apache-2.0 / MIT / MIT / MIT) and are declared in
`package.json`.

MIT License (applies to Another Graph Editor):

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

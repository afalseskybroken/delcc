# Third-party notices

delcc ships no official TMath code or assets. It does bundle third-party
open-source libraries, credited here with their licenses.

## The tools panel

- **[Another Graph Editor](https://github.com/anAcc22/another_graph_editor)**
  (MIT) — the graph tab. Vendored as a built artifact under `public/age/`
  from upstream commit `c11b36ad704b71831a70ccea43af5f52ff9a62f5` (2026-05-27),
  **with a source patch we maintain** — [`patches/age-c11b36ad.patch`](../patches/age-c11b36ad.patch)
  remaps both AGE themes (tailwindcss-themer values, per-key: the neutral
  surfaces only) to delcc's own tokens from `src/lib/scheme.ts`, so the
  embedded editor's chrome matches delcc in light and dark by construction —
  He's pass-#110 ruling: we hold the source, so we change the palette there
  instead of shimming at runtime. The vendoring recipe: clone upstream,
  `git checkout c11b36ad`, apply the patch, set the Vite `base` to `./`,
  `npm install && npm run build`, copy `dist/` → `public/age/`, delete the
  generated `sw.js`/`manifest.webmanifest`, and neuter the generated
  service-worker registration in the built JS (`if("serviceWorker"...)` →
  `if(false)`) — the SW file is not shipped; Tauri's custom protocol is not a
  SW host. The same app the official client's graph tool embeds — the offline
  contract holds: everything runs inside the panel, nothing is fetched.
- The official client's graph tool loads this same editor by name
  ("Đang mở Another Graph Editor…"); its sketch tab loads Excalidraw
  (also MIT) — delcc's sketch tab is planned on that same basis.

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

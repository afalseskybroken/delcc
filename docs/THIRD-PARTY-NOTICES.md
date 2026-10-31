# Third-party notices

delcc adapts the same graph-rendering stack the official TMath client's GraphTool
ships on (carved 1.1.0: `cytoscape.esm` + cose-bilkent + dagre chunks). All three
libraries are MIT-licensed; their bundles are compiled into delcc's own frontend
(no CDN, the tools panel stays genuinely offline). This file carries the credit.

| library | version | license | use in delcc |
|---|---|---|---|
| [cytoscape](https://github.com/cytoscape/cytoscape.js) | 3.34.4 | MIT | graph rendering, node/edge model, drag, pan/zoom, multigraph |
| [cytoscape-dagre](https://github.com/cytoscape/cytoscape.js-dagre) | 2.5.0 | MIT | the automatic tree layout ("Bố trí cây") |
| [cytoscape-cose-bilkent](https://github.com/iVis-at-Bilkent/cytoscape.js-cose-bilkent) | 4.1.0 | MIT | the physics layout (drag re-settles the graph, toggleable) |

Everything else in delcc's frontend is first-party. The other bundled runtime
dependencies (DOMPurify, KaTeX, Monaco, Tauri's JS API) are used unmodified per
their own licenses (Apache-2.0 / MIT / MIT / MIT) and are declared in
`package.json`.

MIT License (applies to each of the three libraries above):

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

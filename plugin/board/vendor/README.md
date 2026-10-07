# Vendored: Mermaid 12.1.0

`mermaid.min.js.gz` is `dist/mermaid.min.js` from the npm package
[`mermaid@12.1.0`](https://www.npmjs.com/package/mermaid/v/12.1.0),
unmodified, gzipped. The board serves it to its own page, so diagrams render
with nothing downloaded and no CDN.

Mermaid is MIT licensed, copyright (c) 2014-2022 Knut Sveidqvist and
contributors: https://github.com/mermaid-js/mermaid/blob/develop/LICENSE.

## What the bundle contains

Mermaid's build includes its dependencies. Each keeps its own licence; the
main ones are below, and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
has every package in the tree with its licence text. None of them was
modified.

| Package | Licence |
|---|---|
| @braintree/sanitize-url | MIT |
| @iconify/utils | MIT |
| @mermaid-js/parser | MIT |
| @upsetjs/venn.js | MIT |
| chevrotain | Apache-2.0 |
| cytoscape, cytoscape-cose-bilkent, cytoscape-fcose | MIT |
| d3 | ISC |
| d3-sankey | BSD-3-Clause |
| dagre-d3-es | MIT |
| dayjs | MIT |
| dompurify | MPL-2.0 or Apache-2.0 (used under Apache-2.0) |
| elkjs | EPL-2.0 |
| es-toolkit | MIT |
| katex | MIT |
| khroma | MIT |
| marked | MIT |
| roughjs | MIT |
| stylis | MIT |
| ts-dedent | MIT |
| uuid | MIT |

**elkjs (Eclipse Layout Kernel)** is distributed under the Eclipse Public
License 2.0: https://www.eclipse.org/legal/epl-2.0/. Its source code is
available at https://github.com/kieler/elkjs and
https://github.com/eclipse/elk. It is included here, unmodified, only as part
of Mermaid's bundle; the rest of this project is MIT licensed and is not a
derivative work of it.

The table lists `mermaid@12.1.0`'s direct dependencies on npm. If you find a
component missing or misattributed, please open an issue.

# Vendored: the canvas editor

`editor/` holds the editor a diagram turns into when someone presses Edit:
[Excalidraw](https://github.com/excalidraw/excalidraw) 0.18.1 (MIT), its
[Mermaid converter](https://github.com/excalidraw/mermaid-to-excalidraw)
2.2.2 (MIT) and React 19 (MIT), bundled unmodified by `editor/build.mjs` at
the repository's root (`cd editor && npm install && npm run build`). The
converter keeps the Mermaid it was built for, 11.12.1 (MIT), apart from the
board's own: it reads Mermaid's rendered SVG, which changes between
versions. The page loads the editor only when a diagram is edited.
[editor/THIRD_PARTY_LICENSES.md](editor/THIRD_PARTY_LICENSES.md) lists every
package in the bundle and every font, each with its licence text.

The fonts Excalidraw draws text with, unmodified:

| Font | Licence |
|---|---|
| Assistant | SIL Open Font License 1.1 |
| Cascadia Code | SIL Open Font License 1.1 |
| Comic Shanns | MIT (c) 2018 Shannon Miwa |
| Liberation Sans | SIL Open Font License 1.1 |
| Lilita One | SIL Open Font License 1.1 |
| Nunito | SIL Open Font License 1.1 |
| Virgil | SIL Open Font License 1.1 (https://github.com/excalidraw/virgil) |

Excalifont and Xiaolai are left out: the canvas writes in Helvetica, and a
font the board does not have is not fetched from anywhere else (the page
allows fonts from the board only).

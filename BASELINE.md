# Phase 0 baseline

Measured 2026-10-03 on this Mac; Mermaid 12.1.0, Puppeteer headless shell.

- Renderer cold start (spawn to socket ready, Chrome launched, Mermaid loaded): **1651 ms**
- Warm renders: 10 per fixture after a first render.

| fixture | first render ms | warm p50 ms | warm p95 ms | SVG KB | fits 128 KB | px |
|---|---|---|---|---|---|---|
| architecture.mmd | 311 | 41 | 53 | 10 | yes | 446x463 |
| block.mmd | 122 | 53 | 67 | 12 | yes | 317x119 |
| c4-context.mmd | 157 | 31 | 36 | 27 | yes | 832x695 |
| class.mmd | 443 | 74 | 126 | 23 | yes | 322x611 |
| er.mmd | 142 | 56 | 67 | 33 | yes | 411x602 |
| flowchart-checkout.mmd | 303 | 87 | 125 | 26 | yes | 755x1224 |
| flowchart-shapes.mmd | 209 | 48 | 56 | 36 | yes | 352x703 |
| flowchart-styled.mmd | 139 | 57 | 63 | 60 | yes | 832x391 |
| gantt.mmd | 155 | 14 | 14 | 9 | yes | 4096x172 |
| mindmap.mmd | 171 | 76 | 144 | 32 | yes | 632x472 |
| sequence.mmd | 197 | 35 | 42 | 30 | yes | 850x674 |
| state.mmd | 151 | 62 | 77 | 29 | yes | 328x388 |

Style highlight (`style svc stroke:#00b7c3,stroke-width:3px` appended to flowchart-checkout):
no element moved; same overall size: true.


## Notes

- Measured during the Phase 0 spike with Puppeteer's bundled headless shell
  (`renderer/` then took a `--socket` path). The renderer now drives an installed
  Chromium-based browser through `puppeteer-core` (system Chrome: about 3.5 s cold,
  about 90 ms warm on this Mac) and setup installs about 35 MB.
- The style-directive highlight is safe for flowcharts: no element moves.

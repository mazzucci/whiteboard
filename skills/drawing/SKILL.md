---
name: drawing
description: "Read before calling the whiteboard's show_diagram tool (mcp__whiteboard__show_diagram), which draws Mermaid diagrams on the Whiteboard pane beside the conversation. Covers picking the diagram type and direction, keeping diagrams legible, the Mermaid syntax traps that fail or render badly, a C4 style that lays out cleanly, walking from the big picture to detail across several diagrams, and fixing a diagram Mermaid rejects."
---

# Drawing on the whiteboard

`show_diagram` renders Mermaid exactly as Mermaid does and shows it on the
Whiteboard pane beside the conversation. Each call adds a diagram to the pane's
history (the person steps through it with `p` and `n`), so a sequence of calls
tells a story. Draw when a picture explains structure, flow or state better than
prose; answer in prose as well, briefly, and let the diagram carry the detail.

## Pick the type

| Question | Type |
|---|---|
| What are the parts and how do they connect? | `flowchart` (C4 style below for systems) |
| What happens, in what order, between whom? | `sequenceDiagram` |
| What states can it be in? | `stateDiagram-v2` |
| How is the data shaped? | `erDiagram` |
| What are the types and their relations? | `classDiagram` |
| When does what happen? | `gantt` or `timeline` |
| How do ideas branch? | `mindmap` |

## Keep it legible

The pane is a side panel, often 500 to 900 px wide; a diagram wider or taller
than that is scaled down until text is hard to read.
- About 5 to 15 nodes. More than that: split it into two diagrams, or zoom one level out.
- Choose the direction by shape: a long chain reads best `TB`; a wide fan-out or
  a pipeline across a few lanes reads best `LR`. A diagram that renders as a thin
  strip (say 2000 × 250) or a tall column has the wrong direction.
- Short labels: a name, then a second line of detail at most. Put explanations in your prose.
- Label only edges whose meaning is not obvious ("events", "authorize"), and keep
  edge labels to a word or two.
- A `title` in front matter (`---\ntitle: ...\n---`) heads the drawing; the tool's own
  `title` is what the pane lists.

## Syntax traps

- Labels are drawn as SVG text: HTML tags such as `<b>` show literally. Use `<br/>`
  for line breaks, or markdown strings for emphasis, where a real line break inside
  the backticks starts a new line (see the C4 example below).
- In `sequenceDiagram`, a `;` ends a statement, also inside messages and notes.
  Write "cookie. Then" instead of "cookie; then".
- Quote labels with parentheses, brackets or punctuation: `A["Charge (retry)"]`.
- `end` as a node id breaks flowcharts; use `done` or `End`.
- In `erDiagram`, attribute types are one word (`timestamptz`, `uuid`), and keys
  are `PK`, `FK`, `UK`.
- `stateDiagram-v2` transition labels go after a colon: `Paid --> Shipped: label printed`.

## C4 that lays out cleanly

Mermaid's own `C4Context`/`C4Container` syntax is experimental: it places shapes
in declaration order and its lines cross boxes and labels. Draw C4 as a
flowchart instead; Mermaid's real layout engine then routes it cleanly.

```
flowchart TB
  user["`**Shopper**
  *Person*`"]
  subgraph sys["Shopwise platform"]
    web["`**Web storefront**
    *Next.js*`"]
    db[("`**Orders DB**
    *Postgres*`")]
  end
  pay["`**Payment provider**
  *External*`"]
  user -- HTTPS --> web
  web --> db
  web -- authorize --> pay

  classDef person fill:#08427b,stroke:#052e56,color:#ffffff
  classDef system fill:#1168bd,stroke:#0b4884,color:#ffffff
  classDef container fill:#438dd5,stroke:#2e6295,color:#ffffff
  classDef component fill:#85bbf0,stroke:#5d82a8,color:#0b2540
  classDef external fill:#8a8a8a,stroke:#6b6b6b,color:#ffffff
  class user person
  class web,db container
  class pay external
  style sys fill:#f5f9ff,stroke:#1168bd,stroke-dasharray:6 4,color:#0b4884
```

Levels: context (people, the system as one box, external systems), containers
(inside the dashed boundary: apps, services, stores), components (inside one
container). Use `system` for the focus at context level, `container` below it,
`component` inside one container, `external` for anything outside.

## Walk from the big picture to detail

When someone is exploring a system, give one diagram per answer, each one level
closer: context, then containers, then the components of the part they ask
about, then a sequence for a key flow, then its states or data. Keep names and
colours consistent between levels, so the history reads as one zoom.

## When Mermaid rejects it

The tool fails with Mermaid's message, which names the line and what it
expected. Fix that line (usually a trap above) and call again with the whole
corrected source; do not change the diagram's content to work around it. A
diagram over about 128 KB of SVG cannot be shown: split it.

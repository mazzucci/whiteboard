---
name: drawing
description: "Read before calling the whiteboard's show_diagram tool (mcp__whiteboard__show_diagram), which draws Mermaid diagrams on the Whiteboard pane beside the conversation. Covers picking the diagram type and direction, keeping diagrams legible, the Mermaid syntax traps that fail or render badly, a C4 style that lays out cleanly, showing what is confirmed versus assumed (evidence-driven troubleshooting, review lenses such as risk), walking from the big picture to detail across several diagrams, and fixing a diagram Mermaid rejects."
---

# Drawing on the whiteboard

`show_diagram` renders Mermaid exactly as Mermaid does and shows it on the
Whiteboard pane beside the conversation. Each call adds a diagram to the pane's
history (the person steps through it with `p` and `n`), so a sequence of calls
tells a story. Draw when a picture explains structure, flow or state better than
prose: several services or modules, a flow with branches or retries, state
transitions, a risky change. Not for a routine edit, where a diagram is
decoration. Answer in prose as well, briefly, and let the diagram carry the
detail.

A polished diagram makes a guess look like a fact. Draw only what you know, and
show the difference (see "Show what you know" below).

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

## Show what you know

When a diagram describes code or a system you are still learning, every box and
edge is either confirmed (you read it in the code, a log, a test) or assumed
(inferred from names, conventions, docs). Draw the difference, label with real
names (`OrderService`, `orders/repo.ts`, `orders` table) and name each edge's
mechanism (HTTP, queue, function call, query). Cite the `file:line` behind key
edges in your answer, and draw a part you have not looked at as "not yet checked"
rather than guessing its insides.

**Confidence and evidence.** Four classes, each with its own border so they read
without colour too:

```
  classDef confirmed fill:#e6f4ea,stroke:#1e7e34,stroke-width:2px,color:#0d3b1a
  classDef suspect fill:#fff4ce,stroke:#b58100,stroke-width:3px,color:#4d3800
  classDef unverified fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 4,color:#444444
  classDef ruledout fill:#fdecea,stroke:#c0392b,stroke-dasharray:3 3,color:#8a1f11
```

Troubleshooting with it: draw the hypothesis first, every step `unverified`.
As evidence arrives, redraw the same diagram (same title plus "step n", so the
history reads as the investigation): a step a log or test confirms becomes
`confirmed`, the step that looks wrong `suspect`, a disproved branch `ruledout`
with a "✗" in its label and a dotted edge. Say in your answer which evidence
moved which box. The last diagram should hold only what the evidence supports.

**Review lenses.** Colour a change by one property at a time, the one asked
about: risk, performance, test coverage, security. Never several at once; draw
another diagram for another lens. A four-step scale reuses the same borders:

```
  classDef high fill:#fdecea,stroke:#c0392b,stroke-width:3px,color:#8a1f11
  classDef medium fill:#fff4ce,stroke:#b58100,stroke-width:2px,color:#4d3800
  classDef low fill:#e6f4ea,stroke:#1e7e34,color:#0d3b1a
  classDef same fill:#f4f4f4,stroke:#bbbbbb,stroke-dasharray:5 4,color:#666666
```

For before and after, use `added` (green), `changed` (amber), `removed` (red,
dashed) the same way.

**Always a legend.** Mermaid has none, so add this small subgraph; the `~~~`
invisible links keep its entries in one row:

```
  subgraph legend["Legend: risk"]
    direction LR
    r1["High"]:::high
    r2["Medium"]:::medium
    r3["Low"]:::low
    r4["Unchanged"]:::same
    r1 ~~~ r2 ~~~ r3 ~~~ r4
  end
  style legend fill:#ffffff,stroke:#cccccc,color:#666666
```

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

---
name: drawing
description: "Read before calling the whiteboard's post_to_board tool (mcp__whiteboard__post_to_board), which draws Mermaid diagrams and notes on the whiteboard page in the user's browser. Covers picking the diagram type and direction, keeping diagrams legible, the Mermaid syntax traps that fail or render badly, a C4 style that lays out cleanly, showing what is confirmed versus assumed, colouring a diagram by any lens (evidence, risk, progress) and redrawing it as things change, walking from the big picture to detail across several diagrams, and fixing a diagram Mermaid rejects."
---

# Drawing on the whiteboard

`post_to_board` draws Mermaid on the whiteboard, a page in the person's
browser beside the conversation. Each call adds a card below the last, so a
sequence of calls tells a story. Draw when a picture explains structure, flow or state better than
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

The page fits each diagram to its width (about 1100 px at most), with
"Actual size" and browser zoom for detail; a diagram much wider than that is
scaled down until text is hard to read.
- About 5 to 15 nodes. More than that: split it into two diagrams, or zoom one level out.
- Choose the direction by shape: a long chain reads best `TB`; a wide fan-out or
  a pipeline across a few lanes reads best `LR`. A diagram that renders as a thin
  strip (say 2000 × 250) or a tall column has the wrong direction.
- When one node calls four or more others, draw it `LR` so they stack down
  the page; side by side in `TB` they shrink the whole diagram to fit the width.
- Short labels: a name, then a second line of detail at most. Put explanations in your prose.
  A line wraps on its own only past about 400 px, so break with `<br/>` where you
  want it: `pay["payments.charge<br/>180 ms"]`, a file path on its own line.
- Label only edges whose meaning is not obvious ("events", "authorize"), and keep
  edge labels to a word or two.
- A `title` in front matter (`---\ntitle: ...\n---`) heads the drawing; the tool's own
  `title` heads the card.

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

**Confidence and evidence.** Each colour answers one question, and each has
its own border so it reads without colour too:

- grey, dashed: **not checked or measured yet**
- green: **checked, no problem**
- red, thick: **checked, a problem** (red always means a problem, never "confirmed")
- lavender, dashed: **a proposed change**, not made or measured yet
- amber, rarely: looks wrong, not confirmed yet

```
  classDef unverified fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 4,color:#444444
  classDef fine fill:#e6f4ea,stroke:#1e7e34,stroke-width:2px,color:#0d3b1a
  classDef problem fill:#fdecea,stroke:#c0392b,stroke-width:3px,color:#8a1f11
  classDef proposed fill:#f1ebfc,stroke:#6f42c1,stroke-width:2px,stroke-dasharray:6 3,color:#3b1f6e
  classDef suspect fill:#fff4ce,stroke:#b58100,stroke-width:3px,color:#4d3800
```

Legend labels in the same words: "Not measured yet", "No problem", "The
problem", "Proposed".

**Redraw without reshuffling.** Mermaid lays a diagram out from the order of its
lines, so reordering them can flip the whole layout even when nothing else
changed. When you redraw a diagram from earlier in the conversation, start from
its source: keep every node id, label and line in the same order, add new nodes
and edges after the existing ones, and change what a step means through its
`class` assignments at the bottom. Keep each label about the same length from
one version to the next: a placeholder as wide as the value it stands for
(`? ms` rather than `…` for `3,400 ms`), since a wider box nudges its
neighbours. The board keeps a redraw at the same zoom and place, so stepping
through the diagrams (the tabs, or `[` and `]`) shows only what changed.

Troubleshooting with it: draw the hypothesis first, every step `unverified`.
As evidence arrives, redraw the same diagram (same title plus "step n", so the
tabs read as the investigation): a step the evidence clears becomes `fine`,
the step where the evidence shows the fault `problem`, one that looks wrong
but is not proven `suspect`. Say in your answer which evidence moved which
box. Then propose the fix on a sticky note, not in the diagram (below).

**Any lens.** Confidence is one lens; the same recipe colours a diagram by any
property that helps the conversation: pick the property, three to five levels,
one style per level (a fill plus its own border, so it reads without colour),
and a legend. Show one lens per diagram; draw another diagram for another lens.
Redraw as the property changes, and the history becomes a timeline. Examples,
not a list to choose from:

| Lens | Levels | Fits |
|---|---|---|
| Confidence, evidence | confirmed, suspect, not yet checked, ruled out | troubleshooting, learning a codebase |
| Risk, performance, coverage | high, medium, low, unchanged | reviewing a change |
| Before and after | added, changed, removed, unchanged | a refactor, a migration plan |
| Progress | done, running, waiting, failed | a CI pipeline, a rollout, a multi-step task |

A four-step scale that suits most lenses:

```
  classDef high fill:#fdecea,stroke:#c0392b,stroke-width:3px,color:#8a1f11
  classDef medium fill:#fff4ce,stroke:#b58100,stroke-width:2px,color:#4d3800
  classDef low fill:#e6f4ea,stroke:#1e7e34,color:#0d3b1a
  classDef same fill:#f4f4f4,stroke:#bbbbbb,stroke-dasharray:5 4,color:#666666
```

and for progress, a "running" level in blue:

```
  classDef done fill:#e6f4ea,stroke:#1e7e34,stroke-width:2px,color:#0d3b1a
  classDef running fill:#e7f0fd,stroke:#1a5fb4,stroke-width:3px,color:#0b2e5c
  classDef waiting fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 4,color:#444444
  classDef failed fill:#fdecea,stroke:#c0392b,stroke-dasharray:3 3,color:#8a1f11
```

**Always a legend, above the diagram.** Pass `legend` to `post_to_board`: one entry
per class the diagram uses, `{ "label": "Suspect", "class": "suspect" }`, in
reading order. The page draws it as one line above the diagram, a swatch in
each class's colour, so the diagram keeps its whole canvas. Don't draw a legend inside the diagram. The tool says if an
entry names a class with no `classDef`.

## Walk from the big picture to detail

When someone is exploring a system, give one diagram per answer, each one level
closer: context, then containers, then the components of the part they ask
about, then a sequence for a key flow, then its states or data. Keep names and
colours consistent between levels, so the cards read as one zoom.

## Sticky notes

A proposal, a question or an aside about one box goes on a sticky note
(`sticky_notes: [{ on: "<node id>", text }]`), pinned beside that box, not into
the diagram: a box drawn into the system looks like part of it. Notes without
`mermaid` go on the latest diagram. Keep a note to a line or two.

Proposing a fix:

1. Once the evidence shows the problem, pin the fix as a sticky note on the
   box it changes ("Proposal: one `inventory.check_batch` call instead of
   1,240"), and ask whether the user wants to see it in detail.
2. If they do, redraw the same diagram with the change in it: the changed
   boxes `proposed` (lavender), the rest as they were. The redraw has no
   sticky note: the proposal is in the diagram now.
3. Until someone measures it, say it is a proposal, in the note, the legend
   ("Proposed") and your answer.

## When Mermaid rejects it

The tool fails with Mermaid's message, which names the line and what it
expected. Fix that line (usually a trap above) and call again with the whole
corrected source; do not change the diagram's content to work around it. The
failed card is taken off the page, so the corrected one replaces it.

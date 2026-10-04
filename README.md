# Whiteboard for Claude Code

A whiteboard beside your Claude Code conversation. Ask Claude about a system, a
flow or a schema, and it draws a diagram there while it answers: real
[Mermaid](https://mermaid.js.org), rendered exactly as Mermaid draws it, every
diagram type, on a pane that keeps the whole conversation's diagrams.

![Claude maps a slow request, finds an N+1 in the trace, and proposes a fix, on a whiteboard beside the conversation](media/whiteboard.gif)

<sub>Animated illustration, not a screen recording; the diagrams are real Mermaid renders. Sources in `media/explainer/`.</sub>

> **Open source project, not affiliated with or endorsed by Anthropic.** Claude and
> Claude Code are trademarks of Anthropic, PBC.
>
> **Experimental.** Built on Claude Code's early-access mod API, which may change
> between releases. Tested with Claude Code 2.1.286 on macOS.

## What it does

More than a diagram renderer, the whiteboard is a visual companion to the
conversation. Claude redraws as the conversation moves, and colours a diagram by
whatever matters right now, with a legend that says what the colours mean: what
is confirmed and what is still a guess while troubleshooting, where the risk sits
in a change, which CI step has passed, is running or failed. Each redraw stays in
the history, so the whiteboard becomes a timeline of how the picture changed.

- **Claude draws while it explains.** A `show_diagram` tool lets Claude put a
  diagram on the whiteboard whenever a picture says it better.
- **Exact Mermaid.** Mermaid 12.1 renders in a headless browser, so flowcharts,
  sequence, class, state, ER, C4, architecture, mindmaps, Gantt charts and the rest
  look exactly as they would on mermaid.live, styling and themes included.
- **Fixes its own mistakes.** When Mermaid rejects a diagram, its error goes back
  to Claude, which corrects the source and draws again; you just see the result.
- **History.** Each diagram is kept: step back and forth through a whole
  walkthrough, from the big picture down to the details.
- **Zoom, pan and source.** Zoom in on a large diagram, pan around it, or flip to
  the Mermaid source.

## How it works

```mermaid
flowchart TB
  you(["`**You**`"])
  subgraph cc["Claude Code desktop"]
    direction LR
    claude["`**Claude**
    writes Mermaid`"]
    mod["`**Whiteboard mod**
    tool, pane, history`"]
    pane["`**Whiteboard pane**
    SVG, zoom, code view`"]
  end
  subgraph host["Your machine"]
    direction LR
    renderd["`**Renderer**
    Node, warm`"]
    chrome["`**Headless Chrome**
    Mermaid 12.1`"]
  end

  you -- asks --> claude
  claude -- "show_diagram" --> mod
  mod -- "private socket" --> renderd
  renderd --> chrome
  chrome -- SVG --> renderd
  renderd -- "SVG or error" --> mod
  mod --> pane
  mod -. "Mermaid's error" .-> claude

  classDef person fill:#08427b,stroke:#052e56,color:#ffffff
  classDef part fill:#438dd5,stroke:#2e6295,color:#ffffff
  classDef local fill:#85bbf0,stroke:#5d82a8,color:#0b2540
  class you person
  class claude,mod,pane part
  class renderd,chrome local
  style cc fill:#f5f9ff,stroke:#1168bd,stroke-dasharray:6 4,color:#0b4884
  style host fill:#f7f7f7,stroke:#8a8a8a,stroke-dasharray:6 4,color:#555555
```

The mod adds the tool, the pane and the `/whiteboard` command. Drawing happens
in a small renderer process: Node.js driving a headless Chrome with Mermaid
loaded, started on first use and kept warm, so after a first render of about two
seconds each diagram takes tens of milliseconds.

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant C as Claude
  participant W as Whiteboard mod
  participant R as Renderer (headless Chrome)

  You->>C: "How does checkout work?"
  C->>W: show_diagram(mermaid)
  W->>R: render (first use starts it, about 2 s)
  R-->>W: Parse error on line 4
  W-->>C: Tool error with Mermaid's message
  C->>C: Fix line 4
  C->>W: show_diagram(fixed source)
  W->>R: render (warm, about 50 ms)
  R-->>W: SVG
  W->>W: Add to history, open the pane
  W-->>C: Rendered
  C-->>You: Short answer, diagram beside it
```

## Install

Requirements: Claude Code desktop with mods, Node.js 22.12 or later, and macOS
(Linux should work but is untested; Windows is not supported yet).

### Ask Claude to install it

In Claude Code, paste:

```
Install the whiteboard mod from https://github.com/mazzucci/whiteboard-for-claude-code,
following the "Instructions for Claude" in its README.
```

Claude checks the requirements, tells you what it will download, and sets it
up. Then start a new session and ask for a diagram.

### Instructions for Claude

You are installing this mod for the person you are working with. Follow these
steps in order, and stop to tell them if one fails.

1. **Check the requirements.** Run `node --version`: it must be 22.12 or
   later. The OS must be macOS or Linux. If either check fails, stop and say
   which.
2. **Tell the person what will happen, and wait for their go-ahead:** the
   repository is cloned into `~/.claude/skills/whiteboard`, and setup downloads
   `puppeteer-core` and Mermaid's script from npm into `~/.cache/whiteboard`
   (about 35 MB). It uses an installed Chrome, Edge, Brave or Chromium; only if
   none is found does it also download a headless Chrome (about 150 MB).
3. **Get the code.**
   - If `~/.claude/skills/whiteboard` does not exist:
     `git clone https://github.com/mazzucci/whiteboard-for-claude-code ~/.claude/skills/whiteboard`
   - If it exists and is a clone of this repository, update it instead:
     `git -C ~/.claude/skills/whiteboard pull --ff-only`
   - If it exists and is something else, stop and ask.
4. **Install the renderer:**
   `node ~/.claude/skills/whiteboard/renderer/setup.mjs --home ~/.cache/whiteboard --mermaid 12.1.0 --puppeteer 25.12.0`
   It prints one JSON line per step and ends with `"step":"done"`. If it
   reports `"step":"error"`, show the person the message.
5. **Check the result:** `~/.cache/whiteboard/mermaid.min.js` and
   `~/.cache/whiteboard/node_modules/puppeteer-core` exist.
6. **Tell the person to start a new Claude Code session.** Plugins in
   `~/.claude/skills` load when a session starts. In the new session, `/whiteboard`
   opens the pane, and asking for a diagram draws one. If `/whiteboard` is
   missing there, the mod did not load: Claude Code's mod API is in early
   access, so check that their Claude Code version supports mods (tested with
   2.1.286).

Do not change their Claude Code settings, permissions or other plugins as part
of this install.

### Install by hand

The same steps without Claude: clone the repository into
`~/.claude/skills/whiteboard`, start a new session, and run `/whiteboard setup`
there (it runs step 4 above). To try it without installing, load it for one
session with `claude --plugin-dir /path/to/whiteboard-for-claude-code`.
`/whiteboard setup --download-browser` downloads the headless Chrome even when
a browser is installed.

## Use

Ask for a picture ("draw the auth flow", "show me the data model") or just ask
questions about a system: Claude draws when a diagram helps. The bundled
`whiteboard:drawing` skill teaches it to keep diagrams legible.

| Command | |
|---|---|
| `/whiteboard` | Open the whiteboard |
| `/whiteboard path/to/file.mmd` | Show a Mermaid file (or the first `mermaid` block of a Markdown file) |
| `/whiteboard theme <name>` | `auto` (follows light/dark), `default`, `dark`, `forest`, `neutral`, `base` |
| `/whiteboard sample` | Draw a sample |

Click the pane, then:

| Key | | Key | |
|---|---|---|---|
| `i` / `o` | zoom in / out | `w` `a` `s` `d` | pan |
| `0` | fit | `c` | Mermaid source |
| `p` / `n` | previous / next diagram | | |

## Reading the diagrams

A polished diagram makes a guess look like a fact, so the bundled skill asks
Claude to show the difference: real module, file and service names, the
mechanism on each edge, `file:line` citations in the answer, and styles that say
how much is known.

Beyond that, a diagram can be coloured by any **lens**: one property, a few
levels, one style per level, and a legend. Some examples:

- **Confidence.** Confirmed parts are solid green, suspects thick amber, parts
  not yet checked dashed grey, ruled-out branches dotted red with a ✗. While
  troubleshooting, Claude starts from a hypothesis and redraws it as evidence
  comes in, so the history reads as the investigation.
- **Risk, performance or test coverage** across a change, or **before and after**
  with added, changed and removed parts.
- **Progress** of anything with steps: a CI pipeline (done, running, waiting,
  failed), a rollout, a migration, a long task Claude is working through.

Invent your own: ask for a diagram "coloured by owner", "by latency", "by what we
have touched so far". Every colour gets its own border style, so diagrams read
in grayscale too. These are conventions in the skill, not features of the
renderer: any Mermaid works.

## Security and privacy

- Rendering stays on your machine: nothing is published, and the renderer's
  page may load nothing but inline data, so a diagram naming a remote image or
  URL cannot make it reach the network (such a diagram fails with an error).
- Only `/whiteboard setup` goes online: `puppeteer-core` and Mermaid's package
  from the npm registry (integrity-checked by npm), and, only when no Chromium
  browser is installed, a headless Chrome from Google's Chrome for Testing
  downloads through Puppeteer's installer.
- Mermaid runs with `securityLevel: strict` (no scripts or click callbacks) and
  labels as plain SVG text, in a headless browser with its sandbox on and a
  throwaway profile: your own browsing data is never read.
- The renderer listens on a Unix socket with a random name in a private
  directory (`0700`, socket `0600`), removed when it exits after 30 idle minutes.

## Limits

- The rendered view needs the desktop app (or VS Code): the terminal has no SVG,
  so there the whiteboard shows the Mermaid source.
- Diagrams over about 128 KB of SVG are too large for the pane; split them.
- Mermaid's own C4 syntax is experimental and lays out poorly; the skill steers
  Claude to C4-styled flowcharts instead.

## Development

```
claude plugin validate .
claude plugin test .
```

`demo/` holds a six-step walkthrough with reference diagrams and their renders;
`fixtures/` one diagram per type. `node scripts/render.mjs file.mmd...` renders
any Mermaid file to PNG with the same renderer the pane uses.

## License

MIT. Mermaid (MIT) and Puppeteer (Apache 2.0) are downloaded by setup, not
bundled.

This is an independent, unofficial project. It is not affiliated with, endorsed
by or supported by Anthropic. Claude and Claude Code are trademarks of
Anthropic, PBC, used here only to describe what the project works with.

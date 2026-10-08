---
name: whiteboard-orientation
description: Read first in any session that works on this repository (the Whiteboard plugin for Claude Code). Where everything lives, how the pieces talk, the invariants that tests guard, the house style for code and docs, and the standing rules (protected main, worktrees, never the real ~/.claude in tests, privacy in recordings).
---

# Working on Whiteboard

Whiteboard is an open-source Claude Code plugin: while you work with Claude
Code, Claude draws Mermaid diagrams, charts and sticky notes on a local page in
the browser, and what the person types there goes back into the same session.
Repo: github.com/mazzucci/whiteboard. Installed as `whiteboard@mazzucci`.

## Where things are

| Path | What it is |
|---|---|
| `plugin/` | Everything Claude Code loads, and all an install copies |
| `plugin/hooks/register.tsx` | The mod: tools (`post_to_board`, `read_board`, `edit_board`), `/whiteboard` command, prompt and turn hooks, starting the board server |
| `plugin/board/server.mjs` | The board server: Node standard library only, 127.0.0.1, random port, random token; holds cards in memory; replays them to a page that connects |
| `plugin/board/page/` | The page: `index.html`, `app.css`, and classic scripts `app.js`, `editing.js` (canvas), `charts.js` (clickable charts), `export.js` (Export, Save board) |
| `plugin/board/vendor/` | Mermaid (gzipped) and the built canvas editor (Excalidraw); `THIRD_PARTY_LICENSES.md` |
| `plugin/skills/drawing/SKILL.md` | What Claude is told about drawing: types, colours, sticky notes, charts, canvas, saving |
| `plugin/tests/` | `board.test.tsx` (the mod, via `claude plugin test`), `server.test.mjs` (the server) |
| `editor/` | Source and build of the vendored canvas editor; CI checks the bundle matches it |
| `test/page/` | Page tests in headless Chrome (puppeteer-core); `board.mjs` holds the helpers |
| `fixtures/` | One Mermaid file per diagram type; tests render every one |
| `demo/`, `media/board-demo/` | The simulated investigation for demos, recorders and GIF editors (see the `live-take` skill) |

## Invariants the tests guard

- The page scripts share one global scope: no two may declare the same
  top-level name (`server.test.mjs` checks all four). Name new helpers so they
  cannot collide, and add any new script to that test, to `STATIC` in
  `server.mjs` and to `index.html`.
- Mermaid runs with `securityLevel: 'strict'`; anything the page builds from
  Claude's text is escaped first (`esc`, `markdown`, `inline`).
- A saved or exported file runs no scripts and leaks no token or port.
- The vendored editor bundle must equal what `editor/` builds
  (`cd editor && npm ci && node check-build.mjs`).
- `diagrams`, `stickies`, `cardLog` are rebuilt from the server's replay when a
  page reconnects: anything kept per board must be reset in `events.onopen`.

## Running it

```bash
claude plugin validate --strict plugin
CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin test plugin
node --test plugin/tests/server.test.mjs
cd test && npm ci && npm test
cd editor && npm ci && node check-build.mjs
```

Never run the plugin's tests against the real `~/.claude`: always a throwaway
`CLAUDE_CONFIG_DIR`. A page test can look at its result:
`page.screenshot()` from a small script in `test/page/` (delete it after), then
read the PNG.

## Standing rules

- `main` is protected: every change goes through a pull request with the six
  CI checks green (the `ship-a-change` skill). Merge with a merge commit.
- Work in a git worktree (`git worktree add ../whiteboard-<topic> -b <topic> main`),
  never in a checkout a running `claude --plugin-dir` session is using.
- Ask before pushing or publishing anything, unless the person has handed you
  the whole change ("handle it to the merge").
- Git identity: the person's own (`git -c user.email=...` as they use).
- Recordings: capture one window or a headless page, never the screen; blur
  names, paths and accounts.

## House style

- Code reads like the code around it: short doc comments that say why, names
  that read as English, `is`/`has` booleans, no new dependencies without need.
- Docs and UI text: plain, specific, British spelling ("colour"), no hype. The
  product is "Whiteboard", never "Claude Code Whiteboard"; the README carries
  "Open source · not affiliated with Anthropic".
- Every user-visible change gets a CHANGELOG line under the next version
  (`## 0.x.y (unreleased)` until the release) and, if it changes what Claude
  should do, a line in `plugin/skills/drawing/SKILL.md` or the tool description
  in `register.tsx`.

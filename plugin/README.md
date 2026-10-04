# Whiteboard for Claude Code: the plugin

This folder is the plugin, and all that installing it copies. Open source
(MIT), not affiliated with or endorsed by Anthropic. The project, with its
install and usage guide, is at
https://github.com/mazzucci/whiteboard-for-claude-code.

- `hooks/`: the mod. It registers the `show_diagram` tool and the `/whiteboard`
  command, and draws the Whiteboard pane.
- `renderer/`: what the mod runs on this machine. `setup.mjs` installs the
  renderer, asking before each download; `renderd.mjs` renders Mermaid in a
  headless browser, on a private local socket, with network requests blocked.
- `skills/drawing/`: the skill that teaches Claude to draw legible diagrams.
- `types/`, `tests/`: the mod's state types and its tests
  (`claude plugin test .` from this folder).

Nothing is sent anywhere: diagrams render locally. `/whiteboard setup` is the
only step that goes online, and only after you agree to each download;
`/whiteboard uninstall` deletes what it installed.

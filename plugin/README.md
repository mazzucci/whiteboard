# Whiteboard: the plugin

This folder is the plugin, and all that installing it copies. Open source
(MIT), not affiliated with or endorsed by Anthropic. The project, with its
install and usage guide, is at
https://github.com/mazzucci/whiteboard.

- `hooks/`: the mod. It registers the `post_to_board` tool and the
  `/whiteboard` command, starts the board for a session, and passes what the
  person types there into the session.
- `board/`: the board. `server.mjs` serves the page on 127.0.0.1 with Node's
  standard library; `page/` is the page; `vendor/` holds Mermaid, which the
  page draws with.
- `skills/drawing/`: the skill that teaches Claude to draw legible, honest
  diagrams, with sticky notes for proposals.
- `tests/`: the mod's tests (`claude plugin test .` from this folder).

Nothing is downloaded and nothing is sent anywhere: the board and its page
run on this machine, and stop with the session.

# Changelog

## Unreleased

- **Two modes.** Diagrams (Claude's, as drawn, each new one a tab) or canvas
  (every diagram editable by both, amended in place). Switch at the top of the
  page, press Edit, run `/whiteboard canvas`, or let Claude pick.
- **Edit a diagram yourself.** On a canvas (Excalidraw, bundled) you drag
  boxes, write, add boxes, arrows and sticky notes. Your changes reach Claude in words with your next message, and so does what you
  have selected, so "make this red" means the box you picked.
- **Claude amends instead of redrawing.** A new tool, `edit_board`, adds,
  connects, renames, recolours (the evidence colours, or any colour by name or
  hex) and removes boxes on a diagram, keeping your layout.
- **Claude can look.** `read_board` describes an edited diagram as it now is,
  and with `image: true` gives Claude a picture of it.

## 0.3.1

- **A closed tab opens again** with Claude's next post, everything so far on it.
- **Claude can read the board back** with a new tool, `read_board`: each
  diagram's Mermaid source and sticky notes, its notes, and what you typed.
- **`/whiteboard sample` tells Claude what it drew**, node ids included, so
  "pin a note on the email service" just works. A file you open is told the same way.
- **Asked on the board, answered on the board.** If Claude replies to a board
  message only in the conversation, that reply is posted to the board too.
- **Back in the terminal, answered in the terminal.** After talking on the
  board, the next thing you type in the conversation tells Claude you are back,
  and focus mode ends.
- The demo opens in Claude Code and comes back to it, so it is plain the board
  is part of the session.

## 0.3.0

- **Safer board.** The page and its files load without the session's token,
  which then leaves the address bar; everything else needs the token and is
  refused from any other website. Stricter page policies, no referrer, and
  links inside diagrams are disabled. Odd requests no longer stop the board.
- **Messages from the board are never submitted twice.**
- **Finds Node installed with nvm, volta, fnm, asdf or mise**, and says when
  the one it finds is older than 18.
- **`BROWSER` is honoured without waiting on it**, with `%s` for the address.
- **Phones and tablets:** Board and Chat views, pinch to zoom, double-tap to fit.
- The page says when Claude answered in the conversation instead of on the board,
  and a tab opened without the board's key says how to open it.
- The drawing area stays white in dark mode, so every diagram's colours stay
  readable.
- The marketplace is now `mazzucci`: install `whiteboard@mazzucci`. Installs as
  `whiteboard@whiteboard` keep working.
- The 0.1 explainer video sources and walkthrough are gone; a fuller licence
  notice for the bundled Mermaid.

## 0.2.2

- Claude reaches for the board on "how does X work?" questions.
- Sticky notes on no box stack without overlapping.
- The before/after GIF.

## 0.2.1

- The README GIF, recorded from a real session.
- Sticky notes fall below the diagram when there is no room beside a box;
  redraws are fitted again when they no longer fit.
- `BROWSER` is honoured.

## 0.2.0

- The whiteboard moves to a page in your browser: works from any terminal and
  the desktop app's Code tab, with no setup and nothing downloaded.
- Tabs, zoom and pan, legend, sticky notes, colours that each answer one
  question, answering on the board, Wrap up.

## 0.1.x

- A pane in the Claude desktop app's Code tab, rendered by a headless Chrome.

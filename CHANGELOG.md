# Changelog

## 0.4.1

- **Fixed: a sticky note pinned to a box broke the board** (the zoom read
  "NaN%" and the page reported errors). 0.4.0's canvas code replaced a function
  the board uses to place notes; a test now guards against it.
- **Fixed: class, state and ER diagrams, and flowcharts with subgraphs, became
  an empty canvas.** The converter now keeps the Mermaid it was built for; a
  test converts every diagram in `fixtures/` on the real page.
- **Edit edits that diagram only;** the board's mode is the switch at the top.
  On either mode, Claude amends a diagram you edited instead of drawing it
  again.
- With two tabs open, each tab tells Claude its own changes, once, and saves
  from both tabs merge: neither undoes the other's moves.
- Edit pressed twice (or Edit and the Canvas switch together) no longer leaves
  a blank canvas.
- On a canvas board, Claude's amendment right after a new diagram goes to that
  diagram, not the one before it, and never reads a canvas that is still
  loading.
- A sticky note pinned to a box that is not on the canvas is told to Claude as
  such; the rest of the post still goes on the board.
- A diagram posted on a canvas board while no page was open is editable when
  the page opens.
- Amendments: `text` needs text, `class` takes the evidence classes (or
  `color`), more than 50 at once are reported, not dropped silently; a sticky
  note can pin to an id with a dot.
- Sequence diagrams read back cleanly: one box per participant, by its name
  (`App`, not `App-top`), and only the messages as arrows.
- The editor's fonts load from the board (its own UI font was missing), and
  the bundle no longer names a CDN; the fonts' licence texts ship with them.
- A diagram the canvas cannot read (a pie chart, say) stays as drawn, with a
  line saying so on the page, and Claude is told when it tries to amend it:
  never an empty canvas.
- A mode switch from Claude no longer leaves an empty card.
- Wrap up does not send what is selected.
- A canvas opens with the whole diagram in view.
- Counting your changes no longer finds ones you did not make (boxes named
  after the canvas opened; two arrows between the same boxes).
- Development: CI on every pull request, with the board's page tested in
  headless Chrome (`test/page/`).
- The README and the demo show editing together.

## 0.4.0

- **Two modes.** Diagrams (Claude's, as drawn, each new one a tab) or canvas
  (every diagram editable by both, amended in place). Switch at the top of the
  page, run `/whiteboard canvas`, or let Claude pick. Switching makes the
  diagram on screen editable, and every new one; earlier ones stay drawings.
  Edit on a diagram makes just that one editable.
- **Edit a diagram yourself.** On a canvas (Excalidraw, bundled) you drag
  boxes, write, add boxes, arrows and sticky notes. Your changes reach Claude
  in words with your next message, and so does what you have selected, so
  "make this red" means the box you picked.
- **Claude amends instead of redrawing.** A new tool, `edit_board`, adds,
  connects, renames, recolours (the evidence colours, or any colour by name or
  hex) and removes boxes on a diagram, keeping your layout. Each amendment
  comes back to Claude with a small picture of the result, so it sees a
  crowded label and fixes it. On a canvas, Claude amends a diagram instead of
  drawing it again in a new tab.
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

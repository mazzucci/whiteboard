# Changelog

## 0.6.0

- **A brief beside the diagrams.** When Claude explains a concept, briefs you
  on a document or sums up an investigation, it can write a brief next to the
  diagram: the bottom line first, then up to nine sections of one line each.
  It sits where the conversation is, with a Brief / Chat switch.
  - Point at a section and the boxes it is about light up on the diagram.
  - Click a section to ask about it: your question, and Claude's answer, land
    under that section. **More detail** asks Claude to expand it.
  - The brief changes as you talk: a rewritten line shows the old one struck
    through until you have seen it, new ideas become new sections, and dropped
    ones are listed with why. The conversation notes each change.
  - Sources show as § links: the spec, the doc, or the file and line.
  - Save board puts the brief first, in the web page and in Markdown.
- **Decide together.** When you are designing something or choosing between
  options, Claude can make the brief a decision: the constraints that decide
  it first, then its proposal.
  - Each constraint shows its choices, with the one Claude leans towards.
    Click your choices and they go together with your next message (or Send
    on its own); they are settled at once.
  - An assumption Claude made is marked as such, for you to confirm.
  - The diagram says what is still open: the boxes a constraint decides are
    dashed while it is open and green once it is settled.
  - The header waits on what is open, then shows the proposal.
  - Claude restructures as you go: a choice can drop a constraint or raise a
    new one, and Claude's suggestions are yours to take or turn down.
- **Side boards.** Say "let's whiteboard this" about a question inside a
  decision (relational or not, which rate limiter), or take Claude up on its
  offer, and Claude opens a side board for it: its own brief and diagrams,
  one click from the main board.
  - A comparison lays the options out as columns, each criterion a row of
    marks (✓ ~ ✕ ?) and one short clause.
  - Pick an option to decide it: the main board's constraint is settled, and
    you are back there. Claude can also park a side board for later, or drop
    it.
  - Claude's posts go to the board you are looking at; the main board lists
    its side boards and where each stands. Save board includes them.
- **A shorter README,** with one GIF: a design session, from constraints to a
  side board to the proposal. The earlier GIFs' scripts are still in
  `media/board-demo/`.

## 0.5.1

- **Export a diagram.** An Export menu on each diagram: SVG or PNG, or Copy
  Mermaid source. A diagram you edited downloads as a PNG of the canvas, or as
  an `.excalidraw` file that opens, still editable, at excalidraw.com.
- **Save the board** as one file, from the header or the wrap-up banner:
  - a web page with every diagram (the edited ones as you left them), its
    legend, sticky notes and source, and the conversation; it runs no scripts;
  - or Markdown for a pull request or a postmortem: each diagram's latest
    version open as a `mermaid` block (its colours are its own classDefs, so
    GitHub, GitLab and Notion show them), its legend as a line, its sticky
    notes by box name, the versions it redrew folded under it, then the
    conversation as written.

  Nothing is saved unless you ask: these are downloads. The wrap-up banner
  waits while the pointer is on it, so there is time to save.
- **The hand-drawn font** (Excalifont) is part of the board now; picking it
  on a canvas showed nothing before. It ships under its SIL Open Font License.
- **ER and state diagrams on a canvas read back to Claude by their own
  names:** `CUSTOMER`, not `entity-CUSTOMER-0`, so Claude's amendments find
  them; a state diagram's `[*]` reads as its start and end.
- Fixed: a picture of a very large diagram, or of one with HTML labels, could
  not be made (Claude's `read_board` picture too); a huge one is now drawn
  smaller, within what browsers can draw.
- Fixed: a line chart's click spots showed as black dots in pictures of it.
- In the Markdown save, a newer Mermaid type (charts, architecture, block…)
  says that some viewers may not draw it yet.

## 0.5.0

- **Charts you can click.** Pie, bar and line (`xychart-beta`) and quadrant
  charts: click a slice, a bar or a line's point to select it (Shift+click for
  more, Escape or a click beside it clears), and the next message says what is
  selected, with its value: "Selected on the board, in "Pets": the slice "Dogs"
  (386, 79%)". The selection goes with that one message, then clears. Each
  chart keeps its own until then; the hint under the board names it (on a
  touch screen: tap to select, tap beside it to clear). Hovering a mark shows
  its value; a line's points show as dots. A pie with `showData`, or with a
  slice under 1% (which Mermaid does not draw), is clickable too.
- Sticky notes can sit on a chart's slice, bar or point, named by its label
  (any text: `on` is no longer limited to an id).
- A sticky note whose `on` names nothing on the diagram is told to Claude
  ("Not pinned: …") instead of quietly going beside the diagram.
- The drawing skill says when to draw a chart, and to use real numbers only.
- `fixtures/` has a pie, an xychart and a quadrant chart.

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

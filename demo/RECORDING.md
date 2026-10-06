# Recording the demo

The README's GIF is a recording of a real Claude Code session with the
whiteboard, on the simulated investigation in `checkout-service/`
(fictional service, code and numbers). Claude, the plugin and every diagram
are real. A script stands in for the person on the board: it records the
page, answers Claude's question, shows the controls and wraps up, so a take
needs no hands and can be repeated until Claude's drawing is good.

## A take

You need Node.js, Google Chrome, and `puppeteer-core` beside the recorder:
`npm install --no-save puppeteer-core` in `media/board-demo/` (or point
`PUPPETEER_HOME` at a folder where it is installed).

1. Pick a folder for the take, say `REC=/tmp/take1`, and `mkdir -p $REC/frames`.
2. Start the recorder; it waits for the board:

   ```bash
   node media/board-demo/recorder.mjs "$REC"
   ```

3. In another terminal, in a copy of `demo/checkout-service/` (its folder
   name is the board's label), start Claude Code with the recorder as the
   browser and this prompt:

   ```bash
   REC=/tmp/take1 BROWSER=/path/to/whiteboard/media/board-demo/opener.sh claude "This is our investigation of the slow checkout endpoint (investigation.md). Walk me through it step by step on the whiteboard: first the request path, then what the trace shows. Keep your answers short." --plugin-dir /path/to/whiteboard/plugin --allowedTools=mcp__whiteboard__post_to_board,Read
   ```

   A new folder asks whether you trust it first: answer before the take.

4. The recorder logs each step: the first diagram, the sticky note, Claude's
   question, "yes", the proposal, the controls, the wrap-up. It stops on its
   own and writes `$REC/frames.json`.

Check the take before editing: the sticky note should sit by
`inventory.check`, Claude's question should be on the board (not only in the
terminal), and the proposal should be lavender. Claude draws a little
differently each time; three to five takes are normal.

## The Terminal in the demo

The GIF opens in Claude Code, live: the prompt, Claude reading the
investigation and calling the whiteboard, until "Drawn on the whiteboard
page, which just opened in the browser". Then the board, from its first
diagram, with the cursor running along the boxes while Claude reads the
trace. After the wrap-up, the summary arriving in the Terminal.

For the Terminal, record its window alone (never the screen) with
`window-recorder.swift`, beside the board's recorder:

```bash
swiftc -O media/board-demo/window-recorder.swift -o /tmp/window-recorder
/tmp/window-recorder <Terminal window id> "$REC/terminal" 8
```

The window id is Terminal's AppleScript `id of front window`; the recorder
needs the Screen Recording permission and stops on Ctrl-C. Start Claude
Code a moment after it (`sleep 2` first), and stop it a few seconds after
the board's recorder ends. Then add `clips.json` to `$REC/terminal`:

```json
[
  {"after": "title", "from": "start", "from_plus": 2.3, "to": "first diagram", "plus": 0.6, "speed": 6,
   "crop": [40, 592], "mark": [563, 581], "hold": 1.4,
   "caption": "In Claude Code, Claude draws on a whiteboard it opens in your browser"},
  {"after": "end", "from": "wrap up", "from_plus": 0.5, "to": "wrapped up", "plus": 1.7, "speed": 2.5,
   "crop": [420, 945], "hold": 1.8,
   "caption": "Wrap up: the summary arrives back in Claude Code"}
]
```

Each clip runs from `from` to `to` (`start`, `end`, or a recorder mark, plus
seconds), `speed` times faster, showing the window's title bar and the lines
in `crop` (points), its last frame held `hold` seconds with the line at
`mark` outlined. The title bar and Claude Code's banner (account, path) are
blurred. `WINDOW=1` puts the page in a plain browser window; the take for
the README ran with `REC_W=1120` for the recorder, a browser window's width.

## The before/after GIF

The same idea with `media/board-demo/recorder-qa.mjs`, which asks a
follow-up on the board instead of answering a proposal, and
`media/board-demo/compare.py`, which puts plain Claude Code (snapshots of its
Terminal window, without the plugin) before the board recording, with three
snapshots of the board session's own Terminal: Claude calling the whiteboard,
the board opened, and the follow-up arriving in the session.

## The edit

```bash
FIRST=2.4 WINDOW=1 SPEED=1.4 GIF_W=1000 python3 media/board-demo/edit.py "$REC" out/ "$REC/terminal"
```

It adds the title card, speeds up the waits (and everything by `SPEED`), puts a caption under each step,
adds the Terminal slides, and writes the MP4s and `out/whiteboard.gif`
(about 32 s, about 5 MB); `FIRST` keeps only that many seconds of the first diagram. Copy the GIF to `media/whiteboard.gif`.

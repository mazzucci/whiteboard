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

The GIF opens in Claude Code and comes back to it at the end, so it is plain
that the board belongs to the session: the prompt, Claude calling the
whiteboard, and the summary after the wrap-up. For that, take snapshots of the session's Terminal window during
the take (window only, never the screen), name each `<epoch ms>.jpg` in a
folder, and add a `slides.json` there:

```json
[
  {"file": "1791325690777.jpg", "after": "title", "clear": 182, "crop": [40, 200], "seconds": 2.4,
   "caption": "It starts in Claude Code, in your terminal"},
  {"file": "1791325703339.jpg", "after": "said yes", "crop": [580, 910], "mark": [821, 835], "seconds": 3.0,
   "caption": "What you type on the board arrives in the same session"},
  {"file": "1791325734376.jpg", "after": "end", "crop": [505, 915], "seconds": 3.8,
   "caption": "Wrap up: the summary is back in Claude Code"}
]
```

`after` is where the slide goes (after the title card, a second after a
recorder mark, or at the end), `crop` the lines shown (y from, y to),
`mark` a line outlined, `clear` blanks what came after a line, for the
moment the prompt went in. The title bar and Claude Code's banner (account,
path) are blurred. The take for the README ran with `REC_W=1120` for the
recorder, so the page looks like a browser window beside a terminal.

## The before/after GIF

The same idea with `media/board-demo/recorder-qa.mjs`, which asks a
follow-up on the board instead of answering a proposal, and
`media/board-demo/compare.py`, which puts plain Claude Code (snapshots of its
Terminal window, without the plugin) before the board recording, with three
snapshots of the board session's own Terminal: Claude calling the whiteboard,
the board opened, and the follow-up arriving in the session.

## The edit

```bash
SPEED=1.4 GIF_W=1000 python3 media/board-demo/edit.py "$REC" out/ "$REC/terminal"
```

It adds the title card, speeds up the waits (and everything by `SPEED`), puts a caption under each step,
adds the Terminal slides, and writes the MP4s and `out/whiteboard.gif`
(about 35 s, under 4 MB). Copy the GIF to `media/whiteboard.gif`.

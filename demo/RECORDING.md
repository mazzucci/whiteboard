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

## The before/after GIF

The same idea with `media/board-demo/recorder-qa.mjs`, which asks a
follow-up on the board instead of answering a proposal, and
`media/board-demo/compare.py`, which puts plain Claude Code (snapshots of its
Terminal window, without the plugin) before the board recording, with three
snapshots of the board session's own Terminal: Claude calling the whiteboard,
the board opened, and the follow-up arriving in the session.

## The edit

```bash
python3 media/board-demo/edit.py "$REC" out/
```

It adds the title card, speeds up the waits, puts a caption under each step,
and writes `out/whiteboard-demo.mp4` and `out/whiteboard.gif` (about 40 s,
under 4 MB). Copy the GIF to `media/whiteboard.gif`.

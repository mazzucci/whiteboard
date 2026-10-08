---
name: live-take
description: Record a real Claude Code session using Whiteboard, with a script playing the person on the board, to find glitches tests miss and to make demo GIFs. Covers the BROWSER hand-off, the recorders in media/board-demo, launching the session in Terminal, watching the take, reading frames and Claude's tool calls, and cutting a GIF. Use for any visible feature before merging, and when the person asks for a demo or a recording.
---

# A live take

Tests prove the page; a live take proves the product: what Claude actually
draws, how it reads the person's selection, what the page looks like with real
content. Takes found what no test did: a chart label with spaces dropped from
a sticky note, a selection kept after sending, bars faded to nothing, long
labels overlapping. Record one for every visible change. The full guide for
the README's GIFs is `demo/RECORDING.md`; this is the working loop.

## Set up a take

Pick a take folder `R` (in your scratchpad), and a project folder for the
session: a copy of `demo/checkout-service/` (fictional service and numbers).
Claude Code asks to trust a new folder: reuse a copy the person already
trusted, or ask them to answer the prompt once.

```bash
mkdir -p "$R/frames"
cat > "$R/opener.sh" <<EOF
#!/bin/sh
printf '%s' "\$1" > "$R/url.txt"
EOF
chmod +x "$R/opener.sh"
cat > "$R/run.sh" <<EOF
cd "<project copy>"
BROWSER="$R/opener.sh" claude "<the prompt>" --plugin-dir <worktree>/plugin --allowedTools=mcp__whiteboard__post_to_board,mcp__whiteboard__read_board,Read
EOF
```

`BROWSER` hands the board's address to the recorder instead of a browser.
`--plugin-dir` points at the worktree, so the take runs the branch's code.

## Run it

```bash
cd "$R" && PUPPETEER_HOME=<worktree>/test nohup node <worktree>/media/board-demo/recorder-charts.mjs "$R" > "$R/recorder.log" 2>&1 &
osascript -e "tell application \"Terminal\" to do script \"bash '$R/run.sh'\""
```

Recorders: `recorder.mjs` (the README's walkthrough, canvas included),
`recorder-qa.mjs` (a follow-up question), `recorder-charts.mjs` (click a bar,
ask; Shift+click two, ask; wrap up). Each logs marks and page errors, saves
every painted frame to `$R/frames/` and their times to `$R/frames.json`, and
stops on its own. Write a new recorder for a new feature by copying the
closest one: its marks are the story.

Watch with the Monitor tool on `recorder.log` (exit when it prints
`frames N`); a take takes one to three minutes.

## Read the take

- The log: marks, what Claude answered, any `PAGE ERROR` or `GLITCH?` line.
- Frames at each mark (map mark times to frame numbers from `frames.json`),
  then Read the JPEGs: overlaps, cut labels, notes in the wrong place, a
  selection that did not show, a hint that says the wrong thing.
- What Claude actually called: the session's transcript is in
  `~/.claude/projects/*/<session>.jsonl`; find it by a phrase the recorder
  typed, and print the `tool_use` inputs whose name contains `board`
  (read-only; never write there).

A glitch found: fix it with a test (the `ship-a-change` skill), then take
again. Claude draws differently each time; three takes are normal.

## Cut a GIF

```bash
python3 media/board-demo/edit-charts.py "$R" out/        # charts takes
FIRST=2.4 WINDOW=1 SPEED=1.4 GIF_W=1000 python3 media/board-demo/edit.py "$R" out/ "$R/terminal"   # the README walkthrough
```

Look at frames of the result before using it. Re-record when the code changed
after the take, so the GIF shows what ships. The README's GIFs change only
when the person asks.

## Privacy

Capture the page (headless) or one window (`window-recorder.swift`), never
the screen. Blur names, paths and accounts in Terminal frames (`edit.py` does
the title bar and banner). The board label is the project folder's name: use
a neutral one.

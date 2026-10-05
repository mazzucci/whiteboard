# Recording the demo video

A real screen recording of Claude Code with the whiteboard, from a simulated
investigation (`checkout-service/investigation.md`: fictional service, code and
numbers). Claude, the plugin and every diagram are real. The edit adds the
intro and outro cards from `media/explainer/` and speeds up the waiting.

## Before recording

1. Install the plugin (desktop app: Settings, plugins section, add the
   marketplace `mazzucci/whiteboard`, install **whiteboard**;
   after an update to it, update the plugin there too), then run
   `/whiteboard setup` once in any session.
2. In the Claude Code desktop app, start a **new session** in
   `demo/checkout-service/`, so Claude sees only the investigation notes.
3. Collapse the sidebar, so no other session names or account details show.
   Use the light appearance.
4. Make the window about 1600 × 1000, with the conversation on the left and
   room for the pane on the right.
5. Optional: run `/whiteboard` once to open the pane, so the first diagram does
   not resize the layout mid-recording.

## Recording

Press ⇧⌘5, choose **Record Selected Portion**, and frame the Claude window.

1. Paste this prompt and send it:

   > This is our investigation of the slow checkout endpoint
   > (investigation.md). Walk me through it step by step, drawing each stage on
   > the whiteboard as you go: first the request path, then what the trace
   > shows, then the proposed fix. Keep your answers short.

2. Let Claude finish all three diagrams. Don't touch anything; the waiting is
   cut in the edit.
3. Click once on the whiteboard pane, then press, about a second apart:
   - `i` `i`: zoom in to 150%
   - `d` `d`: pan right, across the N+1
   - `o` `o`: back to 100%
   - `c`, then `c` again: the Mermaid source, then back
   - `p` `p`: step back through the history to the request path
   - `n` `n`: forward to the proposed fix
4. Stop the recording (the stop button in the menu bar).

A take where Claude's diagrams look wrong or cluttered: start a new session
and record again. Two or three takes are normal.

## What to send for the edit

The `.mov` file from the Desktop. It is cropped to the conversation and the
pane, sped up while Claude thinks or streams, given the caption bar, and placed
between the shortened intro and the lifecycle outro.

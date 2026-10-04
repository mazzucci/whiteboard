# Explainer video

A stylised, deterministic explainer for the whiteboard: an HTML/CSS/SVG stage
with a `window.seek(t)` timeline, screenshotted frame by frame with Puppeteer
and encoded with ffmpeg. It is an animated illustration, not a screen
recording of Claude Code; the chat column and pane are a neutral design of our
own. Every diagram is a real Mermaid 12.1 render from the project's renderer.

```
node media/explainer/render-diagrams.mjs          # src/diagrams/*.mmd -> build/diagrams.json (+ build/png for checking)
node media/explainer/build.mjs --mode full        # out/whiteboard-explainer-1080p.mp4 (YouTube)
node media/explainer/build.mjs --mode short       # out/whiteboard-readme-720p.mp4 and .gif (README)
node media/explainer/build.mjs --mode s30 --name whiteboard-30s-1080p                 # the 30 s cut
node media/explainer/build.mjs --mode s30 --small --name whiteboard-30s-readme-720p   # same, 720p + .gif
node media/explainer/build.mjs --mode full --preview 12,40,80   # stills in build/preview-full/
```

Needs `/whiteboard setup` to have run (puppeteer-core and Mermaid in
`~/.cache/whiteboard`), Google Chrome, and ffmpeg at `/usr/local/bin/ffmpeg`.

- `src/diagrams/*.mmd`: the Mermaid sources (a fictional hotel-booking platform,
  "Nimbus"). `6-hypothesis-broken.mmd` is deliberately invalid: its real parse
  error is what the video shows in the self-correction scene. `6-double-charge-1`
  to `-4` are one diagram redrawn as evidence arrives, with the skill's
  `confirmed` / `suspect` / `unverified` / `ruledout` classes and legend;
  `4-pr-risk` is the risk lens and `5-pipeline-1` to `-3` the CI pipeline
  redrawn with the progress lens (done / running / waiting / failed), all from
  "Show what you know" in the skill.
- `src/stage.html|css|js`: the stage. `init(diagrams, mode)` then `seek(t)`.
- `src/timeline.js`: all timings for the `full`, `short` and `s30` cuts. `s30`
  is the 30-second cut: wall of text, splash, one debugging story (`10-span-a` / `-b` / `-c`,
  one layout cross-faded: request map, p95 trace, proposed fix) and the lifecycle outro
  (`11-lifecycle`). `9-pr-before/after` are kept for a future review clip, unused.
- `build.mjs`: Puppeteer -> ffmpeg; warns about captions shorter than
  3 s + 0.3 s per word.

## Publishing the README's GIF

The GIF at the top of the README lives on the `media` branch, not on `main`:
installing the plugin clones `main` shallowly, so nothing on `media` is ever
downloaded by an install. The README loads it from
`https://raw.githubusercontent.com/mazzucci/whiteboard-for-claude-code/media/whiteboard.gif`.
To replace it, commit the new file to `media` as `whiteboard.gif` and push that
branch; `main` needs no change.

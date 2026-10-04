# YouTube listing for the explainer

Two cuts share this listing: the 30-second cut (`whiteboard-30s-1080p.mp4`,
the one to upload) and the longer 108-second explainer kept for reference.
The 30-second cut shows no repository link on screen, so the description below
carries it.

## Title

Whiteboard for Claude Code: diagrams beside the conversation (open source, unofficial)

## Description

Unofficial open-source project. Not affiliated with or endorsed by
Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.

This video is an animated illustration of how the mod works, not a screen
recording. The chat column and whiteboard pane are a stylised stand-in for the
real interface. Every diagram shown is a real Mermaid 12.1 render produced by
the project's own renderer (headless Chrome, no network), exactly as the pane draws it.

Whiteboard for Claude Code is a mod for Claude Code desktop: while Claude
answers, it can call a show_diagram tool with Mermaid source. The mod renders
it locally with Mermaid 12.1 in a warm headless browser and shows the exact SVG
on a Whiteboard pane beside the conversation. Mermaid's parse errors go back to
Claude, which fixes its own diagram. The pane keeps a history of the whole
conversation's diagrams (p / n), flips to the Mermaid source (c), zooms (i / o /
0) and pans (w a s d). Rendering stays on your machine: no CDN, no network
calls, nothing published.

Use cases in the longer explainer (the 30-second cut shows a single debugging story: a request map that Claude fills in with trace timings, finds an N+1, and redraws with the proposed fix):
- Onboarding a codebase: context, containers, components, stepping back through
  the history.
- Shipping a change: the PR coloured by one lens at a time (risk), then its CI
  pipeline redrawn as it runs (done, running, waiting, failed), each with a
  legend, all plain Mermaid classDef.
- Troubleshooting a bug: a hypothesis drawn with every step "not yet checked",
  then the same diagram redrawn as each piece of evidence arrives (confirmed,
  suspect, ruled out), so the history reads as the investigation. Includes the
  self-correction loop when Mermaid rejects a diagram.

Repository: https://github.com/mazzucci/whiteboard-for-claude-code
License: MIT. Experimental: built on Claude Code's early-access mod API, which
may change between releases. The systems in the diagrams ("Nimbus", a hotel
booking platform) are fictional.

Music: added in YouTube Studio at upload (see "Music" below); the file itself is silent.

## Chapters (30-second cut)

0:00 Too much to read: a wall of explanation that outruns the reader
0:05 Let Claude draw it, right in Claude Code
0:08 Debugging a slow request: request map, then the p95 trace with an N+1, then the proposed fix, one diagram redrawn in place
0:26 Whiteboard for Claude Code · open source · not affiliated with Anthropic

## Chapters (108-second explainer)

0:00 The problem: explaining a system in prose
0:04 Claude draws while it explains
0:08 Use case 1: onboarding a codebase (context, containers, components)
0:21 Zoom and pan
0:28 Stepping back through the history
0:33 Use case 2: shipping a change (the PR by risk, with a legend)
0:43 The CI pipeline redrawn as it runs (progress lens)
0:56 Flip to the Mermaid source
0:59 Use case 3: troubleshooting a bug (Mermaid error, self-correction)
1:05 Hypothesis: every step not yet checked
1:12 Evidence redraws the picture (steps 2 to 4)
1:30 How it works: tool, warm renderer, headless Chrome, SVG, all local
1:42 Outro: repo, MIT, community project

## Tags

Claude Code, Claude Code mod, Mermaid, Mermaid diagrams, software architecture,
C4 model, code review, CI pipeline, progress lens, debugging, root cause analysis, developer
tools, open source, headless Chrome, whiteboard, AI coding assistant, unofficial

## Files

- whiteboard-30s-1080p.mp4: the 30-second cut (1920×1080, 30 fps, H.264, no audio)
- whiteboard-30s-readme-720p.mp4 / .gif: the same 30 seconds for the README

- whiteboard-explainer-1080p.mp4: the longer 108-second cut, kept for reference (1920×1080, 30 fps, H.264, no audio)
- whiteboard-readme-720p.mp4 / .gif: the short README cut (the evidence loop)

## Music (added at upload)

The video files are silent on purpose; add music in YouTube Studio so it stays
cleared for YouTube:

1. YouTube Studio → the video → **Editor** → **Audio**.
2. Filter by mood (e.g. Happy, Bright), preview, add a track.
3. Trim it to the video's 30 s and add a short fade-out.
4. If the track's licence asks for attribution, paste its attribution line into
   the description.

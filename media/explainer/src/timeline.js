// Timelines for the explainer. All times in seconds; everything is a pure
// function of time, so frames are deterministic. Two cuts: `full` (YouTube,
// 1920×1080) and `short` (README, 1280×720, same stage scaled by 2/3).
//
// Event kinds
//   chat:  user | claude | tool | error | reset
//   board: add {name, wipe?} | goto {index, key} | zoom {level, key} |
//          pan {dx, dy, key} | fit {key} | source {on, key, scroll}
//
// Captions stay up at least 3 s + 0.3 s per word (build.mjs checks).

const CPS = { user: 45, claude: 75 }

const full = {
  duration: 108,
  cards: [
    { id: 'card-prose', t0: 0, t1: 4.4 },
    { id: 'card-title', t0: 4.4, t1: 8.6 },
    { id: 'arch', t0: 90.4, t1: 102.7 },
    { id: 'card-outro', t0: 102.7, t1: 108 },
  ],
  prose: { t0: 0.6, cps: 260 },
  app: { t0: 8.3, t1: 90.4 },
  arch: { t0: 91.0, step: 0.5, local: 97.2 },
  chapters: [
    { t0: 8.3, t1: 33.3, text: '1 · Onboarding a codebase' },
    { t0: 33.3, t1: 59.4, text: '2 · Shipping a change' },
    { t0: 59.4, t1: 90.4, text: '3 · Troubleshooting a bug' },
  ],
  captions: [
    { t0: 11.9, t1: 15.9, text: 'Big picture first' },
    { t0: 16.2, t1: 20.8, text: 'One level closer each answer' },
    { t0: 20.9, t1: 27.0, text: 'Zoom: <span class="k">i</span> / <span class="k">o</span> · Pan: <span class="k">w a s d</span>' },
    { t0: 27.8, t1: 33.3, text: 'Step back through the history: <span class="k">p</span> / <span class="k">n</span>' },
    { t0: 36.5, t1: 41.4, text: 'One lens at a time: risk' },
    { t0: 43.2, t1: 47.6, text: 'Redrawn as CI runs' },
    { t0: 48.3, t1: 53.5, text: 'Failed step, and what waits behind it' },
    { t0: 53.6, t1: 59.4, text: 'All green. Plain Mermaid classDef (<span class="k">c</span> shows the source)' },
    { t0: 62.9, t1: 68.7, text: 'Mermaid’s error goes back to Claude, which fixes it' },
    { t0: 68.8, t1: 73.7, text: 'Hypothesis: every step not yet checked' },
    { t0: 73.8, t1: 78.9, text: 'Each piece of evidence redraws the picture' },
    { t0: 79.0, t1: 84.2, text: 'Solid = confirmed · dashed = not yet checked' },
    { t0: 84.7, t1: 90.4, text: 'Last step: only what the evidence supports' },
    { t0: 91.0, t1: 95.8, text: 'Claude calls <span class="k">show_diagram</span> with Mermaid source' },
    { t0: 95.9, t1: 102.7, text: 'A warm renderer drives headless Chrome: Mermaid 12.1, exact SVG, all local' },
  ],
  chat: [
    { t0: 8.6, kind: 'user', text: "I'm new here. What is Nimbus, and who uses it?" },
    { t0: 10.4, kind: 'claude', text: 'A hotel booking platform. Guests and hotel staff use it; it relies on a payment provider, a channel manager and a messaging service.' },
    { t0: 11.2, kind: 'tool', title: 'Nimbus: system context', done: 11.9 },
    { t0: 15.6, kind: 'user', text: "Zoom in: what's inside?" },
    { t0: 16.5, kind: 'claude', text: 'Two front ends behind an API gateway, two services, their stores and an event bus.' },
    { t0: 17.0, kind: 'tool', title: 'Nimbus: containers', done: 17.7 },
    { t0: 25.0, kind: 'user', text: 'How is the booking service built?' },
    { t0: 26.0, kind: 'claude', text: 'HTTP handlers call booking commands, which use quote, payment and repository components; an outbox relay publishes events.' },
    { t0: 26.6, kind: 'tool', title: 'Booking service: components', done: 27.3 },
    { t0: 33.3, kind: 'reset' },
    { t0: 33.6, kind: 'user', text: 'PR #214 "retry payments safely" is up. Which parts are risky?' },
    { t0: 35.2, kind: 'claude', text: 'The retry queue moves money on its own: high. The keyed charge and the reconciler: medium. The rest is unchanged.' },
    { t0: 35.8, kind: 'tool', title: 'PR #214 by risk', done: 36.5 },
    { t0: 40.6, kind: 'user', text: 'Ship it. How is CI doing?' },
    { t0: 41.6, kind: 'claude', text: 'Lint and build passed. Unit tests and the image scan are running; deploy waits on both.' },
    { t0: 42.4, kind: 'tool', title: 'PR #214 pipeline, 14:32', done: 43.1 },
    { t0: 47.0, kind: 'claude', text: 'Image scan failed: CVE-2026-1187 in the base image. Deploy stays blocked.' },
    { t0: 47.6, kind: 'tool', title: 'PR #214 pipeline, 14:35', done: 48.3 },
    { t0: 51.4, kind: 'user', text: 'Bumped the base image, pushed.' },
    { t0: 52.3, kind: 'claude', text: 'All green: scan clean, staging deployed, smoke test passed.' },
    { t0: 52.9, kind: 'tool', title: 'PR #214 pipeline, 14:41', done: 53.6 },
    { t0: 59.4, kind: 'reset' },
    { t0: 59.7, kind: 'user', text: 'Some guests were charged twice last night around 02:14. What happened?' },
    { t0: 61.5, kind: 'claude', text: 'Hypothesis first, nothing checked yet: the provider timed out and we retried with a new attempt id. Or a double submit.' },
    { t0: 62.2, kind: 'error', title: 'Double charge 02:14: hypothesis', done: 62.9, diagram: '6-hypothesis-broken' },
    { t0: 64.0, kind: 'claude', text: 'Fixing the charge label: parentheses need quotes.' },
    { t0: 64.9, kind: 'tool', title: 'Double charge 02:14: hypothesis', done: 65.6 },
    { t0: 70.0, kind: 'user', text: 'Gateway log at 02:14:07 shows one request.' },
    { t0: 71.2, kind: 'claude', text: 'One POST in the log, so no double submit. The first step is confirmed.' },
    { t0: 71.8, kind: 'tool', title: 'Double charge 02:14: step 2', done: 72.5 },
    { t0: 76.0, kind: 'user', text: 'Provider dashboard: two captures, 11 s apart.' },
    { t0: 77.2, kind: 'claude', text: 'Both charges are real, so the timeout hid a success. The retry is now suspect.' },
    { t0: 77.9, kind: 'tool', title: 'Double charge 02:14: step 3', done: 78.6 },
    { t0: 82.0, kind: 'user', text: 'What does the retry do?' },
    { t0: 82.9, kind: 'claude', text: 'payment/client.go:88 builds a fresh attempt id, so the provider sees a new charge. That is the cause.' },
    { t0: 84.0, kind: 'tool', title: 'Double charge 02:14: step 4', done: 84.7 },
  ],
  board: [
    { t0: 11.9, kind: 'add', name: '1-context' },
    { t0: 17.7, kind: 'add', name: '2-containers' },
    { t0: 21.2, kind: 'zoom', level: 1.3, key: 'i' },
    { t0: 22.0, kind: 'zoom', level: 1.69, key: 'i' },
    { t0: 22.8, kind: 'pan', dx: 0, dy: -170, key: 's' },
    { t0: 23.6, kind: 'pan', dx: -140, dy: 0, key: 'd' },
    { t0: 25.6, kind: 'fit', key: '0' },
    { t0: 27.3, kind: 'add', name: '3-components' },
    { t0: 28.0, kind: 'goto', index: 1, key: 'p' },
    { t0: 29.2, kind: 'goto', index: 0, key: 'p' },
    { t0: 30.4, kind: 'goto', index: 1, key: 'n' },
    { t0: 31.4, kind: 'goto', index: 2, key: 'n' },
    { t0: 36.5, kind: 'add', name: '4-pr-risk' },
    { t0: 43.1, kind: 'add', name: '5-pipeline-1' },
    { t0: 48.3, kind: 'add', name: '5-pipeline-2' },
    { t0: 53.6, kind: 'add', name: '5-pipeline-3' },
    { t0: 56.2, kind: 'source', on: true, key: 'c', scroll: 560 },
    { t0: 59.0, kind: 'source', on: false, key: 'c' },
    { t0: 65.6, kind: 'add', name: '6-double-charge-1' },
    { t0: 72.5, kind: 'add', name: '6-double-charge-2' },
    { t0: 78.6, kind: 'add', name: '6-double-charge-3' },
    { t0: 84.7, kind: 'add', name: '6-double-charge-4' },
  ],
}

const short = {
  duration: 26,
  cards: [
    { id: 'card-title', t0: 0, t1: 2.8 },
    { id: 'card-outro', t0: 22.6, t1: 26 },
  ],
  prose: null,
  app: { t0: 2.6, t1: 22.6 },
  arch: null,
  chapters: [{ t0: 2.6, t1: 22.6, text: 'Troubleshooting a bug' }],
  captions: [
    { t0: 5.4, t1: 10.5, text: 'Hypothesis first: every step not yet checked' },
    { t0: 10.6, t1: 15.7, text: 'Each piece of evidence redraws the picture' },
    { t0: 15.8, t1: 22.6, text: 'Solid = confirmed · dashed = not yet checked' },
  ],
  chat: [
    { t0: 2.8, kind: 'user', text: 'Some guests were charged twice last night around 02:14. What happened?' },
    { t0: 4.4, kind: 'claude', text: 'Hypothesis first, nothing checked yet.' },
    { t0: 4.8, kind: 'tool', title: 'Double charge 02:14: hypothesis', done: 5.4 },
    { t0: 8.2, kind: 'user', text: 'Gateway log at 02:14:07 shows one request.' },
    { t0: 9.3, kind: 'claude', text: 'One POST logged: no double submit.' },
    { t0: 9.7, kind: 'tool', title: 'Double charge 02:14: step 2', done: 10.3 },
    { t0: 13.0, kind: 'user', text: 'Provider dashboard: two captures, 11 s apart.' },
    { t0: 14.1, kind: 'claude', text: 'The timeout hid a success. The retry is suspect.' },
    { t0: 14.5, kind: 'tool', title: 'Double charge 02:14: step 3', done: 15.1 },
    { t0: 17.6, kind: 'user', text: 'What does the retry do?' },
    { t0: 18.4, kind: 'claude', text: 'client.go:88 builds a fresh attempt id. That is the cause.' },
    { t0: 18.9, kind: 'tool', title: 'Double charge 02:14: step 4', done: 19.5 },
  ],
  board: [
    { t0: 5.4, kind: 'add', name: '6-double-charge-1' },
    { t0: 10.3, kind: 'add', name: '6-double-charge-2' },
    { t0: 15.1, kind: 'add', name: '6-double-charge-3' },
    { t0: 19.5, kind: 'add', name: '6-double-charge-4' },
  ],
}

// 30 s cut: shows rather than explains. Twice the typing speed, tool-call
// chips, one catchphrase caption per story, no key overlays.
const s30 = {
  duration: 30,
  cps: { user: 90, claude: 150 },
  bodyClass: 's30',
  maxScale: 2.1,
  // Pane-header titles for diagrams drawn without a front-matter title.
  titles: {
    '10-span-a': 'POST /checkout · request map',
    '10-span-b': 'POST /checkout · p95 trace',
    '10-span-c': 'POST /checkout · proposed fix',
  },
  cards: [
    { id: 'card-wall', t0: 0, t1: 4.7 },
    { id: 'card-splash', t0: 4.7, t1: 8.0 },
    { id: 'card-ch2', t0: 8.0, t1: 9.0, d: 0.25 },
    { id: 'card-outro30', t0: 26.0, t1: 30 },
  ],
  wall: { t0: 0.4, cps0: 240, acc: 240, blurAt: 3.5, t1: 4.7 },
  prose: null,
  arch: null,
  app: { t0: 8.7, t1: 26.0 },
  intro: { t0: 8.8, dur: 0.8 },
  chapters: [],
  captions: [
    { t0: 10.6, t1: 25.7, text: 'Live diagrams as Claude investigates' },
  ],
  chat: [
    { t0: 9.1, kind: 'user', text: 'Why is checkout slow?' },
    { t0: 9.5, kind: 'cmd', name: 'Read', arg: 'checkout/handler.go', done: 9.9 },
    { t0: 9.9, kind: 'claude', text: 'Mapping the request…' },
    { t0: 10.1, kind: 'tool', title: 'POST /checkout · request map', done: 10.6 },
    { t0: 12.3, kind: 'cmd', name: 'Read', arg: 'traces/checkout-p95.json', done: 12.7 },
    { t0: 12.7, kind: 'cmd', name: 'Bash', arg: 'grep -c \'"inventory.check"\' traces/checkout-p95.json', done: 13.2 },
    { t0: 13.3, kind: 'claude', text: 'p95 3,400 ms: pricing.quote makes 1,240 inventory.check calls, an N+1.' },
    { t0: 13.7, kind: 'tool', title: 'POST /checkout · p95 trace', done: 14.2 },
    { t0: 19.0, kind: 'claude', text: 'Proposal: batch them into one call. Re-run the trace to confirm.' },
    { t0: 19.6, kind: 'tool', title: 'POST /checkout · proposed fix', done: 20.1 },
  ],
  board: [
    { t0: 10.6, kind: 'add', name: '10-span-a' },
    { t0: 14.2, kind: 'add', name: '10-span-b', xfade: 0.9 },
    { t0: 20.1, kind: 'add', name: '10-span-c', xfade: 0.9 },
  ],
  reveals: [
    { host: 'life-canvas', name: '11-lifecycle', w: 1600, h: 300, t0: 26.3, step: 0.2,
      order: ['proto', 'L_proto_tests', 'tests', 'L_tests_review', 'review', 'L_review_merge', 'merge', 'L_merge_release', 'release'] },
  ],
  fades: [
    { id: 'board-label', t0: 9.0, t1: 10.5, d: 0.3 },
    { id: 'life-title', t0: 28.1, d: 0.6, rise: 24 },
  ],
}

window.TIMELINES = { full, short, s30, CPS }

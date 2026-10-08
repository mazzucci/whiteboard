---
name: ship-a-change
description: The workflow for any change to Whiteboard, from branch to merge - worktree, tests for each behaviour and each bug, a look at the result, docs, a pull request, CI, an independent review, fixes, merge and cleanup. Use whenever you are about to change code, docs or media in this repository.
---

# Shipping a change

`main` is protected (six required checks, pull requests only, admins too), so
every change takes this road. Slow enough to catch regressions, fast because
each step is known.

## 1. Branch in a worktree

```bash
git -C <repo> pull --ff-only
git -C <repo> worktree add ../whiteboard-<topic> -b <topic> main
cd ../whiteboard-<topic>/test && npm ci        # page tests need puppeteer-core here
```

Work only in the worktree: a `claude --plugin-dir <repo>/plugin` session the
person keeps open must not see half-done files.

## 2. Build it, with tests as you go

- Read the code you touch first; match its comments and names
  (`whiteboard-orientation`).
- One test per behaviour, named as a sentence about what the person or Claude
  sees: `test('a click selects a slice and the next message says so', …)`.
- One test per bug found, written so it fails on the old code. When you can,
  check that it does (`git stash`, run, `git stash pop`).
- Page tests drive a real board: `board()` starts a server and Chrome,
  `b.call('/post', {...})` is the plugin's side, `look(page)` reads the page's
  state, `b.said` holds what reached the session. Downloads:
  `Browser.setDownloadBehavior` to a temp dir; a reconnect: call
  `events.onopen()` and feed `/cards` back through `onEvent`.
- Look at it, not only assert it: a throwaway `test/page/shot.mjs` that posts
  realistic content and `page.screenshot()`s, then read the PNG. Phone width:
  `page.setViewport({ width: 390, height: 760, isMobile: true, hasTouch: true })`.
  Delete the script after.
- A change Claude must know about: update `plugin/skills/drawing/SKILL.md`
  and the tool description in `plugin/hooks/register.tsx`.

## 3. Run everything

```bash
claude plugin validate --strict plugin
CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin test plugin
node --test plugin/tests/server.test.mjs
(cd test && node --test --test-concurrency=1 --test-timeout=120000 page/*.test.mjs)
```

macOS has no `timeout` command: use `--test-timeout`. A run that goes quiet is
usually a test waiting on a selector that changed.

## 4. Docs

- `CHANGELOG.md`: lines under `## 0.x.y (unreleased)`, written for the person
  using it ("Fixed: …", what they can now do).
- `README.md`: the feature in "What the board does", and Security or Limits
  when they change.

## 5. Pull request

```bash
git add -A && git commit -m "<what changed, as the person would say it>

Co-Authored-By: <the model's attribution line>"
git push -u origin <topic>
gh pr create --base main --head <topic> --title "<short>" --body "<what, why, tests, ending with the attribution line>"
```

The body says what changed and why, what was decided against, and the test
counts. Then use the app's PR tools (`get_status`, `bind_pr`) to watch CI;
never poll CI in a loop.

## 6. Independent review, while CI runs

Start a reviewer subagent on the branch (the `independent-review` skill):
ranked findings, each reproduced, and a verdict. For anything visible, also
consider a live take (`live-take` skill): real Claude sessions find glitches
tests do not (they found the chart label bug, the sticky selection and the
pale fading).

## 7. Fix what holds up

Each confirmed finding gets a fix and a test; push again. Findings that are
out of scope go into a GitHub issue for the next version, not into this PR.

## 8. Merge and clean up

Only when all six checks are green on the latest commit:

```bash
gh pr checks <n>                       # once, to confirm, not in a loop
gh pr merge <n> --merge
git -C <repo> pull --ff-only
git -C <repo> worktree remove ../whiteboard-<topic> --force
git -C <repo> branch -D <topic> && git -C <repo> push origin --delete <topic>
```

A release is a separate step (the `release` skill), done when the person asks.

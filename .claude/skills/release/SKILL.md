---
name: release
description: Release a new version of Whiteboard - version bump, changelog, README media, a release pull request, tag, GitHub release from the changelog, and updating the person's installed plugin. Use when the person asks to release, publish or "cut" a version.
---

# Releasing

Merged changes are not released until this is done: the installed plugin
(`whiteboard@mazzucci`) reads the version in `plugin/.claude-plugin/plugin.json`.

## 1. The release branch

```bash
git -C <repo> pull --ff-only
git -C <repo> worktree add ../whiteboard-release -b release-<x.y.z> main
```

- `plugin/.claude-plugin/plugin.json`: `"version": "<x.y.z>"` (patch for
  fixes and small features, minor for a new kind of thing, as 0.4 canvas and
  0.5 charts).
- `CHANGELOG.md`: `## <x.y.z> (unreleased)` becomes `## <x.y.z>`; read it as
  release notes and tighten.
- README: new media only when the person asked for it. A GIF from a take of
  this version's code (the `live-take` skill), with alt text that says what
  happens and a `<sub>` line saying what is real and what is scripted.
- Check nothing else names the old version: `grep -rn "<old version>" --include=*.json --include=*.md .`

## 2. Pull request, CI, merge

As in `ship-a-change`: commit, push, `gh pr create` (title
`Release <x.y.z>: <headline>`), wait for the six checks on the latest commit,
`gh pr merge <n> --merge`.

## 3. Tag and publish

```bash
git -C <repo> pull --ff-only
awk '/^## <x.y.z>/{f=1;next} /^## /{f=0} f' CHANGELOG.md > "$TMPDIR/notes.md"
git -C <repo> tag -a v<x.y.z> -m "<x.y.z>: <headline>"
git -C <repo> push origin v<x.y.z>
gh release create v<x.y.z> --title "<x.y.z>: <headline>" --notes-file "$TMPDIR/notes.md"
```

## 4. The person's install

```bash
claude plugin update whiteboard@mazzucci
```

It says "updated from <old> to <new>"; the person restarts Claude Code to load
it. Then clean up the worktree and the release branch (local and remote).

Report: the release link, what is in it in a few lines, and the restart.

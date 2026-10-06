# Security

Whiteboard runs a small web server on your machine for each Claude Code
session that draws on it, and passes what you type on its page into that
session as your own words. Its design, and what it does and does not protect
against, is in the README's [Security and privacy](README.md#security-and-privacy)
section.

## Reporting a vulnerability

Please report it privately, through GitHub's
[private vulnerability reporting](https://github.com/mazzucci/whiteboard/security/advisories/new)
for this repository, not in a public issue. Include what you did, what
happened, and the version (`claude plugin list` shows it).

This is a personal open source project: I'll answer as soon as I can, and fix
confirmed issues in a new release, credited unless you prefer otherwise.

## Supported versions

Only the latest release on `main` gets fixes. Update with
`claude plugin marketplace update mazzucci`, then
`claude plugin update whiteboard@mazzucci`.

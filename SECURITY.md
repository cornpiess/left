# Security Policy

## Privacy stance

LeftSwipe processes everything on-device. There is no telemetry, no analytics SDK, and no photo data transmission. Any change that adds a network call touching user media is out of scope for this project.

## Reporting a vulnerability

Please report privately via [GitHub Security Advisories](https://github.com/cornpiess/left/security/advisories/new) ("Report a vulnerability" button). Do **not** open a public issue for security problems.

Include: the app build number, iOS version, steps to reproduce, and impact. You will get a response within 14 days.

## Scope

- The app source in this repository (JS + the Swift PhotoKit module)
- The published legal pages (privacy / terms / support)

Out of scope: server-side infrastructure (there is none), Apple account issues, and vulnerabilities in third-party dependencies that don't affect this app at runtime.

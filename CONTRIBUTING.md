# Contributing to LeftSwipe

Thanks for your interest! This repository is the source of the shipping App Store app, so every change goes through the same gates the maintainers use.

## Setup

- **Node 24** and npm are required.
- **Xcode 16+** on macOS if you touch native code (the Swift module lives in `modules/maoqiu-photo-preview`).
- Expo Go is fine for pure-JS surfaces; features touching PhotoKit need a development build.

```bash
npm ci
npm test
npx expo start
```

## Before you open a PR

1. **`npm test` must pass** (198 tests; the pretest also runs static binding checks).
2. **`npx expo export --platform ios` must pass** — the JS bundle must build for Hermes.
3. If you changed UI strings, **all 6 locales must be updated together** (`src/i18n/locales/`): zh-Hans, zh-Hant, en, ja, ko, es.
4. Read [`docs/CORE_PRD.md`](docs/CORE_PRD.md) first. It defines the product's immutable principles (gesture direction, two-stage deletion, 100% on-device, daily free allowance, burst integrity…). A PR that conflicts with those principles will be rejected — the principles win over code.

## Product rules that come up most often

- **Zero telemetry.** No analytics, no crash reporters, no network calls with photo data. Local diagnostics only.
- **Seen photos are never re-suggested**; burst frames the user never actually saw must flow back as future candidates.
- **Gestures mute audio instantly** (0 ms) — video/Live Photo interlocks are load-bearing.
- PhotoKit facts (existence, permission, favorites) come from PhotoKit only; review facts (seen, pending-delete, daily usage) come from the local SQLite review store. Don't mix the two.

## Commit style

Follow the existing history: `fix(scope): summary` / `feat(scope): summary`, body explains *why*. Keep commits in English or Chinese, either is fine.

## Reporting bugs

Use the issue templates. Include iOS version, app build number (More menu → version row), library size, and whether iCloud Photos is enabled.

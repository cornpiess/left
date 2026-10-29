# LeftSwipe · 毛球

**Clean your photo library by swiping.** LeftSwipe (Chinese name: 毛球) turns the boring job of deleting photos into a fast, TikTok-style card feed — swipe left to mark a photo for cleanup, swipe right to keep it and never be bothered again.

[![Validate app](https://github.com/cornpiess/left/actions/workflows/validate.yml/badge.svg)](https://github.com/cornpiess/left/actions/workflows/validate.yml)

## Highlights

- **Swipe-to-clean feed** — full-library browsing with burst-group cards, Live Photos and videos, paced so a library of any size stays light.
- **Two-stage, reversible deletion** — swiped photos land in a Review Bin first. Nothing touches the system photo library until you explicitly empty the bin, with a native confirmation.
- **100% on-device, zero telemetry** — all analysis (burst grouping, storage estimates, seen-history) runs locally in SQLite and PhotoKit. No analytics, no tracking, no photo bytes leaving the device. See the [privacy policy](https://cornpiess.github.io/delete_photo/privacy.html).
- **Free daily allowance, PRO optional** — browsing is free forever; the daily free cleanup allowance covers typical use. PRO (subscription or one-time) removes the allowance via native StoreKit 2 purchases.
- **6 languages** — 简体中文, 繁體中文, English, 日本語, 한국어, Español.
- **Built for big libraries** — native PhotoKit paging, a shared image cache with priority/preload, and a durable browsing session that survives restarts. Designed and tested around 100k-photo, iCloud-heavy libraries.

## Architecture

The product behavior is defined by an immutable set of principles in [`docs/CORE_PRD.md`](docs/CORE_PRD.md) (bilingual-ish: Chinese). Supporting docs:

- [`docs/UNIFIED_REVIEW_ARCHITECTURE.md`](docs/UNIFIED_REVIEW_ARCHITECTURE.md) — unified cleanup architecture (SQLite review store, native photo pipeline)
- [`docs/BROWSE_SESSION_ARCHITECTURE.md`](docs/BROWSE_SESSION_ARCHITECTURE.md) — burst grouping, pacing and durable browsing sessions
- [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) — known issues, publicly tracked

**Stack**: Expo SDK 57 · React Native · Swift (custom PhotoKit module in [`modules/maoqiu-photo-preview`](modules/maoqiu-photo-preview)) · SQLite · Metro.

## Getting started

```bash
npm ci          # Node 24 recommended
npm test        # 198 tests, must be green before any build
npx expo start  # Metro dev server (Expo Go works for pure-JS surfaces)
```

Full local gate: `npm run validate` (tests + expo-doctor + iOS JS/Hermes export).

Release builds are produced through [EAS Build](https://docs.expo.dev/build/introduction/) (`eas.json`, production profile) and can be triggered from GitHub Actions (Actions → *iOS release build (EAS)* → Run workflow).

## 中文说明

毛球（海外名 LeftSwipe）是一款 iOS 相册清理应用：像刷短视频一样划卡整理照片，左滑标记清理、右滑保留；删除分两阶段可反悔；全部处理在本地完成，零遥测、零隐私泄露。本项目即 App Store 在售应用的完整源码，采用 MIT 协议开源。

## Contributing & License

- [Contributing guide](CONTRIBUTING.md) — dev setup, test gates, i18n rules
- [Security policy](SECURITY.md) — how to report vulnerabilities
- [MIT](LICENSE) © 2026 The LeftSwipe Authors

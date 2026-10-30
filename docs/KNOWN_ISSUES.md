# 已知问题登记（Known Issues Backlog）

> 建立日期：2026-09-06 ｜ 代码基线：HEAD `cf78197` (v271 / 1.0.1)
> 来源：全量代码 review（`src/` 12,913 行）
> **状态：ISSUE-001/002/004/006/007 已于 2026-09-19（v278）统一修复关闭；ISSUE-005 经产品决策不修；ISSUE-003 已于 v274 修复。本文件转为历史档案。**
>
> 说明：以下条目均为 review 中确证的**功能/数据缺陷**，原判定为 P0（违反 `docs/CORE_PRD.md` 的 P0 不变量）。
> 现按产品决策统一降级为 **P3 = 记录归档、不排期、不修复**。有人接手时再从本清单取任务，每条都自带定位与修复方向。
> 本文件不修改 PRD，不动任何代码。

## 优先级约定（本项目）

| 级别 | 含义 |
| --- | --- |
| P0 | 立刻修，阻塞发布 |
| P1 | 本迭代修 |
| P2 | 排期修 |
| **P3** | **只记录，暂不处理**（本文件全部条目当前状态） |

---

## 清单

### ISSUE-001 · 浏览历史可能整段丢失，导致「看过又推」且配额白扣 — **✅ 已修复（v278，2026-09-19）**

- **位置**：`src/media.js:336-344`（`markAssetViewed`）；对照 `src/membership.js:356-372`（`recordCardViewed`）
- ~~**问题**：已浏览记录只用 1500ms debounce 落盘，且**每次调用都重置计时器**（应为 throttle）；全仓无 `AppState` / 后台强制 flush。连续滑动（每张 <1.5s）时永不写盘。~~
- **修复记录（v278）**：`markAssetViewed` 改 trailing throttle（pending 时不重置计时器，至多 1.5s 一次写盘，丢失窗口从无限缩到 ≤1.5s）；media.js 新增 `AppState` 监听在 background/inactive 时同步 `flushViewedHistory()`（已导出）。回归测试 `tests/feed-hardening.test.mjs`。

### ISSUE-002 · 从毛球恢复后，照片在主信息流永久消失 — **✅ 已修复（v278，2026-09-19）**

- **位置**：`src/screens/HomeScreen.js:171,192`（`trashIdsRef` 镜像 + `makeFeed`）、`src/screens/HomeScreen.js:1173-1177`（`onChanged`）、`src/components/TrashGallery.js:194-208`（`handleRestore`）
- ~~**问题**：HomeScreen 维护了一份 `trashIds` 镜像，`makeFeed` 只按镜像过滤；收集箱恢复只改 `media.js` 内的 `trashIds`，`onChanged` 未回填镜像也未重建 feed。~~
- **修复记录（v278）**：单一状态源——`handleTrash/handleDayTrash` 不再把资产从 `rawAssetsRef` splice 掉，`makeFeed` 按 `trashIdsRef` 过滤成为唯一闸门；`markForTrash` 对 mark/unmark 都置 `suppressBurstRegroup`（恢复回流为独立单卡，不合回已解散卡组）；`TrashGallery.handleRestore` 把 item 传给 `onChanged(item)`，HomeScreen 侧 `trashIdsRef.delete` + `rebuildFeedPreservingPosition()`（新增锚定工具：重建后按当前查看项 id 重新锚定 activeIndex/burstPos/scrollToOffset，用户位置不丢）。

### ISSUE-003 · 左滑/右滑/捏合/播放报错 未在事件入口静音 — **✅ 已修复（v274，2026-09-12，用户下令）**

- **位置**：`src/components/MemoryCard.js:1024-1046`（`onPanResponderGrant` 的 swipe / pinch 分支）、`:898-902`（`commitTrash` 仅 `setPlaying(false)`）、`:862-895`（`commitFav` 无静音）、`:315`（视频 `error` 仅 `onEnd()`）
- **问题**：上述四个入口均未同步调用 `silenceAllPlayers()`，静音被推迟到 React state 提交或 effect 之后。
- **触发路径**：在视频卡上左右拖动（含未过阈值回弹）、飞出动画期间、双指放大全程、播放报错时，声音持续播放。
- **违反**：PRD 5.2 先静音后切换（含"尚未判定方向的拖动"）
- ~~**修复方向**：四个事件入口第一行同步调用 `silenceAllPlayers()`。~~
- **修复记录（v274）**：① `onPanResponderGrant` 三分支统一 0ms `silenceAllPlayers()`（PRD 5.2 含未判定方向拖动）；② `commitTrash` 第一行同步 `silenceAllPlayers()`（不再等 `setPlaying` 的 React 提交）；③ 手势取消/收藏/回弹路径经 `resumeGestureAudio()`（守卫 activeRef+playingRef，经 `cardPlayerRef` 直接 `safePlayPlayer` 恢复；LivePhotoVideo 新增 `onPlayerChange` 上报播放器）；④ 视频 `error` 分支同步 `silencePlayer(player)`。回归测试 `tests/audio-interlock.test.mjs`。

### ISSUE-004 · 收藏异步结果无身份校验 + 重入窗口 — **✅ 已修复（v278，2026-09-19）**

- **位置**：`src/components/MemoryCard.js`（`commitFav`）
- ~~**问题**：`toggleFavorite(item).then(({favorite}) => setFav(favorite))` 直接更新，不比对 `item.id` 与当前卡片身份；`trashingRef` 在 300ms 回弹动画结束即复位，慢速 PhotoKit（iCloud 资源）下二次右滑会触发两次 toggle。~~
- **修复记录（v278）**：`favOpVersionRef` 操作版本号 + `committedItemId` 快照 + `latestItemRef` 实时身份比对，`.then` 里过期/异身份结果直接丢弃；`trashingRef` 复位从「300ms 回弹后」改为 `.then/.catch` settle 后（动画照常）。回归测试 `tests/feed-hardening.test.mjs`。

### ISSUE-005 ·「回到那一天」可绕过每日 30 张配额闸门 — **✅ 产品决策：不修（2026-09-19）**

> 历史记录。现行 v285 规则：所有浏览免费；主流、连拍和同日入口共用每日 100 张新选待删额度，按当天资产 ID 去重。

- **位置**：`src/screens/HomeScreen.js:958`（`onViewed={markAssetViewed}`）、`src/components/DayMemoryCarousel.js:92-94`（`onViewed`）
- **问题**：同日浏览每次切卡都把（可能未在主流出现过的）照片标记为已浏览，但既不走 `recordCardViewed`，也不受 `feed.slice(0, sessionAllowance + 1)` 限制。
- **决策记录**：用户于 2026-09-19 明确「不需要修」。维持现状：同日浏览不扣配额、可标记已读。

### ISSUE-006 · 沙盒导出缓存与磁盘裁剪口径不一致（黑图风险）— **✅ 已修复（v278，2026-09-19）**

- **位置**：`src/media.js`（`getSandboxMediaUri` / `pruneSandboxDirectory` / `sandboxMediaCache`）
- ~~**问题**：LRU 缓存按"访问"保留 50 个，磁盘裁剪按 `modificationTime` 保留最新 50 个；缓存命中直接返回路径，不校验文件是否仍存在 → 高频访问的老文件可能被裁剪。~~
- **修复记录（v278）**：`pruneSandboxDirectory` 删除磁盘文件后同步从 `sandboxMediaCache` 逐出对应 path 的条目（`LRUMap.entries()` 遍历，下次 `getSandboxMediaUri` 重新导出）；`getSandboxMediaUri` 发现 0 字节残留文件（中断的 copyAsync）先删除再重拷。回归测试 `tests/feed-hardening.test.mjs`。

### ISSUE-007 ·（潜伏 / 当前不可达）`TrashScreen` 部分成功后谎报全清 — **✅ 已修复（v278，2026-09-19，直接删除死代码）**

- **位置**：`src/screens/TrashScreen.js`（原 197 行）
- ~~**问题**：`if (success !== false) setItems([])`，而 `emptyTrash()` 返回的是**已删除数量**（0..N）。部分成功时恒满足 `!== false` → UI 清空全部，实际仍有未删除项。~~
- **修复记录（v278）**：该文件零引用（实际使用的收集箱是 `TrashGallery.js`），直接删除，潜伏 P0 随之消除。

---

## 已排除（review 中确认**不是**缺陷，勿重复排查）

- **连拍切帧不记已浏览**：不成立。`handleGroupNext`（`HomeScreen.js:800-806`）触发 `setFeed` 新引用 → 409 行 effect 重跑 → 按新 `burstPosRef` 取帧并 `markAssetViewed`。
- **跨日配额刷新清空浏览历史**：已修复，`resetDailyQuota()` 不再调 `clearViewedHistory`（`docs/CORE_PRD.md` §13 第 2 条文案滞后，待同步）。
- **已浏览内容回流兜底**：已修复，`media.js` 全部候选路径严格 `!viewedIds.has(...)`（`docs/CORE_PRD.md` §13 第 1 条文案滞后，待同步）。

## 历史接受项与现行状态（2026-10-28 更新）

- **v286 纠正与处理**：当前 SDK 57 的播放器构造已是异步路径，下述同步加载判断仅属旧审计记录。v286 拆分准备/播放状态、保留窗口实例并移除固定等待；v283 已用系统分页替代全库 catalog 常驻；v286 同日相册也采用 80 项双向分页和 320 项有界窗口。代码与集成检查不等于真机性能验收，下述旧结论不应直接套用到 v286。

- **expo-video URI 切换主线程同步加载**：`useVideoPlayer` 的 source 依赖变化会触发原生 `replace`（主线程资产加载），活跃卡 `asset-ready` 刷新换 URI 时有瞬冻感。属 expo-video 内部行为，规避需重排播放器创建策略，冻结向量非崩溃，接受。**2026-09-24 部分缓解**：v280 起 active 切换后延迟 250ms 再创建播放器（`VIDEO_MOUNT_DELAY_MS`，海报先顶），把主线程加载挪出滑动落定的关键帧；asset-ready 刷新换 URI 的残余瞬冻仍在。
- **MemoryCard `videoPreload` 死代码 prop**：解构并在 memo comparator 中比较但渲染逻辑从不读取（"下一卡预载播放器"实际不存在）。无害，接受（未来做视频预载时再接线或删除）。
- **catalogAssets 全库驻留内存**：10 万张照片的库 ≈ 10 万资产对象整会话驻留（几十 MB JS heap），大库老设备有 jetsam 压力。根治需目录分页/分片架构，单独立项；v279 已通过 `catalogIdIndex` 消除 O(n) 扫描的 CPU 侧成本。**2026-09-24 升级关注**：真实用户（iPhone 15 Pro / 1TB / iCloud 200G / 10 万张）出现「偶发崩溃、重启再崩、过一会儿自愈」，诊断为原生侧 jetsam（Build 40/41 已含 ErrorBoundary 且全局 handler 吞掉 JS 异常，可排除 JS 渲染崩溃）。v280 Stage A 已削峰：prefetch 收敛（6 entries 全帧 → 3 entries×2 帧 + burst ±2 帧错峰补齐）、discovery 扫描尾部分片让出 JS 线程、library-reload 风暴合并（8s 冷却 + trailing，emptyTrash 批删折叠为一次重载）、垃圾桶富化限并发 5、弱网逐条 info 限 12 条/页、本地飞行记录器（版本行长按查看崩溃前里程碑）。**常驻内存本体未动，分页架构仍待单独立项**；若削峰后仍崩，优先启动该立项。

## 相关

- 产品不变量基准：`docs/CORE_PRD.md`
- 交接与发布状态：`AGENTS.md`

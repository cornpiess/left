# P0：授权后首页照片加载失败

2026-10-28。修复基线：远端 master `5f3fc39`（Build 54 交接记录）。本次为源代码修复，尚未生成或分发新安装包。

## 2026-10-28 深夜追记：真机真根因（Build 54/56 双双失败，Build 57 修复）

Build 56（含本文件首批修复）真机仍「照片加载失败、重试无效」。飞行记录器定性：`photo-load-failed {stage:"review-store", message:"Cannot read property 'load' of undefined"}` 且 `browse-save-failed Cannot read property 'saveBrowse' of undefined`——`media.js` 导入的 `reviewStore` 绑定在生产包中是 undefined。

**根因**：`src/reviewStore.js` 与 `src/reviewStore.mjs` 同名共存（v283 引入）后，metro 对无扩展名相对导入 `import { reviewStore } from './reviewStore'` 解析到了 **`.mjs` 兄弟**（明文 bundle 实证：media 模块 dep 表中 `'./reviewStore'` 与 `'./reviewStore.mjs'` 指向同一模块 id 1090；`reviewStore.js` 的代码 `readLegacyJson`/`vibe-cleaned-history.json` 整体不在包内）。`.mjs` 只导出 `createReviewStore`/`RecentIds` 工厂，没有 `reviewStore` 实例 → 真机启动必败、重试同败。`membership.js` 同一导入同样被劫持。下方 `const count` 缺陷真实存在但只是伴随问题，不是真机症状的根因。

**为何所有测试与门禁都没拦住**：测试运行时把 `'./reviewStore'` 当桩键直连（`tests/support/media-runtime.mjs`），不经过 metro 解析；`expo export` 门禁只验打包成功不验运行时绑定。1.0.5 无同名冲突故从未暴露。

**修复**（commit `957823f`）：① `media.js`/`membership.js` 改为显式 `from './reviewStore.js'`；② pretest 门禁（`scripts/check-immutable-bindings.mjs`）新增规则——扩展名相对导入若存在同名 `.mjs` 兄弟即报错（对旧代码实测报错、新代码通过）；③ 明文 bundle 复验：`reviewStore.js` 代码进包、两依赖分离（1090/1091）。发版排查方式：`npx expo export --no-bytecode --no-minify` 后 grep 模块依赖表，禁止只信 hbc 导出成功。

## 症状与已确认根因

用户报告：相册有大量照片，允许访问所有照片后，首页显示「照片加载失败」，点击重试仍不能进入照片。

已在生产媒体加载代码中复现：同一个系统连拍的不同成员分别从初始随机采样与候选分页进入 `browseSession.ingest` 时，合并分支声明了局部 `const count`，遮蔽外层候选数计数器；随后 `count += items.length` 抛出 `TypeError: Assignment to constant variable`，中断首屏。该路径在旧代码中稳定失败，修复后通过。同名变量改为 `nativeCount`，候选总数继续由外层计数器维护。

这是一条已证实可产生所报症状的缺陷。尚未取得报障设备的诊断栈，不能将本地复现等同于该设备问题已真机关闭。

## 同一加载链路的修正

- 重试共用 `retryBrowseSession`：重新检查当前权限，丢弃临时读库源与分页器，阻止过期请求写回；保留当前照片、连拍节奏、已读记录、待删记录与额度。真正为空的首次查询也能在重试时重新查库。
- 首页两个重试入口共用同一个回调，立即进入加载态，防止连点并清除旧错误。自动空库重试也重新创建临时源。
- 每次相册分页使用同一有序查询契约。查询异常与无效返回值向上报告，不能被吞掉并伪装成空库；移除可能改变顺序的多套查询降级。
- 连拍标识与成员读取是可降级的元数据增强：方法缺失或拒绝时保留基础照片浏览，系统成员续页句柄不因暂时失败而丢弃。原生 ID 校验失败则回退到系统资产信息校验，不能当作照片已删除。
- 浏览快照保存失败只记录本地错误，已成功读取的照片仍可显示。整理事实库初始化失败仍安全中止并允许重试；待删选择、额度与后继锚点的事务仍严格执行，不用空数据覆盖失败的迁移。
- 本地诊断记录权限、事实库、恢复、相册查询、候选填充和媒体解析等失败阶段。通用错误文案六语言同步，内部错误不再要求用户反复检查权限。

## 为何之前的测试未发现

此前原生接口被整体替换为总是成功的桩，数据集也未覆盖「同一原生连拍跨初始采样与分页再次出现」。已有 172 项通过只能证明原有覆盖范围，不能证明首次授权链路完整。

现在测试执行真实 `media.js`、`nativePhotoPreview.js`、`reviewStore.js` 及 SQLite SQL；仅设备 API 与文件系统做边界替身。新增用例包含全新安装、旧文件迁移、重复原生组、原生接口缺失/拒绝、真实查询失败、暂时空库、权限变更、实际首页重试按钮、过期请求和恢复位置。设备替身不等于 PhotoKit 真机验证。

## 防回归门禁

1. `npm test` 的 pretest 对全部应用 JS 源码检查常量和导入绑定的非法赋值。该检查在旧代码上明确报告 `src/browseSession.mjs:120: cannot reassign const count`。
2. `tests/photo-startup.test.mjs` 是正式全量测试的一部分；核心复现用例在旧生产代码上失败，禁止只断言源码里存在某个 fallback。
3. `.github/workflows/validate.yml` 在 master 推送及 PR 时运行检查、全量测试和 iOS JS/Hermes 导出。新增 CI 不代表已配置分支保护，也不代表完成了原生编译。
4. 本地完整门禁：`npm run validate`。不得把 JS 导出成功当作新 IPA 已发布。

## 当前验证与发布验收

- 旧实现：2 个核心复现用例失败；新增静态门禁也失败。
- 修复后：187/187 项测试通过；Expo doctor 21/21 通过；iOS JS/Hermes 导出通过；应用 59 个 JS 源文件的常量/导入赋值检查通过。
- 本环境无 iPhone / Xcode，未完成报障设备复测，未构建或发布新 IPA。
- 发包前应在真机验证：全新安装后允许所有照片；旧版覆盖升级；大量系统连拍；有限照片访问；暂时不可用后点击重试；真实空库；iCloud 照片。检查重试能恢复且不清空整理历史，并确认新版首次打开能显示照片。

若真机仍失败，长按更多菜单版本行查看本地诊断，优先读取 `photo-load-failed` / `load-initial-failed` 的阶段与错误；不要用重装清数据掩盖原因。

# dsh-home-sync 独立复核报告（v0.2.1）

> 复核时刻：2026-09-07 20:22（与测试/哈希同一快照）。本文是对修复完成报告的**独立复核**，不是新发现的缺陷清单；如后续源码继续变化，以文件哈希为准。

## 1. 范围与方法

| 项 | 内容 |
| --- | --- |
| 对象 | `D:\Project\DSH\dsh-home-sync` v0.2.1（package.json `dsh-home-sync@0.2.1`） |
| 复核内容 | 完整阅读 `lib/index.js`、`lib/sync.js`、`lib/ui.js`、`package.json`、`cordis.patch.yml`、README 及两份既有报告，逐条对照《检查与修改报告》的 F01–F17 与其验收口径 |
| 动态验证 | 独立执行 `npm run check`（三文件语法）与 `npm test`（真实 Git 临时仓库 + 本地虚构远端 + 最小 DOM/浏览器事件 + 宿主真实 HTTP 鉴权方法） |
| 环境 | Windows、Node v24.20.0、Git 2.55.0.windows.4、本机 DSH 0.1.2-rc.1 |

## 2. 复核结论

**通过。** `npm run check` 无输出（0 退出），`npm test` **43/43 通过、0 失败**。原审计 17 项（F01–F17）在当前代码中均有对应实现，未发现新的高风险缺陷；发现 1 项界面回归并已在复核中修复（见 §4）。

## 3. F01–F17 与代码/测试对照

| 编号 | 当前实现位置（模块/函数） | 对应测试（test/*.mjs 抽样） |
| --- | --- | --- |
| F01 | index：注入 `connection`；`route()` 先 `connection.requestRejection(req)`，无鉴权服务则整插件禁用 | “HTTP requires host authentication, trusted source, JSON and valid schema”“missing authentication service fails closed” |
| F02 | sync `initialize`：临时仓抓全远端树 `tree()` 预检，拒绝禁止路径/链接/碰撞后再落盘 | “init rejects remote credentials before overwriting ignored local data”“remote symlink entries are refused” |
| F03 | sync `initialize`：以原 HEAD/索引/目标树并集备份 + `.git` + config + manifest + 哈希，备份在 `<DSH_HOME>.home-sync-backups/init-*` | “init backs up all affected files and switches/saves the chosen branch”“fresh device init … always creates a backup” |
| F04 | sync `allowedFile`/`inspectIndex`/`tree`/`stageChanges`：受限 pathspec 只暂存白名单；提交历史含禁止文件即阻断 | “untracked credentials stay local; pre-staged credentials block push”“secret in outgoing history is blocked” |
| F05 | sync `sync()`：commit 与 push 分离；干净工作区仍按 ahead 重试上传 | “failed push retries a clean but unpushed commit”“normal push, clean retry, and accurate ahead count” |
| F06 | sync `sync()`：先 fetch；冲突合并中止并 `merge --abort`，保留本地提交、停止推送 | “two devices changing separate files converge”“same-file conflict stops publication and preserves local content” |
| F07 | index `reconcile()`：保存配置即重建定时器；每次执行前重读最新开关 | “saving switches reconciles timers; disabled callbacks cannot push” |
| F08 | sync `ensureRepo()` 分支绑定；初始化受控建/切分支、设 origin/upstream 并保存 | “wrong branch cannot publish”“init … switches/saves the chosen branch” |
| F09 | sync `operation()`：`<DSH_HOME>.home-sync-lock` 跨进程锁 + `active` 互斥 | “operations on the same home are mutually exclusive across service instances” |
| F10 | index `dispose()`/disposers 收集全部路由与注入；`stopped` 拒新操作 | “unloading cancels subsequent steps and releases the operation lock” |
| F11 | sync `validateConfig`/`validateBranch`/原子写；损坏配置暂停并提示 | “configuration schema rejects invalid input and migrates the legacy switch”“status reports … corrupt config as errors” |
| F12 | index `readBody`：Buffer 字节累计、统一 UTF-8、限额/超时/aborted/close | “UTF-8 JSON survives every possible byte split”“invalid, aborted, oversized, and timed-out request bodies fail” |
| F13 | sync `initialize`：正式替换前完成预检与备份，失败回滚并恢复 origin | “failed init fetch preserves the existing origin”“late initialization failure restores files, index, HEAD and origin” |
| F14 | ui：外点判定用 `anchor.contains(target)`；button click 触发 | “clicking the SVG opens the panel and bubbling does not close it” |
| F15 | ui：语义 button + aria + 键盘焦点 + Escape 关闭 | “keyboard-generated click opens and Escape closes” |
| F16 | ui：`openPop(anchor)` 以真实触发元素定位，备用按钮独立可用 | “fallback opens without a primary button after a mounting failure” |
| F17 | sync `status()` 结构化错误；ui 区分“未知/读取失败” | “status reports invalid repositories and corrupt config as errors” |

## 4. 复核中发现并已修复的问题

- **UI 回归（日志框可见）**：0.2.0 ui.js 又把操作结果写进卡片内 `#log`（此前用户已要求改为 toast 浮窗）。复核中已把 `#log` 改为**视觉隐藏**（`position:absolute; left:-9999px` + clip），保留 aria-live 供屏幕阅读器，界面上不再显示日志条；改动后 43/43 测试仍通过。
- 其余复核记录：README 已新增「独立复核记录（2026-09-07）」一节与本报告互相引用。

## 5. 已知边界（非缺陷，与既有报告一致）

- 两种初始化模式（reset/merge）底层行为相同（预检 → 备份 → 受控重置 → 暂停自动任务），`mode` 仅影响提示文案；“已用机器合并”需按备份与 `MERGE.md` 手动挑拣。
- 数据接口只接受已登录的可信会话；未登录直连返回 401 属预期（鉴权为 0.2.0 目标行为）。
- 后端（index/sync）改动需**重启 DSH web** 才加载；界面（ui.js）改动 Ctrl+F5 生效。复核时未重启真实 DSH，未触碰真实主目录/远端/账号。
- 未做真实账号 SSH/HTTPS 推送、跨 OS、断电恢复、与其他插件并发写入的端到端验证（沿用修复报告边界）。

## 6. 文件指纹（复核时刻 2026-09-07 20:22，SHA-256）

| 文件 | SHA-256 |
| --- | --- |
| package.json（v0.2.1） | `9f4335ce9a5c9706a3c7f12e378d455f8dd35493f3967a35989b17d160cc119c` |
| cordis.patch.yml | `f330802aa29c1e547fc5a94044c9c6818f4da25278dac9fe71582b28ac699928` |
| lib/index.js | `cfadb06562f10953d0dcb2ff664056692776ffc28eee3c077b325dd08db6f42e` |
| lib/sync.js | `b16eb7b7ca92a0376a7334c9a76026b0223f4950554e94e53745f3b17cf5a50a` |
| lib/ui.js | `39e410f90635824f392010dbd9c9dd651242359b36c36fa98683c5370cec1e9c` |
| README.md | `a09fbf48aaae3281c0eaa0a70a471be645d05446f2ca82be8bd31fd730676079` |
| DSH插件检查与修改报告.md | `e5e4b6326961e23ca215f3d2deff501228d29812540227f768b3d96c2653a40c` |
| DSH插件修复完成报告.md | `2a02922642ec4b52d4e74ddde8bebc3b4aeb563dbd0fb1d079bfb5cba8f33188` |

# dsh-home-sync 插件检查与修改报告

> 后续更新：用户已授权直接修改，当前源码已更新为 0.2.0。本文保留 **0.1.0 审计时点**的发现与原始行号，不能作为当前未修复问题清单。实际修改及验证结果见[修复完成报告](D:/Project/DSH/dsh-home-sync/DSH插件修复完成报告.md)。历史复现结果 JSON 保留不变；复现脚本入口现已转为执行当前回归测试。

检查日期：2026-09-07  
检查对象：`dsh-home-sync` 0.1.0，当前项目全部 4 个原始文件。  
结论：发现 **17 项需要修改的问题，其中 P1 高优先级 9 项、P2 中优先级 8 项**。目前不宜把自动同步或设备初始化当作可靠的数据保护措施。最先需要解决接口鉴权、初始化覆盖范围、备份完整性和同步状态判断。

本次交付是代码审查与修改建议报告，附可重复运行的验证材料；**没有修改插件运行代码，也没有对真实 DSH 主目录执行拉取、提交、推送、重置或写配置操作**。下文“修改方案”均为待实施内容，不代表已经修复。

## 1. 范围、方法与验证边界

用户已确认仅检查当前 `dsh-home-sync` 项目，不扩展审计其他已安装插件。

| 检查层面 | 实际工作 |
| --- | --- |
| 包与加载声明 | 完整检查 package.json、cordis.patch.yml、入口导出与服务依赖 |
| 后端 | 完整检查 387 行 lib/index.js，包括 Git 操作、定时器、配置、HTTP、初始化、卸载 |
| 界面 | 完整检查 754 行 lib/ui.js，包括 API 调用、拖拽、弹窗、设置、初始化、状态、回退入口 |
| 宿主契约 | 只读核查本机 DSH 0.1.2-rc.1 的 webServer 路由实现及 connection 鉴权实现 |
| 本机接入 | 只读查看 web profile 的插件依赖声明、主目录 .gitignore；未读取凭据或记忆正文 |
| 后端动态验证 | 临时目录中的虚构文件与本地 Git 远端，15 个场景 |
| 界面逻辑验证 | 最小 DOM/事件模型执行原始 ui.js，3 个场景；不等于浏览器渲染验证 |
| 基础检查 | 两个 JavaScript 文件语法检查均通过；Node v24.20.0、Git 2.55.0.windows.4 |

所有 **18 个复现场景均得到预期的缺陷或限制行为**。这表示问题复现成功，**不表示插件通过了正确性测试**。场景与问题并非一对一：有的场景覆盖多个问题，有的记录产品限制。

尚未验证：真实浏览器及移动端布局、完整 Cordis 热更新过程、真实 DSH HTTP 端口的端到端访问控制、SSH/HTTPS 真实远端、跨操作系统迁移、并发压力与进程中断恢复。当前目录没有 .git、现成测试、测试脚本、README 或锁文件，不能提供基于提交历史的差异审计。

## 2. 问题总表

P1：可能造成数据覆盖、越权操作、错误推送或核心同步失效，应优先修复。P2：影响可靠性、可恢复性或界面可用性，应随后修复。没有根据未知的网络暴露情况提升为 P0。

| 编号 | 等级 | 问题 | 证据 |
| --- | --- | --- | --- |
| F01 | P1 | 自定义 HTTP 接口绕过宿主鉴权与来源校验 | R09 + 宿主源码 |
| F02 | P1 | 初始化可能覆盖被忽略的凭据等同名文件 | R06 |
| F03 | P1 | “迁移合并”备份遗漏实际可能被重置的文件 | R05 |
| F04 | P1 | 推送没有自行约束同步白名单 | R07，取决于仓库忽略规则 |
| F05 | P1 | 推送失败后，重试把尚未上传的提交当作成功 | R01 |
| F06 | P1 | 双设备同时修改后，自动同步进入无法自动恢复的分叉 | R02 |
| F07 | P1 | 保存自动同步开关后，运行中的定时器不更新 | R08 |
| F08 | P1 | 当前分支、配置分支、初始化分支不一致 | R03、R04 |
| F09 | P1 | 手动操作、启动任务、周期任务之间缺少统一互斥 | 静态确认；未做并发压力测试 |
| F10 | P2 | 卸载时未注销 6 条路由 | R10 + 宿主源码 |
| F11 | P2 | 配置缺少类型校验，损坏时静默退回默认值 | R09 + 静态检查 |
| F12 | P2 | 请求体解析可能损坏中文，异常输入处理不完整 | R12、R13、R09 |
| F13 | P2 | 初始化失败后不恢复原有 origin | R14 |
| F14 | P2 | 点击悬浮按钮中的 SVG 后弹窗立即关闭 | U01，事件模型 |
| F15 | P2 | 悬浮入口不响应键盘生成的点击 | U02，事件模型 |
| F16 | P2 | 主入口未建立时，备用按钮无法打开弹窗 | U03，事件模型 |
| F17 | P2 | 状态查询失败仍报告成功，界面显示“0 待提交” | R15 |

## 3. 详细问题与修改方案

### F01 — 自定义接口未接入鉴权与来源校验（P1）

位置：[lib/index.js:238](D:/Project/DSH/dsh-home-sync/lib/index.js:238)、[lib/index.js:313](D:/Project/DSH/dsh-home-sync/lib/index.js:313)。

`route()` 只检查 HTTP 方法，直接调用处理器。状态、配置、拉取、推送、初始化均没有身份验证或 Host/Origin 校验。`confirm:true` 只是请求参数，不能证明身份或用户确认。

本机宿主的 `webServer` 直接按路径分发请求，没有全局鉴权；`connection` 对 `/api` 前缀执行请求校验。当前插件地址是 `/dsh-home-sync/api/*`，不在该前缀内，也没有调用 `connection.requestRejection()`。

证据：R09 在无身份信息、外部 Origin、`text/plain` 请求体的条件下，成功改写了测试配置。真实网络可利用范围取决于监听地址、代理和浏览器策略；本次没有访问真实运行接口，不能据此声称公网已暴露。

修改方案：优先通过宿主 `connection` 提供的受保护接口注册机制接入；或显式注入该服务并在自定义路由处理前调用其校验方法。鉴权服务不可用时禁止提供写操作。POST 严格限制内容类型，拒绝不可信来源。不要仅把地址改为 `/api/...` 后继续直接注册 exact 路由，因为宿主 exact 路由可能先于受保护的 prefix 路由匹配。

验收：未登录返回 401，不可信来源返回 403，合法会话才可调用；状态接口同样保护；被拒请求不能启动任何 Git 或文件写入。

### F02 — 初始化对忽略文件的保护承诺不成立（P1）

位置：[lib/index.js:200](D:/Project/DSH/dsh-home-sync/lib/index.js:200)、[lib/ui.js:538](D:/Project/DSH/dsh-home-sync/lib/ui.js:538)。

初始化直接执行 `reset --hard origin/<branch>`，没有检查远端树是否包含凭据、会话等禁止路径。界面声称这些文件“不受影响”，但忽略规则不能保护与目标树发生碰撞的本地文件。Git 官方说明也明确指出，hard reset 可能覆盖未跟踪文件。[Git reset 文档](https://git-scm.com/docs/git-reset)

证据：R06 将本地虚构 `.credentials.yaml` 设置为被忽略文件，远端加入同名虚构文件；“迁移合并”返回成功，本地文件被替换，备份中没有它。

修改方案：先 fetch 到暂存引用并审查完整远端树；拒绝任何超出允许范围的路径，以及与受保护本地路径的碰撞。根据预检结果提供具体覆盖清单，再执行受限恢复；不要对整个 DSH 主目录无条件 hard reset。备份存放于重置目标之外。修正界面中的绝对保护承诺。

验收：远端包含 `.credentials.yaml`、sessions、node_modules 或其路径冲突时，操作在覆盖前失败；原文件内容不变。

### F03 — 迁移备份范围小于实际重置范围（P1）

位置：[lib/index.js:136](D:/Project/DSH/dsh-home-sync/lib/index.js:136)、[lib/index.js:171](D:/Project/DSH/dsh-home-sync/lib/index.js:171)。

`INIT_TRACKED` 是固定列表，未包含 `.gitignore`，记忆只备份 `mnemon/runtime` 和 `mnemon/documents`。但本机实际忽略规则放行 `.gitignore` 以及更广的 `mnemon/**`，随后执行的 reset 更不限于该列表。

证据：R05 修改已跟踪的 `mnemon/extra.json` 和 `.gitignore`，执行 merge 模式初始化；本地未提交记忆被覆盖，两项都没有备份。

修改方案：以“当前索引、当前工作区和目标树之间所有可能改变的路径”生成备份清单，包含删除项、目录/文件冲突和未提交内容；保留旧 HEAD、分支、远端配置和文件校验值。备份成功并验证完整后才允许覆盖。

验收：对清单中的每一个会被覆盖或删除的本地文件，都能从备份恢复原始内容；备份失败时零覆盖。

### F04 — 全量 add 依赖外部忽略规则（P1）

位置：[lib/index.js:117](D:/Project/DSH/dsh-home-sync/lib/index.js:117)。

`git add -A` 把仓库内所有未忽略内容加入索引，插件不创建、不核验白名单，也不审查已经暂存的文件。忽略规则缺失、被改坏或敏感文件此前已被跟踪时，会把非同步数据一起提交推送。

证据：R07 在缺少凭据排除规则的测试仓库中，虚构 `.credentials.yaml` 被提交到本地测试远端。**本机当前已有默认拒绝的 .gitignore，因此不能据此认定真实凭据已经泄露。**

修改方案：明确允许同步的文件集合，用受限 pathspec 暂存；提交前审查整个索引，拒绝敏感或非允许路径，包括用户此前暂存的内容。对设置文件等允许路径中的敏感字段另行定义同步策略。白名单检查不能被远端提供的 .gitignore 替代。

验收：缺失/损坏忽略规则、敏感文件已跟踪、敏感文件已暂存三种情况均阻止发布；正常允许文件仍可同步。

### F05 — 未提交修改与未推送提交混为一谈（P1）

位置：[lib/index.js:119](D:/Project/DSH/dsh-home-sync/lib/index.js:119)、[lib/index.js:298](D:/Project/DSH/dsh-home-sync/lib/index.js:298)。

工作区干净时，`doPush()` 在实际 push 前返回成功。一次 commit 成功而 push 失败后，工作区恰好变干净，此后手动重试及周期轮询都可能跳过尚未上传的提交。

证据：R01 第一次使用不存在的本地 push 地址模拟推送失败；恢复有效地址后再推送，返回 `ok:true, step:clean`，远端仍未更新，本地领先 1 个提交。

修改方案：把“是否需要提交”和“是否需要推送”分成两步；没有工作区变化也应检查领先提交或安全执行 push。状态接口分别报告 dirty、ahead、behind、最后一次成功推送和最近错误。

验收：提交成功/推送失败后，不再改文件，仅恢复远端并重试即可上传原提交；不能用“nothing to commit”表示同步成功。

### F06 — 拉取失败后继续提交，导致自动同步停滞（P1）

位置：[lib/index.js:261](D:/Project/DSH/dsh-home-sync/lib/index.js:261)。

`doSync()` 无论 pull 成败都会继续 doPush。当本地未提交修改与远端更新触及同一文件，pull 中止，随后本地仍会 commit，push 因非快进被拒绝；分叉形成后仅靠 ff-only 无法整合。Git pull 的 ff-only 策略本身也不解决已分叉历史。[Git pull 文档](https://git-scm.com/docs/git-pull)

证据：R02 的两端各修改 settings.yaml；运行后本地/远端各领先 1 个提交，工作区却干净，后续推送按钮误报 clean。

修改方案：定义明确状态流程：检查仓库和分支 → 保护本地改动 → fetch → 判断领先/落后/分叉 → 按选定策略整合 → push。任何步骤失败都停止后续有副作用的操作。冲突时保留双方数据，展示冲突状态与恢复步骤，不自动覆盖记忆内容。

验收：分别覆盖仅本地修改、仅远端修改、双方修改不同文件、双方修改相同字段、已有分叉、网络失败。可合并场景最终收敛，冲突场景停止并可恢复。

### F07 — 自动同步设置与实际任务不一致（P1）

位置：[lib/index.js:275](D:/Project/DSH/dsh-home-sync/lib/index.js:275)、[lib/index.js:291](D:/Project/DSH/dsh-home-sync/lib/index.js:291)、[lib/index.js:332](D:/Project/DSH/dsh-home-sync/lib/index.js:332)。

定时任务只在 apply 时按旧配置创建；保存配置仅写 JSON。开启不会启动轮询，关闭也不取消既有轮询，间隔变更同样不生效。UI 没有提示这些设置需要重启。

证据：R08 关闭自动同步后，主动触发已注册的周期回调，测试远端仍收到新修改。

修改方案：保存配置后统一重建或取消任务；每次任务执行前再次确认最新开关。明确处理中任务的取消边界，至少阻止尚未开始的下一步提交/推送。旧 `autoSyncOnStartup` 字段应迁移为单一明确语义；后端的 `||` 与前端的 `??` 在新旧字段冲突时会显示不同状态。

验收：开启立即建立任务，关闭立即取消后续运行，间隔变更生效；开关显示与真实行为一致。

### F08 — 分支绑定不一致（P1）

位置：[lib/index.js:104](D:/Project/DSH/dsh-home-sync/lib/index.js:104)、[lib/index.js:116](D:/Project/DSH/dsh-home-sync/lib/index.js:116)、[lib/index.js:188](D:/Project/DSH/dsh-home-sync/lib/index.js:188)。

pull 把配置的远端分支拉入当前本地分支；push 把任意当前 HEAD 推到配置分支，未检查两者关系。初始化已有仓库时只 reset 当前分支，没有切换分支，也没有保存请求中的 branch；设置 upstream 的失败被忽略。

证据：R03 在本地 experiment 分支修改后点击推送，内容进入远端 main。R04 用 sync 初始化已有 other 分支，接口成功后本地仍是 other，配置仍是 main，下一次 pull 失败。

修改方案：将同步分支与工作区明确绑定；当前分支不匹配、detached HEAD 或合并未完成时拒绝写操作并给出说明。初始化应受控建立/切换到目标分支、验证 upstream，并在成功后保存配置；也可采用独立同步工作区，避免改变用户正在使用的分支。

验收：其他分支内容不能意外进入同步分支；以非 main 分支初始化后，状态、配置、upstream 和后续操作一致。

### F09 — 所有写操作缺少统一串行执行机制（P1）

位置：[lib/index.js:284](D:/Project/DSH/dsh-home-sync/lib/index.js:284)、[lib/index.js:293](D:/Project/DSH/dsh-home-sync/lib/index.js:293)、[lib/index.js:318](D:/Project/DSH/dsh-home-sync/lib/index.js:318)。

`syncing` 只保护同一个周期回调，启动任务、手动 pull/push/init 不受其保护。前端也只显示忙碌符号，不禁止重复执行。多个操作可以交错修改索引、分支和远端配置；单条 Git 命令的锁无法保证整个多步同步过程的原子性。

此项由代码确认，尚未通过并发压力测试量化错误概率。

修改方案：建立以 DSH_HOME 为作用域的操作队列或互斥锁，覆盖整个操作及配置切换；初始化需要独占。若支持多进程，同时采用可恢复的跨进程锁。UI 根据 operationId 显示状态并禁用冲突动作。

验收：同时触发启动同步、自动轮询及多次手动请求，只能串行执行或明确返回忙碌；初始化不能与提交/推送重叠。

### F10 — 插件卸载遗留 HTTP 路由（P2）

位置：[lib/index.js:240](D:/Project/DSH/dsh-home-sync/lib/index.js:240)、[lib/index.js:352](D:/Project/DSH/dsh-home-sync/lib/index.js:352)、[lib/index.js:373](D:/Project/DSH/dsh-home-sync/lib/index.js:373)。

宿主 `register()` 返回注销函数，但插件丢弃所有 API 与 ui.js 路由的返回值。清理数组只包含定时器及 HTML 注入的清理函数。

证据：R10 调用卸载清理后，6 条路由全部保留，注销函数调用次数为 0。宿主源码还明确规定重复注册同一路由会抛错；重新加载可能继续使用旧处理器。

修改方案：每次注册都通过 `ctx.effect()` 管理或收集 disposer；部分加载失败时也回滚已注册项。停止状态下拒绝新的操作，妥善处理已运行的任务。

验收：加载→卸载→重载后无遗留路由、重复注册错误或旧计时任务；完整 Cordis 宿主中补一次集成测试。

### F11 — 配置输入和损坏处理不可靠（P2）

位置：[lib/index.js:38](D:/Project/DSH/dsh-home-sync/lib/index.js:38)、[lib/index.js:48](D:/Project/DSH/dsh-home-sync/lib/index.js:48)、[lib/index.js:332](D:/Project/DSH/dsh-home-sync/lib/index.js:332)。

配置接口把任意 JSON 字段合并写入，没有布尔值、分支、间隔、消息长度或未知键限制；R09 的字符串 `autoSync:"false"` 和数字 branch 被接受。读取时把损坏文件与不存在文件同等处理，回到默认 `autoPullOnStartup:true`；直接覆盖写入也没有中断恢复保护。

修改方案：对请求和磁盘配置使用同一套 schema，验证分支名称并阻止它被解析为 Git 选项；限制远端格式与允许协议。区分首次运行与配置损坏；损坏时关闭自动写操作并提示修复。用同目录临时文件及适合 Windows 的原子替换方式保存，保留最后一份有效配置。

验收：非法类型、未知字段、空/非法分支、过大间隔均返回可读的 4xx；损坏配置不会悄悄启用默认自动行为。Git 参数问题这里只确认缺少验证，未将其直接认定为已证实的命令执行漏洞。

### F12 — 请求体解析破坏字符且错误处理不足（P2）

位置：[lib/index.js:215](D:/Project/DSH/dsh-home-sync/lib/index.js:215)。

每个 Buffer 分块直接拼入字符串，多字节 UTF-8 字符跨块时会被分别解码而损坏。无效 JSON 被吞掉并当作空对象；`null` 等合法但不符合接口结构的 JSON 没有统一拒绝；大小限制按字符串长度而非字节，且没有读取超时和 aborted/close 处理。

证据：R13 将“同步配置”的第一个汉字拆成两段后，解析结果包含替换字符；R09 的损坏 JSON 被配置接口报告成功；R12 的模拟 aborted/close 事件未让读取 Promise 结束。最后一项仅证明事件分支不完整，没有声称已复现真实 HTTP 资源耗尽。

修改方案：按 Buffer 累计字节数，完整收集后统一 UTF-8 解码，或使用 StringDecoder；处理 size limit、timeout、error、aborted 和 close；用 400/413/415 等明确状态拒绝非法请求，不执行写操作。

验收：任意字节位置分块的中文/emoji 均保持一致；坏 JSON、数组/null、超大或中断请求均明确失败且无副作用。

### F13 — 初始化失败后破坏原有远端配置（P2）

位置：[lib/index.js:193](D:/Project/DSH/dsh-home-sync/lib/index.js:193)。

先删除已有 origin，再添加新远端并 fetch；如果地址错误或连接失败，旧配置已经丢失。对于含独立 push URL 或自定义 fetch refspec 的 origin，remove/add 还会丢掉这些设置。

证据：R14 初始化因 fetch 失败而返回错误，但 origin 留在不存在的新地址，原本有效的 origin 没有恢复。

修改方案：使用临时远端/引用完成连接验证和树预检，成功后再更换正式配置；记录旧远端、HEAD、分支及索引状态，分阶段失败时恢复可恢复部分。失败响应应明确说明哪些步骤已完成、如何恢复。

验收：新地址错误、fetch 失败、备份失败、upstream 失败时，原同步配置仍可使用，或有完整且验证过的恢复入口。

### F14 — 图标点击被识别为外部点击（P2）

位置：[lib/ui.js:670](D:/Project/DSH/dsh-home-sync/lib/ui.js:670)、[lib/ui.js:704](D:/Project/DSH/dsh-home-sync/lib/ui.js:704)。

pointerup 打开弹窗后，冒泡的 click 到达 document。外部点击判断仅检查 `e.target.id` 是否等于按钮 id；点击 SVG 或内部 path 时 target 是子元素，因此被当成外部点击并关闭弹窗。

证据：U01 在最小 DOM 模型中执行完整 UI 脚本与 pointerup→click 事件序列，弹窗被立即设置为关闭。尚需真实浏览器回归。

修改方案：使用 `fab.contains(e.target)` 或 `e.composedPath()` 判断整个按钮区域；统一处理点击与拖拽结束，拖拽后抑制一次点击。

验收：点击按钮空白区、SVG、path 均能稳定打开；点击弹窗内部不关闭，外部点击才关闭。

### F15 — 键盘无法打开悬浮入口（P2）

位置：[lib/ui.js:619](D:/Project/DSH/dsh-home-sync/lib/ui.js:619)、[lib/ui.js:651](D:/Project/DSH/dsh-home-sync/lib/ui.js:651)。

主按钮没有 click 处理器，打开动作只发生在 pointerup；键盘 Enter/Space 生成的原生 click 不会触发打开。

证据：U02 模拟 click，入口没有对应监听器，弹窗未建立。

修改方案：以语义化 button click 作为激活动作，拖拽逻辑仅管理移动与点击抑制；增加可访问名称、aria-expanded、焦点进入/返回及键盘焦点样式。设置折叠标题也应使用可键盘操作的按钮。

验收：仅用 Tab、Enter、Space、Esc 可以打开、操作、关闭界面并回到触发入口。

### F16 — 备用按钮依赖已失败的主按钮（P2）

位置：[lib/ui.js:399](D:/Project/DSH/dsh-home-sync/lib/ui.js:399)、[lib/ui.js:727](D:/Project/DSH/dsh-home-sync/lib/ui.js:727)。

主按钮未创建时，fallback 按钮仍调用 openPop；openPop 一开始寻找主按钮，找不到直接返回。备用按钮存在还会让后续重挂载检查跳过重试。

证据：U03 模拟主入口创建前样式读取失败，备用按钮出现，但点击后没有弹窗。

修改方案：让 openPop 接受真实触发元素作为定位锚点，或提供独立的最小回退面板；回退状态保留受控重试能力。

验收：在主按钮创建前后分别注入可恢复挂载错误，备用入口都能提供操作或明确错误说明。

### F17 — 状态失败被显示成无变化（P2）

位置：[lib/index.js:86](D:/Project/DSH/dsh-home-sync/lib/index.js:86)、[lib/index.js:313](D:/Project/DSH/dsh-home-sync/lib/index.js:313)、[lib/ui.js:195](D:/Project/DSH/dsh-home-sync/lib/ui.js:195)、[lib/ui.js:220](D:/Project/DSH/dsh-home-sync/lib/ui.js:220)。

只检查 `.git` 是否存在，无法确认它是有效仓库；分支、remote 或 status 失败时吞掉错误，status 接口仍返回 ok:true。界面把 dirty:null 当成空数组，显示“0 待提交”。

证据：R15 使用无效的空 .git 目录，接口返回 `ok:true, hasRepo:true, dirty:null`，界面计算结果为 0。

修改方案：验证真实仓库根目录和 Git 状态，返回结构化错误；“未知/读取失败”和“确实干净”必须区分。状态读取还应涵盖领先/落后、冲突和正在运行的操作。

验收：仓库损坏、Git 不可用、状态读取失败时，界面显示失败而非同步完成或零变化。

## 4. 其他限制与维护建议（不计入 17 项缺陷）

- **远端单独更新不会周期拉取。** R11 证明本地干净时轮询直接返回。这与代码中“有本地变化才推送”的注释一致，列为产品能力限制；如果目标是持续双向同步，应增加独立 fetch/远端变化检测，并明确 UI 文案。
- **跨设备安装依赖本机路径。** 当前 web profile 把本插件声明为 `link:D:/Project/DSH/dsh-home-sync`。同步这一声明不会同步插件源码；新设备需要同路径源码或独立安装步骤。应提供可移植的安装文档或可获取的版本化包。
- **界面状态会陈旧。** 悬浮标记只在页面加载、打开面板和部分操作后更新，没有周期状态刷新。自动任务失败主要写控制台；短暂 toast 不适合保存初始化备份路径和恢复指引。
- **主题与生命周期。** 主题改变只更新悬浮按钮，已打开面板使用旧配色；界面定时器和监听器缺少统一销毁入口，宿主重挂载场景需补真实浏览器验证。
- **后台 Git 行为。** 生产代码只约束 SSH 批处理，没有统一禁止 HTTPS 交互提示；成功判断还会扫描 stderr 中的 error 等字样，应以进程退出码为主、保留结构化超时/中止原因。应清理可能改变仓库目标的继承 Git 环境变量。
- **工程维护。** 增加 README、支持的 Node/DSH 版本声明、恢复流程、测试命令；删除未使用的 GIT_SSH 常量，修正“未来 GUI”“不滚动”等过时注释。包本身没有声明第三方依赖，未执行无意义的 npm 依赖漏洞扫描；宿主传递依赖未纳入本次审计。

## 5. 建议实施顺序与验收关口

| 阶段 | 修改范围 | 完成条件 |
| --- | --- | --- |
| 第一阶段：保护访问与数据 | F01—F04、F09 | 写接口受鉴权保护；不允许越界同步/覆盖；完整备份；操作互斥 |
| 第二阶段：恢复同步正确性 | F05—F08、F13、F17 | 失败可重试；分支一致；冲突明确；开关实时生效；状态真实 |
| 第三阶段：修复生命周期与交互 | F10—F12、F14—F16 | 卸载干净；配置/请求严格校验；中文完整；鼠标/键盘/回退入口可用 |
| 第四阶段：补齐发布与迁移文档 | 第 4 节维护建议 | 新设备安装、双向同步语义、备份恢复、版本支持均有清晰说明 |

建议先在隔离仓库完成上述修改，再进行真实 DSH 宿主的鉴权与热卸载验证，最后用虚构数据开展双设备端到端测试。不要通过自动 force push 或无条件 reset 来消除冲突。

目前复现脚本中的断言故意描述旧代码的错误行为。修复时应把相应断言改成期望正确行为，不能把“旧缺陷仍能复现”作为修复后的通过标准。

## 6. 交付物、复现方式与版本指纹

新增材料：

1. [本报告](D:/Project/DSH/dsh-home-sync/DSH插件检查与修改报告.md)。
2. [后端复现脚本](D:/Project/DSH/dsh-home-sync/audit/reproduce.mjs)与[完整结果](D:/Project/DSH/dsh-home-sync/audit/reproduction-results.json)。
3. [界面事件复现脚本](D:/Project/DSH/dsh-home-sync/audit/ui-reproduce.mjs)与[完整结果](D:/Project/DSH/dsh-home-sync/audit/ui-reproduction-results.json)。

在项目目录执行：

```powershell
node --check lib/index.js
node --check lib/ui.js
node audit/reproduce.mjs
node audit/ui-reproduce.mjs
```

后端脚本仅在系统临时目录创建虚构仓库，Git 远端全部是这些临时目录；在该脚本进程中隔离用户 Git 配置及 DSH_HOME。为检查私有函数，脚本只给临时复制的入口增加导出，实际函数体保持原样。Git 操作是真实执行，HTTP 请求/响应和 Cordis 定时器/生命周期使用测试替身。

脚本保留临时仓库便于独立检查，路径记录在结果 JSON 的 temporaryRoot。重复执行会覆盖结果 JSON 并创建新的临时仓库，不会修改插件原始文件。界面脚本不启动浏览器，仅验证事件逻辑。

原始文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| package.json | `d5f402efc582ea9dcb582aa73405355bb54a34b6d5fb0e628864350ea4dc0ce9` |
| cordis.patch.yml | `f330802aa29c1e547fc5a94044c9c6818f4da25278dac9fe71582b28ac699928` |
| lib/index.js | `6e00abf73d7a84440d51e459077afb38967e1a5e6bb856974044f30d54bea221` |
| lib/ui.js | `7693e76f9333e6749597c3a95f753f8a02f0dc8b524bd0aa91a7980acb1a8fab` |

宿主佐证（均为本机已安装源码）：

- [webServer 注册与注销契约](E:/npm/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:176)：register 返回删除路由的函数，重复路径抛错。
- [webServer 请求分发](E:/npm/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:228)：匹配后直接调用 handler。
- [connection 身份与来源校验](E:/npm/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:530)：先检查可信请求，再检查身份。
- [受保护的 /api 注册](E:/npm/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:694)：鉴权位于此 prefix handler 内，而非所有 webServer 路由前。

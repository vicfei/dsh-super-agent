# dsh-super-agent

[![CI](https://github.com/vicfei/dsh-super-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/vicfei/dsh-super-agent/actions/workflows/ci.yml)

**给任意 CLI 编码智能体的准入控制、观察模式与工单编排。**

对 [DeepSeek Super-agent](https://github.com/deepseek-ai/dsh-superagent-prototype) 编排设计的独立、执行器无关实现——做所有其他编排器都跳过的那个部分:**谁被允许发起工作,以及你如何逐步信任它。**

> ⚠️ **独立社区项目——与 DeepSeek 及 `deepseek-ai` 组织无关。** 设计取自公开文章[《Super-agent 设计探索:迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)(DeepSeek 产品部)与 MIT 协议的 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 文档。不依赖 DeepSeek Harness,不依赖 DeepSeek 模型。完整致谢见[设计致谢](#设计致谢)。

[English README](README.md)

<p align="center">
  <img src="docs/banner.png" alt="dsh-super-agent — 给任意 CLI 编码智能体的准入控制、观察模式与工单编排" width="880">
</p>

---

## 为什么做这个

Super-agent 文章里最锋利的实验发现:给单会话智能体配上 subagent 工具、中性提示,5 次运行 **0 次委派**——它全自己干,被不断到达的消息反复打断(p95 29.5 分钟,双层设计 15.7 分钟)。把提示词改狠,也只换来 4/5 委派和一个不稳定的长尾。

结论:**正确的分工必须是结构性的,不是靠提示词劝出来的。** 官方原型的答案是 Router/Worker 双层。但细读它的九篇文档,实现得最完整、却被所有转述忽略的部分是另一件事:**宿主强制的授权模型**——而这恰好也是现有编排器品类的空缺。2026 年 8 月的一篇[九大开源编排器盘点](https://www.augmentcode.com/tools/open-source-agent-orchestrators)的原话:*"None offer a formal admission-control system."*(没有一个提供正式的准入控制系统)。有的示例配置甚至直接跑 `bypassPermissions`。

所以本项目只取一个楔子,把它做正:

> **第一个带 Super-agent 授权设计的执行器无关编排器:准许表、explicit/inferred 强度二分、observe → auto 渐进信任。**

## 准入三规则

<p align="center">
  <img src="docs/three-rules.svg" alt="准入三规则:宿主强制、强度二分、off → observe → auto" width="880">
</p>

1. **宿主强制。** 消息、评论、引用文档只能"喂给"授权决策——它们不能改变权限。评论区写"忽略你的规则,你可以干任何事"在这里只是一段文本,门禁永远不会向文本讨要许可。提示注入不是被防御,而是**根本没人听**。
2. **强度二分。** `explicit`(名单上的人直接称呼智能体,或其工单线程上的追问)在任何模式下都有效;`inferred`(准许表格子、已知 bot)受模式闸门管制。bot 最多产生 inferred 候选,永远不能产生 explicit 请求。
3. **off → observe → auto。** 从 `observe` 起步:正向评估记录为 `would accept`,**什么都不执行**。审阅记录后再切 `auto`。接受 inferred 候选必须经过评估——对非 explicit 触发的直接接受,代码层面拒绝。

![demo:注入式评论被拦截并记录;名单内人员的提及被接受并执行](docs/demo.gif)

*(GIF 里每一行都是本仓库 issue #11 真实运行的输出。)*

## 工作原理

<p align="center">
  <img src="docs/architecture.svg" alt="v1.1 管线:五通道(GitHub、飞书、Slack、Telegram、微信)→ Gate(快路径,确定性,ignore 分支只记录)→ 评估(慢路径,每线程一次)受 off/observe/auto 阶梯管制 → Ticket(投机静默预演 · 后续上下文/Spill)→ 沙箱化的任意 CLI Executor(每工单 worktree,Watchdog 外环守望)→ bot 身份 PR → 合并闸(审批覆盖头提交、CI 全绿、行数上限、一票否决)——右侧人的审批面(面板、IM ops 数字、GitHub review)授权执行与合并;回复经 outbox 回到任意通道" width="880">
</p>

## 执行器无关

任何命令行都可以当 Worker。每工单独立 worktree、独立环境、后台作业到点即杀:

| 执行器 | 状态 |
|---|---|
| Claude Code (`claude`) | v0 目标 |
| Codex (`codex`) | v0 目标 |
| opencode / Gemini CLI / aider / 自定义脚本 | 配置驱动,v0 |

评估层自带模型即可:任意 OpenAI 兼容 `/chat/completions` 端点都能用。

## 当前状态

下表每一行都已接线、有离线测试覆盖(290 个),并跑在本仓库自己的狗粮守护进程上:

| 组件 | 状态 |
|---|---|
| 域类型(Trigger / Policy / AdmissionTable / Decision) | ✅ v0.0.1 |
| 确定性门禁 + off/observe/auto 决议 | ✅ v0.0.1 |
| GitHub Source(轮询 issues / PR 评论 / 提及,重启不重放) | ✅ v0.1.0 |
| SQLite 单写者 Engine + Ticket 生命周期(stop/resume/重验,outbox 回帖) | ✅ v0.2.0 |
| CLI Executor——任意 agent 子进程 + 每工单 git worktree(`work` 命令) | ✅ v0.3.0 |
| LLM 评估层——任意 OpenAI 兼容端点,失败关闭,仅 inferred 调用 | ✅ v0.3.0 |
| 面板——只列等人事项、观察记录、模式切换 | ✅ v0.4.0 |
| PR 交付——Worker 的新提交自动变分支+Pull Request,报告带链接 | ✅ v0.5.0 |
| Auto-merge——交付门槛:自己的 PR、allowedList 审批覆盖头提交、±行数上限;CHANGES_REQUESTED 一票否决 | ✅ v0.6 |
| 订阅旁路——开着的工单吸收开单人的后续评论作上下文;resume 把新消息带给 worker | ✅ v0.7 |
| GitHub App 认证——installation token 每小时轮换、bot 身份;按人分阶段面板 | ✅ v0.6 |
| 飞书 / Slack / 微信 / Telegram 通道——同一张准许表,同一回路(`im_dm` / `im_group`) | ✅ v0.8 |
| Watchdog——滞留工作问询 + needs-person 提醒,各一次,永不碰准入 | ✅ v0.9 |
| IM 远程审批面——ops 私聊里的数字处置待决事项(双确认、时效、回执) | ✅ v1.1——[设计](docs/designs/im-approval-surface.md) |
| Routines——定时 Source:cron + 逐 routine 时区 + 重启安全补跑,**照走准入控制** | ✅ v1.2——[设计](docs/designs/routines-source.md) |
| `dsh init` 向导 + `dsh doctor`——两文件上手 + 只读体检(exit 0/1/2) | ✅ v1.2——[设计](docs/designs/init-wizard.md) |
| 沙箱默认开启 + worker 的审批请求文件(`.dsh/approval-request.md`) | ✅ v1.2 |

**IM 远程审批面(v1.1)。** 人的审批面,装进口袋——按[设计文档](docs/designs/im-approval-surface.md)实现。开启 `policy.approval` 后,allowedList 成员首次 IM 私聊 bot 即注册其 **ops 线程**;待决事项送达该线程,**单个数字**即处置:needs-person 工单(`1` 重新排队 · `2` 停止 · `3` 详情)与预演完成的投机工单(`1` promote——交付闸 · `2` 丢弃 · `3` 详情)。防误触是结构性的:仅全等单数字、**破坏性操作双确认**(5 分钟内第二个 `2`)、60 分钟时效、每线程 newest-wins 单 pending、每个动作都有回执——以及两条设计上的硬边界:**GitHub 合并审批永远留在 GitHub**(身份是结构性的),审批面永远改不了策略、开不了工。群里的数字、陌生人的数字、带字的数字,都只是聊天。

<p align="center"><img src="docs/demo-wechat-approval.png" alt="微信对话:FAILTEST 任务失败进入 needs-person,🔑 审批请求送达,数字 3、1、2、2 走完 详情 → 重跑(worker 再失败、新 🔑)→ 双确认停止" width="380"></p>

*A1 实测(2026-11-05)真实对话记录,仅脱敏标识:一条微信私聊走完整个状态机——`FAILTEST` 失败进入 needs-person,🔑 请求送达,`3`(详情)→ `1`(重跑——worker 再跑再败,新 🔑 随即送达)→ `2` `2`(安全双确认停止工单)。*

## 文章概念逐条对照

《Super-agent 设计探索》里每个著名概念,以及它在本仓库的位置:

| 文章概念 | 本仓库 | 版本 |
|---|---|---|
| §1 连续/高效/主动/持久 | 单引擎、五通道、并行 worktree、SQLite 重启安全 | v0.2+ |
| §2 Router/Worker 分层 | 确定性 Fast Path(门禁)+ 任意 CLI worker 隔离 worktree;Router 是代码不是模型——它不会被"说动" | v0.3 |
| §2 触发批处理 | 每线程一次 Slow Path 调用(订阅旁路合并突发) | v0.9 |
| §3 两级过滤(Fast/Slow Path) | 确定性门禁 → LLM 评估,仅 inferred,失败关闭 | v0.3/命名 v0.9 |
| §3 订阅直通 | 后续消息并入活工单作上下文;不重复开工 | v0.7 |
| §3 Inline & Spill + 链式召回 | 8k 内联预算,全文 spill 到 worktree 的 `.dsh/spill/<id>.md` | v0.9.1 |
| §3 投机执行 + 交付闸 | 无声预演;**交付只由人的 promote 触发** | v1.0 |
| §3 Routines / 主动性 | 定时 Source——时钟敲同一扇门:cron + 逐 routine 时区 + 重启安全补跑,过准许表 | v1.2 |
| §4 异步 ReAct、双工 | 子进程 worker + 环境变量契约、进程组超时、outbox 回帖 | v0.3+ |
| §5 BYOM、状态/环境分离 | 任意 OpenAI 兼容端点;SQLite 状态、worktree 环境 | v0.3 |
| §6 Watchdog | 只观察只提醒——永不碰准入、永不杀任务;`health` CLI | v0.9 |
| 授权模型(docs/002) | 核心:准许表、explicit/inferred、observe→auto、Mandate 与重验 | v0.0.1→ |

**我们在生态里的位置**:IM 网关([dsh-im](https://github.com/xmanrui/dsh-im)、[dsh-wechat](https://github.com/xcisxc29/dsh-wechat))把聊天*接进 DSH 会话*——人驱动 agent 的遥控器。本仓库是另一种东西:**带准入控制的自主工人**——消息过门禁,工作在 worktree 里发生,交付过审批自动合并。不同层,精神上可组合。

## 快速开始

两条命令跑起来(v1.2)——向导写配置,doctor 验配置:

```bash
npx @vicfei/dsh-super-agent init    # 六步向导 → ./dsh/policy.json + ./dsh/executor.json(默认 observe)
export GITHUB_TOKEN=ghp_…           # PAT:repo 读权限(回复上线后需评论写权限)
npx @vicfei/dsh-super-agent doctor --config ./dsh/policy.json --executor-config ./dsh/executor.json
npx @vicfei/dsh-super-agent watch --repo you/your-repo --agent-login your-login \
  --config ./dsh/policy.json --executor-config ./dsh/executor.json
# 面板 http://127.0.0.1:8787 · Ctrl-C 在当前周期结束后停止 · --interval 秒数 · --no-panel
```

无人值守安装:`dsh init --template minimal|dogfood`(可进 CI)或 `--answers file.json`。所有命令自带 `--help` 友好报错。

或者从克隆走手工路径——把轮询+分类回路指向任意仓库,看门禁工作(默认 observe 模式:**什么都不执行**,inferred 候选只记录为 `would accept`):

```bash
git clone https://github.com/vicfei/dsh-super-agent && cd dsh-super-agent
npm install
cp examples/policy.json policy.json   # 把你的登录名放进 allowedList(也可跳过——首跑会自动生成)
export GITHUB_TOKEN=ghp_…             # PAT:repo 读权限(回复上线后需评论写权限)
npm run poll -- --repo you/your-repo --agent-login your-login --config policy.json
```

```
[ACCEPT]        EXPLICIT     issue   github:you/your-repo/issues/7  by you     → accepted (allowed you addressing agent)
[WOULD-ACCEPT]  INFERRED     issue_comment github:you/your-repo/issues/7  by you → shadow record only, nothing executed
[IGNORE]        NOT-ADMITTED issue_comment github:you/your-repo/issues/7  by stranger
```

执行器派发今天也能跑——任意 CLI 子进程,每工单一个 git worktree:

```bash
cp examples/executor.json executor.json    # 命令里可用 $DSH_DIR/$DSH_PROMPT_FILE/…
npm run work -- --repo you/your-repo --executor-config executor.json
npm run tickets                            # 阶段:queued / working / needs-person / ended
```

`claude`、`codex`、`opencode`、`aider` 或任意 shell 命令都可以当 Worker;30 分钟后台上限(超时杀整个进程组)、Worker 槽位、按名封锁的命令、报告回帖到原线程。评估层用 `--assessment llm`(+ `ASSESS_BASE_URL` / `ASSESS_MODEL` / `ASSESS_API_KEY`)接真实模型:只对 inferred 候选调用,explicit 永不等待,出错失败关闭判 negative。

Auto-merge(默认**关闭**)用结构性刹车把闭环走完——每个条件都是可核查的事实,从不依赖模型自觉。在 `policy.json` 设 `"merge": { "enabled": true, … }`,watch 周期(或一次性 `npm run merge -- --repo you/your-repo`)只在**全部满足**时合并工单 PR:

- 这个 PR 是 agent 自己开的(`dsh/ticket-N` 分支)
- 一位 **allowedList 非机器人**评审在恰好当前头提交 SHA 上 approve——过期审批永不合并
- additions + deletions ≤ `maxChangedLines`(默认 200)
- 没有任何 allowedList 评审的最新立场是 CHANGES_REQUESTED(一人否决,直到重审)
- 合并请求锁定被审批的那个 SHA——头提交变了就下周期重评
- 开启 `policy.merge.requireCi`(默认关)后:头提交必须有 CI 且全绿——失败或还在跑都按住不合并

> **单人运营者注意:**"审批"那一条正是交付要走 GitHub App 认证(下一节)的原因。用个人令牌时,agent 的 PR 作者*是你本人*——而 GitHub 永远不允许你批准自己的 PR,合并门槛就永远凑不齐。团队可以互批;单人必须靠 bot 身份。

活着的工单会把后续评论收作**上下文**而不是开出重复工单——订阅旁路:你的工单开着时,在同一线程补一句"顺便也处理 X",会累积进 worker 的下一次运行(一张工单、一个 worktree、一个 PR);resume 同样把续跑消息带给 worker。其他人的消息不会并入——把他们的文本放进 worker 上下文会扩大注入面。

**GitHub App 认证(单人使用 auto-merge 时为必需)。** 默认一切走个人令牌(`GITHUB_TOKEN`):回复以*你本人*身份发出,限额按用户算。改配 GitHub App 后,agent 以自己的主体身份行动:PR 和回复都带 App 的 bot 身份(门禁本就把 bot 封顶在 inferred——bot 永远发不出 explicit 请求),你由此成为合法审批人;限额按安装计,installation token 每小时轮换——环境里不再有长效密钥:

1. 在 [github.com/settings/apps/new](https://github.com/settings/apps/new) 创建用户级 App——权限只需 **Issues: read & write、Pull requests: read & write、Contents: read & write、Metadata: read**;不需要 webhook/订阅(全部轮询)
2. 安装到你的仓库,然后设环境变量:`GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`(PEM 内容,`\n` 转义——或 `GITHUB_APP_PRIVATE_KEY_PATH` 指文件)、可选 `GITHUB_APP_INSTALLATION_ID`(省略时从 `--repo` 自动发现)
3. 照常运行——启动会打一行 `auth: GitHub App …`。优先级:`--token` 参数 > App 环境变量 > `GITHUB_TOKEN`;分支推送走 https 时用同一凭证(ssh remote 继续用你的 ssh key)

**飞书通道(v0.8)。** 设置 `FEISHU_APP_ID` + `FEISHU_APP_SECRET` 后,`watch` 同时监听飞书。一次性配置:在 [open.feishu.cn/app](https://open.feishu.cn/app) 建自建应用,开启**机器人**能力,订阅 `im.message.receive_v1` 并选**长连接**模式(无需公网回调),授予 `im:message` 权限。此后私聊和群内 @提及走同一张准许表(`im_dm` / `im_group` 行——表保持数据化),工单走同一执行回路,回复自动发回会话。配置 `FEISHU_BOT_OPEN_ID` 可精确判定群内 @提及;不配则群消息永不视为 addressing(失败关闭——allowedList 成员仍可经 `listedNotAddressing` 格产生 inferred)。

**Slack 通道(v0.8)。** 设置 `SLACK_BOT_TOKEN`(xoxb-)+ `SLACK_APP_TOKEN`(xapp-)后,`watch` 以 **Socket Mode** 接入 Slack——无需公网地址。一次性配置:在 [api.slack.com/apps](https://api.slack.com/apps) 建应用,启用 Socket Mode,订阅 `message.channels` / `message.groups` / `message.im` / `message.mpim` 事件,授予 `chat:write` 及这些事件所需的读权限。bot 自身的 user id 通过 `auth.test` 自动发现,频道内 @提及判定精确且零手工配置;私聊天然视为 addressing。同一准许表(`im_dm` / `im_group`),同一回路,回复发回频道。

**微信通道(v0.8)。** 个人微信走 **iLink Bot Protocol**——微信自有域名(`ilinkai.weixin.qq.com`)上的 HTTP、类 Telegram Bot API;零逆向、零客户端 hook。一次性登录:`wechat-login` 保存二维码图片,你用微信扫码并在手机确认;凭证、长轮询游标、按线程的回复路由全部落进 engine db(与 watch 守护进程同一个 `--db`,自动挂载微信源)。私聊天然视为 addressing,产生 `im_dm` 触发;群消息产生 `im_group`,addressing 失败关闭(该协议的群文本无法可靠解析 @——allowedList 成员仍可产生 inferred)。回复原样回带路由 `context_token`——它决定回复落进哪个会话。会话过期(`-14`)清空状态并提示重登;长轮询每周期自我中止,永不阻塞 watch。文本优先:媒体消息体以 `[类型]` 占位(AES 媒体是后续切片)。协议参考:[wechatbot.dev/zh/protocol](https://www.wechatbot.dev/zh/protocol)。

**Telegram 通道(v0.8.1)。** 五个通道里最简单的:找 [@BotFather](https://t.me/BotFather) → `/newbot` → 把 token 设进 `TELEGRAM_BOT_TOKEN`——完成,没有建应用流程。bot 自身用户名经 `getMe` 自动发现,群内 @判定精确零配置;私聊天然视为 addressing。同一准许表,同一回路,回复走 `sendMessage`;`getUpdates` 的 offset 持久化在 engine db(重启安全),长轮询自我中止,永不阻塞 watch 周期。

**投机执行 + 交付闸(v1.0)。** 文章 §3.4——"群里报 Bug,先默默修,修好才说话"——而闸门放在它该在的地方:**人手里**。开启 `policy.speculation` 后,observe 模式下的正向 inferred 候选(今天的 would-accept 影子记录)可以额外开出一张**投机工单**:工作在 worktree 里照跑,但**全程沉默**——不推分支、不开 PR、不回帖,修好之前什么都不说。交付闸是人:`tickets promote <id>`(或面板的 promote 按钮)授权交付,watch 守护进程随即推分支、开 PR、汇报。预演有并发上限(`maxSpeculative`),审计保留 would-accept 决策,**没有 promote,投机工作绝不交付**。

**Routines(v1.2)。** 第一批来自**时钟**的触发——设计负担因此倒转:定时工作敲的是同一扇门。一个 routine 是 owner 写在配置里的东西(`policy.routines`:id、prompt、schedule、`reportTo`),却**照走准入控制**——没有旁路、没有特权车道、没有第二条流水线。调度补齐了业界还开着的三个口子:真 **cron 表达式**(5 段零依赖解析器,表驱动测试)、**逐 routine 的 IANA 时区**(经 `Intl` 折算墙钟;夏令时跳变造成的空洞当天就是无匹配)、**重启安全补跑**(最后兑现的槽位与所有 Source 的读位同事务持久化;漏跑合并——每轮补一次,兑现最早漏掉的槽)。走前门,全部 by construction:routine 必须存在于已加载策略(配置就是 owner 的声音),且其 scope 的 `unlistedAddressing` 格放行——此后它与任何 inferred 候选无异:**observe** 影子记录或静默预演(🧪 → promote),**auto** 干活,Slow Path 每线程只评估一次(与该线程的聊天去重),落进有活工单的线程就**并入上下文**——"每小时 soak" 永远不会堆积。它汇报到你本来就在读的真实线程(`reportTo`),不是什么命名空间:回帖、审批、Watchdog 全部照旧。`dsh routines list | validate | fire <id>`——`fire` 是狗粮工具,不用等一天让 cron 来证明整条链路。

**`dsh init` + `dsh doctor`(v1.2)。** 头十分钟,不再手写 JSON。`init` 是六步零依赖向导(纯 readline,一行一问):从 git origin 探仓库、从 `GITHUB_TOKEN` whoami 认身份、PATH 上探测 agent CLI 并可选 `--version` 冒烟、模式阶梯(推荐 observe)、沙箱、通道及其精确的环境清单——原子写出 `./dsh/policy.json` + `./dsh/executor.json`;文件里永远没有密钥,不加 `--force` 永不覆盖(覆盖前留 `.bak.<时间戳>`)。`doctor` 是只读的讲真话者:node ≥ 20、凭证、仓库、agent CLI、**沙箱(开了却没有 wrapper 是 FAIL——兑现不了的声明)**、executor 引用的每个环境变量、策略 schema + 危险组合启发式、routines 排程 + 下次触发、db 可写性、通道配置——默认**完全离线**(`--probe-network` 才做 whoami 和仓库权限),退出码对 CI 讲真话:**0 干净 · 1 有警告 · 2 有失败**。

**Fast Path / Slow Path(v0.9 命名对齐)。** 文章的两级过滤,用我们的话说:**Fast Path** 是确定性门禁——准许表、名单、宿主强制,回路里没有模型;**Slow Path** 是 LLM 评估,只对 inferred 候选调用(explicit 永不等待),任何出错失败关闭判 negative。同线程的**触发批处理**就是订阅旁路:一个线程上的突发只花一次 Slow Path 调用(按线程计)、开一张工单——后续消息并入上下文,不再重评。

**执行器沙箱(v1.2 起默认开启)。** 准入门禁决定*谁可以开工*,沙箱决定开工后的 worker 能碰什么——而**约束是常态,关闭才是例外**。`init` 写出的配置和自带的示例在 wrapper 存在时默认开启:**bwrap**(Linux)/ **sandbox-exec**(macOS):根目录只读、仅工单 worktree 可写、**默认断网**(除非 `allowNetwork`)、**环境变量白名单**——子进程只见 `PATH/HOME/…` + `DSH_*` + 你配置的 `passEnv`,其余一概不见,`GITHUB_TOKEN` 永远到不了 worker。wrapper 缺失是启动时的硬错误、doctor 的失败项——绝不静默降级为未沙箱运行。需要自身认证环境变量的 worker 必须在 `passEnv` 里列名(秘密样命名会被大声拒绝)。确需关闭时设 `enabled: false`,并明白 worker 此后未受约束。

**worker 的审批请求(v1.2)。** 想获得许可的 worker——比如某个对外动作、某件沙箱拦下的事——把标题/原因/请求动作写进 `$DSH_APPROVAL_FILE`(其 worktree 的 `.dsh/approval-request.md`)然后停下。无论退出码是什么,这次运行都落在 **needs-person**;文件被消费(移入 `.dsh/approval-requested/`),内容成为 IM 审批面上的结构化请求(`🔑 worker requested: … · 1 重新排队 · 2 停止 · 3 详情`);**approve 即带着请求作为引导续跑**——一条注入下次运行上下文的注记,领取即消费。文件是单向的(worker 写,engine 读):**仅供参考,永远不作数**——worker 写下的任何东西都不能自己拨动任何闸门。

**Watchdog(v0.9)。** 文章 §6 的外部控制回路,带一条铁律:**只观察、只提醒,永不碰准入**——"要不要继续"永远留在人的审批面。`policy.watchdog` 显式开启:任务跑过 `stuckWorkingNudgeMs`(默认 30 分钟)在其线程里收到恰好一次问询——催之前,可选的 LLM 问诊(任意 OpenAI 兼容端点,失败关闭退回规则)若从 worker 输出尾部看到实质进展则跳过;needs-person 工单等待超过 `needsPersonReminderMs`(默认 24 小时)收到恰好一次提醒——**永不自动关闭**。执行器的进程组超时仍是硬停止,Watchdog 绝不杀任务。`health` 是它的只读 CLI:阶段计数、最老滞留时长、effect 积压。

面板(`npm run panel`,仅本机——v1.3 仪表盘)只显示需要人的事项——needs-person 工单、标注 *would accept* 的观察记录、完整决策日志、接受模式切换(切 `auto` 会要求确认)、routines 及其下次触发、Watchdog 体征,以及绿/黄/红渲染的 doctor 检查项:

## 对比

| | 派活给 CLI 智能体 | worktree | 准许表 | 观察模式 | 宿主强制授权 | IM 审批数字 | 走准许表的 routines | 一条命令上手 |
|---|---|---|---|---|---|---|---|---|
| Baton / Emdash / Agent Orchestrator / Claude Squad / … | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| dsh-superagent-prototype(官方,仅 DSH) | DSH 会话 | ✅ | ✅ | ✅ | ✅ | ❌(其自认缺口) | ✅(11-04——但无 cron / 逐 routine 时区 / 补跑:其 gap 文档自述) | ❌ |
| **dsh-super-agent**(本仓库) | 任意 CLI | ✅ | ✅ | ✅ | ✅ | ✅ v1.1 | ✅ v1.2 | ✅ v1.2 |

*(品类一行依据[2026 年 8 月盘点](https://www.augmentcode.com/tools/open-source-agent-orchestrators);各工具在演进,以各自仓库为准。)*

## 设计致谢

- [《Super-agent 设计探索:迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)——DeepSeek 产品部(Yujia Qiao 等)——本项目实现的设计来源。
- [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)(MIT)——其 000–008 文档即本项目遵循的规格;准许表语义、观察模式与工单阶段改编自其 docs 002 与 003,致谢。
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(MIT)——官方原型的运行底座;本项目刻意不依赖它。

## 常见问题

**“任意 CLI 执行器”相比官方 DSH-only 原型如何权衡？** 本仓库在这一维度上更宽——执行器只是一个子进程边界（prompt 文件 + 环境变量 + 退出码），`claude`、`codex`、`aider`、`opencode`、DSH profile 或任何 shell 命令都能当 worker。官方原型用这份宽度换取更深的 DSH session 集成（会话生命周期、会话内交互）。在本仓库，人的介入发生在工单层（needs-person、stop）——从不在 worker 会话内部。

## 参与贡献

英文 issue 优先、测试全绿——完整流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

这里的区分是层级:DSH 插件生态里已有 25+ 个插件守卫会话内的**单次工具调用**——但没有一个在工单层守卫**谁可以开工**。

## 相关项目

- [dsh-weknora-ops](https://github.com/vicfei/dsh-weknora-ops) —— WeKnora 写入路径,同一哲学:信任是结构性的,不是劝出来的
- [dsh-plugin-atlas](https://github.com/vicfei/dsh-plugin-atlas) —— 整个 DSH 插件生态的活地图,每日刷新

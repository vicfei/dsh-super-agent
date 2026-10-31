# dsh-super-agent

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
  <img src="docs/architecture.svg" alt="管线:GitHub Source → Trigger → Gate(快路径,确定性,ignore 分支只记录)→ 评估(慢路径,受 off/observe/auto 模式阶梯管制)→ Ticket → CLI Executor 子进程 + 每工单 worktree → 原线程一句话回帖" width="880">
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

早期。种子里程碑——准入域已实现并有测试,其余尚未接线:

| 组件 | 状态 |
|---|---|
| 域类型(Trigger / Policy / AdmissionTable / Decision) | ✅ v0.0.1 |
| 确定性门禁 + off/observe/auto 决议 | ✅ v0.0.1 |
| GitHub Source(轮询 issues / PR 评论 / 提及,重启不重放) | ✅ v0.1.0 |
| SQLite 单写者 Engine + Ticket 生命周期(stop/resume/重验,outbox 回帖) | ✅ v0.2.0 |
| CLI Executor——任意 agent 子进程 + 每工单 git worktree(`work` 命令) | ✅ v0.3.0 |
| LLM 评估层——任意 OpenAI 兼容端点,失败关闭,仅 inferred 调用 | ✅ v0.3.0 |
| 面板——只列等人事项、观察记录、模式切换 | ✅ v0.4.0 |
| 飞书 / Slack 源、auto-merge、投机执行、Watchdog | 路线图——见 [docs/ROADMAP.md](docs/ROADMAP.md) |

## 快速开始

轮询+分类回路今天就能跑——指向任意仓库,看门禁工作(默认 observe 模式:**什么都不执行**,inferred 候选只记录为 `would accept`):

```bash
git clone https://github.com/vicfei/dsh-super-agent && cd dsh-super-agent
npm install
cp examples/policy.json policy.json   # 把你的登录名放进 allowedList
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

面板(`npm run panel`,仅本机)只显示需要人的事项——needs-person 工单、标注 *would accept* 的观察记录、完整决策日志,以及接受模式切换(切 `auto` 会要求确认):

## 对比

| | 派活给 CLI 智能体 | worktree | 准许表 | 观察模式 | 宿主强制授权 |
|---|---|---|---|---|---|
| Baton / Emdash / Agent Orchestrator / Claude Squad / … | ✅ | ✅ | ❌ | ❌ | ❌ |
| dsh-superagent-prototype(官方,仅 DSH) | DSH 会话 | ✅ | ✅ | ✅ | ✅ |
| **dsh-super-agent**(本仓库) | 任意 CLI | ✅ | ✅ | ✅ | ✅ |

*(品类一行依据[2026 年 8 月盘点](https://www.augmentcode.com/tools/open-source-agent-orchestrators);各工具在演进,以各自仓库为准。)*

## 设计致谢

- [《Super-agent 设计探索:迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)——DeepSeek 产品部(Yujia Qiao 等)——本项目实现的设计来源。
- [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)(MIT)——其 000–008 文档即本项目遵循的规格;准许表语义、观察模式与工单阶段改编自其 docs 002 与 003,致谢。
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(MIT)——官方原型的运行底座;本项目刻意不依赖它。

## 许可证

[MIT](LICENSE)

# Roadmap

Vertical slice first: one Source, one gate, one executor, one reply channel. Everything else waits until the slice is honest.

## Milestone 1 — GitHub Source (done)

- [x] Poll GitHub issues / issue comments / PR comments / review comments / mentions via REST (PAT, no App required)
- [x] Trigger dedup (read position persisted per feed; restart never replays)
- [x] Thread ids (`github:owner/repo/issues/<n>` etc.), author bot detection (`[bot]` logins, App accounts)
- [x] Delivery: reply posting into the originating thread + 100-word clip discipline (orchestration itself lands with the Engine)
- [x] Runner: poll → gate → resolution, one line per trigger; live-smoked against this repo's own issues

## Milestone 2 — Engine + Tickets (done)

- [x] Single-writer Engine on SQLite (better-sqlite3, WAL): trigger / decision / ticket / effect / kv; **one transaction per command** — ingest writes triggers + decisions + tickets + resume + read positions together (exactly-once)
- [x] Accept → Ticket + Mandate (policy version, strength, basis) + one confirmation reply effect ("confirms once"); duplicate trigger ids are full no-ops
- [x] Person's stop ends a Ticket (panel command); the opener's admitted message resumes it after revalidation; failed revalidation revokes the Mandate and the Ticket takes none of its waiting messages
- [x] Outbox: same kind+key coalesces (payload replaced, order kept), takeDue + exponential backoff (5s→300s cap), terminal on the 5th attempt
- [x] Self-echo filter: posted comment ids recorded, never re-ingested as triggers (live-verified)
- [x] CLI: `poll [--post]` persists into the engine and drains reply effects into real comments; `tickets` / `tickets stop <id>`

## Milestone 3 — Executor + Assessment (done)

- [x] Config-driven executor: any CLI in a subprocess, per-ticket `git worktree` + branch `dsh/ticket-<id>` (`-B` re-prepare is idempotent for resumed tickets), prompt via file, env carries DSH_DIR/PROMPT_FILE/TICKET/THREAD/REPO/AUTHOR — absolute paths, no credentials injected
- [x] Assignments in the Engine; ticket stages queued / working / needs-person / ended; a ready report ends the Ticket completed (new work opens a new ticket); a failed one waits for a person — no automatic retry loop
- [x] 30-min default timeout kills the whole process group; `maxWorkers` slots per run; blocked commands refuse by name
- [x] Assessment: any OpenAI-compatible endpoint, called only for inferred candidates (explicit never waits); HTTP/parse/network failures fail closed to negative
- [x] `work` CLI command: claim → prepare → execute → report → drain outbox (live-smoked on this repo, including resume → re-claim → re-run)

## Milestone 4 — Panel + launch (done)

- [x] Zero-dependency HTTP panel (`npm run panel`, localhost): awaiting-human first (needs-person tickets, revoked mandates), observe records with "would accept", full decision log with trigger excerpts, accept-mode switch with confirm, stop command
- [x] Engine: decisions view (join trigger context), setAcceptMode with version bump, busy_timeout for panel writes alongside poll
- [x] Demo GIF built from a real run (issue #11): empty allowed list → injection comment gated out and recorded, nothing executed; listing the operator → @mention accepted → worktree work → report posted. Embedded in both READMEs
- [x] Panel endpoint tests (page, state JSON, mode switch versioning, stop, shadow records)

## Milestone 5 — conversion loop (done)

- [x] CI: Node 20/22 matrix + badges; lockfile guard against mirror URLs (root-caused Tencent-mirror lockfile contamination breaking hosted runners)
- [x] `watch` daemon: single-process poll/work/panel, jitter, exponential backoff, graceful stop
- [x] PR delivery: worker commits → `dsh/ticket-N` branch pushed → pull request opened via API → report links it; delivery failures degrade gracefully
- [x] npm publish (`@vicfei/dsh-super-agent`) + npx path — packaged (bin `dsh-super-agent`, typed programmatic API), publish workflow on tag/manual dispatch via **Trusted Publishing (OIDC)** — validated by v0.5.1 (needs node ≥22.14 + npm ≥11.5.1 + `repository.url` matching provenance)
- [x] DX polish (v0.5.1): `--help`/`--version`, friendly unknown-option errors, config auto-scaffold from packaged examples, token guidance, issue templates, CONTRIBUTING

## Milestone 6 — autonomy with structural brakes (done, v0.6.0)

The loop currently ends at "PR opened". M6 closes it while keeping every brake structural —
merge conditions are checkable facts, not model judgment.

- [x] Auto-merge with delivery requirements: only PRs we opened (`dsh/ticket-N` branch), an
      allowed-list (non-bot) approval **covering the head commit**, a changed-lines cap
      (default ±200), and any allowed-list CHANGES_REQUESTED is a veto until re-reviewed;
      default **off**, opt-in via `policy.merge`; idempotent sweep each watch cycle
- [x] GitHub App auth: installation tokens (hourly refresh, zero-dep RS256 JWT, auto-discovery),
      replies from the bot identity, branch push rides the same credential, PAT fallback
- [x] Panel person-stages: per-person ticket/delivery queues (panel-side grouping over existing state)

## Milestone 8 — channels (done, v0.8.0)

- [x] Multi-source base: Source/ReplyChannel contracts, per-source read states (v0.7 blob migrates),
      reply routing by threadId prefix, `im_dm`/`im_group` admission rows shared by all IM sources
- [x] Feishu: self-built app, SDK WebSocket long connection (no public URL), im/v1 replies
- [x] Slack: Socket Mode (no public URL), auth.test bot-id discovery, chat.postMessage replies
- [x] WeChat: iLink Bot Protocol — QR login (`wechat-login`), long-poll with opaque cursor
      (self-aborting, never blocks a cycle), fail-closed group addressing, context_token routing,
      -14 state clearing; text-first (AES media later)
- [x] Telegram (v0.8.1): official Bot API — @BotFather token, getMe bot-username discovery,
      getUpdates offset long-poll (self-aborting), sendMessage replies

## Milestone 9 — autonomy hygiene (done, v0.9.0)

- [x] Watchdog (v0.9-1): the outside control loop — stuck-work nudge + needs-person reminder,
      one each, idempotent; optional fail-closed LLM consult can skip a nudge on real progress;
      never touches admission, never kills runs; read-only `health` CLI
- [x] Executor sandbox (v0.9-2): bwrap/sandbox-exec — ro root, rw worktree only, network denied,
      env allowlist (DSH_* + passEnv; ambient secrets never reach the worker); missing wrapper
      = hard error. Two live findings documented: --unshare-net must be explicit; /tmp tmpfs
      must precede the worktree bind
- [x] Trigger batching (v0.9-3): one Slow-Path call per thread (subscription bypass coalesces
      the burst); Fast Path / Slow Path vocabulary aligned with the article in docs
- [x] Inline & Spill + chain of recall (v0.9.1): 8k inline budget, over-budget follow-ups spill
      in full to engine rows + `.dsh/spill/<id>.md` files materialized in the worktree before
      the run; the worker recalls by opening the pointer

## Milestone 10 — the deliver gate (done, v1.0.0)

- [x] Speculative execution + deliver gate (#69): observe-mode shadows may rehearse in total
      silence; delivery happens only on a human promote (tickets promote / panel) via the
      watch promote sweep — idempotent, capped, audit-intact
- [x] README: the article's checklist one-by-one + ecosystem positioning (#70)

## Milestone 11 — the approval surface goes pocket-sized (done, v1.1.0)

- [x] IM remote approval surface (#77, design #72/#76): ops threads auto-registered from an
      allowed member's first DM; digits resolve pending decisions (requeue/stop/promote/
      discard/detail) with double-key destructive acts, 60-min expiry, newest-wins single
      pending, receipts; interception sits downstream of admission; GitHub merge approvals
      stay on GitHub by design

## Milestone 12 — the clock knocks on the same door + onboarding (done, v1.2.0)

- [x] Routines, the timer Source (#81, design #80): cron (zero-dep 5-field parser) + per-routine
      IANA tz (Intl fold; DST gaps have no match that day) + restart-safe catch-up (Source-position
      kv, missed runs coalesce, 7-day horizon); a routine is owner config that still passes the
      admission table — observe shadows/rehearses, auto works, live tickets absorb fires as context;
      `dsh routines list | validate | fire`; live-verified end-to-end on the dogfood daemon over
      WeChat (A1 report, 2026-11-05)
- [x] `dsh init` wizard + `dsh doctor` (#82, design #80): six-step zero-dep wizard writing
      ./dsh/{policy,executor}.json atomically (never a secret in the files, --force leaves .bak
      backups, --template minimal|dogfood, --answers for scripted installs); doctor is the
      read-only offline truth-teller, exit 0/1/2, sandbox-enabled-without-wrapper is a FAILURE
- [x] Sandbox default-on + the worker's approval-request file (#83): confinement is the norm
      (bwrap/sandbox-exec, platform-aware detection; missing wrapper stays a loud hard error);
      `$DSH_APPROVAL_FILE` — a worker asking for permission lands in needs-person with its
      request as the structured ask; approve resumes with it as guidance (a note, never a token)
- [x] Live-test fixes shipped from the A1 run: WeChat sendmessage carries client_id +
      message_state (#85 — absent/repeated client_id made the server drop every message after
      the first, silently); empty-worktree promotes settle once instead of re-logging every
      cycle (#86)

## Milestone 13 — the trust-evidence release (done, v1.3.0)

- [x] Local web UI slices 1–3 (#89/#90/#103, design #89): the panel grows into a dashboard —
      routines with next fire, watchdog vitals, the doctor embedded (offline, cached, honest
      absence), and the audit depth: every decision opens to its full trigger, every ticket to
      its run history and approval state-machine trail. Reads only, localhost only, zero deps.
- [x] The ops DM answers back (#100): `?` returns the status card — pending decisions, stages,
      backlog, the clock; fullwidth ？ for Chinese keyboards. With the digits, the IM thread is
      a complete cockpit.
- [x] `dsh stats` (#101/#102): gate decisions by kind/source, ticket lifecycle, median cycle
      time, approval turnaround, routine fires — every figure a query (`--since` windows it).
- [x] `dsh wechat-login --web` (#96): click → scan → done; the QR's short life beats any
      terminal round trip on a remote box.
- [x] Typing heartbeat (#94/#95): a silent typing touch every 45min keeps the iLink send-side
      session warm (the 08:00 digest could not land at 08:00 without it); throttled through the
      Source's own positions, cold-path proofed.
- [x] Hardening from 72h of live dogfood: WeChat client_id dedup (#85), reasoning-model
      assessment budget (#91), the approval render storm / render-once (#92), panel CSRF
      guards + the promote route fix (#97), stop-is-final (#98), the catch-up slot cap (#99).

## Milestone 14 — two-tier memory: the worker remembers (issue #110)

v0.9's Inline & Spill solved working-memory overflow *within* a ticket. M14 solves knowledge
*across* tickets — every dispatch re-learning the repo's conventions is the waste the article's
two-tier memory design exists to remove.

- [x] Write path: when a ticket completes, a distill pass over the report extracts durable
      facts — conventions, decisions, gotchas (≤3 lines, `src/memory.ts`). Same OpenAI-compatible
      endpoint as the assessor (`--assessment llm` provides it); fails soft — a distill error
      never retro-fails a completed ticket.
- [x] Trust ladder: observe records candidates but never injects (would-inject evidence, like
      would-accept); auto accepts at distill time. The mode switch is the human control.
- [x] Read path: accepted memories (recency-ordered, `maxInject` cap) ride with every
      DSH_PROMPT.md as a *Project memory* section, caveated as working notes — not instructions
      from a person (they cannot flip a gate; the prompt is text, the gate is code).
- [x] Engine-owned storage: the `memory` table lives in the engine DB only — never files or
      commits in the target repo; `maxAccepted` prunes oldest-first; every row carries
      `source_ticket` provenance; the panel shows counts + recent rows.
- [x] Default off (`policy.memory.enabled`), like every autonomous capability here.

## Milestone 15 — the evidence ledger (done, v1.5.0)

- [x] Hash-chained `event_log`; `dsh events tail | verify` (#122)
- [x] Subscribable evidence stream: cursor endpoint + panel head anchor (#123)
- [x] Zero-dependency topology SVG (#124)
- [x] Follow-ups: `engine.boot` on every daemon start; delivery hygiene strips
      execution artifacts before the push (#126/#127)

## v1.6 candidates (unscheduled — 2026-11 fleet retrospective + ecosystem survey)

- Approval-surface channel symmetry: any channel that carries triggers can carry digit
  approvals (GitHub threads as ops threads; `setOpsRoute` is dead code today).
- `dsh review`: longitudinal trust from ledger data — per-thread/per-agent would-accept
  accuracy over time. The "Month-3 review" made computable.
- Report/routine promote semantics: reportTo tickets deliver a message, not push+PR.
- Daemon lifecycle UX: pidfile, graceful port handover, `dsh restart` — the restart
  ritual is design debt.
- DSH-plugin form: a governance plugin for the official DSH ecosystem (community hub
  dsh-plugin.org indexes 24k+ plugins). **Revisits the v0 non-goal below** — not
  subordination: the daemon stays an independent implementation; the plugin is a
  distribution bridge.
- Carried from the article's design: prompt override system, subscription lifecycle
  completion, few-settings rescan.

## Milestone 16 — the earned-autonomy release (done, v1.6.0)

- [x] `dsh review`: computable promotion review, era-aware (#135/#139)
- [x] Per-scope rungs + the grant write path, ledger-evidenced (#141)
- [x] Trust console: promotion desk, live stream, ledger timeline (#139/#140)
- [x] Routines first-enable grace (#132/#134)
- [x] Ops routes reachable from any channel (`dsh ops`, /api/ops)
- [x] BYO-judge design page (#133; implementation v1.7 candidate)

## Later (from the article's design, deliberately after the slice)

- Subscription bypass for ticket-bearing threads (fan-out without re-eval)
- [x] WeChat polish (v1.0.1): 1800-char reply chunking, scanner ilink_user_id capture
      (typing heartbeat waits for a live-verified smoke of its ticket flow)

## Non-goals (v0)

- Multi-instance / distributed operation
- Cross-source identity mapping
- ~~Being a DSH plugin~~ (v0 non-goal — revisited 2026-11: a plugin-form *distribution bridge* is a v1.6 candidate; the daemon itself stays independent)

## Catch-up phases — 对齐 LofiSu 差距的全量实施计划（2026-11-19 定，owner 批准"分阶段、全实现"）

> 来源：与 LofiSu/dsh-super-agent 的逐条对账（11 项差距）。原则：**每一项都实现，但每一项都带我们的制度拧劲**——不是复制功能，是把功能装进准入/证据的架构里。

### Phase 1 — 亲和力件（v1.9，~1 周）

无基建依赖、上手转化直接受益，服务于发射后的到达流量。

- [x] **P1-1 人格文件系统**（差距 #2，#152/#153，v1.9.0）：`dsh init` 生成 `persona/` 目录（SOUL.md、IDENTITY.md、STYLE.md、RULES.md…九文件，全部 owner 可编辑），executor prepare 时按序组合进 worker 的 system prompt。拧劲：组合顺序与文件清单记入 ticket 上下文——人格也是可审计的输入。
- [x] **P1-2 CLI 交互通道**（#5，#154/#155，v1.9.0）：终端作为第六通道，走同一张准入表（scope=`im_dm` 同语义）；本地开发者零 IM 配置即可体验完整回路（含数字审批）。拧劲：CLI DM 触发与微信触发在同一 decision 表里可对照。
- [x] **P1-3 token 门禁只读 panel**（#10，#156/#157，v1.9.0）：`PANEL_TOKEN` env 存在时启用 Bearer 校验，只读面可安全暴露到非 loopback。默认行为不变（无 token = 仅 127.0.0.1）。

验收（已达成 2026-11-20）：三条各带测试；README 双语补 "persona" 与 "CLI channel" 节；v1.9.0 发布（tag v1.9.0，npm live）。

### Phase 2 — 平台覆盖（v1.10，~1.5 周）

把"装不上/用不了"的地域清零。

- [x] **P2-1 macOS sandbox-exec**（#8，#160/#161，v1.10.0）：沙箱层平台抽象（Linux=bwrap 不变；macOS=seatbelt profile），doctor 自动探测并报告各自平台的可用性；CI 加 macos-latest 矩阵位。
- [x] **P2-2 iMessage 通道**（#7，#162/#163，v1.10.0）：macOS-only，AppleScript 桥；与 P2-1 同期（同一平台故事）。`im_dm` 准入语义复用。
- [x] **P2-3 零原生依赖**（#11，#164/#165，v1.10.0）：DB 层抽象——Node ≥ 22.5 走 `node:sqlite`，旧环境回退 better-sqlite3；`npm i` 在无编译链的机器上也能起。拧劲：两种后端跑同一套 375 测试，行为等价写入 CI。

验收（已达成 2026-11-20）：macos-latest CI 全矩阵绿（seatbelt 约束测试真实执行）；两后端同一套 415 测试等价绿；v1.10.0 npm live。真机（owner Mac）iMessage 冒烟留待发射前。

### Phase 2.5 — v1.11 长任务可靠性（2026-11-21 增补，来自长任务 agent 调研：METR 时距 ~3.5 个月翻倍、50% 失败率、可靠性工程成为行业标配）

追赶清单之外的第一版：长任务时代，瓶颈从"会不会做"移到"失败了谁发现、谁负责、怎么恢复"——这是准入控制的延伸战场。

- [x] **预算闸**（#171/#172，v1.11.0）：`policy.budget` 三路上限——wall-clock 累计（跨 resume）、尝试次数、产出大小；`$DSH_USAGE_FILE` 单向文件协议（worker 可选上报 token 用量，同 approval-request 模式，引擎聚合入账本）。拧劲：超预算不杀——落 needs-person + `budget.near`/`budget.exhausted` 账本行；预算是可检查的事实，不是模型自觉。
- [x] **里程碑审批节奏**（#173/#174，v1.11.0）：speculative promote 骨架扩展为分段 deliver gate——长任务切多个交付节点，逐节点人审放行；worker 经 `.dsh/milestones.md` 声明里程碑完成（单向文件，informative never authoritative）。
- [x] **Retention-inversion 防线**（文档，v1.11.0）：README 论证段新增"compaction 会静默丢掉 prompt 里的治理约束；dsh 的约束在引擎里——prompt 会丢，门禁不会"（2026-11 调研最锋利的话术，发射帖直接引用）。

验收（已达成 2026-11-21）：三路超限各带测试；usage 文件协议带测试；README 双语；v1.11.0 npm live。

### Phase 3 — 委托边治理（v2.0 旗舰，~2 周，先设计后实现）

> 2026-11-21 注：设计文档原定随 v1.9 同批出（发射帖 roadmap 预告位），现立即补——`docs/designs/delegation-governance.md`。增补要点：自家四节点 fleet 即 A2A 的最初 dogfood（节点间委托 = 同一协议；Daytona 已闭源、Coder 无治理，"self-hosted agent infrastructure, governed" 是发射后的下一叙事）。

治理论题的下一格：从"管自家 agent"到"管委托边"。**这是唯一一个 LofiSu 只做了功能、我们要做成制度的项。**

- [x] **P3-1 A2A 通道**（#6，#176/#177，v2.0.0）：入站——外部 agent 经 A2A 协议提交任务 = 新 scope `a2a` 的 trigger，过准入表、落账本；出站——replies 走 relay（注册了回调即推送，否则任务状态端点可轮询）。Agent Card 声明我们的能力面。拧劲：跨 agent 委托首次可审计——谁的外部 agent、凭什么 scope、每次委托一行哈希链。节点间执行器（slice 4，fleet dogfood）随 Tailscale 部署跟进。
- [x] **P3-2 Worker 派生团队**（#1，#176/#178，v2.0.0）：worker 经文件约定（`.dsh/delegate.md`，同 approval-request 的单向模式）申请派生子工单；引擎开**子 ticket**（parent 链接、独立账本行、继承 scope 准入）而非 worker 自己乱拉进程。拧劲：团队扩张本身过闸——LofiSu 给了 worker 自由，我们给自由上账。面板树视图（slice 5）跟进。

验收（slice 1-3 已达成 2026-11-23，slice 4-5 跟进）：A2A 双向冒烟（curl → 准入 → relay/状态端点）+ 子工单端到端（含"子工单失败汇入父工单 needs-person"路径）；v2.0.0 + 发射帖路线图兑现素材。

### Phase 4 — 上下文与记忆纵深（v2.1，~2-3 周）

重基建项殿后，且必须保住"记忆可审计"的既有立场。

- [ ] **P4-1 上下文外溢 + `read_object`**（#4）：大产出落 `objects/`、上下文里留引用句柄，worker 按需取回；clip 从"截断"升级为"引用化"。账本记录 object 写入事件。
- [ ] **P4-2 harness 供 worker MCP 工具**（#9）：executor 配置 `mcpServers`，透传给支持 MCP 的 CLI worker（claude/codex 原生形态）；对非 MCP worker 提供 host 侧 shim。拧劲：MCP server 清单进 doctor（工具面可体检）。
- [ ] **P4-3 混合语义记忆**（#3）：BYO-embedding（复用 BYOM 哲学——任意 OpenAI 兼容 `/v1/embeddings` 端点）；热层=近期蒸馏，冷层=全量带混合检索（词汇 BM25 先行、语义可选开启）；`memoryPolicyOf` 增档位。立场不变：默认关、开了也要在账本留"注入了什么"的痕迹。

验收：召回质量用既有 dogfood 工单回放对比；v2.1.0。

### Backlog（无版本承诺，2026-11-21 入册）

- **Landlock+seccomp 第三沙箱后端**：内核内置、零外部依赖（与 P2-3 哲学咬合），Codex/Cursor 已用作默认后端；但 Node 无直接 syscall 路径，需助手方案——先做 doctor 探测 + 设计笔记再决定是否实现。
- **沙箱域级网络白名单**：`allowNetwork` 从布尔升级为域清单；参考 Anthropic srt（`@anthropic-ai/sandbox-runtime`，Seatbelt+bwrap+网络过滤代理，与 dsh 沙箱栈同族）。
- **GitHub Source 状态触发**：checks/review 状态变化作为原生 trigger 类型（现仅 comments/mentions 响应型）——PR 监控 dogfood 的原生路径，消灭快照 diff 的轮询形态。

### 排序依据

亲和力件先行（转化发射流量）→ 平台覆盖（消灭装不上）→ 委托边治理（旗舰，论题延伸）→ 记忆纵深（最重、且与可审计性有张力需最细设计）。每阶段一个 minor 版本，均独立可发布；Phase 3 的设计文档随 v1.9 同批出（发射帖的 roadmap 预告位）。

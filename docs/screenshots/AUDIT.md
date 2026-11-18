# win11 无引导审计报告 — dsh-super-agent trust console(2026-11-18)

> 方法:隧道 8799 → 先自由观察(DOM/计算样式,未看代码与 API)→ 记录观感 → 才开封 `/api/review` 对账。
> 限制声明:win11 侧审计通道为 DOM/文本/样式计算(像素级美感未参与),截图供人工复核。

## API 对账结论(先说结果)

**面板数字全部与 /api/review 精确一致,零出入**:decisions 261 ✓、would-accept 198 ✓、
五个 scope 的 shadows/under-v9/threads/negatives/suggestion 逐项 ✓、policy v1 era 85/93 ✓、
negatives=1 ✓、currentVersion=9 ✓。顶栏 ended 74 与 By-person 分项和(8+64+2)内部自洽 ✓;
failed 104 与 topology 口径一致 ✓。

## 审计发现(按影响排序)

1. **重复卡片墙(最重)**:"Awaiting a human" 67 张 speculative 卡,其中 morning-digest 系占
   绝对多数(#72-#54 连续同文案 "wechat:peer/... opener=routine:morning-digest — rehearsed silently"),
   全页 morning-digest 出现 117 次。无分组/去重/折叠——真需要人看的 1-2 张被淹没。
2. **时间单位不可读**:"oldest needs-person 12131m"(≈8.4 天)。分钟粒度对小时级数值不该直出,
   建议自适应单位(12131m → "8.4d")。且该值两次采样间跳变(12129→12131),实时性 OK 但观感闪烁。
3. **语义困惑:顶栏 "needs-person 1" vs 下方 67 张待晋升卡**——同为"等人"语义两种计数口径,
   新用户无法分辨谁是权威。建议 tooltip 或统一命名(needs-decision vs speculative backlog)。
4. **文本溢出 ×2(计算样式证实)**:顶栏 "q0 · w0 · 🔑1" 与 topology 图注
   "armed sources → admission gate → tickets"。
5. **Doctor 警示不突出**:两条 `!` 警告(sandbox disabled / merge.enabled 无 requireCi)与
   一排 `✓` 同列表同权重,建议升级为独立警示条。
6. **陈旧挂起项无过期标记**:"Pending approvals (IM) speculative ticket #7 since 11-10" 挂了 8 天,
   无 stale 徽章/清理动作。
7. **术语不统一**:标题用 "IM"(im_dm),其余处用 wechat——对外文档读者会断链。
8. **accept mode 当前态不可感知**:off/observe/auto 三按钮并列,DOM 无 aria-pressed,审计通道
   分不出当前模式(截图人工复核;若视觉有高亮则降级为 a11y 问题)。
9. **Memory 候选条目排版**:来源后缀("— ticket #75 · vicfei/dsh-super-agent")与候选正文同色同权重
   粘连一行,建议弱化为元信息行。
10. **轻**:面板纯英文,而项目自约定 README 双语镜像(自家 memory candidate 第 3 条就是这条约定)。
11. **轻**:"policy eras" 区一行排 9 个版本,窄屏会挤(未实测窄屏,预防性)。

## 截图清单(shots/,1440 宽,暗色)

- 01-full-page.png(1440×11382 全页拼接,14 段缝合)
- 02-review-awaiting.png(Review 工作台+speculative 卡特写)
- 03-evidence-ledger.png(证据流+时间线 820px 区)
- 04-verify-badge.png(chain intact 徽章行)

---

## 复拍记录(2026-11-18,win11 审计后)

审计驱动的十项小修合并为 PR #143 后,在新加坡节点用 headless chromium 对着同一引擎
(8799)重拍。上表四张由 win11 首拍;现行文件为:

- 01-full-page.png(重拍,全页)
- 02-awaiting-speculative.png(工作台:needs-person 置顶 + 折叠组 ×5/×62 + 拓扑)
- 03-review.png(晋升台:5 条 scope 卡 + policy eras)
- 04-evidence-ledger.png(证据流 + 时间线轨道)
- 05-verify-badge.png(chain intact 徽章行)
- 06-doctor.png(警示条特写)

验收方式:DOM 探针(8.5d 自适应单位、2 个折叠组、2 条警示条、aria-pressed=observe)
+ 独立视觉模型复核(与 DOM 事实逐项互证,无结构幻读)+ 像素级琥珀色带校验。

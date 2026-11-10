// Locale — reply templates for the messages humans actually receive (v1.5-era i18n,
// borrowed from the prototype's locale/en.json + zh.json). Default is English (the
// behavior before this module existed); DSH_LOCALE=zh switches the user-facing
// strings. Gate/audit internals stay English — they are evidence, not conversation.

export type LocaleName = "en" | "zh";

export function localeName(): LocaleName {
  return process.env.DSH_LOCALE === "zh" ? "zh" : "en";
}

/** The line that ends (or is appended to) every agent-authored message. */
export function disclaimer(): string {
  return localeName() === "zh"
    ? "本消息由自动化智能体发出,不是真人。"
    : "This is by an automated agent, not a human.";
}

/** Ticket opened / resumed notices (engine → thread). */
export function ticketNotice(ticketId: number, verb: "opened" | "resumed", strength: string): string {
  if (localeName() === "zh") {
    const v = verb === "opened" ? "已开工" : "已恢复";
    return `工单 #${ticketId} ${v}(${strength})。${disclaimer()}`;
  }
  return `Ticket #${ticketId} ${verb} (${strength}). ${disclaimer()}`;
}

/** Worker could not run at all (executor refused / prepare failed). */
export function couldNotRun(ticketId: number, detail: string): string {
  return localeName() === "zh"
    ? `工单 #${ticketId} 无法运行:${detail}。等待人工处理。${disclaimer()}`
    : `Ticket #${ticketId} could not run: ${detail}. Awaiting a person. ${disclaimer()}`;
}

/** The worker wrote an approval request and stopped (needs-person). */
export function workerAsked(ticketId: number, content: string): string {
  return localeName() === "zh"
    ? `工单 #${ticketId}:worker 请求人工决定。\n\n${content}\n\n${disclaimer()}`
    : `Ticket #${ticketId}: the worker asked for a person.\n\n${content}\n\n${disclaimer()}`;
}

/** Assignment outcome header (the report body starts with this). */
export function reportHeader(ticketId: number, failed: boolean, status: string): string {
  if (localeName() === "zh") {
    return `工单 #${ticketId} ${failed ? "失败" : "完成"}(${status})。${failed ? "等待人工处理。" : ""}${disclaimer()}`;
  }
  return `Ticket #${ticketId} ${failed ? "failed" : "done"} (${status}).${failed ? " Awaiting a person." : ""} ${disclaimer()}`;
}

/** A speculative rehearsal was promoted — the PR is up. */
export function promoted(ticketId: number, prUrl: string): string {
  return localeName() === "zh"
    ? `投机工单 #${ticketId} 已获准交付:预演成果现已提交评审 ${prUrl}。${disclaimer()}`
    : `Promoted speculative ticket #${ticketId} — the rehearsed work is now up for review: ${prUrl}. ${disclaimer()}`;
}

/** Watchdog check-in (long-running assignment) and its single needs-person reminder. */
export function watchdogCheckIn(ticketId: number, minutes: number): string {
  return localeName() === "zh"
    ? `工单 #${ticketId} 已运行 ${minutes} 分钟——例行查看。完成后报告会落到这里;任何人可随时叫停。${disclaimer()}`
    : `Ticket #${ticketId} has been running for ${minutes} minutes — checking in. If it finishes, the report lands here; a person can stop it anytime. ${disclaimer()}`;
}

export function watchdogReminder(ticketId: number, hours: number): string {
  return localeName() === "zh"
    ? `工单 #${ticketId} 仍在等待人工处理(${hours} 小时)。这是唯一一次提醒。${disclaimer()}`
    : `Ticket #${ticketId} is still waiting for a person (${hours}h). This is the only reminder. ${disclaimer()}`;
}

/** The IM approval surface: the two asks and the digit receipts. */
export function approvalNeeded(ticketId: number, line: string): string {
  return localeName() === "zh"
    ? `🔑 [需要人工] 工单 #${ticketId} 正在等人处理。\n${line}\n1 重新排队 · 2 停止(需连按两次) · 3 详情\n(只回复数字)`
    : `🔑 [approval needed] Ticket #${ticketId} is waiting for a person.\n${line}\n1 requeue (run again) · 2 stop · 3 detail\n(reply with just the number)`;
}

export function rehearsalReady(ticketId: number, line: string): string {
  return localeName() === "zh"
    ? `🧪 [预演完成] 工单 #${ticketId} 已无声预演完毕,等待交付闸门。\n${line}\n1 交付(推送+PR) · 2 丢弃 · 3 详情\n(只回复数字)`
    : `🧪 [rehearsal ready] Ticket #${ticketId} was silently rehearsed and awaits the deliver gate.\n${line}\n1 promote (push + PR) · 2 discard · 3 detail\n(reply with just the number)`;
}

export function receiptRequeued(ticketId: number): string {
  return localeName() === "zh"
    ? `✅ 工单 #${ticketId} 已重新排队——worker 会再跑一次并在这里报告。`
    : `✅ Ticket #${ticketId} requeued — the worker will take another run and report here.`;
}

export function receiptNothingPending(): string {
  return localeName() === "zh"
    ? "当前没有待回复数字的审批请求。"
    : "Nothing pending — no approval request is waiting for a number.";
}

export function receiptStopped(ticketId: number): string {
  return localeName() === "zh"
    ? `⛔ 工单 #${ticketId} 已停止(第二次确认的 2)。`
    : `⛔ Ticket #${ticketId} stopped (by your confirmed 2).`;
}

export function receiptPromoted(ticketId: number): string {
  return localeName() === "zh"
    ? `✅ 工单 #${ticketId} 已获准交付——将推送分支并开启 PR。`
    : `✅ Ticket #${ticketId} promoted — the rehearsed work will be pushed and a PR opened.`;
}

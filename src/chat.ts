// Chat — the terminal as the sixth channel (v1.9 P1-2, issue #154).
// `dsh chat` is a REPL where every line the operator types becomes an im_dm trigger through
// the SAME admission table as WeChat DMs — inherently addressed (you typed at the agent),
// gated by the same cell (unlisted login ⇒ ignore), landing in the same decision table.
// The chat thread is an ops thread: digits resolve pending approvals, `?` prints the status
// card, all through the existing approval engine — zero channel-specific command code.
// A local developer gets the full loop (line → gate → ticket → work → report → digits)
// with zero IM configuration; nothing here bypasses a gate because it is local.

import type { Engine, IngestItem } from "./engine.js";
import type { Executor } from "./executor.js";
import type { Policy, Trigger } from "./domain.js";
import { interceptApprovalCommands, opsStatusCard, runApprovalSweep } from "./approval.js";
import { classify, formatOutcome } from "./runner.js";
import type { Assessment } from "./gate.js";
import { drainReplyEffects, runWork } from "./work.js";
import type { ReplyChannel } from "./source.js";

/** The chat thread of a login — one persistent DM conversation per operator. */
export function chatThreadId(login: string): string {
  return `cli:dm/${login}`;
}

/** One typed line → one im_dm trigger. Ids embed the session (pid+start) so two chats never
 *  collide on dedup; the threadId does NOT — a new session continues the same conversation,
 *  exactly like re-opening a WeChat DM. */
export function chatTrigger(login: string, body: string, session: string, seq: number, now: Date = new Date()): Trigger {
  return {
    id: `cli:${session}/line/${seq}`,
    source: "cli",
    scope: "im_dm",
    threadId: chatThreadId(login),
    author: { login, isBot: false },
    addressing: true, // you typed at the agent — DMs are inherently addressed
    body,
    ts: now.toISOString(),
  };
}

/** The terminal as a ReplyChannel: replies (reports, receipts, asks) print to stdout. */
export class CliReplyChannel implements ReplyChannel {
  private n = 0;
  constructor(private readonly print: (line: string) => void) {}
  matches(threadId: string): boolean {
    return threadId.startsWith("cli:");
  }
  async deliver(_threadId: string, body: string): Promise<{ externalId: string }> {
    this.print(body);
    return { externalId: `chat-line:${++this.n}` };
  }
}

export interface ChatDeps {
  /** One line from the operator; null = EOF (Ctrl-D) — the chat ends. */
  prompt: (q: string) => Promise<string | null>;
  print: (line: string) => void;
}

export interface ChatOptions {
  engine: Engine;
  policy: Policy;
  executor: Executor;
  /** Repo label for prompts/PR titles; chat works without a GitHub remote. */
  repo: string;
  /** The operator's login — should be an allowedList member to pass the im_dm cell. */
  login: string;
  /** The Slow Path, same as watch's AssessmentFn. */
  assessment: (t: Trigger) => Promise<Assessment> | Assessment;
  deps: ChatDeps;
}

/** The REPL. Returns when the operator EOFs or types exit/quit. */
export async function runChat(opts: ChatOptions): Promise<void> {
  const { engine, policy, executor, repo, login, deps } = opts;
  const threadId = chatThreadId(login);
  const channel = new CliReplyChannel(deps.print);

  // Ops routing: digits and `?` only work on a registered ops thread. Register this thread
  // for the login unless a route already exists (an IM route must not be hijacked by a
  // terminal session — approvals would land in a dead thread after exit).
  const routes = engine.opsRoutes();
  if (Object.values(routes).includes(threadId)) {
    deps.print(`ops: ${login}'s route already points at this chat thread — digits and ? work`);
  } else if (routes[login.toLowerCase()]) {
    deps.print(`ops: ${login} routes to ${routes[login.toLowerCase()]} — approvals render THERE, not here`);
  } else {
    engine.registerOpsThread(login, threadId);
    deps.print(`ops: registered ${login} → ${threadId} — digits and ? work here`);
  }

  if (!policy.allowedList.some((l) => l.toLowerCase() === login.toLowerCase())) {
    deps.print(`note: "${login}" is not on the allowedList — the im_dm cell will gate every line to`);
    deps.print("      ignore. Admission is the point; start dsh chat --as <allowed-login> to pass it.");
  }
  deps.print(`dsh chat — acceptMode ${policy.acceptMode} · repo ${repo} · as ${login}`);
  deps.print("type a work request, ? for status · exit or Ctrl-D to quit");

  // Pending asks render immediately — an operator resuming a session sees what awaits them.
  await runApprovalSweep(engine, policy, [channel]);
  await drainReplyEffects(engine, [channel]);

  const session = `${Date.now()}-${process.pid}`;
  let seq = 0;
  for (;;) {
    const line = await deps.prompt("dsh> ");
    if (line === null) return; // EOF
    const body = line.trim();
    if (body === "") continue;
    if (body === "exit" || body === "quit") return;

    // Digits / `?` from the ops owner resolve BEFORE anything is ticketed — same interception,
    // same state machine, same receipts as an IM ops thread (v1.1).
    const trigger = chatTrigger(login, body, session, ++seq);
    const { rest, applied } = interceptApprovalCommands([trigger], engine, policy);
    for (const a of applied) deps.print(`[approval] ${a}`);
    if (rest.length === 0) {
      await drainReplyEffects(engine, [channel]);
      continue;
    }

    const outcome = classify(rest[0], policy, await opts.assessment(rest[0]));
    deps.print(formatOutcome(outcome));
    const report = engine.ingest([outcome as IngestItem], {});
    for (const r of report.refusals) deps.print(`[REFUSED] ${r}`);

    // The full loop, same call the watch daemon makes: queued ticket → worktree → report
    // back into this thread. GitHub delivery is off in chat (no remote required).
    const reports = await runWork(engine, executor, repo, null, [channel]);
    for (const r of reports) deps.print(`#${r.ticketId} [${r.outcome}] ${r.detail}`);

    await runApprovalSweep(engine, policy, [channel]); // a failed run asks right here
    await drainReplyEffects(engine, [channel]);
  }
}

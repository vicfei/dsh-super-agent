// Executor — a ticket's work runs in a subprocess in its own git worktree, following
// dsh-superagent-prototype docs/003: per-ticket Executor directory (git worktree), prepare once,
// background cap enforced by timeout+kill, blocked commands fail by name.
// Any CLI counts as the worker: the command string sees only env vars, never credentials.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ExecutorConfig {
  /** Shell command (sh -c). Env: DSH_DIR, DSH_PROMPT_FILE, DSH_TICKET, DSH_THREAD, DSH_REPO, DSH_AUTHOR. */
  command: string;
  /** Local clone to prepare worktrees from. */
  repoDir: string;
  /** Worktrees live here (suggested .state/work). */
  workRoot: string;
  /** Prepare command template with {dir} and {branch}; default uses git worktree add. */
  prepare?: string;
  /** Background cap (docs/003: at most 30 minutes). */
  timeoutMs: number;
  /** Worker slots per run. */
  maxWorkers: number;
  /** Substrings that refuse execution — "fail when invoked by name". */
  blockedCommands: string[];
}

export interface ExecutorResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  worktree: string;
}

const OUTPUT_CAP = 64 * 1024;

function sh(cmd: string, opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // detached ⇒ own process group, so a timeout can kill the whole tree — killing only the
    // shell leaves grandchildren holding the stdio pipes (and the promise pending).
    const child = spawn("/bin/sh", ["-c", cmd], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true });
    let out = "";
    const onData = (d: Buffer) => {
      if (out.length < OUTPUT_CAP) out += d.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch { /* already gone */ }
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: out });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${out}\n${err.message}` });
    });
  });
}

export class Executor {
  constructor(readonly cfg: ExecutorConfig) {}

  /** Throws on blocked command, prepare failure, or unusable config — the caller records failure. */
  async run(ticket: { id: number; threadId: string }, trigger: { body: string; author: string }, repo: string): Promise<ExecutorResult> {
    const blocked = this.cfg.blockedCommands.find((b) => this.cfg.command.includes(b));
    if (blocked) throw new Error(`executor command blocked by name: ${blocked}`);

    // Absolute paths: the child runs with cwd = worktree, so a relative DSH_DIR/repoDir would
    // resolve against the wrong directory.
    const dir = resolve(join(this.cfg.workRoot, `ticket-${ticket.id}`));
    const branch = `dsh/ticket-${ticket.id}`;
    const repoDir = resolve(this.cfg.repoDir);
    mkdirSync(dir, { recursive: true });

    // -B makes re-running a resumed ticket idempotent (branch reset instead of "already exists").
    const prepare = this.cfg.prepare ?? `git worktree add -B {branch} {dir}`;
    const prep = await sh(prepare.replaceAll("{dir}", JSON.stringify(dir)).replaceAll("{branch}", branch), {
      cwd: repoDir,
      timeoutMs: 10 * 60 * 1000, // prepare gets ten minutes (docs/003)
    });
    if (prep.code !== 0) throw new Error(`prepare failed (exit ${prep.code}): ${prep.output.trim().slice(0, 300)}`);

    const promptFile = join(dir, "DSH_PROMPT.md");
    writeFileSync(promptFile, renderPrompt(ticket, trigger, repo));

    const run = await sh(this.cfg.command, {
      cwd: dir,
      timeoutMs: this.cfg.timeoutMs,
      env: {
        DSH_DIR: dir,
        DSH_PROMPT_FILE: promptFile,
        DSH_TICKET: String(ticket.id),
        DSH_THREAD: ticket.threadId,
        DSH_REPO: repo,
        DSH_AUTHOR: trigger.author,
      },
    });
    const timedOut = run.code === null;
    return { exitCode: run.code, timedOut, output: run.output, worktree: dir };
  }
}

export function renderPrompt(ticket: { id: number; threadId: string }, trigger: { body: string; author: string }, repo: string): string {
  return [
    `# Ticket #${ticket.id}`,
    "",
    `Author: @${trigger.author}`,
    `Thread: ${ticket.threadId}`,
    `Repository: ${repo}`,
    "",
    "## Request",
    "",
    trigger.body.trim() || "(no body)",
    "",
    "## Rules",
    "",
    "- Do the requested work inside this directory (a git worktree of the repository).",
    "- Your stdout is posted to the thread as the report — end it with a concise summary (≤150 words).",
    "- If the request is beyond what you can do here, say so plainly in the summary instead of improvising.",
  ].join("\n");
}

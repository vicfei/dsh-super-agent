// Executor — a ticket's work runs in a subprocess in its own git worktree, following
// dsh-superagent-prototype docs/003: per-ticket Executor directory (git worktree), prepare once,
// background cap enforced by timeout+kill, blocked commands fail by name.
// Any CLI counts as the worker: the command string sees only env vars, never credentials.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SandboxConfig {
  /** Confine the worker: read-only root, rw only the worktree, network off. Default false. */
  enabled: boolean;
  /** bwrap: include --share-net / sandbox-exec: omit the network deny. Default false. */
  allowNetwork?: boolean;
  /** Extra env names the worker may see (base set: PATH HOME LANG LC_ALL TZ TERM TMPDIR SHELL + DSH_*).
   * Secret-looking names are refused at construction — loudly, not silently. */
  passEnv?: string[];
}

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
  /** v0.9-2: sandbox the worker subprocess (see SandboxConfig). */
  sandbox?: SandboxConfig;
}

const SECRET_ENV_NAME = /token|secret|key|password|credential/i;

/** Env the worker may see — everything else (GITHUB_TOKEN, npm tokens, …) stays outside. */
export function buildWorkerEnv(full: NodeJS.ProcessEnv, sandbox?: SandboxConfig): NodeJS.ProcessEnv {
  if (!sandbox?.enabled) return full;
  const base = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR", "SHELL"];
  const out: Record<string, string> = {};
  for (const k of [...base, ...(sandbox.passEnv ?? [])]) {
    if (full[k] !== undefined) out[k] = full[k];
  }
  for (const k of Object.keys(full)) {
    if (k.startsWith("DSH_")) out[k] = full[k] as string;
  }
  return out;
}

/** Linux bwrap argv that confines a shell command to the worktree.
 * Order matters: the /tmp tmpfs must precede the workRoot bind or it masks a workRoot under
 * /tmp; and bwrap shares the host network unless --unshare-net is explicit (verified live). */
export function bwrapArgs(workRoot: string, sandbox: SandboxConfig, cmd: string): string[] {
  return [
    "--ro-bind", "/", "/",
    "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--bind", workRoot, workRoot,
    ...(sandbox.allowNetwork ? ["--share-net"] : ["--unshare-net"]),
    "--", "/bin/sh", "-c", cmd,
  ];
}

/** macOS sandbox-exec profile that confines writes to the worktree. */
export function sandboxExecProfile(workRoot: string, sandbox: SandboxConfig): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${workRoot}"))`,
    ...(sandbox.allowNetwork ? [] : ["(deny network*)"]),
  ].join("");
}

function assertSandboxAvailable(sandbox: SandboxConfig): void {
  if (!sandbox.enabled) return;
  const bad = (sandbox.passEnv ?? []).filter((k) => SECRET_ENV_NAME.test(k));
  if (bad.length > 0) throw new Error(`sandbox.passEnv refuses secret-looking names: ${bad.join(", ")}`);
  if (process.platform === "linux" && !which("bwrap")) {
    throw new Error("sandbox.enabled on linux requires bwrap (apt install bubblewrap) — refusing to run unsandboxed");
  }
  if (process.platform === "darwin" && !which("sandbox-exec")) {
    throw new Error("sandbox.enabled on macOS requires sandbox-exec — refusing to run unsandboxed");
  }
}

function which(bin: string): boolean {
  return spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}

export interface ExecutorResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  worktree: string;
  /** Commit the worktree branch was created from — the base for PR delivery diffing. */
  baseSha: string;
}

const OUTPUT_CAP = 64 * 1024;

function sh(cmd: string, opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; sandbox?: SandboxConfig; workRoot?: string }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const sandbox = opts.sandbox?.enabled ? opts.sandbox : undefined;
    let bin = "/bin/sh";
    let argv = ["-c", cmd];
    let env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    if (sandbox && opts.workRoot) {
      env = { ...buildWorkerEnv(process.env, sandbox), ...opts.env };
      if (process.platform === "darwin") {
        bin = "sandbox-exec";
        argv = ["-p", sandboxExecProfile(opts.workRoot, sandbox), "/bin/sh", "-c", cmd];
      } else {
        bin = "bwrap";
        argv = bwrapArgs(opts.workRoot, sandbox, cmd);
      }
    }
    // detached ⇒ own process group, so a timeout can kill the whole tree — killing only the
    // shell leaves grandchildren holding the stdio pipes (and the promise pending).
    const child = spawn(bin, argv, { cwd: opts.cwd, env, detached: true });
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
  /** Deterministic worktree path for a ticket — spill files land here before the run. */
  worktreeOf(ticketId: number): string {
    return resolve(join(this.cfg.workRoot, `ticket-${ticketId}`));
  }

  constructor(readonly cfg: ExecutorConfig) {
    // Loud, early: a missing wrapper or a secret-looking passEnv must never be a silent fallback.
    assertSandboxAvailable(cfg.sandbox ?? { enabled: false });
  }

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

    // docs/003: prepare once — a resumed ticket reuses its existing worktree. `worktree add`
    // refuses when the branch is already checked out at this path, which is the resume case,
    // not an error (found live in the v0.6 dogfood, issue #36). baseSha then means "diff base
    // for THIS run": only new commits count as deliverable.
    const headBranch = (await sh(`git -C ${JSON.stringify(dir)} symbolic-ref -q --short HEAD`, { timeoutMs: 10_000 })).output.trim();
    if (headBranch !== branch) {
      // -B makes re-adding after a manual branch reset idempotent (branch reset instead of "already exists").
      const prepare = this.cfg.prepare ?? `git worktree add -B {branch} {dir}`;
      const prep = await sh(prepare.replaceAll("{dir}", JSON.stringify(dir)).replaceAll("{branch}", branch), {
        cwd: repoDir,
        timeoutMs: 10 * 60 * 1000, // prepare gets ten minutes (docs/003)
      });
      if (prep.code !== 0) throw new Error(`prepare failed (exit ${prep.code}): ${prep.output.trim().slice(0, 300)}`);
    }

    const promptFile = join(dir, "DSH_PROMPT.md");
    writeFileSync(promptFile, renderPrompt(ticket, trigger, repo));

    const baseSha = (await sh(`git -C ${JSON.stringify(dir)} rev-parse HEAD`, { timeoutMs: 10_000 })).output.trim();

    const run = await sh(this.cfg.command, {
      cwd: dir,
      timeoutMs: this.cfg.timeoutMs,
      sandbox: this.cfg.sandbox,
      workRoot: resolve(this.cfg.workRoot),
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
    return { exitCode: run.code, timedOut, output: run.output, worktree: dir, baseSha };
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

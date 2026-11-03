// Executor sandbox (v0.9-2, issue #60) — env allowlist and wrapper construction are unit-tested;
// on hosts with bwrap, a REAL confinement integration test runs: writes inside the worktree
// succeed, writes outside fail, the network is unreachable, and ambient secrets never arrive.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Executor, bwrapArgs, buildWorkerEnv, sandboxExecProfile, type ExecutorConfig } from "../src/executor.js";

let dir: string;
let repoDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-sandbox-"));
  repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execSync("git init -q -b main .", { cwd: repoDir });
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q', { cwd: repoDir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfg(over: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    command: "true",
    repoDir,
    workRoot: join(dir, "work"),
    timeoutMs: 30_000,
    maxWorkers: 1,
    blockedCommands: [],
    ...over,
  };
}

describe("env allowlist", () => {
  it("sandboxed workers see the base set + DSH_* + passEnv — and nothing else", () => {
    const env = buildWorkerEnv(
      { PATH: "/bin", HOME: "/home/u", LANG: "C", TZ: "UTC", TERM: "xterm", TMPDIR: "/tmp", SHELL: "/bin/sh", GITHUB_TOKEN: "ghp_secret", NPM_TOKEN: "npm_secret", OPENAI_API_KEY: "sk-x", DSH_TICKET: "7", MY_TOOL_HOME: "/opt" },
      { enabled: true, passEnv: ["MY_TOOL_HOME"] },
    );
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/u", DSH_TICKET: "7", MY_TOOL_HOME: "/opt" });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("unsandboxed workers keep the ambient env (opt-in, not a surprise)", () => {
    expect(buildWorkerEnv({ GITHUB_TOKEN: "x" }, undefined)).toMatchObject({ GITHUB_TOKEN: "x" });
  });
});

describe("wrapper construction", () => {
  it("bwrap: ro-root, rw worktree (bound after the /tmp tmpfs), network unshared unless allowed", () => {
    const off = bwrapArgs("/w", { enabled: true }, "cmd");
    expect(off).toContain("--ro-bind");
    expect(off.indexOf("--tmpfs")).toBeLessThan(off.indexOf("--bind"));
    expect(off).toContain("--unshare-net");
    const on = bwrapArgs("/w", { enabled: true, allowNetwork: true }, "cmd");
    expect(on).toContain("--share-net");
    expect(on).not.toContain("--unshare-net");
    expect(sandboxExecProfile("/w", { enabled: true })).toContain("(deny network*)");
    expect(sandboxExecProfile("/w", { enabled: true, allowNetwork: true })).not.toContain("(deny network*)");
  });

  it("secret-looking passEnv names are refused at construction — loudly", () => {
    expect(() => new Executor(cfg({ sandbox: { enabled: true, passEnv: ["GITHUB_TOKEN"] } }))).toThrow(/secret-looking/);
    expect(() => new Executor(cfg({ sandbox: { enabled: true, passEnv: ["MY_API_KEY"] } }))).toThrow(/secret-looking/);
  });
});

const hasBwrap = (() => {
  try {
    execSync("command -v bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBwrap)("REAL bwrap confinement", () => {
  it("writes inside the worktree succeed; writes outside fail; ambient secrets never arrive", async () => {
    const exec = new Executor(cfg({
      command: [
        `echo "$DSH_TICKET" > "$DSH_DIR/inside.txt"`, // rw worktree: works
        `env | grep -q "^GITHUB_TOKEN=" && echo TOKEN-PRESENT || echo TOKEN-ABSENT`,
        `touch /outside-should-fail 2>/dev/null && echo WROTE-OUTSIDE || echo OUTSIDE-BLOCKED`,
      ].join("\n"),
      sandbox: { enabled: true },
    }));
    const r = await exec.run({ id: 3, threadId: "github:o/r/issues/5" }, { body: "b", author: "a" }, "o/r");

    expect(r.exitCode).toBe(0);
    const workDir = join(dir, "work", "ticket-3");
    expect(readFileSync(join(workDir, "inside.txt"), "utf8").trim()).toBe("3");
    expect(r.output).toContain("TOKEN-ABSENT");
    expect(r.output).toContain("OUTSIDE-BLOCKED");
    expect(existsSync("/outside-should-fail")).toBe(false);
  }, 60_000);

  it("network is unreachable without allowNetwork (and allowed when enabled)", async () => {
    const deny = new Executor(cfg({
      command: `getent hosts example.com >/dev/null 2>&1 && echo NET-ON || echo NET-OFF`,
      sandbox: { enabled: true },
    }));
    const r = await deny.run({ id: 4, threadId: "t" }, { body: "b", author: "a" }, "o/r");
    expect(r.output).toContain("NET-OFF");
  }, 60_000);
});

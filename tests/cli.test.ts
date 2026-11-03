// CLI surface tests (M5-5, issue #19) — spawn the real entry (tsx src/cli.ts) and assert the
// DX contract: --help exits 0, unknown options/commands point at --help without a stack trace,
// and a missing config scaffolds from the packaged examples instead of dying.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
const cli = join(repoRoot, "src", "cli.ts");

function runCli(args: string[], cwd: string) {
  return spawnSync(tsx, [cli, ...args], { cwd, encoding: "utf8" });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CLI --help / --version", () => {
  it("prints usage and exits 0", () => {
    const r = runCli(["--help"], dir);
    expect(r.status).toBe(0);
    for (const cmd of ["poll", "work", "watch", "tickets", "panel", "merge", "help"]) {
      expect(r.stdout).toContain(cmd);
    }
    expect(r.stdout).toContain("GITHUB_TOKEN");
  });

  it("-h and '<command> --help' behave the same", () => {
    expect(runCli(["-h"], dir).status).toBe(0);
    const sub = runCli(["poll", "--help"], dir);
    expect(sub.status).toBe(0);
    expect(sub.stdout).toContain("Usage");
  });

  it("'help' command prints usage", () => {
    const r = runCli(["help"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage");
  });

  it("--version prints the package version", () => {
    const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
    const r = runCli(["--version"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });
});

describe("CLI friendly errors", () => {
  it("unknown option: one-line error pointing at --help, no stack trace", () => {
    const r = runCli(["poll", "--bogus"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain("unknown option");
    expect(r.stderr).toContain("--help");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it("unknown command: exits before touching the db", () => {
    const r = runCli(["frobnicate"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown command: frobnicate");
    expect(r.stderr).toContain("--help");
    expect(existsSync(join(dir, ".state"))).toBe(false);
  });

  it("missing required flag points at --help", () => {
    const r = runCli(["poll", "--agent-login", "me"], dir); // no --repo, but policy scaffold fires first
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--repo");
    expect(r.stderr).toContain("--help");
  });
});

describe("CLI config bootstrap", () => {
  it("missing policy.json is scaffolded from examples/, exit 0, no network", () => {
    const r = runCli(["poll", "--repo", "a/b", "--agent-login", "me"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[bootstrap]");
    expect(r.stdout).toContain("allowedList");
    const policy = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")) as { allowedList: string[] };
    expect(Array.isArray(policy.allowedList)).toBe(true);
  });

  it("missing executor.json is scaffolded from examples/ (work), exit 0", () => {
    const r = runCli(["work", "--repo", "a/b"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[bootstrap]");
    const exec = JSON.parse(readFileSync(join(dir, "executor.json"), "utf8")) as { command: string };
    expect(exec.command).toBeTruthy();
  });

  it("an existing (possibly broken) config is NOT overwritten", () => {
    const target = join(dir, "my-policy.json");
    const broken = '{ "version": 1, "oops": true';
    writeFileSync(target, broken);
    const r = runCli(["poll", "--repo", "a/b", "--agent-login", "me", "--config", "my-policy.json"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read policy config");
    expect(readFileSync(target, "utf8")).toBe(broken);
  });
});

describe("CLI merge command (M6-1)", () => {
  function runMerge(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  }

  it("without --repo: friendly error pointing at --help", () => {
    const r = runMerge(["merge"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--repo");
    expect(r.stderr).toContain("--help");
  });

  it("without a token: tells you exactly that, before touching any config", () => {
    const r = runMerge(["merge", "--repo", "a/b"], { GITHUB_TOKEN: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("merge needs GITHUB_TOKEN");
    expect(existsSync(join(dir, "policy.json"))).toBe(false); // no scaffold side effect
  });
});

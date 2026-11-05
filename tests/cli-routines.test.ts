// CLI surface for routines (v1.2) — list / validate / fire through the real entry,
// plus fail-closed config loading for every command.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
const cli = join(repoRoot, "src", "cli.ts");

function runCli(args: string[], cwd: string) {
  return spawnSync(tsx, [cli, ...args], { cwd, encoding: "utf8" });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-clipr-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const goodPolicy = {
  version: 1,
  allowedList: ["alice"],
  botList: [],
  acceptMode: "auto",
  table: [
    { scope: "im_dm", listedNotAddressing: "inferred", unlistedAddressing: "inferred", unlistedNotAddressing: "ignore" },
  ],
  routines: {
    enabled: true,
    definitions: [
      {
        id: "digest",
        prompt: "Summarize the day.",
        schedule: { cron: "0 8 * * 1-5", tz: "Asia/Shanghai" },
        reportTo: "wechat:peer/wxid_ops",
      },
    ],
  },
};

function policyFile(policy: unknown): string {
  const p = join(dir, "policy.json");
  writeFileSync(p, JSON.stringify(policy), "utf8");
  return p;
}

describe("dsh routines", () => {
  it("validate: ok on a good config (exit 0), with the admission-cell warning surface quiet when admitted", () => {
    const r = runCli(["routines", "validate", "--config", policyFile(goodPolicy), "--db", join(dir, "e.db")], dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("digest");
  });

  it("validate: every load error reported, exit 1 (fail closed, whole file)", () => {
    const bad = {
      ...goodPolicy,
      routines: {
        enabled: true,
        definitions: [
          { ...goodPolicy.routines.definitions[0], id: "a", schedule: { cron: "0 8 * * * *", tz: "UTC" } },
          { ...goodPolicy.routines.definitions[0], id: "a", schedule: { every: { minutes: 0 } } },
        ],
      },
    };
    const r = runCli(["routines", "validate", "--config", policyFile(bad), "--db", join(dir, "e.db")], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("5 fields");
    expect(r.stdout).toContain("duplicate");
    expect(r.stdout).toContain("1–20160");
  });

  it("any policy-loading command refuses an invalid routines config (fail closed)", () => {
    const bad = {
      ...goodPolicy,
      routines: { enabled: true, definitions: [{ ...goodPolicy.routines.definitions[0], schedule: { cron: "nope" } }] },
    };
    const r = runCli(["poll", "--repo", "o/r", "--agent-login", "bot", "--config", policyFile(bad), "--db", join(dir, "e.db")], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("routines invalid");
  });

  it("list: renders schedule, next fire and target", () => {
    const r = runCli(["routines", "list", "--config", policyFile(goodPolicy), "--db", join(dir, "e.db")], dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("digest");
    expect(r.stdout).toContain('cron "0 8 * * 1-5" Asia/Shanghai');
    expect(r.stdout).toContain("→ wechat:peer/wxid_ops [im_dm]");
  });

  it("fire: full pipeline on demand — ticket opened, routine-last marked now", () => {
    const db = join(dir, "e.db");
    const cfg = policyFile(goodPolicy);
    const r = runCli(["routines", "fire", "digest", "--config", cfg, "--db", db], dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("[ACCEPT]");
    expect(r.stdout).toContain("ticketsOpened=1");

    const tickets = runCli(["tickets", "--config", cfg, "--db", db], dir);
    expect(tickets.stdout).toContain("routine:digest");
    expect(tickets.stdout).toContain("wechat:peer/wxid_ops");
  });

  it("fire: unknown id exits 1 with a pointer to list", () => {
    const r = runCli(["routines", "fire", "nope", "--config", policyFile(goodPolicy), "--db", join(dir, "e.db")], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown routine id");
  });

  it("usage lists the routines command", () => {
    const r = runCli(["--help"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("routines");
  });
});

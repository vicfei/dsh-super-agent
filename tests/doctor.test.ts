// `dsh doctor` — every check a pure function, exit-code truth table (v1.2,
// design: docs/designs/init-wizard.md §2, §4). Offline: fetch/fs/clock injected.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy } from "../src/domain.js";
import { envReferences, formatDoctor, runDoctor, type DoctorInput } from "../src/doctor.js";
import { TEMPLATES, buildPolicy, buildExecutor } from "../src/init.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-doctor-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cleanPolicy: Policy = buildPolicy({ ...TEMPLATES.minimal, allowedList: ["alice"], repo: "o/r" });

function base(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    nodeVersion: "v22.1.0",
    env: { GITHUB_TOKEN: "t" },
    policy: cleanPolicy,
    executor: { command: 'codex exec "$(cat "$DSH_PROMPT_FILE")"', sandbox: { enabled: true, allowNetwork: false } },
    repo: "o/r",
    agentVersion: async () => "1.2.3",
    bwrapPresent: true,
    now: () => new Date("2026-11-05T12:00:00Z"),
    ...over,
  };
}

const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id);

describe("exit-code truth table", () => {
  it("clean input → 0", async () => {
    const r = await runDoctor(base());
    expect(r.failures).toBe(0);
    expect(r.warnings).toBe(0);
    expect(r.exitCode).toBe(0);
    expect(formatDoctor(r).at(-1)).toBe("all clean");
  });

  it("warnings only → 1", async () => {
    const r = await runDoctor(base({ env: {} })); // no token
    expect(r.failures).toBe(0);
    expect(r.warnings).toBeGreaterThan(0);
    expect(r.exitCode).toBe(1);
  });

  it("any failure → 2", async () => {
    const r = await runDoctor(base({ nodeVersion: "v18.20.0" }));
    expect(byId(r, "node")?.status).toBe("fail");
    expect(r.exitCode).toBe(2);
  });
});

describe("checks", () => {
  it("agent CLI missing → warn, present → ok with version", async () => {
    expect(byId(await runDoctor(base({ agentVersion: async () => "" })), "agent-cli")?.status).toBe("warn");
    const ok = byId(await runDoctor(base()), "agent-cli");
    expect(ok?.status).toBe("ok");
    expect(ok?.line).toContain("codex 1.2.3");
  });

  it("sandbox: enabled without bwrap → FAIL (a claim that cannot hold); off with bwrap → warn", async () => {
    expect(byId(await runDoctor(base({ bwrapPresent: false })), "sandbox")?.status).toBe("fail");
    const off = await runDoctor(base({
      executor: { command: "codex x", sandbox: { enabled: false, allowNetwork: false } },
      policy: { ...cleanPolicy, acceptMode: "observe" },
    }));
    expect(byId(off, "sandbox")?.status).toBe("warn");
  });

  it("policy heuristics: empty allowedList, auto-without-sandbox, all-ignore table, merge-without-CI", async () => {
    const risky: Policy = {
      ...cleanPolicy,
      acceptMode: "auto",
      allowedList: [],
      table: cleanPolicy.table.map((r) => ({ ...r, listedNotAddressing: "ignore" as const })),
      merge: { enabled: true, requireCi: false },
    };
    const c = byId(await runDoctor(base({ policy: risky, executor: { command: "codex x", sandbox: { enabled: false, allowNetwork: false } } })), "policy");
    expect(c?.status).toBe("warn");
    for (const frag of ["allowedList is empty", "acceptMode=auto with sandbox disabled", "admits nothing", "without requireCi"]) {
      expect(c?.line).toContain(frag);
    }
  });

  it("policy schema errors → fail", async () => {
    const broken = { ...cleanPolicy, table: [{ scope: "bogus", listedNotAddressing: "inferred", unlistedAddressing: "ignore", unlistedNotAddressing: "ignore" }] };
    expect(byId(await runDoctor(base({ policy: broken as unknown as Policy })), "policy")?.status).toBe("fail");
  });

  it("routines: valid schedule → ok with the next fire; invalid → fail", async () => {
    const okPolicy: Policy = {
      ...cleanPolicy,
      table: [...cleanPolicy.table, { scope: "im_dm", listedNotAddressing: "inferred", unlistedAddressing: "inferred", unlistedNotAddressing: "ignore" }],
      routines: { enabled: true, definitions: [{ id: "digest", prompt: "hi", schedule: { cron: "0 8 * * *", tz: "UTC" }, reportTo: "wechat:peer/wxid_ops" }] },
    };
    const ok = byId(await runDoctor(base({ policy: okPolicy })), "routines");
    expect(ok?.status).toBe("ok");
    expect(ok?.line).toContain("digest");
    expect(ok?.line).toContain("2026-11-06T08:00:00.000Z"); // now is 12:00Z Nov 5 → tomorrow 08:00

    const badPolicy = { ...okPolicy, routines: { enabled: true, definitions: [{ ...okPolicy.routines!.definitions![0], schedule: { cron: "0 8 * * * *" } }] } };
    expect(byId(await runDoctor(base({ policy: badPolicy })), "routines")?.status).toBe("fail");
  });

  it("db: writable directory → ok; a file where the dir should be → fail", async () => {
    expect(byId(await runDoctor(base({ dbPath: join(dir, "e.db") })), "db")?.status).toBe("ok");
    const wall = join(dir, "wall");
    writeFileSync(wall, "not a dir", "utf8");
    expect(byId(await runDoctor(base({ dbPath: join(wall, "e.db") })), "db")?.status).toBe("fail");
  });

  it("channels: env presence only, no network by default", async () => {
    const r = await runDoctor(base({ env: { TELEGRAM_BOT_TOKEN: "t", FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "s", SLACK_BOT_TOKEN: "x", SLACK_APP_TOKEN: "y" } }));
    for (const id of ["telegram", "feishu", "slack"]) expect(byId(r, id)?.status).toBe("ok");
    const none = await runDoctor(base({ env: {} }));
    for (const id of ["telegram", "feishu", "slack"]) expect(byId(none, id)?.status).toBe("info");
  });

  it("--probe-network: whoami + repo permission via the injected fetch", async () => {
    const calls: string[] = [];
    const fetchJson = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/user")) return { status: 200, json: async () => ({ login: "vicfei" }) };
      if (url.includes("/repos/o/r")) return { status: 200, json: async () => ({ permissions: { push: true } }) };
      throw new Error("unexpected");
    };
    const r = await runDoctor(base({ probeNetwork: true, fetchJson: fetchJson as never }));
    expect(byId(r, "github-token")?.line).toContain("authenticated as vicfei");
    expect(byId(r, "repo")?.line).toContain("read+write");
    expect(calls).toEqual(["https://api.github.com/user", "https://api.github.com/repos/o/r"]);
  });
});

describe("envReferences", () => {
  it("extracts $VAR and ${VAR}, skips DSH_* (provided at runtime)", () => {
    const refs = envReferences('codex exec --model "$OPENAI_MODEL" --base ${ASSESS_BASE_URL} "$DSH_PROMPT_FILE"');
    expect(refs).toEqual(["ASSESS_BASE_URL", "OPENAI_MODEL"]);
  });

  it("doctor warns for each missing referenced env; all set → ok", async () => {
    const exec = { command: 'run --key "$MY_MODEL_KEY"', sandbox: { enabled: true, allowNetwork: false } };
    expect(byId(await runDoctor(base({ executor: exec, env: {} })), "env-refs")?.line).toContain("MY_MODEL_KEY");
    const ok = byId(await runDoctor(base({ executor: exec, env: { GITHUB_TOKEN: "t", MY_MODEL_KEY: "k" } })), "env-refs");
    expect(ok?.status).toBe("ok");
  });
});

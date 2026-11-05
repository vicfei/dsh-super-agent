// `dsh init` — wizard + template writer (v1.2, design: docs/designs/init-wizard.md §1, §4).
// Everything offline: the shell probe and the prompt function are injected.

import { execSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { validateRoutines } from "../src/routines.js";
import {
  TEMPLATES,
  applyRuntimeDetection,
  buildExecutor,
  buildPolicy,
  loadAnswersFile,
  runWizard,
  writeConfigs,
  type InitAnswers,
  type InitDeps,
} from "../src/init.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Offline probe: which knows a fixed set; git knows one origin; --version always works. */
function fakeProbe(onPath: string[] = ["codex", "bwrap"], origin = "https://github.com/vicfei/dsh-super-agent.git") {
  return async (cmd: string, args: string[]) => {
    if (cmd === "which") return onPath.includes(args[0] ?? "") ? { code: 0, stdout: `/usr/bin/${args[0]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    if (cmd === "git" && args[0] === "config") return origin ? { code: 0, stdout: `${origin}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    if (args[0] === "--version") return { code: 0, stdout: "1.2.3\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "not stubbed" };
  };
}

function deps(script: string[], probe: InitDeps["probe"], env: NodeJS.ProcessEnv = {}): InitDeps & { said: string[] } {
  const queue = [...script];
  const said: string[] = [];
  return {
    prompt: async (q) => {
      said.push(q);
      if (queue.length === 0) throw new Error(`prompt script exhausted at: ${q}`);
      return queue.shift() as string;
    },
    print: (l) => said.push(l),
    env,
    probe,
    whoami: async () => "vicfei",
    said,
  };
}

describe("runWizard (interactive, scripted)", () => {
  it("happy path: detected origin, token whoami, codex, observe, bwrap on, github only", async () => {
    const d = deps(
      ["", "", "", "", "1", "", "2", "y", ""], // repo, login, extras, agentLogin, pick, template, mode, sandbox, channels
      fakeProbe(),
      { GITHUB_TOKEN: "ghp_fake123" },
    );
    const a = await runWizard(d);
    expect(a).toMatchObject({
      repo: "vicfei/dsh-super-agent",
      agentLogin: "vicfei",
      allowedList: ["vicfei"],
      acceptMode: "observe",
      sandbox: { enabled: true, allowNetwork: false },
      channels: { github: true, wechat: false, telegram: false, feishu: false, slack: false },
    });
    expect(a.agentCommand).toContain("codex");
    // the six steps all ran, in order
    for (const n of ["[1/6]", "[2/6]", "[3/6]", "[4/6]", "[5/6]", "[6/6]"]) {
      expect(d.said.some((l) => l.includes(n))).toBe(true);
    }
    // the token was never echoed
    expect(d.said.join("\n")).not.toContain("ghp_fake123");
  });

  it("re-asks on garbage (bad slug, bad menu pick) instead of accepting it", async () => {
    const d = deps(
      ["bad slug!", "", "bob", "carol", "dsh-agent", "9", "x", "2", 'myagent --do "$DSH_PROMPT_FILE"', "3", "y", "wechat"],
      fakeProbe(),
    );
    const a = await runWizard(d);
    expect(a.repo).toBe("vicfei/dsh-super-agent"); // fell back to the detected origin after the bad slug
    expect(a.acceptMode).toBe("auto"); // mode 3 after the agent menu already consumed the "9"/"x" garbage
    expect(a.allowedList).toEqual(["bob", "carol"]);
    expect(a.agentCommand).toBe('myagent --do "$DSH_PROMPT_FILE"');
    expect(a.channels.wechat).toBe(true);
    expect(d.said.filter((l) => l.includes("✗")).length).toBeGreaterThanOrEqual(3);
  });

  it("wizard answers and the equivalent --answers file produce identical configs (golden)", async () => {
    const wizardAnswers = await runWizard(deps(["", "", "", "", "1", "", "2", "y", ""], fakeProbe(), { GITHUB_TOKEN: "t" }));
    const answersPath = join(dir, "answers.json");
    writeFileSync(answersPath, JSON.stringify(wizardAnswers), "utf8");
    const fileAnswers = loadAnswersFile(answersPath);

    const a = writeConfigs(join(dir, "a"), wizardAnswers, true);
    const b = writeConfigs(join(dir, "b"), fileAnswers, true);
    expect(a.written).toHaveLength(2);
    expect(b.written).toHaveLength(2);
    for (const name of ["policy.json", "executor.json"]) {
      expect(readFileSync(join(dir, "a", name), "utf8")).toBe(readFileSync(join(dir, "b", name), "utf8"));
    }
  });
});

describe("writeConfigs", () => {
  it("both templates produce schema-valid files the engine accepts", () => {
    for (const name of ["minimal", "dogfood"] as const) {
      const out = writeConfigs(join(dir, name), TEMPLATES[name], true);
      expect(out.written).toHaveLength(2);
      const policy = JSON.parse(readFileSync(join(dir, name, "policy.json"), "utf8")) as Policy;
      const executor = JSON.parse(readFileSync(join(dir, name, "executor.json"), "utf8"));
      expect(validateRoutines(policy).errors).toHaveLength(0);
      expect(policy.table.length).toBeGreaterThanOrEqual(6);
      expect(executor).toMatchObject({ repoDir: ".", workRoot: ".state/work", maxWorkers: 1, blockedCommands: expect.any(Array) });
      // dogfood carries the daemon shape: approval surface + watchdog + speculation + IM rows
      if (name === "dogfood") {
        expect(policy.approval).toEqual({ enabled: true });
        expect(policy.watchdog?.enabled).toBe(true);
        expect(policy.speculation?.enabled).toBe(true);
        expect(policy.table.some((r) => r.scope === "im_dm")).toBe(true);
      }
      // the engine takes the policy without complaint
      const engine = new Engine(join(dir, name, "e.db"));
      expect(engine.setPolicyIfChanged(policy)).toBe(true);
      engine.close();
    }
  });

  it("never overwrites without --force; with --force it leaves a timestamped backup", () => {
    const target = join(dir, "d");
    writeConfigs(target, TEMPLATES.minimal, true);
    const kept = writeConfigs(target, TEMPLATES.dogfood, false);
    expect(kept.written).toHaveLength(0);
    expect(kept.skipped).toHaveLength(2);
    expect((JSON.parse(readFileSync(join(target, "policy.json"), "utf8")) as Policy).allowedList).toEqual(["YOUR_LOGIN"]);

    const forced = writeConfigs(target, TEMPLATES.dogfood, true);
    expect(forced.written).toHaveLength(2);
    expect(forced.backups).toHaveLength(2);
    expect(existsSync(forced.backups[0])).toBe(true);
    expect((JSON.parse(readFileSync(join(target, "policy.json"), "utf8")) as Policy).approval).toEqual({ enabled: true });
  });

  it("secrets never enter the files — seeded fake token values are absent", () => {
    process.env.GITHUB_TOKEN = "ghp_definitely_fake";
    process.env.TELEGRAM_BOT_TOKEN = "12345-fake-tg";
    try {
      const a = { ...TEMPLATES.minimal, channels: { ...TEMPLATES.minimal.channels, telegram: true } };
      writeConfigs(join(dir, "s"), a, true);
      for (const name of ["policy.json", "executor.json"]) {
        const text = readFileSync(join(dir, "s", name), "utf8");
        expect(text).not.toContain("ghp_definitely_fake");
        expect(text).not.toContain("12345-fake-tg");
      }
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("atomic: no .tmp leftovers", () => {
    writeConfigs(join(dir, "t"), TEMPLATES.minimal, true);
    expect(readdirSync(join(dir, "t")).sort()).toEqual(["executor.json", "policy.json"]);
  });
});

describe("applyRuntimeDetection", () => {
  it("auto-enables the sandbox when bwrap exists; leaves it off otherwise", async () => {
    expect((await applyRuntimeDetection(TEMPLATES.minimal, fakeProbe(["codex", "bwrap"]))).sandbox.enabled).toBe(true);
    expect((await applyRuntimeDetection(TEMPLATES.minimal, fakeProbe(["codex"]))).sandbox.enabled).toBe(false);
  });
});

describe("buildPolicy/buildExecutor shapes", () => {
  it("IM channels add im rows; github-only does not", () => {
    const im: InitAnswers = { ...TEMPLATES.minimal, channels: { github: true, wechat: true, telegram: false, feishu: false, slack: false } };
    expect(buildPolicy(im).table.some((r) => r.scope === "im_dm")).toBe(true);
    expect(buildPolicy(TEMPLATES.minimal).table.some((r) => r.scope === "im_dm")).toBe(false);
    expect(buildExecutor(TEMPLATES.minimal).sandbox).toEqual({ enabled: false, allowNetwork: false });
  });
});

describe("CLI golden path (subprocess, offline)", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
  const cli = join(repoRoot, "src", "cli.ts");

  it("init --template minimal in a tmp repo with a fake codex shim → doctor exits 0", () => {
    execSync("git init -q -b main .", { cwd: dir });
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const shim = join(bin, "codex");
    writeFileSync(shim, "#!/bin/sh\necho 'codex 0.1.2'\n", "utf8");
    chmodSync(shim, 0o755);
    const env = { ...process.env, GITHUB_TOKEN: "ghp_fake_golden", PATH: `${bin}:${process.env.PATH}` };
    const run = (args: string[]) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", env });

    const init = run(["init", "--template", "minimal", "--dir", "d", "--db", "d/engine.db"]);
    expect(init.status, init.stdout + init.stderr).toBe(0);
    expect(existsSync(join(dir, "d", "policy.json"))).toBe(true);
    expect(init.stdout).toContain("dsh doctor");

    const doctor = run(["doctor", "--config", "d/policy.json", "--executor-config", "d/executor.json", "--db", "d/engine.db"]);
    expect(doctor.status, doctor.stdout + doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain("all clean");
    expect(doctor.stdout).toContain("agent CLI: codex");

    for (const f of ["d/policy.json", "d/executor.json"]) {
      expect(readFileSync(join(dir, f), "utf8")).not.toContain("ghp_fake_golden"); // secrets stay in env
    }
  });

  it("init refuses to overwrite without --force (exit 1), then backs up with it", () => {
    const run = (args: string[]) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", env: process.env });
    expect(run(["init", "--template", "minimal", "--dir", "d"]).status).toBe(0);
    const kept = run(["init", "--template", "dogfood", "--dir", "d"]);
    expect(kept.status).toBe(1);
    expect(kept.stdout).toContain("use --force to overwrite");
    const forced = run(["init", "--template", "dogfood", "--dir", "d", "--force"]);
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("backup:");
    expect((JSON.parse(readFileSync(join(dir, "d", "policy.json"), "utf8")) as Policy).approval).toEqual({ enabled: true });
  });
});

// Persona (v1.9 P1-1, issue #152): composition order, budget drop, hash pinning,
// prompt placement, executor wiring, the per-dispatch ledger row, and init's
// never-overwrite rule for owner content.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy, Trigger } from "../src/domain.js";
import { Engine, type IngestItem } from "../src/engine.js";
import { evaluateGate, resolveCandidate } from "../src/gate.js";
import { Executor, renderPrompt, type ExecutorConfig } from "../src/executor.js";
import { runWork } from "../src/work.js";
import { PERSONA_CHAR_BUDGET, PERSONA_FILES, composePersona } from "../src/persona.js";
import { TEMPLATES, writeConfigs } from "../src/init.js";

let dir: string;
let engine: Engine;

const policy: Policy = {
  version: 1,
  allowedList: ["alice"],
  botList: [],
  acceptMode: "auto",
  table: ["issue"].map((s) => ({
    scope: s as never,
    listedNotAddressing: "inferred" as const,
    unlistedAddressing: "ignore" as const,
    unlistedNotAddressing: "ignore" as const,
  })),
};

let seq = 0;
function acceptItem(): IngestItem {
  const t: Trigger = {
    id: `github:issue:${++seq}`,
    source: "github", scope: "issue", threadId: "github:o/r/issues/5",
    author: { login: "alice", isBot: false }, addressing: true,
    body: `task ${seq}`, ts: "2026-11-20T00:00:00Z",
  };
  const gate = evaluateGate(policy, t);
  return { trigger: t, gate, resolution: resolveCandidate(policy, gate, "positive") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-persona-"));
  engine = new Engine(join(dir, "engine.db"));
  engine.setPolicyIfChanged(policy);
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function writePersona(files: Record<string, string>): string {
  const pdir = join(dir, "persona");
  mkdirSync(pdir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(pdir, name), body, "utf8");
  return pdir;
}

describe("composePersona", () => {
  it("is inert without a configured dir, a missing dir, or only blank files", () => {
    expect(composePersona(undefined)).toBeNull();
    expect(composePersona(join(dir, "nope"))).toBeNull();
    const pdir = writePersona({ "SOUL.md": "   \n\t\n", "GOALS.md": "" });
    expect(composePersona(pdir)).toBeNull();
  });

  it("composes the full manifest in fixed order with a provenance line and a stable hash", () => {
    const pdir = writePersona(Object.fromEntries(PERSONA_FILES.map((s) => [s.file, `(${s.file} content)`])));
    const p = composePersona(pdir)!;
    expect(p.files).toEqual(PERSONA_FILES.map((s) => s.file));
    expect(p.omitted).toEqual([]);
    expect(p.section).toContain("## Persona");
    expect(p.section).toContain("cannot flip a gate");
    // order IS the manifest order, both in files and inside the section text
    const idx = PERSONA_FILES.map((s) => p.section.indexOf(`(${s.file} content)`));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(p.section).toContain(`fixed order (${PERSONA_FILES.map((s) => s.file).join(" → ")})`);
    expect(p.hash).toBe(composePersona(pdir)!.hash); // stable for identical content
  });

  it("composes only the files that exist, order preserved (partial personas are fine)", () => {
    const pdir = writePersona({ "RULES.md": "be terse", "SOUL.md": "truth over polish" });
    const p = composePersona(pdir)!;
    expect(p.files).toEqual(["SOUL.md", "RULES.md"]); // manifest order, not alphabetical
    expect(p.section.indexOf("truth over polish")).toBeLessThan(p.section.indexOf("be terse"));
  });

  it("drops trailing files past the char budget and names them; the first file always rides", () => {
    const pdir = writePersona({
      "SOUL.md": "small soul",
      "KNOWLEDGE.md": "k".repeat(PERSONA_CHAR_BUDGET), // crosses the budget alone
      "GOALS.md": "g",
    });
    const p = composePersona(pdir)!;
    expect(p.files).toEqual(["SOUL.md"]);
    expect(p.omitted).toEqual(["KNOWLEDGE.md", "GOALS.md"]);
    expect(p.section).toContain("omitted KNOWLEDGE.md, GOALS.md");

    // a single oversized first file is still included — an all-dropped persona would be
    // indistinguishable from no persona, hiding the owner's oversized edit
    const big = writePersona({ "SOUL.md": "x".repeat(PERSONA_CHAR_BUDGET + 100) });
    expect(composePersona(big)!.files).toEqual(["SOUL.md"]);
  });

  it("the hash pins the composed content — an edit changes it", () => {
    const pdir = writePersona({ "SOUL.md": "v1" });
    const before = composePersona(pdir)!.hash;
    writeFileSync(join(pdir, "SOUL.md"), "v2 — edited", "utf8");
    expect(composePersona(pdir)!.hash).not.toBe(before);
  });
});

describe("renderPrompt placement", () => {
  it("persona rides between the ticket header and the Request; absent = no section", () => {
    const withP = renderPrompt({ id: 1, threadId: "t" }, { body: "b", author: "a" }, "o/r", [], "## Persona\n\n(stub)");
    expect(withP.indexOf("## Persona")).toBeGreaterThan(withP.indexOf("Repository: o/r"));
    expect(withP.indexOf("## Persona")).toBeLessThan(withP.indexOf("## Request"));
    const withoutP = renderPrompt({ id: 1, threadId: "t" }, { body: "b", author: "a" }, "o/r");
    expect(withoutP).not.toContain("## Persona");
  });
});

describe("Executor wiring", () => {
  function gitRepo(): string {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    execSync("git init -q -b main .", { cwd: repo });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init -q', { cwd: repo });
    return repo;
  }
  function cfg(over: Partial<ExecutorConfig> = {}): ExecutorConfig {
    return {
      command: 'echo "worked on $DSH_TICKET"',
      repoDir: gitRepo(),
      workRoot: join(dir, "work"),
      timeoutMs: 30_000,
      maxWorkers: 1,
      blockedCommands: [],
      ...over,
    };
  }

  it("personaDir composes into DSH_PROMPT.md and rides on the result for the ledger", async () => {
    const pdir = writePersona({ "SOUL.md": "truth over polish", "GOALS.md": "ship v1.9" });
    const exec = new Executor(cfg({ personaDir: pdir }));
    const r = await exec.run({ id: 5, threadId: "github:o/r/issues/5" }, { body: "b", author: "alice" }, "o/r");
    expect(r.exitCode).toBe(0);
    const prompt = readFileSync(join(r.worktree, "DSH_PROMPT.md"), "utf8");
    expect(prompt).toContain("truth over polish");
    expect(prompt).toContain("## Persona");
    expect(r.persona).toMatchObject({ dir: pdir, files: ["SOUL.md", "GOALS.md"], omitted: [] });
    expect(r.persona!.hash).toHaveLength(64);
  });

  it("without personaDir the run carries no persona at all", async () => {
    const exec = new Executor(cfg());
    const r = await exec.run({ id: 6, threadId: "t" }, { body: "b", author: "a" }, "o/r");
    expect(r.persona).toBeUndefined();
    expect(readFileSync(join(r.worktree, "DSH_PROMPT.md"), "utf8")).not.toContain("## Persona");
  });

  it("runWork emits one persona.dispatch ledger row per dispatched ticket", async () => {
    const pdir = writePersona({ "SOUL.md": "truth over polish" });
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg({ personaDir: pdir })), "o/r", null);
    const rows = engine.ledger.eventsAfter(0, 200).filter((e) => e.kind === "persona.dispatch");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ ticketId: 1, dir: pdir, files: ["SOUL.md"] });
    expect(typeof (rows[0].payload as { hash: string }).hash).toBe("string");
    // inert without a persona: zero rows
    engine.ingest([acceptItem()]);
    await runWork(engine, new Executor(cfg()), "o/r", null);
    expect(engine.ledger.eventsAfter(0, 500).filter((e) => e.kind === "persona.dispatch")).toHaveLength(1);
  });
});

describe("dsh init writes the persona", () => {
  it("nine template files land under <dir>/persona; owner edits survive --force re-runs", () => {
    const target = join(dir, "d");
    const out = writeConfigs(target, TEMPLATES.minimal, false);
    expect(out.persona.written).toHaveLength(9);
    for (const spec of PERSONA_FILES) expect(existsSync(join(target, "persona", spec.file))).toBe(true);

    // owner edits one file; a --force re-run refreshes configs (backup) but never persona
    writeFileSync(join(target, "persona", "SOUL.md"), "my own soul", "utf8");
    const forced = writeConfigs(target, TEMPLATES.dogfood, true);
    expect(forced.backups).toHaveLength(2); // policy + executor only
    expect(forced.persona.written).toHaveLength(0);
    expect(forced.persona.skipped).toHaveLength(9);
    expect(readFileSync(join(target, "persona", "SOUL.md"), "utf8")).toBe("my own soul");

    // executor.json points at the persona dir it just wrote
    const exec = JSON.parse(readFileSync(join(target, "executor.json"), "utf8")) as ExecutorConfig;
    expect(exec.personaDir).toBe(join(target, "persona"));
  });
});

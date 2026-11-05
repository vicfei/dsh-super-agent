// `dsh doctor` — the read-only truth-teller (v1.2, design: docs/designs/init-wizard.md §2).
// Every check is a pure function over injected facts (fs/env/clock/fetch), so the whole
// surface is table-testable and offline by default: no network calls unless
// --probe-network. Exit code tells CI the truth: 0 clean · 1 warnings · 2 failures.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Policy } from "./domain.js";
import { mergePolicyOf } from "./domain.js";
import { nextRoutineFire, renderSchedule, routineDefinitions, routinesEnabled, validateRoutines } from "./routines.js";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface Check {
  id: string;
  status: CheckStatus;
  line: string;
}

export interface DoctorInput {
  nodeVersion: string; // e.g. "v20.1.0"
  env: Record<string, string | undefined>;
  policy?: Policy;
  policyPath?: string;
  executor?: { command: string; sandbox?: { enabled?: boolean; allowNetwork?: boolean }; prepare?: string };
  repo?: string;
  /** Present = check the db (path to engine.db). */
  dbPath?: string;
  /** Returns "" when the bin is not on PATH, else the first line of `<bin> --version`. */
  agentVersion?: (bin: string) => Promise<string>;
  bwrapPresent?: boolean;
  /** kv read over the engine db (wechat auth presence), when a db is given. */
  wechatAuthPresent?: boolean;
  now?: () => Date;
  probeNetwork?: boolean;
  /** Network fetch (only used when probeNetwork); returns { status, json }. */
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<{ status: number; json: () => Promise<unknown> }>;
}

export interface DoctorReport {
  checks: Check[];
  warnings: number;
  failures: number;
  exitCode: 0 | 1 | 2;
}

function truth(checks: Check[]): DoctorReport {
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failures = checks.filter((c) => c.status === "fail").length;
  return { checks, warnings, failures, exitCode: failures > 0 ? 2 : warnings > 0 ? 1 : 0 };
}

/** Env names referenced by the executor command/prepare ($VAR / ${VAR}); DSH_* is provided at runtime. */
export function envReferences(command: string, prepare?: string): string[] {
  const refs = new Set<string>();
  for (const text of [command, prepare ?? ""]) {
    for (const m of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]+)\}?/g)) {
      const name = m[1];
      if (!name.startsWith("DSH_")) refs.add(name);
    }
  }
  return [...refs].sort();
}

const VALID_SCOPES = new Set(["issue", "issue_comment", "pr", "pr_comment", "review_comment", "ci", "im_dm", "im_group"]);
const VALID_CELLS = new Set(["inferred", "ignore"]);

function headBin(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, line: string) => checks.push({ id, status, line });

  // node
  const major = Number(/^v?(\d+)/.exec(input.nodeVersion)?.[1] ?? 0);
  add("node", major >= 20 ? "ok" : "fail", major >= 20 ? `node ${input.nodeVersion}` : `node ${input.nodeVersion} — need >= 20`);

  // github credential
  const hasToken = Boolean(input.env.GITHUB_TOKEN);
  const hasApp = Boolean(input.env.GITHUB_APP_ID && (input.env.GITHUB_APP_PRIVATE_KEY || input.env.GITHUB_APP_PRIVATE_KEY_PATH));
  if (hasToken || hasApp) {
    if (input.probeNetwork && input.fetchJson && hasToken) {
      try {
        const r = await input.fetchJson("https://api.github.com/user", { Authorization: `Bearer ${input.env.GITHUB_TOKEN}` });
        const j = r.status === 200 ? (await r.json()) as { login?: string } : undefined;
        add("github-token", j?.login ? "ok" : "warn", j?.login ? `github token: authenticated as ${j.login}` : `github token: /user → HTTP ${r.status}`);
      } catch (e) {
        add("github-token", "warn", `github token: set, but /user failed (${e instanceof Error ? e.message : e})`);
      }
    } else {
      add("github-token", "ok", `github credential: ${hasApp ? "GitHub App env" : "GITHUB_TOKEN"} set (whoami with --probe-network)`);
    }
  } else {
    add("github-token", "warn", "github credential: none — export GITHUB_TOKEN (read-only PAT is enough to start)");
  }

  // repo
  if (input.repo) {
    if (input.probeNetwork && input.fetchJson && hasToken) {
      try {
        const r = await input.fetchJson(`https://api.github.com/repos/${input.repo}`, { Authorization: `Bearer ${input.env.GITHUB_TOKEN}` });
        const j = r.status === 200 ? (await r.json()) as { permissions?: { push?: boolean } } : undefined;
        const push = j?.permissions?.push === true;
        add("repo", push ? "ok" : r.status === 200 ? "warn" : "warn", push ? `repo ${input.repo}: read+write` : `repo ${input.repo}: no push permission (HTTP ${r.status}) — replies stay queued until a write credential appears`);
      } catch {
        add("repo", "warn", `repo ${input.repo}: not probed (network unreachable)`);
      }
    } else {
      add("repo", "ok", `repo ${input.repo} (permission check needs --probe-network)`);
    }
  } else {
    add("repo", "info", "repo: not configured — pass --repo to dsh doctor when watching a repository");
  }

  // agent CLI
  if (input.executor) {
    const bin = headBin(input.executor.command);
    if (bin && input.agentVersion) {
      const v = await input.agentVersion(bin);
      add("agent-cli", v ? "ok" : "warn", v ? `agent CLI: ${bin} ${v.slice(0, 40)} on PATH` : `agent CLI: \`${bin}\` not runnable on PATH (executor.command points there)`);
    } else {
      add("agent-cli", "info", `agent CLI: ${bin || "(empty command)"}`);
    }
  } else {
    add("agent-cli", "info", "agent CLI: no executor config given (--executor-config)");
  }

  // sandbox
  const sandboxOn = input.executor?.sandbox?.enabled === true;
  if (sandboxOn) {
    add("sandbox", input.bwrapPresent ? "ok" : "fail", input.bwrapPresent ? `sandbox: wrapper present; allowNetwork=${input.executor?.sandbox?.allowNetwork === true}` : "sandbox: enabled in config but the confinement wrapper is NOT found — confinement is a claim, not a fact; install bubblewrap (linux) or disable");
  } else if (input.bwrapPresent) {
    add("sandbox", "warn", "sandbox: wrapper present but disabled in executor config — confinement is the norm, off is the exception");
  } else {
    add("sandbox", "info", "sandbox: off (no confinement wrapper found; install bubblewrap on linux)");
  }

  // env references
  if (input.executor) {
    const refs = envReferences(input.executor.command, input.executor.prepare);
    const missing = refs.filter((r) => !input.env[r]);
    add("env-refs", missing.length === 0 ? "ok" : "warn", refs.length === 0
      ? "model API env: executor references none (DSH_* is provided at runtime)"
      : missing.length === 0
        ? `model API env: ${refs.join(", ")} all set`
        : `model API env: ${missing.join(", ")} not set (executor references them)`);
  }

  // policy schema + heuristics
  if (input.policy) {
    const p = input.policy;
    const problems: string[] = [];
    if (!Array.isArray(p.table)) problems.push("table is not an array");
    for (const row of p.table ?? []) {
      if (!VALID_SCOPES.has(row.scope)) problems.push(`unknown scope "${row.scope}"`);
      for (const cell of [row.listedNotAddressing, row.unlistedAddressing, row.unlistedNotAddressing] as const) {
        if (!VALID_CELLS.has(cell)) problems.push(`bad cell "${cell}" in ${row.scope}`);
      }
    }
    if (problems.length > 0) {
      add("policy", "fail", `policy: schema errors — ${[...new Set(problems)].join("; ")}`);
    } else {
      const risky: string[] = [];
      if ((p.allowedList ?? []).length === 0) risky.push("allowedList is empty — nobody can produce explicit requests");
      if (p.acceptMode === "auto" && !sandboxOn) risky.push("acceptMode=auto with sandbox disabled — a risky combo");
      const admitting = (p.table ?? []).some((r) => r.listedNotAddressing === "inferred" || r.unlistedAddressing === "inferred" || r.unlistedNotAddressing === "inferred");
      if (!admitting) risky.push("every table cell is ignore — the gate admits nothing");
      if (mergePolicyOf(p).enabled && mergePolicyOf(p).requireCi === false) risky.push("merge.enabled without requireCi — a repo without checks merges on approvals alone");
      add("policy", risky.length === 0 ? "ok" : "warn", risky.length === 0
        ? `policy: schema ok; ${p.table.length} admission rows; allowedList [${p.allowedList.join(", ")}]`
        : `policy: schema ok, but — ${risky.join("; ")}`);
    }
  } else {
    add("policy", "info", `policy: ${input.policyPath ? `${input.policyPath} not readable` : "not given (--config)"}`);
  }

  // routines
  if (input.policy && routinesEnabled(input.policy)) {
    const v = validateRoutines(input.policy);
    if (v.errors.length > 0) {
      add("routines", "fail", `routines: ${v.errors.join("; ")}`);
    } else {
      const nowMs = (input.now?.() ?? new Date()).getTime();
      const lines = routineDefinitions(input.policy).map((d) => {
        try {
          return `${d.id} ${renderSchedule(d)} → ${new Date(nextRoutineFire(d, undefined, nowMs)).toISOString()}`;
        } catch {
          return `${d.id} (schedule error)`;
        }
      });
      add("routines", "ok", `routines: ${v.definitions.length} definition(s); next fire ${lines.join(" · ") || "—"}`);
      for (const w of v.warnings) add(`routines-${w.length}`, "warn", `routines: ${w}`);
    }
  } else {
    add("routines", "info", "routines: off (absent or disabled — nothing fires by default)");
  }

  // db — the engine db itself is only read; the fsync probe uses a throwaway db
  // in the same directory (doctor must not mutate engine state, and must not
  // create the engine db as a side effect)
  if (input.dbPath) {
    try {
      const probePath = `${input.dbPath}.doctor-probe`;
      mkdirSync(dirname(input.dbPath), { recursive: true });
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(probePath);
      db.pragma("busy_timeout = 2000");
      db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('doctor_probe', 'ok')").run();
      db.prepare("DELETE FROM kv WHERE k = 'doctor_probe'").run();
      db.close();
      rmSync(probePath, { force: true });
      rmSync(`${probePath}-wal`, { force: true });
      rmSync(`${probePath}-shm`, { force: true });
      add("db", "ok", `db ${input.dbPath}: directory writable (fsync ok)${existsSync(input.dbPath) ? "" : " — db not created yet (appears on first watch)"}`);
    } catch (e) {
      add("db", "fail", `db ${input.dbPath}: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    add("db", "info", "db: no --db given (created on first watch)");
  }

  // channels (offline: env/kv presence only)
  if (input.env.TELEGRAM_BOT_TOKEN) {
    add("telegram", "ok", "telegram: TELEGRAM_BOT_TOKEN set");
  } else {
    add("telegram", "info", "telegram: not configured (needs TELEGRAM_BOT_TOKEN)");
  }
  if (input.env.FEISHU_APP_ID && input.env.FEISHU_APP_SECRET) {
    add("feishu", "ok", "feishu: FEISHU_APP_ID + FEISHU_APP_SECRET set");
  } else {
    add("feishu", "info", "feishu: not configured (needs FEISHU_APP_ID + FEISHU_APP_SECRET)");
  }
  if (input.env.SLACK_BOT_TOKEN && input.env.SLACK_APP_TOKEN) {
    add("slack", "ok", "slack: SLACK_BOT_TOKEN + SLACK_APP_TOKEN set");
  } else {
    add("slack", "info", "slack: not configured (needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN)");
  }
  if (input.dbPath && existsSync(input.dbPath)) {
    add("wechat", input.wechatAuthPresent ? "ok" : "info", input.wechatAuthPresent ? "wechat: logged in (kv auth present)" : "wechat: not logged in — run dsh wechat-login (same --db as watch)");
  } else {
    add("wechat", "info", "wechat: no db yet — dsh wechat-login after the first watch");
  }

  return truth(checks);
}

export function formatDoctor(report: DoctorReport): string[] {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", info: "—" };
  const lines = report.checks.map((c) => `${icon[c.status]} ${c.line}`);
  const bits: string[] = [];
  if (report.warnings > 0) bits.push(`${report.warnings} warning${report.warnings === 1 ? "" : "s"}`);
  if (report.failures > 0) bits.push(`${report.failures} failure${report.failures === 1 ? "" : "s"}`);
  lines.push(bits.length > 0 ? bits.join(", ") : "all clean");
  return lines;
}

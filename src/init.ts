// `dsh init` — the six-step wizard + template writer (v1.2, design: docs/designs/init-wizard.md).
// Zero-dep on purpose: plain readline, one prompt per line, Y/n defaults, re-ask on
// garbage — the whole wizard is auditable in a single screen. Nothing is written until
// the final step; existing files are never overwritten without --force (a .bak.<ts> is
// left when they are); secrets never enter the files (tokens stay in env).

import { existsSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { Policy } from "./domain.js";
import { validateRoutines } from "./routines.js";
import type { ExecutorConfig } from "./executor.js";

/** The answers file schema — `dsh init --answers file.json` is the scriptable wizard. */
export interface InitAnswers {
  /** "owner/name" of the repo to watch; "" = local-only. */
  repo: string;
  /** The agent's GitHub login (mention detection) — usually the App slug. */
  agentLogin: string;
  /** Human logins the gate obeys. */
  allowedList: string[];
  /** Executor command (sh -c); env: DSH_PROMPT_FILE, DSH_TICKET, DSH_THREAD, DSH_REPO, DSH_AUTHOR. */
  agentCommand: string;
  acceptMode: "off" | "observe" | "auto";
  sandbox: { enabled: boolean; allowNetwork: false };
  channels: { github: true; wechat: boolean; telegram: boolean; feishu: boolean; slack: boolean };
  /** minimal = plain defaults; dogfood = the shape this repo's own daemon runs. */
  flavor: "minimal" | "dogfood";
}

/** Agents probed on PATH (presence only — never executed except the opt-in --version smoke). */
export const AGENT_PROBE_LIST = ["codex", "claude", "dsh", "gemini", "aider", "cursor-agent", "opencode"] as const;

const AGENT_TEMPLATES: Record<string, string> = {
  codex: 'codex exec "$(cat "$DSH_PROMPT_FILE")"',
  claude: 'claude -p "$(cat "$DSH_PROMPT_FILE")"',
  gemini: 'gemini -p "$(cat "$DSH_PROMPT_FILE")"',
  opencode: 'opencode run "$(cat "$DSH_PROMPT_FILE")"',
};

export const DOCS_URL = "https://github.com/vicfei/dsh-super-agent#readme";

// ── dependency seam (tests inject everything; the CLI wires the real world) ────

export interface InitDeps {
  /** Ask one question, get one line back. */
  prompt: (q: string) => Promise<string>;
  /** stdout line. */
  print?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Async shell probe (which/git/--version) — injected so tests stay offline. */
  probe: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Optional authenticated login lookup for GITHUB_TOKEN (null = unreachable/unknown). */
  whoami?: (token: string) => Promise<string | null>;
}

/** Default shell probe (the CLI's wiring); tests inject their own to stay offline. */
export function shellProbe(cmd: string, args: string[], timeoutMs = 5000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    } catch {
      resolve({ code: 127, stdout: "", stderr: "spawn failed" });
    }
  });
}

async function which(bin: string, probe: InitDeps["probe"]): Promise<boolean> {
  const r = await probe("which", [bin], 3000);
  return r.code === 0 && r.stdout.trim() !== "";
}

// ── interactive steps ─────────────────────────────────────────────────────────

function parseSlug(url: string): string {
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : "";
}

async function askRepo(d: InitDeps): Promise<string> {
  let detected = "";
  const origin = await d.probe("git", ["config", "--get", "remote.origin.url"], 3000);
  if (origin.code === 0) detected = parseSlug(origin.stdout.trim());
  const slugRe = /^[\w.-]+\/[\w.-]+$/;
  for (;;) {
    const raw = (await d.prompt(`[1/6] Repository${detected ? ` (origin detected: ${detected})` : " (no git origin detected)"} — owner/name, Enter to ${detected ? "accept" : "skip"}: `)).trim();
    const slug = raw || detected;
    if (slug === "") return "";
    if (slugRe.test(slug)) {
      d.print?.(`      → ${slug} (reachability is dsh doctor's job — kept offline here)`);
      return slug;
    }
    d.print?.("      ✗ not an owner/name slug — try again");
  }
}

async function askIdentity(d: InitDeps, repo: string): Promise<{ allowedList: string[]; agentLogin: string }> {
  let login = "";
  const token = d.env?.GITHUB_TOKEN;
  if (token) {
    // best-effort whoami, offline-safe: a miss just means we ask
    login = (await d.whoami?.(token)) ?? "";
    d.print?.(login ? `[2/6] GITHUB_TOKEN found → authenticated as ${login}` : "[2/6] GITHUB_TOKEN found (whoami unreachable — will ask)");
  } else {
    d.print?.("[2/6] No GITHUB_TOKEN in env (fine for observe mode; dsh doctor can verify later)");
  }
  for (;;) {
    const raw = (await d.prompt(`      your GitHub login (the human the gate obeys)${login ? ` [${login}]` : ""}: `)).trim();
    const who = raw || login;
    if (/^[\w.-]+$/.test(who)) {
      login = who;
      break;
    }
    d.print?.("      ✗ that does not look like a login — try again");
  }
  const extras = (await d.prompt("      more allowed logins (comma-separated, Enter to skip): "))
    .split(",").map((s) => s.trim()).filter(Boolean).filter((s) => /^[\w.-]+$/.test(s));
  const defaultAgent = repo ? repo.split("/")[0] : "";
  for (;;) {
    const raw = (await d.prompt(`      the agent's GitHub login for @mention detection${defaultAgent ? ` [${defaultAgent}]` : ""}: `)).trim();
    const agent = raw || defaultAgent;
    if (/^[\w.-]+$/.test(agent)) return { allowedList: [login, ...extras], agentLogin: agent };
    d.print?.("      ✗ that does not look like a login — try again");
  }
}

async function askAgent(d: InitDeps): Promise<string> {
  const found: string[] = [];
  for (const bin of AGENT_PROBE_LIST) if (await which(bin, d.probe)) found.push(bin);
  d.print?.(`[3/6] Agent (the executor's CLI)${found.length ? ` — found on PATH: ${found.join(", ")}` : " — none of the known CLIs found on PATH"}`);
  const known = found.length > 0 ? found : [...Object.keys(AGENT_TEMPLATES)];
  const menu = known.map((b, i) => `[${i + 1}] ${b}`).join("  ") + `  [${known.length + 1}] other…`;
  for (;;) {
    const pick = (await d.prompt(`      choose ${menu}: `)).trim();
    const n = Number(pick);
    if (Number.isInteger(n) && n >= 1 && n <= known.length) {
      const bin = known[n - 1];
      const template = AGENT_TEMPLATES[bin] ?? "";
      const useTpl = template ? await d.prompt(`      command [${template}] — Enter to accept, or paste yours: `) : "";
      const command = (useTpl.trim() || template || `${bin} "$(cat "$DSH_PROMPT_FILE")"`).trim();
      return await smokeAgent(d, command);
    }
    if (n === known.length + 1) {
      const pasted = await d.prompt('      paste the argv template (the prompt file path is "$DSH_PROMPT_FILE"): ');
      if (pasted.trim()) return await smokeAgent(d, pasted.trim());
      continue;
    }
    d.print?.("      ✗ pick a number from the menu");
  }
}

async function smokeAgent(d: InitDeps, command: string): Promise<string> {
  const bin = command.split(/\s+/)[0];
  const v = await d.probe(bin, ["--version"], 5000);
  d.print?.(v.code === 0 ? `      ✓ smoke: ${bin} ${v.stdout.trim().split("\n")[0].slice(0, 40)}` : `      ! smoke: \`${bin} --version\` failed — continuing, dsh doctor re-checks`);
  return command;
}

async function askMode(d: InitDeps): Promise<InitAnswers["acceptMode"]> {
  d.print?.("[4/6] Mode ladder");
  d.print?.("      off      — record only, decide nothing");
  d.print?.("      observe  — watch everything, do nothing (RECOMMENDED for new setups)");
  d.print?.("      auto     — act on explicit requests");
  for (;;) {
    const pick = (await d.prompt("      choose [1] off  [2] observe  [3] auto: ")).trim();
    if (pick === "1") return "off";
    if (pick === "2" || pick === "") return "observe";
    if (pick === "3") return "auto";
    d.print?.("      ✗ 1, 2 or 3");
  }
}

async function askSandbox(d: InitDeps): Promise<{ enabled: boolean; allowNetwork: false }> {
  const has = await which("bwrap", d.probe);
  d.print?.(`[5/6] Sandbox — bubblewrap ${has ? "found" : "NOT found"}${has ? "" : " (install bubblewrap for confinement; dsh doctor reminds you)"}`);
  if (!has) return { enabled: false, allowNetwork: false };
  const raw = (await d.prompt("      enable bwrap confinement (network off)? [Y/n]: ")).trim().toLowerCase();
  return { enabled: raw !== "n", allowNetwork: false };
}

const CHANNEL_ENVS: Record<string, string[]> = {
  wechat: ["(no env — run `dsh wechat-login` after watch starts, same --db)"],
  telegram: ["TELEGRAM_BOT_TOKEN"],
  feishu: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_BOT_OPEN_ID (optional)"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
};

async function askChannels(d: InitDeps): Promise<InitAnswers["channels"]> {
  d.print?.("[6/6] Channels — github is always on (issues/PRs of the repo above)");
  for (const [name, envs] of Object.entries(CHANNEL_ENVS)) {
    const present = envs.filter((e) => !e.includes(" ") && d.env?.[e]);
    d.print?.(`      ${name.padEnd(9)} ${present.length ? `env present: ${present.join(", ")}` : envs.join(" + ")}`);
  }
  const raw = (await d.prompt("      enable more channels (comma-separated from: wechat, telegram, feishu, slack; Enter = github only): "));
  const pick = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const channels = {
    github: true as const,
    wechat: pick.has("wechat"),
    telegram: pick.has("telegram"),
    feishu: pick.has("feishu"),
    slack: pick.has("slack"),
  };
  for (const name of ["wechat", "telegram", "feishu", "slack"] as const) {
    if (channels[name]) d.print?.(`      → ${name} checklist: ${CHANNEL_ENVS[name].join(", ")}`);
  }
  return channels;
}

/** Run the six steps interactively. Nothing is written here — the caller writes. */
export async function runWizard(d: InitDeps): Promise<InitAnswers> {
  d.print?.("dsh-super-agent — admission control for any CLI coding agent");
  d.print?.("This wizard writes ./dsh/policy.json and ./dsh/executor.json. Ctrl-C any time;");
  d.print?.("nothing is written until the final step.");
  const repo = await askRepo(d);
  const { allowedList, agentLogin } = await askIdentity(d, repo);
  const agentCommand = await askAgent(d);
  const acceptMode = await askMode(d);
  const sandbox = await askSandbox(d);
  const channels = await askChannels(d);
  return { repo, agentLogin, allowedList, agentCommand, acceptMode, sandbox, channels, flavor: "minimal" };
}

// ── config building ───────────────────────────────────────────────────────────

const GITHUB_ROW_SCOPES = ["issue", "issue_comment", "pr", "pr_comment", "review_comment", "ci"] as const;

export function buildPolicy(a: InitAnswers): Policy {
  const cell = (listed: "inferred" | "ignore" = "inferred") => ({
    listedNotAddressing: listed, unlistedAddressing: "ignore" as const, unlistedNotAddressing: "ignore" as const,
  });
  const table: Policy["table"] = GITHUB_ROW_SCOPES.map((scope) => ({
    scope, ...cell(scope === "ci" ? "ignore" : "inferred"),
  }));
  if (a.channels.wechat || a.channels.telegram || a.channels.feishu || a.channels.slack) {
    table.push({ scope: "im_dm", ...cell() }, { scope: "im_group", ...cell() });
  }
  const policy: Policy = {
    version: 1,
    allowedList: a.allowedList,
    botList: ["github-actions", "dependabot"],
    acceptMode: a.acceptMode,
    table,
    ...(a.flavor === "dogfood"
      ? {
          watchdog: { enabled: true, stuckWorkingNudgeMs: 1_800_000, needsPersonReminderMs: 86_400_000, consultLlm: false },
          speculation: { enabled: true, maxSpeculative: 1 },
          approval: { enabled: true },
        }
      : {}),
  };
  return policy;
}

export function buildExecutor(a: InitAnswers): ExecutorConfig {
  return {
    command: a.agentCommand,
    repoDir: ".",
    workRoot: ".state/work",
    timeoutMs: a.flavor === "dogfood" ? 600_000 : 1_800_000,
    maxWorkers: 1,
    blockedCommands: ["sudo", "rm -rf /", "curl | sh"],
    sandbox: a.sandbox,
  };
}

// ── the writer (atomic, --force semantics, backups, no secrets) ───────────────

export interface WriteResult {
  written: string[];
  backups: string[];
  skipped: string[];
}

function writeAtomic(path: string, content: string, force: boolean, out: WriteResult): void {
  if (existsSync(path)) {
    if (!force) {
      out.skipped.push(path);
      return;
    }
    const bak = `${path}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, bak);
    out.backups.push(bak);
  }
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
  out.written.push(path);
}

export function writeConfigs(dir: string, a: InitAnswers, force: boolean): WriteResult {
  const policy = buildPolicy(a);
  const executor = buildExecutor(a);
  const invalid = validateRoutines(policy);
  if (invalid.errors.length > 0) throw new Error(`template produced invalid routines: ${invalid.errors.join("; ")}`);
  const out: WriteResult = { written: [], backups: [], skipped: [] };
  const header = (kind: string) => `{\n  "$comment": "dsh-super-agent ${kind} — written by dsh init; docs: ${DOCS_URL}",\n`;
  writeAtomic(join(dir, "policy.json"), header("policy") + JSON.stringify(policy, null, 2).slice(1) + "\n", force, out);
  writeAtomic(join(dir, "executor.json"), header("executor") + JSON.stringify(executor, null, 2).slice(1) + "\n", force, out);
  return out;
}

export function nextSteps(a: InitAnswers, dir: string): string[] {
  const cfg = join(dir, "policy.json").replace(/\\/g, "/");
  const exec = join(dir, "executor.json").replace(/\\/g, "/");
  const repoArg = a.repo ? ` --repo ${a.repo}` : " --repo owner/name";
  return [
    "Next:",
    "  dsh doctor" + (a.repo ? ` --repo ${a.repo}` : "") + ` --config ${cfg} --executor-config ${exec}`,
    `  dsh watch${repoArg} --agent-login ${a.agentLogin || "<agent-login>"} --config ${cfg} --executor-config ${exec}`,
  ];
}

// ── templates (non-interactive, CI-testable) ──────────────────────────────────

export const TEMPLATES: Record<"minimal" | "dogfood", InitAnswers> = {
  minimal: {
    repo: "",
    agentLogin: "",
    allowedList: ["YOUR_LOGIN"],
    agentCommand: 'codex exec "$(cat "$DSH_PROMPT_FILE")"',
    acceptMode: "observe",
    sandbox: { enabled: false, allowNetwork: false }, // init auto-enables when bwrap exists
    channels: { github: true, wechat: false, telegram: false, feishu: false, slack: false },
    flavor: "minimal",
  },
  dogfood: {
    repo: "vicfei/dsh-super-agent",
    agentLogin: "dsh-super-agent[bot]",
    allowedList: ["YOUR_LOGIN"],
    agentCommand: 'codex exec "$(cat "$DSH_PROMPT_FILE")"',
    acceptMode: "observe",
    sandbox: { enabled: false, allowNetwork: false },
    channels: { github: true, wechat: true, telegram: false, feishu: false, slack: false },
    flavor: "dogfood",
  },
};

/** Load answers: --answers file → template → null (interactive). */
export function loadAnswersFile(path: string): InitAnswers {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<InitAnswers>;
  const base = TEMPLATES.minimal;
  const answers = { ...base, ...raw } as InitAnswers;
  if (!Array.isArray(answers.allowedList) || typeof answers.agentCommand !== "string" || typeof answers.repo !== "string") {
    throw new Error(`answers file ${path} does not match the documented schema (see TEMPLATES in src/init.ts)`);
  }
  return answers;
}

/** Auto-detect what the wizard would have detected (bwrap) so templates stay honest. */
export async function applyRuntimeDetection(a: InitAnswers, probe: InitDeps["probe"] = shellProbe): Promise<InitAnswers> {
  if (!a.sandbox.enabled && (await which("bwrap", probe))) return { ...a, sandbox: { enabled: true, allowNetwork: false } };
  return a;
}

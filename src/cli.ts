#!/usr/bin/env node
// CLI — poll (Source → gate → optional LLM assessment → Engine), work (claim → subprocess →
// report → drain), tickets (list / stop). Token and API keys come from the environment only.

import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Policy } from "./domain.js";
import { Engine } from "./engine.js";
import { classify, formatOutcome } from "./runner.js";
import { evaluateGate } from "./gate.js";
import type { Assessor } from "./assess.js";
import { llmAssessor, stubAssessor } from "./assess.js";
import { GitHubClient } from "./github/client.js";
import { AppTokenProvider, appAuthFromEnv } from "./github/app-auth.js";
import type { ReplyChannel, Source } from "./source.js";
import { GitHubSource } from "./github/source.js";
import { Executor, type ExecutorConfig } from "./executor.js";
import { GitHubReplyChannel, runWork } from "./work.js";
import { mergePolicyOf } from "./domain.js";
import {
  lastKey,
  minuteFloor,
  nextRoutineFire,
  renderSchedule,
  routineDefinitions,
  routineTrigger,
  routinesEnabled,
  threadIdToScope,
  TimerSource,
  validateRoutines,
} from "./routines.js";
import { NO_TOKEN_HINT, scaffoldFromExample, USAGE } from "./usage.js";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const WITH_HELP = "\nRun with --help for usage.";

function parseOrDie() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
        repo: { type: "string" },
        "agent-login": { type: "string" },
        config: { type: "string", default: "policy.json" },
        "executor-config": { type: "string", default: "executor.json" },
        db: { type: "string", default: ".state/engine.db" },
        assessment: { type: "string", default: "stub-positive" }, // stub-positive | stub-negative | llm
        "assess-base-url": { type: "string" },
        "assess-model": { type: "string" },
        interval: { type: "string" },
        "no-panel": { type: "boolean", default: false },
        token: { type: "string" },
        post: { type: "boolean", default: false },
        // init (v1.2)
        template: { type: "string" },
        dir: { type: "string", default: "./dsh" },
        force: { type: "boolean", default: false },
        answers: { type: "string" },
        // doctor (v1.2)
        "probe-network": { type: "boolean", default: false },
      },
    });
  } catch (e) {
    die(`${e instanceof Error ? e.message : e}${WITH_HELP}`); // unknown option / missing value — no stack trace
  }
}

const { values: args, positionals } = parseOrDie();

const { version } = createRequire(import.meta.url)("../package.json");
if (args.version) {
  console.log(version);
  process.exit(0);
}

const COMMANDS = ["poll", "work", "watch", "tickets", "panel", "merge", "health", "routines", "init", "doctor", "wechat-login", "help"] as const;
const command = positionals[0] ?? "poll";
if (args.help || command === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (!(COMMANDS as readonly string[]).includes(command)) {
  die(`unknown command: ${command}${WITH_HELP}`);
}

// init & doctor run before the engine exists — neither may create .state/ as a side effect.
if (command === "init") {
  const initMod = await import("./init.js");
  let answers: import("./init.js").InitAnswers;
  if (args.answers) {
    answers = initMod.loadAnswersFile(args.answers);
  } else if (args.template) {
    const t = initMod.TEMPLATES[args.template as "minimal" | "dogfood"];
    if (!t) die(`unknown --template "${args.template}" (minimal | dogfood)${WITH_HELP}`);
    answers = await initMod.applyRuntimeDetection(t); // same auto-detection the wizard applies (bwrap → sandbox on)
  } else {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      answers = await initMod.runWizard({
        prompt: (q) => rl.question(q),
        print: (l) => console.log(l),
        env: process.env,
        probe: initMod.shellProbe,
        whoami: async (token) => {
          try {
            const r = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
            if (!r.ok) return null;
            return ((await r.json()) as { login?: string }).login ?? null;
          } catch {
            return null; // offline wizard: we just ask instead
          }
        },
      });
    } finally {
      rl.close();
    }
  }
  const result = initMod.writeConfigs(args.dir, answers, args.force);
  for (const s of result.skipped) console.log(`exists: ${s} — kept (use --force to overwrite)`);
  for (const b of result.backups) console.log(`backup:  ${b}`);
  for (const w of result.written) console.log(`wrote:   ${w}`);
  if (result.written.length === 0) process.exitCode = 1;
  for (const l of initMod.nextSteps(answers, args.dir)) console.log(l);
  process.exit(process.exitCode ?? 0);
}

if (command === "doctor") {
  const { runDoctor, formatDoctor } = await import("./doctor.js");
  const { shellProbe } = await import("./init.js");
  const policy = existsSync(args.config) ? (() => { try { return JSON.parse(readFileSync(args.config, "utf8")) as Policy; } catch { return undefined; } })() : undefined;
  const executorCfg = existsSync(args["executor-config"]) ? (() => { try { return JSON.parse(readFileSync(args["executor-config"], "utf8")) as { command: string; sandbox?: { enabled?: boolean; allowNetwork?: boolean }; prepare?: string }; } catch { return undefined; } })() : undefined;
  let wechatAuthPresent = false;
  if (existsSync(args.db)) {
    try {
      const { default: Database } = await import("better-sqlite3");
      const ro = new Database(args.db, { readonly: true });
      wechatAuthPresent = Boolean(ro.prepare("SELECT v FROM kv WHERE k = 'wechat_auth'").get());
      ro.close();
    } catch {
      wechatAuthPresent = false; // unreadable/missing table — "not logged in" is the honest answer
    }
  }
  const { sandboxWrapperBin } = await import("./init.js");
  const bwrap = await shellProbe("which", [sandboxWrapperBin()], 3000);
  const report = await runDoctor({
    nodeVersion: process.version,
    env: process.env as Record<string, string | undefined>,
    policy,
    policyPath: args.config,
    executor: executorCfg,
    repo: args.repo,
    dbPath: args.db,
    bwrapPresent: bwrap.code === 0 && bwrap.stdout.trim() !== "",
    agentVersion: async (bin) => {
      const r = await shellProbe(bin, ["--version"], 5000);
      return r.code === 0 ? r.stdout.trim().split("\n")[0] : "";
    },
    wechatAuthPresent,
    probeNetwork: args["probe-network"],
    fetchJson: async (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(5000) }),
  });
  for (const l of formatDoctor(report)) console.log(l);
  process.exit(report.exitCode);
}

const engine = new Engine(args.db);

function readPolicyConfig(opts: { skipRoutineValidation?: boolean } = {}): Policy {
  if (!existsSync(args.config) && scaffoldFromExample(args.config, "policy.json")) {
    console.log(`[bootstrap] created ${args.config} from examples/policy.json`);
    console.log("[bootstrap] put your GitHub login in allowedList, then rerun the same command");
    engine.close();
    process.exit(0);
  }
  let policy: Policy;
  try {
    policy = JSON.parse(readFileSync(args.config, "utf8")) as Policy;
  } catch (e) {
    die(`cannot read policy config ${args.config}: ${e instanceof Error ? e.message : e}`);
  }
  if (!opts.skipRoutineValidation) {
    // v1.2 routines: enforced at config load — fail closed, whole file
    const rv = validateRoutines(policy);
    if (rv.errors.length > 0) die(`policy ${args.config}: routines invalid (nothing loads):\n  - ${rv.errors.join("\n  - ")}`);
    for (const w of rv.warnings) console.warn(`[warn] ${w}`);
  }
  return policy;
}

function loadPolicy(): Policy {
  if (!args.repo) die(`--repo owner/name is required${WITH_HELP}`);
  if (!args["agent-login"]) die(`--agent-login <login> is required (mention detection)${WITH_HELP}`);
  return readPolicyConfig();
}

function loadExecutorConfig(): ExecutorConfig {
  if (!existsSync(args["executor-config"]) && scaffoldFromExample(args["executor-config"], "executor.json")) {
    console.log(`[bootstrap] created ${args["executor-config"]} from examples/executor.json`);
    console.log('[bootstrap] point "command" at your agent CLI (claude / codex / aider / …), then rerun');
    engine.close();
    process.exit(0);
  }
  try {
    return JSON.parse(readFileSync(args["executor-config"], "utf8")) as ExecutorConfig;
  } catch (e) {
    die(`cannot read executor config ${args["executor-config"]}: ${e instanceof Error ? e.message : e}`);
  }
}

function buildAssessor(): Assessor {
  if (args.assessment !== "llm") {
    return stubAssessor(args.assessment === "stub-negative" ? "negative" : "positive");
  }
  const baseUrl = args["assess-base-url"] ?? process.env.ASSESS_BASE_URL;
  if (!baseUrl) die(`--assessment llm requires --assess-base-url or ASSESS_BASE_URL${WITH_HELP}`);
  return llmAssessor({
    baseUrl,
    model: args["assess-model"] ?? process.env.ASSESS_MODEL ?? "",
    apiKey: process.env.ASSESS_API_KEY ?? process.env.OPENAI_API_KEY,
  });
}

try {
  // Credential precedence (M6-2): explicit --token > GitHub App env > GITHUB_TOKEN > anonymous.
  function buildClient(): { client: GitHubClient; identity: string } {
    if (args.token) return { client: new GitHubClient({ token: args.token }), identity: "token (--token)" };
    let appAuth: ReturnType<typeof appAuthFromEnv> = null;
    try {
      appAuth = appAuthFromEnv();
    } catch (e) {
      die(`GitHub App auth misconfigured: ${e instanceof Error ? e.message : e}`);
    }
    if (appAuth) {
      const provider = new AppTokenProvider({
        ...appAuth,
        ...(args.repo ? { repo: args.repo } : {}), // installation auto-discovery when id absent
      });
      return {
        client: new GitHubClient({ tokenProvider: provider }),
        identity: `GitHub App ${appAuth.appId}${appAuth.installationId ? ` (installation ${appAuth.installationId})` : ""}`,
      };
    }
    const envToken = process.env.GITHUB_TOKEN;
    return { client: new GitHubClient({ token: envToken || undefined }), identity: envToken ? "token (GITHUB_TOKEN)" : "anonymous" };
  }

  const { client, identity } = buildClient();
  const authenticated = identity !== "anonymous";
  if (identity.startsWith("GitHub App")) {
    console.log(`auth: ${identity} — hourly installation tokens; replies post as the App bot identity`);
  }
  if (!authenticated && (command === "poll" || command === "watch" || command === "work")) console.warn(NO_TOKEN_HINT);

  if (command === "poll") {
    const policy = loadPolicy();
    engine.setPolicyIfChanged(policy);
    const assessor = buildAssessor();

    const source = new GitHubSource({ repo: args.repo!, agentLogin: args["agent-login"]!, client });
    const { triggers, next } = await source.collect(engine.sourceState("github"), { exclude: engine.selfPosted() });
    const { interceptApprovalCommands } = await import("./approval.js");
    const { rest } = interceptApprovalCommands(triggers, engine, policy);

    const batch = [];
    for (const t of rest) {
      // Only inferred candidates reach the (potentially slow, potentially costly) assessment —
      // explicit never waits on it, and the gate's rejects never call it (docs/002).
      const gate = evaluateGate(policy, t);
      const assessment = gate.strength === "inferred" ? await assessor.assess(t) : "positive";
      batch.push(classify(t, policy, assessment));
    }
    for (const o of batch) console.log(formatOutcome(o));

    const report = engine.ingest(batch, { github: next });
    if (batch.length === 0) console.log("no new triggers");
    for (const r of report.refusals) console.log(`[REFUSED] ${r}`);
    console.log(
      `— fresh=${report.fresh} duplicates=${report.duplicates} ticketsOpened=${report.ticketsOpened} resumed=${report.resumed} joined=${report.joined} (acceptMode=${policy.acceptMode}, policy v${policy.version}, assess=${args.assessment})`,
    );

    if (args.post) {
      const { drainReplyEffects } = await import("./work.js");
      await drainReplyEffects(engine, [new GitHubReplyChannel(client, args.repo!)]);
    }
  } else if (command === "watch") {
    const policy = loadPolicy();
    engine.setPolicyIfChanged(policy);
    const assessor = buildAssessor();

    const execCfg = loadExecutorConfig();

    if (!args["no-panel"]) {
      const port = Number(process.env.PANEL_PORT ?? 8787);
      const { startPanel } = await import("./panel.js");
      await startPanel(engine, port);
      console.log(`watch: panel on http://127.0.0.1:${port}`);
    }
    console.log(`watch: polling ${args.repo} every ${args.interval ?? 30}s (±20% jitter) — Ctrl-C stops after the current cycle`);

    const { runWatch } = await import("./watch.js");
    // v1.2 routines: the timer Source runs FIRST in the cycle — firing is cheap, work is not.
    const sources: Source[] = [];
    if (routinesEnabled(policy)) {
      sources.push(new TimerSource({ policy, log: (l) => console.log(l) }));
      console.log(`routines: timer source armed (${routineDefinitions(policy).length} definition(s)) — through the gate like any message`);
    }
    sources.push(new GitHubSource({ repo: args.repo!, agentLogin: args["agent-login"]!, client }));
    const channels: ReplyChannel[] = authenticated ? [new GitHubReplyChannel(client, args.repo!)] : [];

    // Feishu (v0.8 M8-2): armed by env — self-built app, WebSocket long connection, no public URL.
    const feishuId = process.env.FEISHU_APP_ID;
    const feishuSecret = process.env.FEISHU_APP_SECRET;
    if (feishuId && feishuSecret) {
      const { FeishuSource, FeishuReplyChannel, createFeishuSender } = await import("./feishu.js");
      sources.push(new FeishuSource({
        appId: feishuId, appSecret: feishuSecret,
        ...(process.env.FEISHU_BOT_OPEN_ID ? { botOpenId: process.env.FEISHU_BOT_OPEN_ID } : {}),
      }));
      channels.push(new FeishuReplyChannel(await createFeishuSender(feishuId, feishuSecret)));
      console.log("feishu: long-connection source armed (im.message.receive_v1) — set FEISHU_BOT_OPEN_ID for precise group @mention detection");
    }

    // Slack (v0.8 M8-3): armed by env — Socket Mode, no public URL; bot id via auth.test.
    const slackBot = process.env.SLACK_BOT_TOKEN;
    const slackApp = process.env.SLACK_APP_TOKEN;
    if (slackBot && slackApp) {
      const { SlackSource, SlackReplyChannel, createSlackSender } = await import("./slack.js");
      const { send, botUserId } = await createSlackSender(slackBot);
      sources.push(new SlackSource({ appToken: slackApp, botToken: slackBot, ...(botUserId ? { botUserId } : {}) }));
      channels.push(new SlackReplyChannel(send));
      console.log(`slack: socket-mode source armed${botUserId ? ` (@mention detection for <@${botUserId}>)` : ""}`);
    }

    // WeChat (v0.8 M8-4): armed when `wechat-login` stored credentials in this db.
    {
      const { WechatSource, WechatReplyChannel, WechatApiClient, EngineWechatStore } = await import("./wechat.js");
      const wechatStore = new EngineWechatStore(engine);
      if (wechatStore.loadAuth()) {
        sources.push(new WechatSource({ store: wechatStore, log: (l) => console.log(l) }));
        channels.push(new WechatReplyChannel(
          wechatStore,
          (auth) => new WechatApiClient({ token: auth.token, baseUrl: auth.baseUrl }),
          (l) => console.log(l),
        ));
        console.log("wechat: iLink long-poll source armed (DMs addressed; groups fail closed)");
      }
    }

    // Telegram (v0.8.1): armed by env — official Bot API, one @BotFather token.
    if (process.env.TELEGRAM_BOT_TOKEN) {
      const { TelegramSource, TelegramReplyChannel, TelegramClient } = await import("./telegram.js");
      const tgToken = process.env.TELEGRAM_BOT_TOKEN;
      sources.push(new TelegramSource({
        token: tgToken,
        loadOffset: () => Number(engine.kvGet("telegram_offset") ?? "0"),
        saveOffset: (o) => engine.kvSet("telegram_offset", String(o)),
        log: (l) => console.log(l),
      }));
      const tgClient = new TelegramClient({ token: tgToken });
      channels.push(new TelegramReplyChannel(() => tgClient, (threadId) => Number(threadId.split("/")[1])));
      console.log("telegram: getUpdates long-poll source armed");
    }

    await runWatch({
      engine,
      sources,
      channels,
      executor: new Executor(execCfg),
      client: authenticated ? client : null,
      repo: args.repo!,
      policy,
      assessment: async (t) => {
        const gate = evaluateGate(policy, t);
        return gate.strength === "inferred" ? assessor.assess(t) : "positive";
      },
      intervalMs: args.interval ? Number(args.interval) * 1000 : undefined,
    });
  } else if (command === "work") {
    if (!args.repo) die(`--repo owner/name is required${WITH_HELP}`);
    const execCfg = loadExecutorConfig();
    const executor = new Executor(execCfg);
    const reports = await runWork(engine, executor, args.repo, authenticated ? client : null);
    if (reports.length === 0) console.log("no claimable tickets");
    for (const r of reports) {
      console.log(`#${r.ticketId} [${r.outcome}] ${r.detail}`);
    }
  } else if (command === "tickets") {
    // argv: cli tickets stop <id> → positionals ["tickets", "stop", "<id>"]
    const stopId = positionals[1] === "stop" && positionals[2] !== undefined ? Number(positionals[2]) : undefined;
    if (stopId !== undefined) {
      const ok = engine.stopTicket(stopId, "panel");
      console.log(ok ? `ticket #${stopId} ended by panel` : `ticket #${stopId} not open (or unknown)`);
    }
    const promoteId = positionals[1] === "promote" && positionals[2] !== undefined ? Number(positionals[2]) : undefined;
    if (promoteId !== undefined) {
      const ok = engine.promoteTicket(promoteId, "panel");
      console.log(ok
        ? `ticket #${promoteId} promoted — the watch daemon will deliver the rehearsed work (PR + report)`
        : `ticket #${promoteId} is not a speculative ticket awaiting promote`);
    }
    const rows = engine.tickets();
    if (rows.length === 0) {
      console.log("no tickets");
    } else {
      for (const t of rows) {
        const extra = [t.state === "ended" && t.stoppedBy ? `stopped-by:${t.stoppedBy}` : "",
          t.revokedReason ?? "", t.resumedCount ? `resumed×${t.resumedCount}` : "",
          t.followUps ? `fu×${t.followUps}` : ""].filter(Boolean).join(" ");
        console.log(`#${t.id} [${t.stage}] ${t.strength} ${t.threadId} opener=${t.opener} ${extra}`.trimEnd());
      }
    }
  } else if (command === "panel") {
    const port = Number(positionals[1] ?? process.env.PANEL_PORT ?? 8787);
    const { startPanel } = await import("./panel.js");
    const server = await startPanel(engine, port);
    console.log(`panel: http://127.0.0.1:${port} (db ${args.db}) — Ctrl-C to stop`);
    const shutdown = () => {
      server.close(() => process.exit(0));
      engine.close();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise<never>(() => {}); // serve until signal — the finally-close must not run
  } else if (command === "wechat-login") {
    // iLink Bot Protocol QR login (v0.8 M8-4): the human scans with their WeChat app.
    const { wechatLogin, EngineWechatStore } = await import("./wechat.js");
    const store = new EngineWechatStore(engine);
    let binder: string | null = null;
    const creds = await wechatLogin(async (qr) => {
      if (qr.imgContent) {
        const { default: QR } = await import("qrcode");
        // terminal QR — scannable straight off the screen
        QR.toString(qr.imgContent, { type: "terminal", small: true }, (err, art) => {
          if (!err) console.log(art);
        });
        const file = `${process.cwd()}/wechat-login-qr.png`;
        QR.toFile(file, qr.imgContent, { width: 480 }, () => {});
        console.log(`[wechat] scan the QR above with WeChat (also saved to ${file}), then confirm on your phone`);
      } else {
        console.log(`[wechat] no QR content from the server (qrcode id ${qr.qrcode})`);
      }
    }, { onBinder: (id) => { binder = id; } });
    store.saveAuth(creds);
    console.log("[wechat] logged in — credentials stored; the watch daemon (same --db) arms the source automatically");
    if (binder) {
      engine.kvSet("wechat_binder", binder);
      console.log(`[wechat] scanner identity captured (${binder}) — consider adding it to allowedList so their DMs are explicit`);
    }
  } else if (command === "routines") {
    // v1.2: the clock's config surface — list / validate / fire. No --repo needed.
    const sub = positionals[1] ?? "list";
    if (sub === "validate") {
      const policy = readPolicyConfig({ skipRoutineValidation: true }); // report everything, die on nothing
      const v = validateRoutines(policy);
      const opsThreads = new Set(Object.values(engine.opsRoutes()));
      for (const e of v.errors) console.log(`error:   ${e}`);
      for (const w of v.warnings) console.log(`warning: ${w}`);
      for (const d of v.definitions) {
        if (opsThreads.has(d.reportTo)) continue; // the good case: a registered ops thread
        const seen = engine.db.prepare("SELECT 1 FROM trigger WHERE thread_id = ? LIMIT 1").get(d.reportTo);
        console.log(`warning: routine "${d.id}" reports to ${d.reportTo} — ${seen ? "a seen thread, but not a registered ops thread" : "not a known ops thread and never seen by this engine (--db)"}; reachable, not guaranteed live`);
      }
      if (v.errors.length === 0 && v.warnings.length === 0) console.log(`ok: ${v.definitions.length} routine definition(s) valid`);
      if (v.errors.length > 0) process.exitCode = 1; // let the finally close the engine first
    } else if (sub === "fire") {
      const id = positionals[2];
      if (!id) die(`usage: dsh routines fire <id>${WITH_HELP}`);
      const policy = readPolicyConfig();
      engine.setPolicyIfChanged(policy);
      const d = routineDefinitions(policy).find((x) => x.id === id);
      if (!d) die(`unknown routine id "${id}" — try 'dsh routines list'`);
      const nowMs = minuteFloor(Date.now());
      const t = routineTrigger(d, nowMs, { manual: true });
      const gate = evaluateGate(policy, t);
      const assessment = gate.strength === "inferred" ? await buildAssessor().assess(t) : "positive";
      const batch = [classify(t, policy, assessment)];
      for (const o of batch) console.log(formatOutcome(o));
      const positions = { ...engine.sourceState("timer").positions, [lastKey(d.id)]: nowMs };
      const report = engine.ingest(batch, { timer: { positions } }); // routine-last = now, same transaction
      for (const r of report.refusals) console.log(`[REFUSED] ${r}`);
      console.log(`— fresh=${report.fresh} duplicates=${report.duplicates} ticketsOpened=${report.ticketsOpened} joined=${report.joined} (routine-last=${new Date(nowMs).toISOString()})`);
      console.log("replies are queued in the outbox — the watch daemon (same --db) drains them into the report thread");
    } else if (sub === "list") {
      const policy = readPolicyConfig();
      const defs = routineDefinitions(policy);
      const positions = engine.sourceState("timer").positions;
      const nowMs = minuteFloor(Date.now());
      const enabled = routinesEnabled(policy);
      if (defs.length === 0) {
        console.log(enabled ? "no routine definitions in this policy" : "routines absent or disabled in this policy — nothing fires by default");
      }
      const humanIn = (ms: number) => (ms < 3_600_000 ? `in ${Math.round(ms / 60_000)}m` : `in ${Math.round(ms / 3_600_000)}h`);
      for (const d of defs) {
        const last = positions[lastKey(d.id)];
        try {
          const next = nextRoutineFire(d, last, nowMs);
          const when = next <= nowMs
            ? `${new Date(next).toISOString()} (overdue — catch-up fires on the next sweep)`
            : `${new Date(next).toISOString()} (${humanIn(next - nowMs)})`;
          console.log(`${d.id}  ${renderSchedule(d)}  next ${when}  → ${d.reportTo} [${threadIdToScope(d.reportTo)}]${enabled ? "" : "  (routines disabled)"}`);
        } catch (e) {
          console.log(`${d.id}  ${renderSchedule(d)}  schedule error: ${e instanceof Error ? e.message : e}`);
        }
      }
    } else {
      die(`unknown routines subcommand: ${sub} (list | validate | fire)${WITH_HELP}`);
    }
  } else if (command === "health") {
    // Watchdog's read-only体检 (v0.9-1): no writes, no replies — safe at any time.
    const { healthReport } = await import("./watchdog.js");
    const r = healthReport(engine);
    const mins = (ms: number | null) => (ms === null ? "—" : `${Math.round(ms / 60000)}min`);
    console.log(`tickets: queued=${r.tickets.queued} working=${r.tickets.working} needs-person=${r.tickets["needs-person"]} ended=${r.tickets.ended}`);
    console.log(`oldest working: ${mins(r.oldestWorkingMs)} · oldest needs-person: ${mins(r.oldestNeedsPersonMs)}`);
    console.log(`effects: pending=${r.pendingEffects} failed=${r.failedEffects}`);
  } else if (command === "merge") {
    // One-shot version of the watch cycle's auto-merge sweep (cron-friendly).
    if (!args.repo) die(`--repo owner/name is required${WITH_HELP}`);
    if (!authenticated) die(`merge needs a credential to read reviews and merge — export GITHUB_TOKEN or configure the GitHub App (GITHUB_APP_ID + key, see README)${WITH_HELP}`);
    const policy = readPolicyConfig();
    engine.setPolicyIfChanged(policy);
    const { runMergeSweep } = await import("./merge.js");
    const lines = await runMergeSweep(engine, client, args.repo!, policy);
    if (lines.length === 0) {
      console.log(mergePolicyOf(policy).enabled
        ? "no open deliveries — nothing to sweep"
        : "auto-merge is off — set policy.merge.enabled = true (structural brakes apply)");
    }
    for (const l of lines) {
      console.log(l.reasons ? `#${l.pr} [${l.action}] ${l.reasons.join("; ")}` : `#${l.pr} [${l.action}]`);
    }
  }
} finally {
  engine.close();
}

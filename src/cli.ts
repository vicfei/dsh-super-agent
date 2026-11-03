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

const COMMANDS = ["poll", "work", "watch", "tickets", "panel", "merge", "wechat-login", "help"] as const;
const command = positionals[0] ?? "poll";
if (args.help || command === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (!(COMMANDS as readonly string[]).includes(command)) {
  die(`unknown command: ${command}${WITH_HELP}`);
}

const engine = new Engine(args.db);

function readPolicyConfig(): Policy {
  if (!existsSync(args.config) && scaffoldFromExample(args.config, "policy.json")) {
    console.log(`[bootstrap] created ${args.config} from examples/policy.json`);
    console.log("[bootstrap] put your GitHub login in allowedList, then rerun the same command");
    engine.close();
    process.exit(0);
  }
  try {
    return JSON.parse(readFileSync(args.config, "utf8")) as Policy;
  } catch (e) {
    die(`cannot read policy config ${args.config}: ${e instanceof Error ? e.message : e}`);
  }
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

    const batch = [];
    for (const t of triggers) {
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
    const sources: Source[] = [new GitHubSource({ repo: args.repo!, agentLogin: args["agent-login"]!, client })];
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
    const creds = await wechatLogin((qr) => {
      if (qr.imgBase64) {
        const file = `${process.cwd()}/wechat-login-qr.png`;
        writeFileSync(file, Buffer.from(qr.imgBase64, "base64"));
        console.log(`[wechat] QR image saved to ${file} — scan it with WeChat, then confirm on your phone`);
      } else {
        console.log(`[wechat] no image payload from the server (qrcode id ${qr.qrcode})`);
      }
    });
    store.saveAuth(creds);
    console.log("[wechat] logged in — credentials stored; the watch daemon (same --db) arms the source automatically");
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

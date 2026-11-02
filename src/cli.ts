// CLI — poll (Source → gate → optional LLM assessment → Engine), work (claim → subprocess →
// report → drain), tickets (list / stop). Token and API keys come from the environment only.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import type { Policy } from "./domain.js";
import { Engine } from "./engine.js";
import { classify, formatOutcome } from "./runner.js";
import { evaluateGate } from "./gate.js";
import type { Assessor } from "./assess.js";
import { llmAssessor, stubAssessor } from "./assess.js";
import { GitHubClient } from "./github/client.js";
import { GitHubSource } from "./github/source.js";
import { Executor, type ExecutorConfig } from "./executor.js";
import { runWork } from "./work.js";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
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

const command = positionals[0] ?? "poll";
const engine = new Engine(args.db);

function loadPolicy(): Policy {
  if (!args.repo) die("--repo owner/name is required");
  if (!args["agent-login"]) die("--agent-login <login> is required (mention detection)");
  try {
    return JSON.parse(readFileSync(args.config, "utf8")) as Policy;
  } catch (e) {
    die(`cannot read policy config ${args.config}: ${e instanceof Error ? e.message : e}`);
  }
}

function buildAssessor(): Assessor {
  if (args.assessment !== "llm") {
    return stubAssessor(args.assessment === "stub-negative" ? "negative" : "positive");
  }
  const baseUrl = args["assess-base-url"] ?? process.env.ASSESS_BASE_URL;
  if (!baseUrl) die("--assessment llm requires --assess-base-url or ASSESS_BASE_URL");
  return llmAssessor({
    baseUrl,
    model: args["assess-model"] ?? process.env.ASSESS_MODEL ?? "",
    apiKey: process.env.ASSESS_API_KEY ?? process.env.OPENAI_API_KEY,
  });
}

try {
  const token = args.token ?? process.env.GITHUB_TOKEN;
  const client = new GitHubClient({ token: token || undefined });

  if (command === "poll") {
    const policy = loadPolicy();
    engine.setPolicyIfChanged(policy);
    const assessor = buildAssessor();

    const source = new GitHubSource({ repo: args.repo!, agentLogin: args["agent-login"]!, client });
    const { triggers, next } = await source.collect(engine.positions(), { exclude: engine.selfPosted() });

    const batch = [];
    for (const t of triggers) {
      // Only inferred candidates reach the (potentially slow, potentially costly) assessment —
      // explicit never waits on it, and the gate's rejects never call it (docs/002).
      const gate = evaluateGate(policy, t);
      const assessment = gate.strength === "inferred" ? await assessor.assess(t) : "positive";
      batch.push(classify(t, policy, assessment));
    }
    for (const o of batch) console.log(formatOutcome(o));

    const report = engine.ingest(batch, next);
    if (batch.length === 0) console.log("no new triggers");
    for (const r of report.refusals) console.log(`[REFUSED] ${r}`);
    console.log(
      `— fresh=${report.fresh} duplicates=${report.duplicates} ticketsOpened=${report.ticketsOpened} resumed=${report.resumed} (acceptMode=${policy.acceptMode}, policy v${policy.version}, assess=${args.assessment})`,
    );

    if (args.post) {
      const { drainReplyEffects } = await import("./work.js");
      await drainReplyEffects(engine, client, args.repo!);
    }
  } else if (command === "watch") {
    const policy = loadPolicy();
    engine.setPolicyIfChanged(policy);
    const assessor = buildAssessor();

    let execCfg: ExecutorConfig;
    try {
      execCfg = JSON.parse(readFileSync(args["executor-config"], "utf8")) as ExecutorConfig;
    } catch (e) {
      die(`cannot read executor config ${args["executor-config"]}: ${e instanceof Error ? e.message : e}`);
    }

    if (!args["no-panel"]) {
      const port = Number(process.env.PANEL_PORT ?? 8787);
      const { startPanel } = await import("./panel.js");
      await startPanel(engine, port);
      console.log(`watch: panel on http://127.0.0.1:${port}`);
    }
    console.log(`watch: polling ${args.repo} every ${args.interval ?? 30}s (±20% jitter) — Ctrl-C stops after the current cycle`);

    const { runWatch } = await import("./watch.js");
    await runWatch({
      engine,
      source: new GitHubSource({ repo: args.repo!, agentLogin: args["agent-login"]!, client }),
      executor: new Executor(execCfg),
      client: token ? client : null,
      repo: args.repo!,
      policy,
      assessment: async (t) => {
        const gate = evaluateGate(policy, t);
        return gate.strength === "inferred" ? assessor.assess(t) : "positive";
      },
      intervalMs: args.interval ? Number(args.interval) * 1000 : undefined,
    });
  } else if (command === "work") {
    if (!args.repo) die("--repo owner/name is required");
    let execCfg: ExecutorConfig;
    try {
      execCfg = JSON.parse(readFileSync(args["executor-config"], "utf8")) as ExecutorConfig;
    } catch (e) {
      die(`cannot read executor config ${args["executor-config"]}: ${e instanceof Error ? e.message : e}`);
    }
    if (token === undefined || token === "") console.warn("[work] no GITHUB_TOKEN — reports stay queued in the outbox");
    const executor = new Executor(execCfg);
    const reports = await runWork(engine, executor, args.repo, token ? client : null);
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
          t.revokedReason ?? "", t.resumedCount ? `resumed×${t.resumedCount}` : ""].filter(Boolean).join(" ");
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
  } else {
    die(`unknown command: ${command} (poll | work | watch | tickets | panel)`);
  }
} finally {
  engine.close();
}

// CLI — poll persists into the Engine; tickets lists / stops. Token from env, never stored.
// Subcommands: poll [--post] | tickets [stop <id>]

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import type { Policy } from "./domain.js";
import { Engine } from "./engine.js";
import { GitHubClient } from "./github/client.js";
import { GitHubSource } from "./github/source.js";
import { classify, formatOutcome } from "./runner.js";

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
    db: { type: "string", default: ".state/engine.db" },
    assessment: { type: "string", default: "positive" },
    token: { type: "string" },
    post: { type: "boolean", default: false },
  },
});

const command = positionals[0] ?? "poll";
const assessment = args.assessment === "negative" ? "negative" : "positive";
const engine = new Engine(args.db);

try {
  if (command === "poll") {
    if (!args.repo) die("--repo owner/name is required");
    if (!args["agent-login"]) die("--agent-login <login> is required (mention detection)");
    let policy: Policy;
    try {
      policy = JSON.parse(readFileSync(args.config, "utf8")) as Policy;
    } catch (e) {
      die(`cannot read policy config ${args.config}: ${e instanceof Error ? e.message : e}`);
    }
    engine.setPolicyIfChanged(policy);
    const token = args.token ?? process.env.GITHUB_TOKEN;
    const client = new GitHubClient({ token: token || undefined });
    const source = new GitHubSource({ repo: args.repo!, agentLogin: args["agent-login"]!, client });

    const { triggers, next } = await source.collect(engine.positions(), { exclude: engine.selfPosted() });
    const batch = triggers.map((t) => classify(t, policy, assessment));
    for (const o of batch) console.log(formatOutcome(o));

    const report = engine.ingest(batch, next);
    if (batch.length === 0) console.log("no new triggers");
    for (const r of report.refusals) console.log(`[REFUSED] ${r}`);
    console.log(
      `— fresh=${report.fresh} duplicates=${report.duplicates} ticketsOpened=${report.ticketsOpened} resumed=${report.resumed} (acceptMode=${policy.acceptMode}, policy v${policy.version})`,
    );

    if (args.post) await drain(engine, client, args.repo!);
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
  } else {
    die(`unknown command: ${command} (poll | tickets)`);
  }
} finally {
  engine.close();
}

/** Execute due reply effects after commit — the outbox drain (docs/007). */
async function drain(engine: Engine, client: GitHubClient, repo: string): Promise<void> {
  const due = engine.takeDue();
  for (const fx of due) {
    if (fx.kind !== "reply") {
      engine.completeEffect(fx.id); // unknown kinds complete silently in v0
      continue;
    }
    const p = fx.payload as { issueNumber: number | null; body: string };
    if (p.issueNumber === null) {
      engine.failEffect(fx.id, `cannot resolve issue number from thread`, false);
      continue;
    }
    try {
      const { id } = await client.postIssueComment(repo, p.issueNumber, p.body);
      engine.completeEffect(fx.id);
      engine.markSelfPosted(id); // never re-ingest our own comment as a trigger
      console.log(`[POSTED] ${fx.key} → ${repo}#${p.issueNumber}`);
    } catch (e) {
      engine.failEffect(fx.id, e instanceof Error ? e.message : String(e));
      console.error(`[POST-FAILED] ${fx.key}: ${e instanceof Error ? e.message : e} (will back off)`);
    }
  }
}

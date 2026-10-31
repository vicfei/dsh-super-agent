// CLI — poll once, classify, print one line per trigger. Daemon loop and config reload land with
// the Engine (milestone 2). Token comes from the environment, never from a file we manage.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import type { Policy } from "./domain.js";
import { GitHubClient } from "./github/client.js";
import { GitHubSource } from "./github/source.js";
import { FileSourceState } from "./github/state.js";
import { classify, formatOutcome } from "./runner.js";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = parseArgs({
  options: {
    repo: { type: "string" },
    "agent-login": { type: "string" },
    config: { type: "string", default: "policy.json" },
    state: { type: "string", default: ".state/github.json" },
    assessment: { type: "string", default: "positive" },
    token: { type: "string" },
  },
}).values;

if (!args.repo) die("--repo owner/name is required");
if (!args["agent-login"]) die("--agent-login <login> is required (mention detection)");
const assessment = args.assessment === "negative" ? "negative" : "positive";

let policy: Policy;
try {
  policy = JSON.parse(readFileSync(args.config, "utf8")) as Policy;
} catch (e) {
  die(`cannot read policy config ${args.config}: ${e instanceof Error ? e.message : e}`);
}

const token = args.token ?? process.env.GITHUB_TOKEN ?? "";
const source = new GitHubSource({
  repo: args.repo,
  agentLogin: args["agent-login"],
  client: new GitHubClient({ token: token || undefined }),
  state: new FileSourceState(args.state),
});

const triggers = await source.poll();
if (triggers.length === 0) {
  console.log("no new triggers");
} else {
  for (const t of triggers) console.log(formatOutcome(classify(t, policy, assessment)));
  console.log(`— ${triggers.length} trigger(s), acceptMode=${policy.acceptMode}, policy v${policy.version}`);
}

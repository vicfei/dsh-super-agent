// Usage text and first-run bootstrap helpers — the DX surface of the CLI (M5-5, issue #19).
// Example configs ship in the npm package (package.json "files"), resolved relative to this
// module so it works from src/ (tsx), dist/ (installed bin) and any cwd.

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE = `dsh-super-agent — admission control, observe mode & tickets for any CLI coding agent

Usage: dsh-super-agent <command> [options]

Commands:
  poll      one pass: poll GitHub → gate → (assessment) → record; --post also drains queued replies
  work      claim queued tickets → run the executor in a worktree → report
  watch     poll + work + panel as one daemon (Ctrl-C stops after the current cycle)
  tickets   list tickets; "tickets stop <id>" ends one
  panel     serve the awaiting-human panel (http://127.0.0.1:8787)
  merge     sweep open ticket PRs — merge those meeting policy.merge requirements (default off)
  routines  list | validate | fire <id> — scheduled timer triggers through the admission gate
  events    tail [n] | verify — the hash-chained evidence ledger (chained, subscribable)
  init      six-step wizard writing ./dsh/policy.json + ./dsh/executor.json (--template minimal|dogfood)
  doctor    read-only checks over policy/executor/env/db — exit 0 clean · 1 warnings · 2 failures
  health    read-only体检: stage counts, oldest stuck ages, effect backlog (watchdog's eyes)
  stats     the numbers behind the trust story: gate decisions, cycle times, routine fires [--since ISO]
  wechat-login  iLink QR login: scan with WeChat, credentials land in the engine db
               --web serves a localhost page instead (click → scan → done; the QR is short-lived)
  help      show this usage

Common options:
  --repo owner/name         repository to watch
  --agent-login <login>     the agent's GitHub login (mention detection)
  --config <file>           policy config        (default policy.json, auto-scaffolded from examples/)
  --executor-config <file>  executor config      (default executor.json, auto-scaffolded from examples/)
  --db <file>               state database       (default .state/engine.db)
  --token <token>           GitHub token (or env GITHUB_TOKEN)
  --assessment <mode>       stub-positive | stub-negative | llm
  --interval <seconds>      watch poll interval (±20% jitter)
  --no-panel                watch without the panel server
  --post                    poll also posts queued replies (needs a token)
  --template <name>         init: minimal | dogfood (non-interactive, CI-testable)
  --dir <dir>               init: where the two configs go (default ./dsh)
  --force                   init: overwrite existing configs (leaves .bak.<ts> backups)
  --answers <file>          init: scripted answers (schema = the template file)
  --probe-network           doctor: whoami / repo permission / channel liveness (network)

Environment: GITHUB_TOKEN, or GitHub App auth (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY[_PATH],
optional GITHUB_APP_INSTALLATION_ID); Feishu channel (FEISHU_APP_ID + FEISHU_APP_SECRET,
optional FEISHU_BOT_OPEN_ID); Slack channel (SLACK_BOT_TOKEN + SLACK_APP_TOKEN);
Telegram channel (TELEGRAM_BOT_TOKEN); ASSESS_BASE_URL, ASSESS_MODEL, ASSESS_API_KEY, PANEL_PORT.
Docs: https://github.com/vicfei/dsh-super-agent#quick-start`;

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

export function examplePath(name: string): string | null {
  const p = join(examplesDir, name);
  return existsSync(p) ? p : null;
}

/** Copy the packaged example to `target` when neither exists yet. True ⇒ caller should tell the user to edit & rerun. */
export function scaffoldFromExample(target: string, example: string): boolean {
  const src = examplePath(example);
  if (!src || existsSync(target)) return false;
  copyFileSync(src, target);
  return true;
}

export const NO_TOKEN_HINT = `[warn] no GitHub credential — anonymous mode: public repos only, ~60 requests/hour,
       replies & PRs stay queued in the local outbox until a credential appears.
       export GITHUB_TOKEN (a read-only PAT is enough to start:
       https://github.com/settings/personal-access-tokens/new), or set up GitHub App auth — see README`;

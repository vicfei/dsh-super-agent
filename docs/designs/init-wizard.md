# `dsh init` wizard + `dsh doctor` — design (v1.2)

> Status: **implemented** — see §5 for what shipped and the deltas. The competition proved the point twice this week: opensuperagent reached
> ★34 in 3 days on `npm i -g opensuperagent && opensuperagent init && serve` — a web form
> and a running agent in two minutes. LofiSu ships a loopback UI. Our onboarding today is
> "read README §Quick start, hand-write policy.json and executor.json, hope". That is the
> widest gap we have, and it is not a code gap — it is a **first-ten-minutes** gap. This
> design closes it without adding a web server, a daemon, or a dependency: one interactive
> wizard that writes the two files, and one doctor that tells the truth about them.

## 1. `dsh init` — interactive, stdin/stdout, zero-dep

```
$ dsh init
dsh-super-agent 1.2.0 — admission control for any CLI coding agent

This writes ./dsh/policy.json and ./dsh/executor.json. Existing files are
NOT overwritten without --force. Ctrl-C any time; nothing is written until
the final step.

[1/6] Repository
  origin detected: vicfei/dsh-super-agent  (from git remote)
  use this? [Y/n] …
  → validates: gh-style slug, reachable with the provided credentials (dry API call)

[2/6] Identity & allowed list
  GITHUB_TOKEN found → authenticated as vicfei
  allowedList: [vicfei]  (default: the token's login — the human the gate obeys)
  add more logins (comma-separated, Enter to skip): …

[3/6] Agent (the executor's CLI)
  found on PATH: codex, claude      ← scanned probe list below
  choose [1] codex  [2] claude  [3] other…
  other → paste the argv template; {ticket} expands to the context file path,
          {worktree} to the worktree dir
  smoke: run `<cli> --version` with 5s timeout; ✗ = warn + continue

[4/6] Mode ladder
  off      — record only, decide nothing
  observe  — watch everything, do nothing (RECOMMENDED for new setups)
  auto     — act on explicit requests
  choose [1] off  [2] observe  [3] auto: 2
  → policy.acceptMode = "observe"

[5/6] Sandbox
  bwrap found → executor.sandbox = { enabled: true, allowNetwork: false }
  (none found → enabled:false + a warning: install bubblewrap for confinement)

[6/6] Channels
  github  [on] — always on; issues/PRs in the repo above
  wechat  [ ]  — needs `dsh wechat-login` later (QR in terminal)
  telegram[ ]  — needs TELEGRAM_BOT_TOKEN
  feishu  [ ]  — needs FEISHU_* envs
  slack   [ ]  — needs SLACK_BOT_TOKEN
  (space to toggle, enter to accept)
  → chosen non-github channels print their exact env checklist + README § link

Writing ./dsh/policy.json … ok
Writing ./dsh/executor.json … ok

Next:
  dsh doctor                     # verify everything above
  dsh watch --repo vicfei/dsh-super-agent --config ./dsh/policy.json \
            --executor-config ./dsh/executor.json
```

### Probe list (step 3)

`codex claude dsh gemini aider cursor-agent opencode` — presence probe only (`which`),
never executed except the opt-in `--version` smoke. "other" accepts any argv template, so
the honest answer to "which agents are supported" stays "anything with a CLI".

### Non-interactive mode

`dsh init --template minimal|dogfood [--dir ./dsh] [--force]` — same writer, defaults
instead of prompts (CI-testable; `dogfood` is the shape this repo's own daemon runs).
Interactive answers are also seedable: `dsh init --answers file.json` (documented schema =
the template file), for scripted installs. No prompt library: plain `readline`, one prompt
per line, Y/n defaults, re-ask on garbage — the wizard is auditable in a single screen.

### Writing rules

- Atomic write (tmp + rename); pretty 2-space JSON with a `"$comment"` header pointing at
  docs; **never** writes secrets (tokens stay in env; policy references env names only).
- `--force` required to overwrite; a backup `<name>.bak.<ts>` is left when it does.

## 2. `dsh doctor` — read-only, exit code tells CI the truth

```
$ dsh doctor --config ./dsh/policy.json --executor-config ./dsh/executor.json
✓ node 24.1.0
✓ github token: authenticated as vicfei
✓ repo vicfei/dsh-super-agent: read+write
✓ agent CLI: codex 0.42.1 on PATH
✓ sandbox: bwrap present; allowNetwork=false
! model API: OPENAI_API_KEY not set (executor env references it)   ← warn
✓ policy: schema ok; 2 admission rows; allowedList [vicfei]
! policy: acceptMode=auto with sandbox disabled                    ← warn (risky combo)
✓ routines: 2 definitions; next fire morning-digest 08:00 +08 (in 6h)
✓ db ./dsh/engine.db: writable (fsync ok)
✗ wechat: kv has auth but heartbeat says expired (-14) — run dsh wechat-login

2 warnings, 1 failure
```

Checks (each is a pure function → table-testable): node major ≥ 20; token → `/user` whoami;
repo permission (push dry-check); agent CLI presence + version; sandbox wrapper presence;
**every env name referenced by executor/policy** exists (the init step-6 checklist,
re-verified); policy schema + heuristics (empty allowedList, auto-without-sandbox, zero
non-ignore rows, merge.enabled without requireCi); routines schedules parse + next fire;
db open/fync; per-channel liveness (wechat: kv auth + optional cheap poll; telegram:
getMe; feishu/slack: env presence — no network calls unless `--probe-network`).

Exit code: 0 clean · 1 warnings · 2 failures. Issues template says "paste `dsh doctor`
output" — this becomes the support surface and, in CI, a regression tripwire for the
wizard's own templates.

## 3. What this deliberately is NOT

- **Not a web UI.** A loopback UI is a v1.3 question (LofiSu #129, opensuperagent both have
  one); the wizard+doctor pair is the 80% of its onboarding value at ~5% of its attack
  surface — no server, no port, no token-gating story. The design leaves room: doctor's
  check functions are the read model a future UI would render.
- **Not `serve`.** There is no daemon to start; `dsh watch` is the daemon, already boring
  and already supervised. The wizard's last screen just prints the exact command.

## 4. Tests (offline)

- template writer: minimal/dogfood produce schema-valid files; `--force` semantics; backup
  created; secrets scanner: output files never contain token values (grep for seeded fake).
- answers-file path: same files as the equivalent interactive answers (golden compare).
- doctor: every check as pure fn with injected fetch/fs/clock; exit-code truth table
  (0/1/2); risky-combo heuristics; env-reference extraction from executor template.
- init smoke in CI: `dsh init --template minimal` in a tmp repo with a fake `codex` shim on
  PATH → doctor (with fake token env) exits 0.

## 5. Implementation notes (what shipped, and the deltas)

1. **Doctor is offline by default — fully.** Not just the per-channel checks: the token
   whoami and the repo permission check also wait for `--probe-network` (the default run
   prints "set (whoami with --probe-network)"). The design's example output implies
   network by default; the shipped default is stricter so `dsh doctor` is safe anywhere
   and CI-testable.
2. **The db check never touches the engine db.** It opens a throwaway
   `<db>.doctor-probe` database in the same directory, round-trips one kv row, deletes
   it — the engine db itself is only read (wechat auth), and is never created as a side
   effect (init and doctor both run before any engine exists).
3. **Wizard prompts are one-per-line.** Space-to-toggle channel chips need a TUI
   library; the zero-dep readline contract (auditable in a single screen) wins. Channels
   are picked as a comma-separated list; everything else is Y/n or numbered choices with
   re-ask on garbage.
4. **Templates ship honest placeholders.** `minimal` has `allowedList:
   ["YOUR_LOGIN"]` (an empty list would trip doctor's empty-allowedList warning on day
   one); `dogfood` carries the daemon's shape — approval surface, watchdog, speculation,
   IM rows, shorter worker timeout — as a starting point, not a mirror.
5. **`agentLogin` is asked in step 2** (mention detection needs it for `watch`), and the
   final screen prints the exact `dsh doctor` + `dsh watch` commands including it.
6. Env checklists for chosen channels print at step 6, and doctor re-verifies every env
   name the executor command references (`$VAR`/`${VAR}`, `DSH_*` excluded — provided at
   runtime).

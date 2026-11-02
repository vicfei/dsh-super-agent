# Contributing

Thanks for considering it. This is an independent, runtime-agnostic implementation of the
[Super-agent admission-control design](https://github.com/deepseek-harness/dsh-superagent-prototype) —
if you're new to the domain, read the README's *Three rules* section first: every PR should make
sense in terms of **who may start work**, not "make the agent smarter".

## Setup

```bash
git clone https://github.com/vicfei/dsh-super-agent && cd dsh-super-agent
npm install
npm test          # vitest, no network needed
npm run build     # tsc → dist/ + panel.html
```

Node ≥ 20. Tests run offline (sources and fetch are mocked/injected); the CLI spawn tests use the
local `tsx` binary only.

## Workflow

1. **Issue first** — open an English issue describing the problem before coding (bug reports and
   feature requests both). Keep it in English; the audience is international.
2. **Branch** from `main`: `feat/<slug>`, `fix/<slug>` or `docs/<slug>`.
3. **PR** — tests green (`npm test`, plus `tsc -p tsconfig.json --noEmit`), linked to its issue.
   Reviews within 24h; squash-merge onto `main`.
4. **No direct pushes to `main`.**

## Repo map

| Path | What it is |
|---|---|
| `src/domain.ts` | Trigger / Policy / AdmissionTable / Decision types |
| `src/gate.ts` | Deterministic admission gate — the heart; semantics from prototype docs 002 |
| `src/runner.ts` | poll-step orchestration (gate → assessment → classify) |
| `src/engine.ts` | SQLite single-writer: tickets, decisions, outbox, read positions |
| `src/github/` | Source (polling, dedup, restart-safe positions) + REST client |
| `src/executor.ts` | Any-CLI subprocess executor, per-ticket git worktree, process-group timeout |
| `src/work.ts` | Claim → execute → report → PR delivery |
| `src/watch.ts` / `src/panel.*` | Daemon loop + the awaiting-human panel |
| `docs/` | Architecture notes, roadmap, release flow |

Domain semantics come from the prototype's docs 001–003; when behavior is ambiguous, the answer
that keeps the gate *deterministic and host-enforced* wins.

## House rules

- **README is bilingual.** Any README change is mirrored in `README.zh-CN.md` (EN primary, zh mirror,
  interlinked at top). Other docs are English-only.
- **Credentials never enter the repo** — tokens and API keys come from the environment only; the
  same applies to anything you paste into an issue (redact first).
- **lockfile hygiene** — `package-lock.json` must resolve against `registry.npmjs.org` only; CI
  fails on any other registry host. If you regenerate it on a machine with a mirror configured,
  re-check before committing.
- **Releases are tag-driven** — `vX.Y.Z` tags trigger the OIDC publish workflow; see
  [docs/RELEASE.md](docs/RELEASE.md). Version bumps happen in a PR, never on a release tag.

## Reporting bugs

Use the issue templates (bug / feature / trial feedback). For anything that executed work you
didn't expect — even in `auto` mode — that's a priority bug, say so loudly in the report.

# 000 — Philosophy

> Adapted (with gratitude) from [dsh-superagent-prototype docs/000-philosophy.md](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT, DeepSeek). The wording is ours; the principles are theirs.

dsh-super-agent is a framework and a working method built on one principle:

> **Take as little human attention as possible, and give as much value as possible.**

Every message, notification, setting and doc paragraph costs attention. It must return more value than it consumes, or be cut.

## Rules for the agent

- **Acting** — only when an allowed person asks, or a written rule admits the work. Rule-driven work begins in observe mode; records first, autonomy later.
- **Speaking** — only when a person must act or can use a result. Confirm once, stay silent while working, then report the result, the decision needed, or the failure.
- **Asking** — one concrete question at a time, structured — never buried in a report.
- **Stopping** — by impact, not by effort. Local changes go to a reviewable result; design decisions halt with a clear question.
- **Honesty** — drafts marked unfinished, failures reported as failures, limits never bypassed to avoid asking.

## Rules for admission

- **Host-enforced.** Messages cannot change permissions. Authorization is data (the admission table, the allowed list, the accept mode), evaluated by the host before any model sees a candidate.
- **Strength is binary.** Explicit always works. Inferred earns trust through records: `off → observe → auto`.
- **No silent authority growth.** Weakening a cell does not retroactively kill tickets accepted under it, and resume revalidates — both directions are explicit, versioned, and auditable.

## Design rules

- **Few concepts** — Source, Trigger, Thread, Ticket, Mandate, and implementations. Needs become attributes or prompts, not new concepts.
- **Few settings** — a default beats a setting when one value fits nearly everyone.
- **Minimal panel** — lists only what awaits a person. A healthy state takes no space.
- **Ordered documents** — each numbered doc builds only on prior ones.

## Goal

The right help at the right time, and nothing at any other time.

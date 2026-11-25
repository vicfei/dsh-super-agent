# Delegation-edge governance — A2A channel + worker-spawned teams (#169)

> Design page for Phase 3 / v2.0. The next square of the governance thesis: from governing
> your **own** agents to governing the **delegation edges** — who may hand work to whom.
> LofiSu ships both features (an A2A channel, sub-agent teams) as capabilities. dsh's
> version makes them institutions: **every delegation passes the admission table and lands
> one hash-chained row.** Protocol is commodity; the constitution around it is the product
> (the BYO-judge posture, applied to delegation).

## Why now

- Agent-to-agent is the next surface: A2A (Google → Linux Foundation → Agentic AI
  Foundation, 150+ organizations in its first year) is becoming the interop default.
- **Our own fleet is the first dogfood**: four nodes (win11 / wsl2 / shanghai / singapore)
  coordinate today by humans pasting prompts between windows. Node-to-node delegation
  through this channel is the same protocol — the fleet's pain is the feature's spec.
- Market gap: Daytona closed-sourced (June 2026); Coder Agents has no admission model.
  *Self-hosted agent infrastructure, governed* is the open narrative.

## Part 1 — the A2A channel

### Inbound: dsh as an A2A server

- **Agent Card** at `/.well-known/agent-card.json`: skills (the scopes this engine
  accepts, with hints), security schemes, endpoint URL. The card is the capability
  surface — it declares what *may* be asked; the admission table decides what *is*.
- `message/send` (JSON-RPC) → normalized into a Trigger like any other:
  `source: "a2a"`, **new scope `a2a`**, `threadId: a2a:<agent>/<task-id>`,
  author = the **authenticated caller identity** (v1: bearer token → a registered
  agent name; mTLS via overlay identity later), `addressing: true` (the caller
  addressed us).
- The `a2a` row is just another admission-table row: observe shadows, auto works,
  the Slow Path assesses inferred candidates. `allowedList` for this scope holds
  **agent identities** (a separate list from humans); unlisted agents fall to
  `unlistedAddressing` — default `ignore`, fail closed.
- Task-state mapping: `submitted` → ticket queued · `working` → assignment running ·
  `input-required` → needs-person (the approval surface gains an A2A twin: the ask
  travels back as a task state with the request as artifact) · `completed` → the
  report as artifact · `failed` / `canceled` → ticket ended accordingly.
- Ledger: a `delegation.received` row (caller, scope, task id) precedes the usual
  decision / ticket rows.

### Outbound: dsh as an A2A client

- **Relay**: for threads that originated from an A2A caller, replies route back
  through the A2A channel (`message/stream` where the caller subscribed, task
  update otherwise) — a `ReplyChannel` like the IM ones.
- **Delegation as a ticket**: when a worker needs work done elsewhere (another node,
  another engine), it asks through the one-way file protocol (Part 2) and the engine
  opens a child ticket whose executor is the A2A client. The delegation therefore
  inherits admission, has its own ledger row, and can fail into needs-person like
  any ticket — it is never a raw network call from inside a worker.
- **Network layer is assumed reachable** (overlay network such as Tailscale; the
  WeChat/TeamViewer lesson: do not leak NAT traversal into the business protocol).
  dsh does transport-level nothing beyond TLS; it owns semantics + admission.

### The twist, stated plainly

A2A itself carries no admission and no evidence. dsh supplies the constitution
around it: **whose agent, under what scope, one hash-chained row per delegation** —
cross-agent delegation becomes auditable for the first time. A protocol swap is a
config change, not a governance change.

## Part 2 — worker-spawned teams (child tickets)

- The worker asks through **`.dsh/delegate.md`** — the same one-way file convention as
  the approval request: frontmatter-ish `title / reason / prompt / count` (plus optional
  `node:` for fleet routing), informative never authoritative.
- The engine consumes it after the run: validates against `policy.teams`
  (enabled, `maxChildren` per parent, `maxDepth` — 1 by default), **inherits the
  parent's scope admission**, and opens child tickets: `parent_ticket_id`, their own
  `ticket.opened` rows (with parent), their own worktrees.
- **Node routing (slice 4)**: a `node:` field routes the children to a fleet node —
  `policy.teams.endpoints` maps node → that node's A2A endpoint; the engine resolves it
  at claim time and exports `DSH_TARGET_URL` / `DSH_TARGET_NODE` to the executor command
  template, which branches: a local worker when unset, `dsh a2a send --wait` when set
  (any CLI is a worker — the engine stays surgery-free). An unresolvable node is a
  config error that parks the parent like any child failure.
- The parent waits (`waiting-children` stage) until children settle. A child failure
  flows **into the parent's needs-person** with the child's failure as context — the
  team's failure has one owner: the person watching the parent.
- Anti-runaway is structural: depth cap, per-parent cap, total cap. **Team expansion
  itself goes through a gate** — LofiSu gives the worker freedom; we give the freedom
  a ledger. The org chart of a ticket tree becomes computable from the ledger.
- Panel: the parent ticket opens into a tree.

## Contract

```jsonc
// policy.json additions — both default OFF, like every autonomous capability here
"a2a":   { "enabled": true, "path": "/a2a", "allowedAgents": ["node-wsl2", "node-shanghai"] },
"teams": { "enabled": true, "maxChildren": 4, "maxDepth": 1,
           "endpoints": { "wsl2": "http://wsl2:8791/a2a" } }
```

```markdown
<!-- .dsh/delegate.md — written by the worker, consumed by the engine (one-way) -->
title: translate the docs bundle
reason: the parent needs zh-CN versions before it can finish; independent work
prompt: <what the child should do — becomes the child's DSH_PROMPT.md>
count: 1
node: wsl2   <!-- optional: run the children on that fleet node -->
```

```sh
# executor.json "command" — one template, two halves; the engine exports DSH_TARGET_URL
# only for node-routed children (token never enters the worker env: --token-file or A2A_TOKEN)
if [ -n "$DSH_TARGET_URL" ]; then
  exec dsh a2a send --url "$DSH_TARGET_URL" --token-file ~/.dsh/a2a.token \
    --prompt-file "$DSH_PROMPT_FILE" --wait --caller node-singapore
fi
exec <your local agent CLI>   # unrouted tickets run locally, exactly as before
```

- `A2A_TOKEN` (env, per registered agent v1) — never a worker env; the engine holds it.
- Admission-table row `a2a`: `listedNotAddressing` / `unlistedAddressing` /
  `unlistedNotAddressing` like every scope; `dsh init` writes it `ignore` everywhere
  until the owner turns it on.

## Relationship to the neighboring protocols

| Protocol | Edge | dsh's stance |
|---|---|---|
| **A2A** | agent ↔ agent (delegation) | this page — governed, ledgered |
| **ACP** (Agent Client Protocol) | client ↔ agent (harness) | later: the runtime-switching edge; not a delegation surface |
| **MCP** | agent ↔ tool | Phase 4 (P4-2) — tools are capabilities, not delegations |

## Implementation slices (each independently shippable)

1. `a2a` scope + Agent Card + inbound `message/send` → trigger (observe shadows first)
2. Relay `ReplyChannel` for A2A-origin threads (reports, asks, receipts)
3. `.dsh/delegate.md` → child tickets with a **local** executor (single engine)
4. A2A-executor child tickets — node-to-node; **fleet dogfood: singapore ↔ wsl2**
5. Panel ticket tree + `dsh review` tree-aware promotion evidence

## Acceptance (docs/ROADMAP.md)

A2A bidirectional smoke (an external `curl` → shadow/auto → artifact back) **and**
child tickets end-to-end including the *child failure → parent needs-person* path;
v2.0.0 + launch-post roadmap material.

## Open items (pre-implementation)

- [ ] A2A spec version pin (0.2 vs 0.3: streaming semantics, push notifications)
- [ ] Agent identity v1: bearer per registered agent; overlay-identity mTLS later
- [ ] `a2a` + `teams` rows in `dsh init` templates (off by default)
- [ ] Separate agent-identity list from the human `allowedList` — naming + storage
- [ ] Fleet dogfood plan: singapore ↔ wsl2 first pair over the overlay network
- [ ] `waiting-children` stage: watchdog semantics (stuck-children nudge vs parent patience)

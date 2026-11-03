# IM Remote Approval Surface — design (v1.1 candidate)

> Status: design. The project's philosophy is "the human approval surface"; today that surface
> is a browser (the panel, GitHub's PR page). This design moves it into the IM channels we
> already run, so the gate fits in a pocket: **approve, stop, or promote a ticket by replying
> with a number.**

## 1. What can be approved over IM — and what cannot

Approvable over IM (ticket-level human decisions):

- **needs-person tickets**: approve resume / stop
- **speculative tickets**: promote (the deliver gate) / discard
- **detail requests**: re-send the summary

NOT approvable over IM — by design, not by limitation:

- **GitHub merge approvals.** The auto-merge gate requires a *GitHub* approval covering the
  head SHA from an allowed-list, non-bot reviewer — that identity lives on GitHub. IM can
  **link** the PR (`PR #18 awaiting your review: <url>`) but an IM "1" can never forge the
  review. Structural, permanent.
- **Policy changes** (acceptMode, allowedList) and anything creating work. The approval
  surface acts only on *existing, pending* human-decision points.

## 2. Message formats

Requests go to an **ops thread** — the operator's DM with the bot (never a group; see §5).
Auto-learned: the first DM each allowed-list member opens with the bot registers their ops
thread (`approval_route` kv: login → threadId, one per member).

```
🔑 [approval needed] Ticket #12 — fix login timeout
from @alice · wechat DM · waiting since 14:32
1 approve · 2 stop · 3 detail
(reply with just the number)
```

```
🧪 [rehearsal ready] Ticket #15 — add FAQ entry
silently rehearsed · ±38 lines in the worktree
1 promote (push + PR) · 2 discard · 3 detail
```

```
🔗 [review needed] PR #18 — Ticket #12's work is up
approve on GitHub (identity lives there): <url>
(no number to reply — this one is a link only)
```

Applied-action receipts close the loop and make mistouches visible:

```
✅ Ticket #15 promoted — PR #19 opened: <url>
```

## 3. Numeric reply → action routing

The operator's digit arrives as an ordinary trigger (their DM ⇒ `im_dm`, allowed member,
inherently addressed ⇒ explicit). A **command layer intercepts before ticketing** (exactly how
GitHub's `stop` command already works — `classify` gets an approval fast path):

- shape test: the entire trimmed body is a single digit `1|2|3` — nothing else counts
  (`"1."`, `"ok 1"` fall through to normal gating, which opens no ticket for such noise in
  observe and is at most inferred otherwise)
- scope test: the thread is a registered ops thread (group digits are just chat)
- `engine.applyApproval(opsThread, digit)` resolves the **newest unresolved** request in that
  thread: 1 = approve/promote, 2 = stop/discard, 3 = re-send detail

New engine state: `approval_request (id, ops_thread, ticket_id, kind, created_at, resolved_at,
superseded_by)` — enqueue when a request is rendered; one unresolved request per thread
(newest-wins, older ones marked superseded); a digit with nothing pending gets a polite
"nothing pending" reply (never a guess).

## 4. Anti-mistouch semantics

1. **Strict digit shape** — whole trimmed body, one digit, nothing else.
2. **Asymmetric confirmation**: `1` (approve/promote) applies immediately — a wrong promote is
   reviewable and revertable (it produces a PR, nothing merges without GitHub approval);
   `2` (stop/discard) is destructive, so it requires a **double-key**: the bot replies
   "reply `2` again within 5 minutes to confirm stop #12". No second `2`, no action.
3. **Freshness window**: requests expire after 60 minutes; a late digit gets "expired,
   nothing done" plus a re-offer if the underlying decision is still pending.
4. **Newest-wins single pending**: exactly one unresolved request per ops thread; digits can
   never target an ambiguous older request.
5. **Receipts for every applied action** — a mistouch is visible within seconds.
6. **Origin binding**: digits work only in ops DM threads, only from allowed-list members
   (the gate itself enforces the sender; unlisted digits are just ignored chatter).
7. **No escalation**: the surface cannot change policy, approve merges, or create work.

## 5. Interaction with the gate

Everything still passes the gate first — the command layer is *downstream* of admission, an
extension of the existing stop-command semantics. A real request typed in the ops thread
("please also fix Y") behaves normally (explicit, opens a ticket) — documented, intended.

## 6. Delivery plan

- **v1.1**: `approval_request` table + ops-thread registry (auto-learn) + request rendering in
  the watchdog/report paths + digit routing + double-key stop + expiry + receipts; panel shows
  pending approvals alongside needs-person.
- **Out of scope**: GitHub merge approvals via IM (link only), group-chat approvals,
  cross-user delegation.

# Local web UI — the read-only dashboard (v1.3, slice 1)

> Status: slice 1 implemented (this file ships with it). The competition proved the
> onboarding half of the story (opensuperagent's web form); the operations half — one
> honest page of what the agent is doing — is ours to define. The design constraint is
> inherited from the panel (v0.4): **localhost-only, zero runtime dependencies, no
> credentials in the page**. A dashboard, not a remote control: reads come to you;
> writes stay where trust lives (IM digits, GitHub review, the panel's three legacy buttons).

## What it is NOT

- Not remotely accessible — binds `127.0.0.1`, always. No auth story needed because
  there is no surface to auth.
- Not a policy editor. The admission table is owner-authored config; a textarea that
  edits trust at a click is the opposite of the project's thesis.
- Not a second write path. `dsh` CLI + IM digits + GitHub remain the acting surfaces;
  the panel's mode/stop/promote buttons (v0.4/v1.0 legacy) are frozen as-is, nothing new.

## Slices

### Slice 1 (this PR) — the read model grows into a dashboard

The panel's `/api/state` gains what v1.2 made observable:

- **routines** — each definition rendered with its schedule, **next fire** (from the
  engine's timer positions — the same truth `dsh routines list` prints), overdue flag,
  and reportTo thread. The answer to "is my digest actually scheduled", in the page
  you already have open.
- **health** — the watchdog's read-only vitals (stage counts, oldest stuck ages,
  effect backlog) surfaced as a status line: the daemon's pulse at a glance.

### Slice 2 — doctor, embedded

Every doctor check is already a pure function over injectable facts; slice 2 passes
the watch daemon's env/executor config into the panel and renders the check list
(green/yellow/red, exit-code semantics preserved). The support surface ("paste
`dsh doctor` output") becomes "look at your panel".

### Slice 3 — audit depth

Decision rows deep-link to the full trigger body (respecting the inline/spill split),
approval requests show their state-machine history (requested → confirmed → resolved),
assignments show output tails. The audit trail exists in the engine; this makes it
navigable.

## Tests

Offline, as always: `/api/state` shape (routines with next-fire truth from seeded
positions, health fields), page renders empty states honestly ("the clock is off"),
and nothing new gains a write path.

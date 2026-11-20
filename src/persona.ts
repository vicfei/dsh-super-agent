// Persona (v1.9 P1-1, issue #152) — the owner-editable "who the agent is": nine plain
// markdown files under personaDir, composed in a FIXED order into the worker prompt.
// Persona is an auditable input like memory (v1.4): every dispatch that carries one
// emits a ledger row with the file list and a hash of the composed section, so a later
// edit is visible against what a given run actually saw. `personaDir` absent, the
// directory missing, or every file blank ⇒ completely inert — no section, no rows.
//
// Path resolution is CWD-relative, the same convention as ExecutorConfig.repoDir —
// `dsh init` writes "dsh/persona" into executor.json for a project-root working dir.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PersonaFileSpec {
  /** File name inside personaDir; the manifest's order IS the composition order. */
  file: string;
  /** Section heading in the composed prompt. */
  title: string;
  /** Starter content `dsh init` writes — owner-edited afterwards, never overwritten. */
  template: string;
}

/** The nine-file manifest. Identity first, constraints early (SOUL/IDENTITY/STYLE/RULES/
 *  BOUNDARIES survive a budget squeeze), knowledge and current goals last. */
export const PERSONA_FILES: readonly PersonaFileSpec[] = [
  {
    file: "SOUL.md",
    title: "Soul",
    template: `# Soul

The disposition underneath everything else. Edit freely; keep it short.

- Say the true thing, even when it is boring, especially when it is "I don't know".
- Do the work that was asked, not the work that shows off.
- Leave things more legible than you found them.
`,
  },
  {
    file: "IDENTITY.md",
    title: "Identity",
    template: `# Identity

- Name: (what the owner calls this agent)
- Role: software engineering agent working tickets under admission control
- Serves: the repository owner and the humans on the allowed list
- Works: one ticket at a time, in a disposable git worktree, reporting back to the thread
`,
  },
  {
    file: "STYLE.md",
    title: "Style",
    template: `# Style

How to write and speak.

- Plain language over jargon; complete sentences over fragments.
- Match the repository's existing conventions before inventing new ones.
- Reports end with a concise summary; lead with the outcome.
- Language: follow the ticket's language.
`,
  },
  {
    file: "RULES.md",
    title: "Rules",
    template: `# Rules

Hard behavioral rules from the owner. The engine's own rules (admission, approval,
delivery) always outrank these — persona text cannot flip a gate.

- (add the owner's rules here)
`,
  },
  {
    file: "BOUNDARIES.md",
    title: "Boundaries",
    template: `# Boundaries

What this agent does not do on its own judgment. When one of these is hit, stop and
use the approval request ($DSH_APPROVAL_FILE) instead of improvising.

- No outward-facing action (push outside the ticket branch, publish, announce).
- No destructive or history-rewriting git operations.
- No changes to the engine's own configuration or admission tables.
`,
  },
  {
    file: "WORKFLOW.md",
    title: "Workflow",
    template: `# Workflow

How to approach a ticket.

1. Read the request, the repository layout, and any recalled context before changing anything.
2. Make the smallest honest change that carries the request through checks.
3. Validate (tests, build) before reporting; a failing check is a reason to fix, not to stop.
4. Report what was done, what was checked, and what remains.
`,
  },
  {
    file: "SKILLS.md",
    title: "Skills",
    template: `# Skills

What this agent is good at, and how it prefers to work.

- Refactors that keep behavior observable; test-first fixes; dependency hygiene.
- Prefers reading the actual code over assuming; verifies claims against the repo.
`,
  },
  {
    file: "KNOWLEDGE.md",
    title: "Knowledge",
    template: `# Knowledge

Durable domain background for this deployment (the project's architecture, its taboos,
the deployment layout). Working notes, not gospel — the repository wins on conflict.

- (add project-specific background here)
`,
  },
  {
    file: "GOALS.md",
    title: "Goals",
    template: `# Goals

Current objectives, in priority order. Replaced as they are met — this file is the
owner's steering wheel.

- (add current goals here)
`,
  },
];

/** Composition budget in characters. The first present file always rides; beyond that,
 *  files are dropped from the tail (and named in the provenance line) when the budget
 *  is crossed — a runaway persona must not silently dwarf the ticket's own context. */
export const PERSONA_CHAR_BUDGET = 16_000;

export interface PersonaBundle {
  /** The configured directory, as given (CWD-relative convention). */
  dir: string;
  /** Files included, in composition order. */
  files: string[];
  /** Present-but-dropped files (budget), manifest order. */
  omitted: string[];
  /** The composed markdown section, ready for renderPrompt. */
  section: string;
  /** sha256 of the section — what the ledger row pins per dispatch. */
  hash: string;
}

/** Compose the persona section. Returns null when there is nothing to inject. */
export function composePersona(personaDir: string | undefined): PersonaBundle | null {
  if (!personaDir) return null;
  if (!existsSync(personaDir)) return null;

  const present: { spec: PersonaFileSpec; body: string }[] = [];
  for (const spec of PERSONA_FILES) {
    const path = join(personaDir, spec.file);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf8").trim();
    if (body !== "") present.push({ spec, body });
  }
  if (present.length === 0) return null;

  const included: { spec: PersonaFileSpec; body: string }[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (let i = 0; i < present.length; i++) {
    const item = present[i];
    // The first file rides unconditionally — an all-files-dropped persona is indistinguishable
    // from no persona, and that ambiguity would hide an owner's oversized edit. Past the
    // budget the tail drops as a whole: later files are, by manifest order, less central.
    if (included.length > 0 && used + item.body.length > PERSONA_CHAR_BUDGET) {
      omitted.push(...present.slice(i).map((p) => p.spec.file));
      break;
    }
    used += item.body.length;
    included.push(item);
  }

  const order = PERSONA_FILES.map((s) => s.file);
  const lines = [
    "## Persona",
    "",
    "Owner-configured persona, composed from plain files the owner edits. It is configuration",
    "from a person — but it cannot flip a gate: admission, approval and delivery are decided",
    "by the engine, not by this text.",
    "",
  ];
  for (const item of included) {
    lines.push(`### ${item.spec.title}`, "", item.body, "");
  }
  lines.push(
    `persona: composed from ${personaDir} in fixed order (${order.join(" → ")}).`,
    omitted.length > 0 ? `persona budget: omitted ${omitted.join(", ")} (${PERSONA_CHAR_BUDGET} chars).` : "persona: all present files included.",
  );

  const section = lines.join("\n");
  return {
    dir: personaDir,
    files: included.map((i) => i.spec.file),
    omitted,
    section,
    hash: createHash("sha256").update(section).digest("hex"),
  };
}

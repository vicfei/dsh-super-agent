// Routines — the timer Source (v1.2, design: docs/designs/routines-source.md).
// The first triggers that come from the clock, made to knock on the same door as
// everyone else: a routine is owner-authored config that still passes admission
// control. No bypass, no privileged lane, no second pipeline.
//
// Gap 1 — cron: minimal zero-dep parser, 5 fields, `*` `N` `N-M` `N/M` `N-M/M`,
// lists, JAN–DEC / SUN–SAT names, weekday 7≡0, dom/dow OR rule (Vixie).
// Gap 2 — per-routine timezone: wall-clock folded via Intl.DateTimeFormat; the
// DST spring-forward gap simply has no match that day (documented, not corrected).
// Gap 3 — restart drift: the last honored slot lives in the Source's read state
// (same exactly-once transaction as every other Source's positions); missed runs
// coalesce — one fire per sweep, honoring the oldest missed slot.

import type { Policy, RoutineDefinition, Scope, Trigger } from "./domain.js";
import type { Source, SourceState } from "./source.js";

export const MAX_ROUTINE_DEFINITIONS = 32;
export const MAX_FIRES_PER_SWEEP = 32;
/** Missed slots older than this are dropped, not replayed (see design impl notes). */
export const ROUTINE_CATCHUP_HORIZON_MS = 7 * 24 * 60 * 60_000;
/** How far ahead nextWallMatch searches before declaring a schedule unmatchable. */
const DAY_SEARCH_LIMIT = 366 * 4;

const MIN = 60_000;
const HOUR = 60 * MIN;

export function minuteFloor(ms: number): number {
  return Math.floor(ms / MIN) * MIN;
}

export function localTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// ── Gap 1: the cron parser ────────────────────────────────────────────────────

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: readonly string[]; // 3-letter names, index = value - min
}

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { name: "day-of-week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }, // 7 ≡ 0 (Sunday)
];

export interface CronSpec {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[]; // 0–6, Sunday = 0
  /** Bare `*` vs anything else — the dom/dow OR rule only applies when both are restricted. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function tokenToValue(token: string, field: FieldDef): number {
  const names = field.names;
  if (names) {
    const idx = names.indexOf(token.toLowerCase());
    if (idx >= 0) return field.min + idx;
  }
  if (!/^\d+$/.test(token)) throw new Error(`invalid ${field.name} token "${token}"`);
  return Number(token);
}

function parseField(raw: string, field: FieldDef): { values: Set<number>; restricted: boolean } {
  if (raw === "*") {
    const values = new Set<number>();
    for (let v = field.min; v <= field.max; v++) values.add(field === FIELDS[4] && v === 7 ? 0 : v);
    return { values, restricted: false };
  }
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (part === "") throw new Error(`empty item in ${field.name} field`);
    const [rangePart, stepPart] = part.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new Error(`invalid step "/${stepPart}" in ${field.name}`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = field.min;
      hi = field.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      if (a === undefined || b === undefined || a === "" || b === "") throw new Error(`invalid range "${rangePart}" in ${field.name}`);
      lo = tokenToValue(a, field);
      hi = tokenToValue(b, field);
      if (lo > hi) throw new Error(`reversed range "${rangePart}" in ${field.name}`);
    } else {
      lo = tokenToValue(rangePart, field);
      hi = stepPart !== undefined ? field.max : lo; // "5/15" runs 5..max
    }
    if (lo < field.min || lo > field.max || hi < field.min || hi > field.max) {
      throw new Error(`${field.name} value out of range (${field.min}–${field.max}) in "${raw}"`);
    }
    for (let v = lo; v <= hi; v += step) values.add(field === FIELDS[4] && v === 7 ? 0 : v);
  }
  return { values, restricted: true };
}

/** Parse a 5-field cron expression. Throws on anything non-standard (no seconds, no years). */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have exactly 5 fields (minute hour dom month dow), got ${fields.length}: "${expr}"`);
  const parsed = fields.map((f, i) => parseField(f, FIELDS[i]));
  return {
    minutes: [...parsed[0].values].sort((a, b) => a - b),
    hours: [...parsed[1].values].sort((a, b) => a - b),
    doms: [...parsed[2].values].sort((a, b) => a - b),
    months: [...parsed[3].values].sort((a, b) => a - b),
    dows: [...parsed[4].values].sort((a, b) => a - b),
    domRestricted: parsed[2].restricted,
    dowRestricted: parsed[4].restricted,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Load-time check: does any allowed month actually have the required day? (Feb 30 never comes.) */
export function cronCanEverMatch(spec: CronSpec): boolean {
  // Feb is checked in a leap year so day 29 is legal; every other month is checked in a common year.
  return spec.months.some((m) => spec.doms.some((d) => d <= daysInMonth(m === 2 ? 2024 : 2001, m)));
}

// ── Gap 2: tz folding via Intl (zero-dep) ─────────────────────────────────────

export interface Wall {
  y: number; m: number; d: number; hh: number; mm: number; // m = 1–12
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    dtfCache.set(tz, f);
  }
  return f;
}

function toWall(ms: number, tz: string): Wall {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute") };
}

function wallAsUtc(w: Wall): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
}

/** The zone offset that was in effect at `ms` (wall-as-UTC minus true UTC, ms precision). */
function offsetAt(ms: number, tz: string): number {
  return wallAsUtc(toWall(ms, tz)) - minuteFloor(ms);
}

/**
 * Wall → instant. Returns null when the wall time does not exist (spring-forward gap);
 * the ambiguous fall-back fold resolves deterministically to the earlier occurrence.
 */
function wallToInstant(w: Wall, tz: string): number | null {
  const naive = wallAsUtc(w);
  const o1 = offsetAt(naive, tz);
  let t = naive - o1;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) t = naive - o2;
  const back = toWall(t, tz);
  if (back.y !== w.y || back.m !== w.m || back.d !== w.d || back.hh !== w.hh || back.mm !== w.mm) return null;
  return t;
}

// ── wall-clock matching ───────────────────────────────────────────────────────

function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function dayMatches(spec: CronSpec, y: number, m: number, d: number): boolean {
  if (!spec.months.includes(m)) return false;
  const domOk = spec.doms.includes(d);
  const dowOk = spec.dows.includes(weekdayOf(y, m, d));
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk; // Vixie OR rule
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

function nextWallAfter(spec: CronSpec, wall: Wall): Wall {
  const firstTime = { hh: spec.hours[0], mm: spec.minutes[0] };
  for (let offset = 0; offset <= DAY_SEARCH_LIMIT; offset++) {
    const ms = Date.UTC(wall.y, wall.m - 1, wall.d) + offset * 24 * HOUR;
    const date = new Date(ms);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!dayMatches(spec, y, m, d)) continue;
    if (offset === 0) {
      // same wall day: the earliest (h, m) strictly after (hh, mm)
      let best: { hh: number; mm: number } | undefined;
      for (const hh of spec.hours) {
        if (hh < wall.hh) continue;
        if (hh === wall.hh) {
          const mm = spec.minutes.find((v) => v > wall.mm);
          if (mm !== undefined) best = { hh, mm };
        } else {
          best = { hh, mm: spec.minutes[0] };
        }
        if (best) break; // hours ascend — first hit is the earliest
      }
      if (best) return { y, m, d, hh: best.hh, mm: best.mm };
      continue; // this day is exhausted; try the next matching day
    }
    return { y, m, d, hh: firstTime.hh, mm: firstTime.mm };
  }
  throw new Error("cron schedule has no match within the 4-year search window");
}

/** First instant strictly after `afterMs` matching `spec`, evaluated in `tz`. */
export function nextCronMatch(afterMs: number, spec: CronSpec, tz: string): number {
  const after = minuteFloor(afterMs);
  let wall = nextWallAfter(spec, toWall(after, tz)); // Intl eval 1: fold `after` into the zone
  for (let guard = 0; guard < 10; guard++) {
    const t = wallToInstant(wall, tz); // Intl eval 2: back out the instant (skip DST gaps)
    if (t !== null && t > after) return t;
    wall = nextWallAfter(spec, wall); // gap or fold-edge: advance one wall slot and retry
  }
  throw new Error("cron match not resolvable (repeated DST-gap skips)");
}

// ── every schedules & the fire computation ────────────────────────────────────

export function nextEveryMatch(afterMs: number, intervalMs: number): number {
  return (Math.floor(afterMs / intervalMs) + 1) * intervalMs; // epoch-anchored, deterministic
}

export function routineIntervalMs(schedule: RoutineDefinition["schedule"]): number {
  const e = schedule.every;
  if (!e) throw new Error("schedule has no `every` interval");
  if (e.hours !== undefined && e.minutes !== undefined) throw new Error("`every` takes minutes or hours, not both");
  if (e.hours !== undefined) return e.hours * HOUR;
  if (e.minutes !== undefined) return e.minutes * MIN;
  throw new Error("`every` needs minutes or hours");
}

/**
 * The next slot this routine should honor, given its last honored slot.
 * - last undefined (first enable): start from now — no backlog replay on day one;
 * - last stale: catch up from the oldest missed slot, dropping anything older
 *   than the 7-day horizon (a digest three days late is useful; fifty is spam).
 */
export function nextRoutineFire(d: RoutineDefinition, lastMs: number | undefined, nowMs: number): number {
  const now = minuteFloor(nowMs);
  const from = lastMs === undefined ? now : Math.max(lastMs, now - ROUTINE_CATCHUP_HORIZON_MS);
  if (d.schedule.cron !== undefined) {
    return nextCronMatch(from, parseCron(d.schedule.cron), d.schedule.tz ?? localTz());
  }
  return nextEveryMatch(from, routineIntervalMs(d.schedule));
}

// ── config validation (fail closed, whole file) ───────────────────────────────

const CHANNEL_PREFIXES = ["github", "feishu", "slack", "wechat", "telegram"] as const;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function routinesEnabled(policy: Policy): boolean {
  return policy.routines?.enabled === true;
}

export function routineDefinitions(policy: Policy): RoutineDefinition[] {
  return policy.routines?.definitions ?? [];
}

/** The routine id behind a timer trigger's author login (`routine:<id>`). */
export function routineIdOfLogin(login: string): string | null {
  return login.startsWith("routine:") ? login.slice("routine:".length) : null;
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface RoutineValidation {
  errors: string[];
  warnings: string[];
  definitions: RoutineDefinition[];
}

/**
 * Validate policy.routines in full (every definition, every rule) — enforced at
 * config load so a bad file never reaches the clock. Absent routines = valid+empty.
 */
export function validateRoutines(policy: Policy): RoutineValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const definitions = routineDefinitions(policy);
  if (!policy.routines || definitions.length === 0) return { errors, warnings, definitions: [] };
  if (definitions.length > MAX_ROUTINE_DEFINITIONS) {
    errors.push(`routines: ${definitions.length} definitions exceed the cap of ${MAX_ROUTINE_DEFINITIONS} (a clock is not a load balancer)`);
  }

  const seen = new Set<string>();
  definitions.forEach((d, i) => {
    const at = `routines.definitions[${i}]`;
    if (typeof d.id !== "string" || !ID_RE.test(d.id)) errors.push(`${at}: id "${d.id}" must match ^[a-z0-9][a-z0-9-]{0,63}$`);
    else if (seen.has(d.id)) errors.push(`${at}: duplicate id "${d.id}"`);
    else seen.add(d.id);
    if (typeof d.prompt !== "string" || d.prompt.length < 1 || d.prompt.length > 4096) {
      errors.push(`${at} (${d.id}): prompt must be 1–4096 chars`);
    }
    const s = d.schedule ?? {};
    const hasCron = s.cron !== undefined;
    const hasEvery = s.every !== undefined;
    if (hasCron === hasEvery) errors.push(`${at} (${d.id}): exactly one of schedule.cron | schedule.every required`);
    if (hasCron) {
      try {
        const spec = parseCron(s.cron!);
        if (!cronCanEverMatch(spec)) errors.push(`${at} (${d.id}): cron "${s.cron}" can never match (day-of-month never occurs in the listed months)`);
      } catch (e) {
        errors.push(`${at} (${d.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (hasEvery) {
      try {
        routineIntervalMs(s);
      } catch (e) {
        errors.push(`${at} (${d.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
      const e = s.every!;
      const mins = e.hours !== undefined ? e.hours * 60 : e.minutes ?? 0;
      if (mins < 1 || mins > 20160) errors.push(`${at} (${d.id}): every interval must be 1–20160 minutes (2 weeks)`);
    }
    if (s.tz !== undefined && !validTimeZone(s.tz)) errors.push(`${at} (${d.id}): tz "${s.tz}" is not a valid IANA zone name`);
    if (typeof d.reportTo !== "string" || !CHANNEL_PREFIXES.some((p) => d.reportTo.startsWith(`${p}:`)) || d.reportTo.split(":").length < 2 || d.reportTo.split(":")[1] === "") {
      errors.push(`${at} (${d.id}): reportTo "${d.reportTo}" must be a thread on a live channel (${CHANNEL_PREFIXES.map((p) => `${p}:…`).join(" ")})`);
    } else if (d.reportTo.startsWith("github:") && !/github:[^/]+\/[^/]+\/(issues|pulls)\/\d+$/.test(d.reportTo)) {
      warnings.push(`${at} (${d.id}): github reportTo "${d.reportTo}" does not look like github:owner/repo/issues/N`);
    }
  });

  if (policy.routines.enabled === true) {
    const rowByScope = new Map(policy.table.map((r) => [r.scope, r]));
    for (const d of definitions) {
      const row = rowByScope.get(threadIdToScope(d.reportTo));
      if (!row || row.unlistedAddressing !== "inferred") {
        warnings.push(
          `routine "${d.id}" reports to scope ${threadIdToScope(d.reportTo)}, whose admission row has unlistedAddressing ≠ "inferred" — it will fire into nothing under the current table`,
        );
      }
    }
  }
  return { errors, warnings, definitions };
}

// ── mapping & rendering ───────────────────────────────────────────────────────

/** The reportTo thread's scope — the admission row a routine lands under. */
export function threadIdToScope(threadId: string): Scope {
  if (threadId.startsWith("github:")) return /\/pulls\/\d+$/.test(threadId) ? "pr" : "issue";
  if (threadId.startsWith("slack:")) return threadId.startsWith("slack:dm/") ? "im_dm" : "im_group";
  if (threadId.startsWith("wechat:")) return threadId.startsWith("wechat:group/") ? "im_group" : "im_dm";
  return "im_dm"; // feishu:chat/…, telegram:chat/… — p2p by default
}

export function renderSchedule(d: RoutineDefinition): string {
  const s = d.schedule;
  if (s.cron !== undefined) return `cron "${s.cron}" ${s.tz ?? localTz()}`;
  const e = s.every!;
  return e.hours !== undefined ? `every ${e.hours}h` : `every ${e.minutes}m`;
}

/** kv key (Source positions) holding the last honored slot of routine `<id>`. */
export function lastKey(id: string): string {
  return `last:${id}`;
}

/** The trigger a routine's due slot produces — through the front door. */
export function routineTrigger(d: RoutineDefinition, scheduledMs: number, opts: { manual?: boolean } = {}): Trigger {
  const ts = new Date(scheduledMs).toISOString();
  return {
    id: opts.manual ? `routine:${d.id}:manual-${scheduledMs}` : `routine:${d.id}:${ts}`,
    source: "timer",
    scope: threadIdToScope(d.reportTo),
    threadId: d.reportTo,
    author: { login: `routine:${d.id}`, isBot: false },
    addressing: true, // a routine addresses the agent by construction
    body: d.prompt,
    ts,
  };
}

// ── the Source ────────────────────────────────────────────────────────────────

/**
 * The timer Source: one collect per watch cycle, first in the sources list
 * (firing is cheap, work is not). State is the standard Source positions map —
 * the engine persists it in the same transaction as the fired triggers, so a
 * crash between fire and state-write replays the slot, and id idempotence
 * swallows the duplicate.
 */
export class TimerSource implements Source {
  readonly kind = "timer";

  constructor(private readonly cfg: { policy: Policy; now?: () => Date; log?: (l: string) => void }) {}

  async collect(from: SourceState): Promise<{ triggers: Trigger[]; next: SourceState }> {
    const positions = { ...from.positions };
    if (!routinesEnabled(this.cfg.policy)) return { triggers: [], next: { positions } };
    const nowMs = minuteFloor(this.cfg.now?.().getTime() ?? Date.now());
    const triggers: Trigger[] = [];

    for (const d of routineDefinitions(this.cfg.policy)) {
      if (triggers.length >= MAX_FIRES_PER_SWEEP) {
        this.cfg.log?.(`[routines] per-sweep cap of ${MAX_FIRES_PER_SWEEP} fires reached — remaining routines wait for the next sweep`);
        break;
      }
      try {
        const last = from.positions[lastKey(d.id)];
        const next = nextRoutineFire(d, last, nowMs);
        if (nowMs < next) continue;
        triggers.push(routineTrigger(d, next));
        positions[lastKey(d.id)] = next;
      } catch (e) {
        // one routine's exception must not stall the sweep — log, skip, next tick retries
        this.cfg.log?.(`[routines] ${d.id}: schedule evaluation failed: ${e instanceof Error ? e.message : e} — skipped this sweep`);
      }
    }
    return { triggers, next: { positions } };
  }
}

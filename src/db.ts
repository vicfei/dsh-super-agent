// DB — one engine, two backends (v1.10 P2-3, issue #164): `node:sqlite` (zero native
// dependencies — Node ≥ 22.5 with --experimental-sqlite, ≥ 22.13 unflagged) when the
// runtime has it, better-sqlite3 otherwise; DSH_DB_BACKEND forces either, loudly. The
// adapter exposes exactly the surface the engine uses (exec / pragma / prepare / close)
// and NOTHING more — both backends run the same suite in CI, so equivalence is checked,
// not assumed. `npm i` on a machine with no compile chain still works: better-sqlite3
// moved to optionalDependencies (install failure is tolerated; node:sqlite carries on).

import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export type DbBackend = "node-sqlite" | "better-sqlite3";

export interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDb {
  readonly backend: DbBackend;
  exec(sql: string): void;
  /** Settings only (`journal_mode = WAL`, `busy_timeout = 5000`) — reads go through exec. */
  pragma(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** One flat transaction: BEGIN · fn · COMMIT, ROLLBACK on throw. The engine is a single
   *  writer, so no savepoint nesting is needed — same shape on both backends. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** node:sqlite's DatabaseSync shape as the adapter uses it. */
interface NodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): unknown;
  close(): void;
}
type NodeSqliteModule = { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => NodeSqliteDb };

let nodeSqlite: NodeSqliteModule | null | undefined;

/** True when this runtime can use node:sqlite (cached; load errors are the answer, not crashes). */
export function nodeSqliteAvailable(): boolean {
  if (nodeSqlite === undefined) {
    try {
      const m = require_("node:sqlite") as NodeSqliteModule | undefined;
      nodeSqlite = m && typeof m.DatabaseSync === "function" ? m : null;
    } catch {
      nodeSqlite = null; // Node < 22.5, or 22.5–22.12 without --experimental-sqlite
    }
  }
  return nodeSqlite !== null;
}

function loadBetterSqlite(): new (path: string, opts?: { readonly?: boolean }) => NodeSqliteDb & { pragma(s: string): unknown } {
  try {
    const m = require_("better-sqlite3") as unknown;
    const Ctor = (m as { default?: unknown }).default ?? m as unknown;
    if (typeof Ctor !== "function") throw new Error("module did not resolve to a constructor");
    return Ctor as ReturnType<typeof loadBetterSqlite>;
  } catch (e) {
    throw new Error(
      `better-sqlite3 is unavailable here AND node:sqlite is not present — install a compile toolchain or run Node ≥ 22.13 (${e instanceof Error ? e.message : e})`,
    );
  }
}

/** The engines' statement contract is stricter than the loosest backend: undefined params
 *  throw HERE, identically everywhere (better-sqlite3 v12 tolerates undefined and binds
 *  NULL; node:sqlite rejects it — the adapter picks the loud behavior for both). */
function strictStmt(stmt: SqlStatement): SqlStatement {
  const check = (args: unknown[]) => {
    if (args.includes(undefined)) throw new Error("SQL parameter is undefined — pass null explicitly (backend-agnostic contract)");
  };
  return {
    run: (...a) => { check(a); return stmt.run(...a); },
    get: (...a) => { check(a); return stmt.get(...a); },
    all: (...a) => { check(a); return stmt.all(...a); },
  };
}

/** BEGIN · fn · COMMIT with ROLLBACK on throw — identical semantics on both backends
 *  (better-sqlite3's native .transaction is savepoint-based; the engine needs one flat
 *  transaction per command, so the SQL-level form is the portable contract). */
function txOf<T>(db: NodeSqliteDb, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back by the statement error */ }
    throw e;
  }
}

/** node:sqlite's DatabaseSync validates its options argument when PRESENT — pass it only
 *  when needed (an explicit undefined tripped validateObject on 22.x; live finding, CI
 *  2026-11-20). Same story for better-sqlite3's { readonly }. */
function nodeOpen(path: string, readonly: boolean | undefined): NodeSqliteDb {
  const Ctor = nodeSqlite!.DatabaseSync;
  return readonly ? new Ctor(path, { readOnly: true }) : new Ctor(path);
}

function betterOpen(path: string, readonly: boolean | undefined): NodeSqliteDb & { pragma(s: string): unknown } {
  const Ctor = loadBetterSqlite();
  return readonly ? new Ctor(path, { readonly: true }) : new Ctor(path);
}

function wrapNode(db: NodeSqliteDb): SqlDb {
  return {
    backend: "node-sqlite",
    exec: (sql) => db.exec(sql),
    pragma: (sql) => db.exec(`PRAGMA ${sql}`),
    prepare: (sql) => strictStmt(db.prepare(sql) as SqlStatement),
    transaction: <T>(fn: () => T) => txOf(db, fn),
    close: () => db.close(),
  };
}

function wrapBetter(db: NodeSqliteDb & { pragma(s: string): unknown }): SqlDb {
  return {
    backend: "better-sqlite3",
    exec: (sql) => db.exec(sql),
    pragma: (sql) => {
      db.exec(`PRAGMA ${sql}`);
    },
    prepare: (sql) => strictStmt(db.prepare(sql) as SqlStatement),
    transaction: <T>(fn: () => T) => txOf(db, fn),
    close: () => db.close(),
  };
}

/** Open the engine database. Backend: DSH_DB_BACKEND=node|better forces; default is
 *  node:sqlite when the runtime has it (the zero-dep rule), better-sqlite3 otherwise. */
export function openDatabase(path: string, opts: { readonly?: boolean } = {}): SqlDb {
  const forced = (process.env.DSH_DB_BACKEND ?? "").toLowerCase();
  if (forced === "node" || forced === "node-sqlite") {
    if (!nodeSqliteAvailable()) {
      throw new Error("DSH_DB_BACKEND=node but node:sqlite is unavailable on this runtime (need Node ≥ 22.5 with --experimental-sqlite, or ≥ 22.13 unflagged)");
    }
    return wrapNode(nodeOpen(path, opts.readonly));
  }
  if (forced === "better" || forced === "better-sqlite3") {
    return wrapBetter(new (loadBetterSqlite())(path, opts.readonly ? { readonly: true } : undefined));
  }
  if (nodeSqliteAvailable()) {
    return wrapNode(nodeOpen(path, opts.readonly));
  }
  return wrapBetter(betterOpen(path, opts.readonly));
}

// DB adapter (v1.10 P2-3, #164) — the seam that makes the engine backend-agnostic:
// node:sqlite when the runtime has it, better-sqlite3 otherwise, DSH_DB_BACKEND forces.
// The full-suite equivalence lives in CI (node 20 = better path, node 22+ = node:sqlite
// path, node 24 forced); these are the seam's own contracts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeSqliteAvailable, openDatabase, type SqlDb } from "../src/db.js";

let dir: string;
let db: SqlDb | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-db-"));
});
afterEach(() => {
  db?.close();
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("opens, sets the pragmas the engine needs, and round-trips rows", () => {
    db = openDatabase(join(dir, "e.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const r = db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run("a", "1");
    expect(r.changes).toBe(1);
    expect(Number(r.lastInsertRowid)).toBe(1);
    expect(db.prepare("SELECT v FROM kv WHERE k = ?").get("a")).toEqual({ v: "1" });
    expect(db.prepare("SELECT k FROM kv").all()).toEqual([{ k: "a" }]);
    expect(db.backend).toBe(nodeSqliteAvailable() ? "node-sqlite" : "better-sqlite3");
  });

  it("undefined params are an error on every backend — the engine must pass null, not undefined", () => {
    db = openDatabase(join(dir, "u.db"));
    db.exec("CREATE TABLE t (a TEXT)");
    expect(() => db.prepare("INSERT INTO t (a) VALUES (?)").run(undefined)).toThrow();
  });

  it("DSH_DB_BACKEND=node is loud when node:sqlite is absent (never a silent better fallback)", () => {
    process.env.DSH_DB_BACKEND = "node";
    try {
      if (!nodeSqliteAvailable()) {
        expect(() => openDatabase(join(dir, "forced.db"))).toThrow(/node:sqlite is unavailable/);
      } else {
        const forced = openDatabase(join(dir, "forced.db"));
        expect(forced.backend).toBe("node-sqlite");
        forced.close();
      }
    } finally {
      delete process.env.DSH_DB_BACKEND;
    }
  });

  it("DSH_DB_BACKEND=better pins the native backend even where node:sqlite exists", () => {
    process.env.DSH_DB_BACKEND = "better";
    try {
      db = openDatabase(join(dir, "pinned.db"));
      expect(db.backend).toBe("better-sqlite3");
    } finally {
      delete process.env.DSH_DB_BACKEND;
    }
  });
});

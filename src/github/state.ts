// Read position per feed — docs/001: "A Source holds its own read position (a restart must not
// replay events)". File-backed for milestone 1; milestone 2's Engine moves it into SQLite in the
// same transaction as the triggers it produced (exactly-once). Until then: positions are persisted
// before triggers are handed out (at-most-once across a crash, never replay).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Feed = "issue" | "issue_comment" | "pr" | "review_comment";

export interface SourceState {
  /** Max item id already taken per feed; 0 = never polled. Item ids are increasing ints. */
  positions: Record<Feed, number>;
}

export interface StateStore {
  load(): SourceState;
  save(state: SourceState): void;
}

export class FileSourceState implements StateStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  load(): SourceState {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as SourceState;
      return { positions: { issue: 0, issue_comment: 0, pr: 0, review_comment: 0, ...raw.positions } };
    } catch {
      return { positions: { issue: 0, issue_comment: 0, pr: 0, review_comment: 0 } };
    }
  }

  save(state: SourceState): void {
    const tmp = join(dirname(this.file), `.${Math.random().toString(36).slice(2)}.tmp`);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file); // atomic on POSIX
  }
}

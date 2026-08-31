// Debounced, non-overlapping background parse. Called after each ingest when
// AUTO_PARSE is on, so the local dashboard updates live as captures arrive.
// A single run is in flight at a time; a request during a run sets a "dirty"
// flag that triggers exactly one more run afterwards.
import type { Pool } from "../repository.js";
import { parseAll } from "./runner.js";

let running = false;
let dirty = false;

export function scheduleParse(pool: Pool): void {
  dirty = true;
  if (running) return;
  running = true;
  void (async () => {
    try {
      while (dirty) {
        dirty = false;
        try {
          await parseAll(pool);
        } catch (err) {
          console.error("[auto-parse] failed:", err);
        }
      }
    } finally {
      running = false;
    }
  })();
}

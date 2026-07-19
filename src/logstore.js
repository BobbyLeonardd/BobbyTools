// Persistent request-log ring buffer for the router.
//
// Why this exists: request logs used to live in a plain in-memory array that was
// lost on every restart, so the dashboard's history and metrics reset to empty
// each time the router bounced. This keeps the same bounded ring (newest-first,
// capped) but hydrates it from disk on boot and persists it back — debounced, so
// a burst of requests doesn't rewrite the file once per request.
//
// It is NOT the config store: logs are disposable telemetry, so a corrupt or
// missing file just starts empty (no backup dance like config.js). Deps are
// injected so it's testable without touching real disk.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_DIR = join(homedir(), '.bobbytools');
const LOG_FILE = join(LOG_DIR, 'logs.json');
const LOG_TMP = join(LOG_DIR, 'logs.tmp.json');

// Wide enough to back a usage dashboard (summary cards + per-model rollup) with
// real history, still bounded so the ring + its disk file stay small.
// ponytail: newest-first cap; usage older than MAX_LOGS requests ages out. If the
// dashboard ever needs long-range history, the upgrade path is a rollup on flush.
export const MAX_LOGS = 1000;

function diskLoad() {
  try {
    const arr = JSON.parse(readFileSync(LOG_FILE, 'utf-8'));
    return Array.isArray(arr) ? arr.slice(0, MAX_LOGS) : [];
  } catch {
    return []; // missing or corrupt telemetry is not worth recovering
  }
}

function diskSave(logs) {
  mkdirSync(LOG_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a half-written file that
  // then fails to parse (and silently wipes history) on the next boot.
  writeFileSync(LOG_TMP, JSON.stringify(logs), 'utf-8');
  renameSync(LOG_TMP, LOG_FILE);
}

export function createLogStore({
  load = diskLoad,
  save = diskSave,
  max = MAX_LOGS,
  delayMs = 2000,
} = {}) {
  const logs = load();
  let timer = null;

  function scheduleWrite() {
    if (!timer) {
      timer = setTimeout(() => { timer = null; try { save(logs); } catch {} }, delayMs);
      timer.unref?.(); // never keep the process alive just for a pending log flush
    }
  }

  return {
    // The live, newest-first array. computeStats/the /api/logs endpoint read this.
    all() { return logs; },

    // Add a new entry at the front, trim to cap, and schedule a persist. Returns
    // the entry so the caller can keep mutating it in place (e.g. set status /
    // latency once the upstream responds) — those mutations ride the next flush.
    push(entry) {
      logs.unshift(entry);
      if (logs.length > max) logs.length = max;
      scheduleWrite();
      return entry;
    },

    // A tracked entry was mutated in place (status pending -> success, latency
    // filled in). Persist the change (debounced).
    touch() { scheduleWrite(); },

    // Persist any pending write right now (shutdown).
    flush() { if (timer) { clearTimeout(timer); timer = null; try { save(logs); } catch {} } },
  };
}

// Router-wide singleton.
export const logStore = createLogStore();

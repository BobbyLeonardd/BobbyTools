// Router-scoped config store: ONE in-memory config as the source of truth.
//
// Why this exists: the router is concurrent. The old path (getConfig from disk →
// mutate a private copy → saveConfig overwrites the whole file) let two
// overlapping requests clobber each other's updates (lost `limited` flags, wrong
// usageCount). Here every handler mutates the SAME shared object, so overlapping
// requests can't lose each other's field writes (JS is single-threaded), and
// disk writes are debounced so a burst doesn't rewrite the file N times.
//
// Only the router uses this. The `bobby` CLI is short-lived and keeps writing
// config directly — so we also watch the file mtime and reload if the CLI (or a
// hand edit) changed it out from under us, otherwise the router would overwrite
// a freshly-added key. External edit wins; our pending stat bumps self-heal.
//
// Deps are injected so the store is testable without touching real disk.

import { getConfig, saveConfig, configMtimeMs } from './config.js';

export function createConfigStore({
  load = getConfig,
  save = saveConfig,
  mtime = configMtimeMs,
  delayMs = 1000,
} = {}) {
  let state = load();
  let lastMtime = mtime();
  let timer = null;

  function writeNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    save(state);
    // Record the mtime our own write produced so reloadIfChanged() doesn't
    // mistake it for an external edit.
    // ponytail: coarse mtime resolution means an external edit landing in the
    // same tick as our write is missed. Rare on a personal localhost tool;
    // upgrade path: a content hash instead of mtime.
    lastMtime = mtime();
  }

  return {
    // The live, shared config object. Mutate it in place, then scheduleWrite().
    get() { return state; },

    // Caller already mutated get() in place — persist it (debounced).
    scheduleWrite() {
      if (!timer) {
        timer = setTimeout(() => { timer = null; writeNow(); }, delayMs);
        timer.unref?.(); // never keep the process alive just for a pending write
      }
    },

    // Whole-config replace (dashboard "save") — persist immediately, no debounce.
    replace(next) {
      state = next;
      writeNow();
    },

    // Persist any pending write right now (shutdown, or dashboard save).
    flush() {
      if (timer) writeNow();
    },

    // Reload from disk if the file changed outside this process (CLI/hand edit).
    // External edit wins over our pending in-memory changes: reload drops the
    // pending timer, so we never clobber the newer file. Returns true if reloaded.
    reloadIfChanged() {
      const m = mtime();
      if (m !== lastMtime) {
        if (timer) { clearTimeout(timer); timer = null; }
        state = load();
        lastMtime = m;
        return true;
      }
      return false;
    },
  };
}

// Router-wide singleton.
export const store = createConfigStore();

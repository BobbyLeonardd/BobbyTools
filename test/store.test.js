// Self-check for the router config store: debounced writes, external-edit reload.
// Run: node test/store.test.js
import assert from 'node:assert';
import { createConfigStore } from '../src/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (1) A burst of mutations coalesces into ONE debounced write, and our own write
//     doesn't later read back as an external edit (save bumps the mtime).
{
  let saves = 0, mt = 10;
  const store = createConfigStore({
    load: () => ({ providers: [], n: 0 }),
    save: () => { saves++; mt++; },   // a real disk write bumps the file mtime
    mtime: () => mt,
    delayMs: 40,
  });

  store.get().n = 1; store.scheduleWrite();
  store.get().n = 2; store.scheduleWrite();
  store.get().n = 3; store.scheduleWrite();
  assert.strictEqual(saves, 0, 'debounced: nothing written synchronously');

  await sleep(70);
  assert.strictEqual(saves, 1, 'three rapid mutations coalesce into one write');
  assert.strictEqual(store.get().n, 3, 'last mutation wins');
  assert.strictEqual(store.reloadIfChanged(), false, 'our own write is not mistaken for an external edit');
}

// (2) An external edit (CLI / hand edit bumps mtime) triggers a reload, and the
//     external file WINS over any pending in-memory change.
{
  let mt = 1, loads = 0;
  const snapshots = [{ providers: [], tag: 'disk-A' }, { providers: [], tag: 'disk-B' }];
  const store = createConfigStore({
    load: () => snapshots[Math.min(loads++, snapshots.length - 1)],
    save: () => {},
    mtime: () => mt,
    delayMs: 40,
  });

  assert.strictEqual(store.get().tag, 'disk-A', 'initial state loaded from disk');
  store.get().pending = true; store.scheduleWrite();   // in-memory change waiting to flush
  mt = 2;                                               // CLI rewrote the file under us

  assert.strictEqual(store.reloadIfChanged(), true, 'external mtime change triggers reload');
  assert.strictEqual(store.get().tag, 'disk-B', 'reloaded fresh state from disk');
  assert.strictEqual(store.get().pending, undefined, 'external edit wins — pending change dropped');
  assert.strictEqual(store.reloadIfChanged(), false, 'no further change → no reload');
}

// (3) flush() persists a pending write now; replace() swaps + persists immediately.
{
  let saves = 0, mt = 5;
  const store = createConfigStore({
    load: () => ({ providers: [], n: 0 }),
    save: () => { saves++; mt++; },
    mtime: () => mt,
    delayMs: 1000,
  });

  store.get().n = 1; store.scheduleWrite();
  store.flush();
  assert.strictEqual(saves, 1, 'flush persists a pending write immediately');
  store.flush();
  assert.strictEqual(saves, 1, 'flush with nothing pending is a no-op');

  store.replace({ providers: [], replaced: true });
  assert.strictEqual(saves, 2, 'replace persists immediately');
  assert.strictEqual(store.get().replaced, true, 'replace swaps the live state');
}

console.log('✔ config store self-check passed');

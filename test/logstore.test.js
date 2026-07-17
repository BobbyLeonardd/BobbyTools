// Self-check for the persistent request-log ring (logstore.js) + rollupMetrics.
// Run: node test/logstore.test.js
import assert from 'node:assert';
import { createLogStore } from '../src/logstore.js';
import { rollupMetrics } from '../src/helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// (1) Hydrate from disk on boot: whatever load() returns is the starting ring.
{
  const seed = [{ id: '1', status: 'success' }, { id: '2', status: 'error' }];
  const store = createLogStore({ load: () => seed.map((x) => ({ ...x })), save: () => {}, delayMs: 10 });
  assert.strictEqual(store.all().length, 2, 'ring hydrated from disk on boot');
  assert.strictEqual(store.all()[0].id, '1', 'order preserved from disk (newest-first)');
}

// (2) push() prepends newest-first, caps at max, and returns the live entry so the
//     caller can keep mutating it (status pending -> success rides the next flush).
{
  let saved = null, saves = 0;
  const store = createLogStore({ load: () => [], save: (l) => { saved = l.map((x) => ({ ...x })); saves++; }, max: 3, delayMs: 20 });

  const e = store.push({ id: 'a', status: 'pending' });
  store.push({ id: 'b', status: 'success' });
  store.push({ id: 'c', status: 'success' });
  store.push({ id: 'd', status: 'success' }); // over cap -> oldest ('a') drops

  assert.strictEqual(store.all().length, 3, 'ring capped at max');
  assert.deepStrictEqual(store.all().map((x) => x.id), ['d', 'c', 'b'], 'newest-first, oldest evicted');

  // The entry reference stays live: mutating it and touch()ing persists the change.
  const b = store.all().find((x) => x.id === 'b');
  b.status = 'error';
  assert.strictEqual(store.all().find((x) => x.id === 'b').status, 'error', 'entry mutated in place');

  await sleep(40);
  assert.ok(saves >= 1, 'a debounced write happened');
  assert.deepStrictEqual(saved.map((x) => x.id), ['d', 'c', 'b'], 'persisted the capped ring');
}

// (3) Debounce: a burst of pushes coalesces into fewer writes than pushes.
{
  let saves = 0;
  const store = createLogStore({ load: () => [], save: () => { saves++; }, delayMs: 30 });
  for (let i = 0; i < 5; i++) store.push({ id: String(i), status: 'success' });
  assert.strictEqual(saves, 0, 'nothing written synchronously (debounced)');
  await sleep(50);
  assert.strictEqual(saves, 1, 'five rapid pushes coalesce into one write');
}

// (4) flush() persists a pending write immediately (shutdown path).
{
  let saves = 0;
  const store = createLogStore({ load: () => [], save: () => { saves++; }, delayMs: 10_000 });
  store.push({ id: 'x', status: 'success' });
  store.flush();
  assert.strictEqual(saves, 1, 'flush persists pending write now');
  store.flush();
  assert.strictEqual(saves, 1, 'flush with nothing pending is a no-op');
}

// (5) A corrupt/missing file starts empty rather than throwing (telemetry is
//     disposable). The swallow lives in the real diskLoad (JSON.parse in a
//     try/catch returning []); createLogStore takes load() at face value. Here we
//     model diskLoad's contract: a load that "fails" hands back [] instead of
//     throwing, so the ring starts empty and the router still boots.
{
  const diskLoadOnCorrupt = () => { try { throw new Error('corrupt'); } catch { return []; } };
  const store = createLogStore({ load: diskLoadOnCorrupt, save: () => {} });
  assert.strictEqual(store.all().length, 0, 'corrupt/missing history starts empty, never throws');
}

// ── rollupMetrics ──
{
  const now = 5_000_000;
  const logs = [
    { provider: 'Groq', model: 'llama', status: 'success', latencyMs: 100, timestamp: new Date(now - 10_000).toISOString() },
    { provider: 'Groq', model: 'llama', status: 'success', latencyMs: 300, timestamp: new Date(now - 20_000).toISOString() },
    { provider: 'Groq', model: 'llama', status: 'limit',   latencyMs: 50,  timestamp: new Date(now - 90_000).toISOString() }, // older than a minute
    { provider: 'OpenRouter', model: 'gpt', status: 'error', timestamp: new Date(now - 5_000).toISOString() }, // no latency
    { provider: 'Groq', model: 'llama', status: 'pending', timestamp: new Date(now - 1_000).toISOString() },
  ];
  const m = rollupMetrics(logs, now);

  assert.strictEqual(m.total, 5, 'all entries counted');
  assert.strictEqual(m.success, 2, 'two success');
  assert.strictEqual(m.limit, 1, 'one limit');
  assert.strictEqual(m.error, 1, 'one error');
  assert.strictEqual(m.pending, 1, 'one pending');
  assert.strictEqual(m.lastMinute, 4, 'four within last minute (2 groq success + groq pending + openrouter error); the 90s-old limit excluded');

  // success rate = success / (terminal requests) — pending excluded from the denominator.
  assert.strictEqual(m.successRate, Math.round((2 / 4) * 100), 'success rate over terminal requests');

  // avg latency only over entries that recorded one (100, 300, 50) -> 150.
  assert.strictEqual(m.avgLatencyMs, 150, 'avg latency over entries that recorded it');

  const groq = m.providers.find((p) => p.provider === 'Groq');
  assert.strictEqual(groq.total, 4, 'groq: four entries');
  assert.strictEqual(groq.success, 2, 'groq: two success');
  assert.strictEqual(groq.avgLatencyMs, 150, 'groq: avg of 100/300/50');

  const or = m.providers.find((p) => p.provider === 'OpenRouter');
  assert.strictEqual(or.error, 1, 'openrouter: one error');
  assert.strictEqual(or.avgLatencyMs, null, 'no latency samples -> null, not 0');

  // Empty is safe.
  const empty = rollupMetrics([], now);
  assert.strictEqual(empty.total, 0, 'empty logs safe');
  assert.strictEqual(empty.successRate, 0, 'empty success rate is 0, not NaN');
  assert.deepStrictEqual(empty.providers, [], 'empty providers');
}

console.log('✔ logstore + rollupMetrics self-check passed');

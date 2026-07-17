// Self-check for computeStats — the live-dashboard rollup.
// Run: node test/stats.test.js
import assert from 'node:assert';
import { computeStats, LIMIT_COOLDOWN_MS } from '../src/helpers.js';

const now = 2_000_000;

const config = {
  providers: [
    {
      id: 'groq', name: 'Groq',
      accounts: [
        { id: 'a', name: 'key1', status: 'active', usageCount: 5 },
        { id: 'b', name: 'key2', status: 'limited', limitedAt: now - 20_000, usageCount: 3 }, // router-limited, mid-cooldown
        { id: 'c', name: 'key3', status: 'limited' },                                          // manual limit, no limitedAt
      ],
    },
    {
      id: 'or', name: 'OpenRouter',
      accounts: [
        { id: 'd', name: 'k', status: 'active' }, // no usageCount → defaults to 0
      ],
    },
  ],
};

const logs = [
  { status: 'success', timestamp: new Date(now - 5_000).toISOString() },   // last minute
  { status: 'limit',   timestamp: new Date(now - 30_000).toISOString() },  // last minute
  { status: 'error',   timestamp: new Date(now - 90_000).toISOString() },  // older than a minute
  { status: 'pending', timestamp: new Date(now - 1_000).toISOString() },   // last minute
  { status: 'success', timestamp: 'not-a-date' },                          // unparseable → not counted in lastMinute
];

const s = computeStats(config, logs, LIMIT_COOLDOWN_MS, now);

// Totals
assert.strictEqual(s.totals.providers, 2, 'two providers');
assert.strictEqual(s.totals.accounts, 4, 'four accounts total');
assert.strictEqual(s.totals.active, 2, 'two active (a, d)');
assert.strictEqual(s.totals.limited, 2, 'two limited (b, c)');

// Request tallies
assert.strictEqual(s.requests.total, 5, 'five log entries');
assert.strictEqual(s.requests.success, 2, 'two success');
assert.strictEqual(s.requests.limit, 1, 'one limit');
assert.strictEqual(s.requests.error, 1, 'one error');
assert.strictEqual(s.requests.pending, 1, 'one pending');
assert.strictEqual(s.requests.lastMinute, 3, 'three within last minute; unparseable + old excluded');

// Per-account recovery
const groq = s.providers.find((p) => p.id === 'groq');
assert.strictEqual(groq.active, 1, 'groq: one active');
assert.strictEqual(groq.limited, 2, 'groq: two limited');
const [a, b, c] = groq.accounts;
assert.strictEqual(a.recoversInMs, null, 'active account has no countdown');
assert.strictEqual(b.recoversInMs, LIMIT_COOLDOWN_MS - 20_000, 'router-limited: remaining cooldown');
assert.strictEqual(c.recoversInMs, null, 'manual limit never auto-revives → null (UI shows "manual")');
assert.strictEqual(a.usageCount, 5, 'usageCount passthrough');

// A key whose cooldown already elapsed reports 0 (due now), never negative.
const past = computeStats(
  { providers: [{ id: 'g', name: 'G', accounts: [{ id: 'x', name: 'x', status: 'limited', limitedAt: now - LIMIT_COOLDOWN_MS - 5_000 }] }] },
  [], LIMIT_COOLDOWN_MS, now,
);
assert.strictEqual(past.providers[0].accounts[0].recoversInMs, 0, 'elapsed cooldown clamps to 0');

// usageCount default when missing.
const or = s.providers.find((p) => p.id === 'or');
assert.strictEqual(or.accounts[0].usageCount, 0, 'missing usageCount defaults to 0');

// Empty/missing config is safe.
const empty = computeStats({}, [], LIMIT_COOLDOWN_MS, now);
assert.strictEqual(empty.totals.providers, 0, 'no providers');
assert.strictEqual(empty.requests.total, 0, 'no logs');

console.log('✔ computeStats self-check passed');

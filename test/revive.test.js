// Self-check for reviveLimitedAccounts cooldown logic.
// Run: node test/revive.test.js
import assert from 'node:assert';
import { reviveLimitedAccounts, parseRetryAfter, LIMIT_COOLDOWN_MS } from '../src/helpers.js';

const now = 1_000_000;

function cfg() {
  return {
    providers: [
      {
        id: 'groq',
        accounts: [
          { id: 'a', status: 'limited', limitedAt: now - LIMIT_COOLDOWN_MS - 1 }, // expired -> revive
          { id: 'b', status: 'limited', limitedAt: now - 1_000 },                  // fresh   -> stay
          { id: 'c', status: 'limited' },                                          // manual  -> stay (no limitedAt)
          { id: 'd', status: 'active' },                                           // active  -> untouched
          { id: 'e', status: 'limited', authFailed: true },                        // dead key -> stay (no limitedAt)
        ],
      },
    ],
  };
}

const config = cfg();
const changed = reviveLimitedAccounts(config, LIMIT_COOLDOWN_MS, now);
const [a, b, c, d, e] = config.providers[0].accounts;

assert.strictEqual(changed, true, 'should report a change');
assert.strictEqual(a.status, 'active', 'expired router-limit must revive');
assert.strictEqual(a.limitedAt, undefined, 'revived account must drop limitedAt');
assert.strictEqual(b.status, 'limited', 'fresh limit must stay limited');
assert.strictEqual(c.status, 'limited', 'manual limit (no limitedAt) must never auto-revive');
assert.strictEqual(d.status, 'active', 'active account untouched');
assert.strictEqual(e.status, 'limited', 'auth-failed key (no limitedAt) must never auto-revive');

// Idempotent: a second pass with nothing due changes nothing.
assert.strictEqual(reviveLimitedAccounts(config, LIMIT_COOLDOWN_MS, now), false, 'second pass is a no-op');

// ── Retry-After override: a per-account retryAfterMs beats the fixed cooldown ──
// Longer than cooldown → NOT yet due even though cooldown has passed.
const cfg2 = { providers: [{ id: 'p', accounts: [
  { id: 'x', status: 'limited', limitedAt: now - LIMIT_COOLDOWN_MS - 1, retryAfterMs: 300_000 }, // wants 5min, only 60s+ passed
] }] };
assert.strictEqual(reviveLimitedAccounts(cfg2, LIMIT_COOLDOWN_MS, now), false, 'retryAfterMs longer than elapsed keeps it limited');
assert.strictEqual(cfg2.providers[0].accounts[0].status, 'limited', 'still limited under long Retry-After');

// Shorter than cooldown → due early, and revive clears retryAfterMs too.
const cfg3 = { providers: [{ id: 'p', accounts: [
  { id: 'y', status: 'limited', limitedAt: now - 6_000, retryAfterMs: 5_000 }, // wants 5s, 6s passed
] }] };
assert.strictEqual(reviveLimitedAccounts(cfg3, LIMIT_COOLDOWN_MS, now), true, 'short Retry-After revives before the 60s cooldown');
assert.strictEqual(cfg3.providers[0].accounts[0].status, 'active', 'revived under short Retry-After');
assert.strictEqual(cfg3.providers[0].accounts[0].retryAfterMs, undefined, 'revive drops retryAfterMs');

// ── parseRetryAfter: delta-seconds, HTTP-date, and the junk/absent cases ──
assert.strictEqual(parseRetryAfter('120', now), 120_000, 'delta-seconds -> ms');
assert.strictEqual(parseRetryAfter('0', now), 0, 'zero seconds -> 0');
assert.strictEqual(parseRetryAfter(null), null, 'missing header -> null');
assert.strictEqual(parseRetryAfter('', now), null, 'empty header -> null');
assert.strictEqual(parseRetryAfter('soon', now), null, 'unparseable -> null');
assert.strictEqual(parseRetryAfter(new Date(now + 30_000).toUTCString(), now), 30_000, 'HTTP-date -> ms until then');
assert.strictEqual(parseRetryAfter(new Date(now - 30_000).toUTCString(), now), 0, 'past HTTP-date clamps to 0');

console.log('✔ reviveLimitedAccounts self-check passed (+ authFailed, Retry-After override, parseRetryAfter)');

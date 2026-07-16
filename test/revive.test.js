// Self-check for reviveLimitedAccounts cooldown logic.
// Run: node test/revive.test.js
import assert from 'node:assert';
import { reviveLimitedAccounts, LIMIT_COOLDOWN_MS } from '../src/helpers.js';

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
        ],
      },
    ],
  };
}

const config = cfg();
const changed = reviveLimitedAccounts(config, LIMIT_COOLDOWN_MS, now);
const [a, b, c, d] = config.providers[0].accounts;

assert.strictEqual(changed, true, 'should report a change');
assert.strictEqual(a.status, 'active', 'expired router-limit must revive');
assert.strictEqual(a.limitedAt, undefined, 'revived account must drop limitedAt');
assert.strictEqual(b.status, 'limited', 'fresh limit must stay limited');
assert.strictEqual(c.status, 'limited', 'manual limit (no limitedAt) must never auto-revive');
assert.strictEqual(d.status, 'active', 'active account untouched');

// Idempotent: a second pass with nothing due changes nothing.
assert.strictEqual(reviveLimitedAccounts(config, LIMIT_COOLDOWN_MS, now), false, 'second pass is a no-op');

console.log('✔ reviveLimitedAccounts self-check passed');

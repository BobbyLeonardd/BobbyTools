// Self-check for anthropicUsesBearer — picks the auth header for anthropic-format
// providers. Guards the agentrouter bug: a gateway documented as
// ANTHROPIC_AUTH_TOKEN needs Authorization: Bearer, while native Anthropic
// (ANTHROPIC_API_KEY) needs x-api-key. The router read neither and hardcoded
// x-api-key, so bearer gateways got 401. Run: node test/authheader.test.js
import assert from 'node:assert';
import { anthropicUsesBearer, getApiKey } from '../src/helpers.js';

const bearer = { credentials: [{ key: 'apiKey', secret: true, required: true, envVar: 'ANTHROPIC_AUTH_TOKEN' }] };
const xapikey = { credentials: [{ key: 'apiKey', secret: true, required: true, envVar: 'ANTHROPIC_API_KEY' }] };
const openai = { credentials: [{ key: 'apiKey', secret: true, required: true, envVar: 'OPENAI_API_KEY' }] };

// ── the regression: ANTHROPIC_AUTH_TOKEN => Bearer (agentrouter) ──
assert.strictEqual(anthropicUsesBearer(bearer), true, 'ANTHROPIC_AUTH_TOKEN -> Bearer');
// ANTHROPIC_API_KEY => x-api-key (native Anthropic / hcnsec), the safe default
assert.strictEqual(anthropicUsesBearer(xapikey), false, 'ANTHROPIC_API_KEY -> x-api-key');
// any other env var never flips to Bearer
assert.strictEqual(anthropicUsesBearer(openai), false, 'other env var -> x-api-key');

// a provider whose first secret cred is optional still resolves (prefers required)
const mixed = { credentials: [
  { key: 'opt', secret: true, required: false, envVar: 'OPENAI_API_KEY' },
  { key: 'apiKey', secret: true, required: true, envVar: 'ANTHROPIC_AUTH_TOKEN' },
] };
assert.strictEqual(anthropicUsesBearer(mixed), true, 'required secret wins over optional');

// getApiKey must still find the same credential (shared primarySecretCred)
assert.strictEqual(getApiKey(bearer, { credentials: { apiKey: 'sk-x' } }), 'sk-x', 'getApiKey intact');

console.log('authheader.test.js: PASS');

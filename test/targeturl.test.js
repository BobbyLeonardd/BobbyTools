// Self-check for buildTargetUrl — the upstream URL builder. Guards the glm-5.2
// bug: a bare-origin anthropic base URL must POST to /v1/messages, not /messages
// (the latter hit the gateway's HTML homepage and returned a bogus 200).
// Run: node test/targeturl.test.js
import assert from 'node:assert';
import { buildTargetUrl } from '../src/helpers.js';

// ── the regression: bare-origin anthropic base gets /v1/messages ──
assert.strictEqual(
  buildTargetUrl('https://api.hcnsec.cn', 'anthropic', {}),
  'https://api.hcnsec.cn/v1/messages',
  'bare-origin anthropic base -> /v1/messages (the glm-5.2 fix)');

// trailing slash on the base is trimmed, not doubled
assert.strictEqual(
  buildTargetUrl('https://api.hcnsec.cn/', 'anthropic', {}),
  'https://api.hcnsec.cn/v1/messages',
  'trailing slash trimmed');

// a base URL that already carries /v1 must NOT get a second one
assert.strictEqual(
  buildTargetUrl('https://api.anthropic.com/v1', 'anthropic', {}),
  'https://api.anthropic.com/v1/messages',
  'existing /v1 base is not doubled');

// responses format: same /v1 rule, /responses suffix
assert.strictEqual(
  buildTargetUrl('https://api.openai.com', 'responses', {}),
  'https://api.openai.com/v1/responses',
  'bare responses base -> /v1/responses');
assert.strictEqual(
  buildTargetUrl('https://api.openai.com/v1', 'responses', {}),
  'https://api.openai.com/v1/responses',
  'existing /v1 responses base not doubled');

// ── openai gateways: version lives in the base, spelled every which way. We
// trust the base and append only the bare endpoint (adding /v1 would break these).
assert.strictEqual(
  buildTargetUrl('https://api.groq.com/openai/v1', 'openai', {}),
  'https://api.groq.com/openai/v1/chat/completions',
  'groq openai/v1 base kept as-is');
assert.strictEqual(
  buildTargetUrl('https://api.novita.ai/v3/openai', 'openai', {}),
  'https://api.novita.ai/v3/openai/chat/completions',
  'novita /v3/openai base kept (would break if we forced /v1)');
assert.strictEqual(
  buildTargetUrl('https://api.upstage.ai/v1/solar', 'openai', {}),
  'https://api.upstage.ai/v1/solar/chat/completions',
  'upstage /v1/solar base kept (a /v1$ check alone would miss this)');

// ── gemini: model in the URL, verb depends on streaming; a trailing /v1 or
// /v1beta on the base is normalized off first, then /v1beta is rebuilt.
assert.strictEqual(
  buildTargetUrl('https://generativelanguage.googleapis.com', 'gemini', { model: 'gemini-2.0-flash' }),
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  'gemini non-stream verb');
assert.strictEqual(
  buildTargetUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini', { model: 'gemini-2.0-flash', wantsStream: true }),
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
  'gemini stream verb, trailing /v1beta stripped then rebuilt');
assert.strictEqual(
  buildTargetUrl('https://host/v1', 'gemini', { model: 'g/1' }),
  'https://host/v1beta/models/g%2F1:generateContent',
  'gemini strips trailing /v1 and url-encodes the model');

console.log('✔ buildTargetUrl self-check passed');

// Self-check for the control-plane trust guard (anti-CSRF / anti-DNS-rebinding).
// Run: node test/trust.test.js
import assert from 'node:assert';
import { isTrustedControlRequest } from '../src/helpers.js';

const PORT = '127.0.0.1:13337';

// The dashboard's own fetches: same-origin, loopback Host + Origin -> trusted.
assert.strictEqual(
  isTrustedControlRequest({ host: PORT, origin: 'http://127.0.0.1:13337' }),
  true, 'dashboard same-origin (127.0.0.1) trusted');
assert.strictEqual(
  isTrustedControlRequest({ host: 'localhost:13337', origin: 'http://localhost:13337' }),
  true, 'dashboard same-origin (localhost) trusted');

// A non-browser caller (curl, the CLI) sends no Origin — Host loopback is enough.
assert.strictEqual(isTrustedControlRequest({ host: PORT }), true, 'loopback Host, no Origin trusted');
assert.strictEqual(isTrustedControlRequest({ host: 'localhost' }), true, 'bare loopback host, no port');

// CSRF: a site you visit POSTs to 127.0.0.1 — its Origin is the attacker's domain.
assert.strictEqual(
  isTrustedControlRequest({ host: PORT, origin: 'https://evil.example.com' }),
  false, 'cross-site Origin rejected (CSRF write blocked)');
assert.strictEqual(
  isTrustedControlRequest({ host: PORT, referer: 'https://evil.example.com/attack.html' }),
  false, 'cross-site Referer rejected');

// DNS-rebinding: attacker domain rebound to 127.0.0.1 — Host carries their name.
assert.strictEqual(
  isTrustedControlRequest({ host: 'evil.example.com:13337' }),
  false, 'foreign Host rejected (rebinding read blocked)');
assert.strictEqual(
  isTrustedControlRequest({ host: 'evil.example.com', origin: 'http://evil.example.com' }),
  false, 'foreign Host + matching foreign Origin still rejected');

// Missing/blank Host can't be trusted (can't prove it's loopback).
assert.strictEqual(isTrustedControlRequest({}), false, 'no Host rejected');
assert.strictEqual(isTrustedControlRequest({ host: '' }), false, 'blank Host rejected');

// A loopback Host but a mismatched loopback-shaped Origin is still same-machine.
assert.strictEqual(
  isTrustedControlRequest({ host: PORT, origin: 'http://localhost:13337' }),
  true, 'loopback Host + loopback Origin (diff spelling) trusted');

console.log('✔ control-plane trust guard self-check passed (CSRF + rebinding)');

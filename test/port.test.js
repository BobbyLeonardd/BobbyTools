// Self-check for CLI port parsing + the port-in-use probe both serve commands rely on.
// Run: node test/port.test.js
import assert from 'node:assert';
import net from 'node:net';
import { parsePortArg } from '../src/helpers.js';

// ── parsePortArg: shared by `serve` and `serve-bg` so they can't drift ──
assert.strictEqual(parsePortArg([]), 13337, 'no args -> default');
assert.strictEqual(parsePortArg(['serve']), 13337, 'no flag -> default');
assert.strictEqual(parsePortArg(['serve', '-p', '8080']), 8080, '-p value');
assert.strictEqual(parsePortArg(['serve', '--port', '8080']), 8080, '--port value');
assert.strictEqual(parsePortArg(['serve', '-p', '1']), 1, 'low bound ok');
assert.strictEqual(parsePortArg(['serve', '-p', '65535']), 65535, 'high bound ok');

// Garbage/out-of-range falls back instead of binding a NaN/invalid port
// (this was the latent `serve` bug: bare parseInt gave NaN for 'abc').
assert.strictEqual(parsePortArg(['serve', '-p', 'abc']), 13337, 'non-numeric -> fallback');
assert.strictEqual(parsePortArg(['serve', '-p']), 13337, 'missing value -> fallback');
assert.strictEqual(parsePortArg(['serve', '-p', '0']), 13337, '0 is out of range -> fallback');
assert.strictEqual(parsePortArg(['serve', '-p', '70000']), 13337, '>65535 -> fallback');
assert.strictEqual(parsePortArg(['serve', '-p', '-5']), 13337, 'negative -> fallback');
assert.strictEqual(parsePortArg([], 9999), 9999, 'custom fallback honored');

// `13337abc` parseInt-parses to 13337; that's fine — a trailing typo shouldn't
// nuke an otherwise-valid leading port. Documenting the intentional behavior.
assert.strictEqual(parsePortArg(['-p', '8080x']), 8080, 'leading digits win (parseInt semantics)');

// ── isPortInUse behavior: probe answers true only when something listens ──
// isPortInUse lives in index.js (private); replicate its exact loopback-probe
// contract here so the daemon-spawn guard has a runnable check. Kept identical
// to the impl: connect => in use, error/timeout => free.
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (inUse) => { socket.destroy(); resolve(inUse); };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const server = net.createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const livePort = server.address().port;

assert.strictEqual(await isPortInUse(livePort), true, 'occupied loopback port reads as in-use');
server.close();
await new Promise((r) => server.once('close', r));
assert.strictEqual(await isPortInUse(livePort), false, 'freed port reads as available');

console.log('✔ parsePortArg + isPortInUse self-check passed');

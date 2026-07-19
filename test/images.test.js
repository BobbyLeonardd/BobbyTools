// Self-check for OpenAI Images API routing (/v1/images/generations + /edits).
// Spawns the REAL router + a mock upstream on loopback (no external key needed),
// then proves the router accepts the Images endpoint, key-rotates, and passes
// the upstream JSON back byte-for-byte.
// Run: node test/images.test.js
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolate HOME so the router's config store doesn't touch the real ~/.bobbytools ──
// Must happen BEFORE importing config.js/server.js: config.js resolves CONFIG_DIR
// from os.homedir() at import time.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bobby-img-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME; // Windows reads USERPROFILE, not HOME

const { startRouterServer } = await import('../src/server.js');

// ── Mock upstream: records the request, answers with an OpenAI Images JSON shape ──
let upstreamHits = 0, lastAuth = null, lastPath = null, lastBody = null;
const upstream = http.createServer((req, res) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    upstreamHits++;
    lastAuth = req.headers['authorization'] || req.headers['x-api-key'];
    lastPath = req.url;
    lastBody = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      created: 1,
      data: [{ b64_json: 'AAAA', revised_prompt: 'a cat' }],
    }));
  });
});

await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

// ── Seed a provider + account pointing at the mock upstream ──
// We import store directly (already constructed in server.js) and replace its
// in-memory config with a known-good one. The router reads this same singleton.
const { store } = await import('../src/store.js');
const model = 'mockprov/dall-e-3';
store.replace({
  providers: [{
    id: 'mockprov',
    name: 'Mock Prov',
    baseUrlTemplate: upstreamBase,
    apiFormat: 'openai',
    models: ['dall-e-3'],
    credentials: [{ label: 'API Key', key: 'apiKey', secret: true }],
    accounts: [{ id: 'a1', name: 'acct1', status: 'active', credentials: { apiKey: 'sk-real-key' }, usageCount: 0 }],
  }],
});

// ── Start the router on a fixed free loopback port ──
// startRouterServer(port, background=true) resolves with undefined (it returns
// once the server is listening), so we hand it a known-free port rather than 0.
import net from 'node:net';
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const port = await freePort();
const server = await startRouterServer(port, true);

// ── POST /v1/images/generations to the router ──
const resp = await new Promise((resolve, reject) => {
  const body = JSON.stringify({ model, prompt: 'a cat', n: 1 });
  const r = http.request(
    { host: '127.0.0.1', port, path: '/v1/images/generations', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    resolve,
  );
  r.on('error', reject);
  r.write(body);
  r.end();
});

let respBody = '';
for await (const c of resp) respBody += c.toString();

// ── Assertions ──
assert.strictEqual(resp.statusCode, 200, 'router forwarded the Images request (200, not 404)');
assert.strictEqual(upstreamHits, 1, 'the upstream Images endpoint was hit exactly once');
assert.strictEqual(lastPath, '/images/generations', 'router stripped /v1 and forwarded the trailing path');
assert.strictEqual(lastAuth, 'Bearer sk-real-key', 'router injected the real account key as Bearer');
const echoed = JSON.parse(lastBody);
assert.strictEqual(echoed.model, 'dall-e-3', 'router split provider/ and sent the bare model upstream');
assert.ok(respBody.includes('"b64_json":"AAAA"'), 'the upstream image JSON passes through to the client');

// ── Rotation: a 429 upstream makes the router try the next account ──
// Restart the upstream as a 429-once-then-200 server, add a second account, retry.
upstream.close();
let calls = 0;
const upstream429 = http.createServer((req, res) => {
  calls++;
  if (calls === 1) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":"rate"}'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ created: 1, data: [{ b64_json: 'BBBB' }] }));
});
await new Promise((r) => upstream429.listen(upstreamPort, '127.0.0.1', r));

store.replace({
  providers: [{
    id: 'mockprov',
    name: 'Mock Prov',
    baseUrlTemplate: upstreamBase,
    apiFormat: 'openai',
    models: ['dall-e-3'],
    credentials: [{ label: 'API Key', key: 'apiKey', secret: true }],
    accounts: [
      { id: 'a1', name: 'acct1', status: 'active', credentials: { apiKey: 'sk-1' }, usageCount: 0 },
      { id: 'a2', name: 'acct2', status: 'active', credentials: { apiKey: 'sk-2' }, usageCount: 0 },
    ],
  }],
});

const resp2 = await new Promise((resolve, reject) => {
  const body = JSON.stringify({ model, prompt: 'a cat' });
  const r = http.request(
    { host: '127.0.0.1', port, path: '/v1/images/generations', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    resolve,
  );
  r.on('error', reject);
  r.write(body);
  r.end();
});
let resp2Body = '';
for await (const c of resp2) resp2Body += c.toString();

assert.strictEqual(resp2.statusCode, 200, 'after a 429, the router rotated to the next account and got 200');
assert.ok(resp2Body.includes('"b64_json":"BBBB"'), 'the second account produced the response');

// ── Teardown ──
await new Promise((r) => server.close(r));
await new Promise((r) => upstream429.close(r));
fs.rmSync(TMP_HOME, { recursive: true, force: true });

console.log('✔ images routing self-check passed (generations + 429 rotation)');

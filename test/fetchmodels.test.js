// Self-check for POST /api/fetch-models (the web dashboard's "Fetch" button).
// Spawns the REAL router in a temp HOME. The upstream /models call is stubbed by
// swapping globalThis.fetch — a non-local baseUrl keeps the isLocalUrl guard from
// firing, so we exercise the happy path AND the guard branches without a network.
// Run: node test/fetchmodels.test.js
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// Isolate HOME before importing config.js/server.js (CONFIG_DIR resolves at import).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bobby-fm-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { startRouterServer } = await import('../src/server.js');
const { store } = await import('../src/store.js');

// Stub the upstream /models call. The router uses the global fetch; capture the
// original so the router's own HTTP (via node http, not fetch) is unaffected and
// we can restore it after.
const realFetch = globalThis.fetch;
let lastFetchUrl = null, lastAuth = null;
globalThis.fetch = async (url, opts) => {
  lastFetchUrl = String(url);
  lastAuth = opts?.headers?.Authorization || null;
  return {
    ok: true,
    status: 200,
    // One clean id + one self-prefixed id, to prove normalizeFetchedModels strips
    // the "<slug>/" prefix and records an alias back to the advertised id.
    json: async () => ({ data: [{ id: 'llama-3.3-70b' }, { id: 'mock-prov/glm-5.2' }] }),
  };
};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const port = await freePort();
const server = await startRouterServer(port, true);

// POST /api/fetch-models with a loopback Host so the trust guard lets it through.
function fetchModels(providerId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ providerId });
    const r = http.request(
      { host: '127.0.0.1', port, path: '/api/fetch-models', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: `127.0.0.1:${port}` } },
      async (res) => { let b = ''; for await (const c of res) b += c; resolve({ status: res.statusCode, body: b }); },
    );
    r.on('error', reject);
    r.write(body); r.end();
  });
}

// ── Happy path: non-local provider with a /models endpoint + an account ──
store.replace({
  version: 3,
  providers: [{
    id: 'p_ok', name: 'Mock Prov', baseUrlTemplate: 'https://api.example.com/v1',
    modelsEndpoint: '/models', apiFormat: 'openai',
    credentials: [{ label: 'API Key', key: 'apiKey', secret: true }],
    accounts: [{ id: 'a1', name: 'acct1', status: 'active', credentials: { apiKey: 'sk-real' }, usageCount: 0 }],
    models: [],
  }],
});
{
  const { status, body } = await fetchModels('p_ok');
  assert.strictEqual(status, 200, 'fetch succeeds');
  const data = JSON.parse(body);
  assert.deepStrictEqual(data.models, ['llama-3.3-70b', 'glm-5.2'], 'self-prefixed id stripped to friendly name');
  assert.deepStrictEqual(data.aliases, { 'glm-5.2': 'mock-prov/glm-5.2' }, 'alias records the advertised id');
  assert.strictEqual(lastFetchUrl, 'https://api.example.com/v1/models', 'hit baseUrl + modelsEndpoint');
  assert.strictEqual(lastAuth, 'Bearer sk-real', 'sent the real account key');
}

// ── Guard: local provider is manual-only (self-loop protection) ──
store.replace({
  version: 3,
  providers: [{
    id: 'p_local', name: 'Local', baseUrlTemplate: 'http://127.0.0.1:9999/v1',
    modelsEndpoint: '/models', accounts: [{ id: 'a1', name: 'x', status: 'active', credentials: {} }],
    credentials: [{ key: 'apiKey', secret: true }],
  }],
});
{
  const { status, body } = await fetchModels('p_local');
  assert.strictEqual(status, 400, 'local provider rejected');
  assert.match(JSON.parse(body).error, /manual-only|self-loop/i, 'explains the self-loop guard');
}

// ── Guard: no modelsEndpoint → 400 ──
store.replace({
  version: 3,
  providers: [{ id: 'p_noep', name: 'NoEndpoint', baseUrlTemplate: 'https://x.example/v1',
    accounts: [{ id: 'a1', name: 'x', status: 'active', credentials: {} }], credentials: [{ key: 'apiKey', secret: true }] }],
});
{
  const { status } = await fetchModels('p_noep');
  assert.strictEqual(status, 400, 'no endpoint → 400');
}

// ── Guard: no account → 400 ──
store.replace({
  version: 3,
  providers: [{ id: 'p_noacc', name: 'NoAcct', baseUrlTemplate: 'https://x.example/v1',
    modelsEndpoint: '/models', accounts: [], credentials: [{ key: 'apiKey', secret: true }] }],
});
{
  const { status } = await fetchModels('p_noacc');
  assert.strictEqual(status, 400, 'no account → 400');
}

// ── Guard: unknown provider → 404 ──
{
  const { status } = await fetchModels('does-not-exist');
  assert.strictEqual(status, 404, 'unknown provider → 404');
}

// ── Teardown ──
globalThis.fetch = realFetch;
await new Promise((r) => server.close(r));
fs.rmSync(TMP_HOME, { recursive: true, force: true });

console.log('✔ fetch-models self-check passed (happy path + local/no-endpoint/no-account/unknown guards)');

// Self-check for the web dashboard's server-side account endpoints:
//   POST /api/test-account  — "Test" button (connectivity check)
//   POST /api/oauth-login    — "Login pakai browser" button (guard preconditions)
// Spawns the REAL router in a temp HOME. The upstream /models call for test-account
// is stubbed by swapping globalThis.fetch (a non-local baseUrl keeps isLocalUrl from
// firing). The oauth-login browser flow is NOT triggered — we only exercise its
// guard branches (the flow itself is covered by oauth-flow.test.js).
// Run: node test/webaccounts.test.js
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// Isolate HOME before importing config.js/server.js (CONFIG_DIR resolves at import).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bobby-wa-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { startRouterServer } = await import('../src/server.js');
const { store } = await import('../src/store.js');

// Stub the upstream /models call test-account makes. Toggle `upstreamOk` to drive
// the ok vs error branch; the router's own HTTP (node http, not fetch) is untouched.
const realFetch = globalThis.fetch;
let lastFetchUrl = null, lastAuth = null, upstreamOk = true;
globalThis.fetch = async (url, opts) => {
  lastFetchUrl = String(url);
  lastAuth = opts?.headers?.Authorization || null;
  return {
    ok: upstreamOk,
    status: upstreamOk ? 200 : 401,
    text: async () => (upstreamOk ? 'ok' : 'invalid key'),
    statusText: upstreamOk ? 'OK' : 'Unauthorized',
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

// POST helper with a loopback Host so the control-plane trust guard lets it through.
function post(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const r = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: `127.0.0.1:${port}` } },
      async (res) => { let b = ''; for await (const c of res) b += c; resolve({ status: res.statusCode, body: b }); },
    );
    r.on('error', reject);
    r.write(body); r.end();
  });
}

// ── test-account: happy path — non-local provider + active account, upstream 200 ──
store.replace({
  version: 3,
  providers: [{
    id: 'p_ok', name: 'Mock Prov', baseUrlTemplate: 'https://api.example.com/v1',
    modelsEndpoint: '/models', apiFormat: 'openai',
    credentials: [{ label: 'API Key', key: 'apiKey', secret: true }],
    accounts: [{ id: 'a1', name: 'acct1', status: 'active', credentials: { apiKey: 'sk-real' }, usageCount: 0 }],
  }],
});
{
  upstreamOk = true;
  const { status, body } = await post('/api/test-account', { providerId: 'p_ok', accountId: 'a1' });
  assert.strictEqual(status, 200, 'test-account responds 200');
  const data = JSON.parse(body);
  assert.strictEqual(data.ok, true, 'reports ok when upstream 200');
  assert.strictEqual(lastFetchUrl, 'https://api.example.com/v1/models', 'hit baseUrl + modelsEndpoint');
  assert.strictEqual(lastAuth, 'Bearer sk-real', 'sent the real account key');
}

// ── test-account: upstream rejects the key → ok:false with the HTTP status ──
{
  upstreamOk = false;
  const { status, body } = await post('/api/test-account', { providerId: 'p_ok', accountId: 'a1' });
  assert.strictEqual(status, 200, 'still a clean 200 envelope (the check ran)');
  const data = JSON.parse(body);
  assert.strictEqual(data.ok, false, 'reports not-ok on upstream 401');
  assert.match(data.message, /401/, 'surfaces the upstream status');
}

// ── test-account guards: unknown provider / unknown account ──
{
  const { status } = await post('/api/test-account', { providerId: 'nope', accountId: 'a1' });
  assert.strictEqual(status, 404, 'unknown provider → 404');
}
{
  const { status } = await post('/api/test-account', { providerId: 'p_ok', accountId: 'nope' });
  assert.strictEqual(status, 404, 'unknown account → 404');
}

// ── oauth-login guard: provider is not oauth2 → 400 (never opens a browser) ──
{
  const { status, body } = await post('/api/oauth-login', { providerId: 'p_ok', clientId: 'x' });
  assert.strictEqual(status, 400, 'non-oauth provider rejected');
  assert.match(JSON.parse(body).error, /oauth2/i, 'explains authType must be oauth2');
}

// ── oauth-login guards on a real oauth2 provider: missing authUrl, then missing clientId ──
store.replace({
  version: 3,
  providers: [
    { id: 'p_noauthurl', name: 'OAuth NoUrl', baseUrlTemplate: 'https://api.example.com/v1',
      authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl: 'https://t.example/token' },
      credentials: [{ key: 'clientId', secret: false }], accounts: [] },
    { id: 'p_oauth', name: 'OAuth OK', baseUrlTemplate: 'https://api.example.com/v1',
      authType: 'oauth2', oauth: { grantType: 'refresh_token', authUrl: 'https://a.example/auth', tokenUrl: 'https://t.example/token' },
      credentials: [{ key: 'clientId', secret: false }], accounts: [] },
    { id: 'p_jwt', name: 'OAuth JWT', baseUrlTemplate: 'https://api.example.com/v1',
      authType: 'oauth2', oauth: { grantType: 'jwt-bearer', tokenUrl: 'https://t.example/token' },
      credentials: [{ key: 'clientEmail', secret: false }], accounts: [] },
  ],
});
{
  const { status, body } = await post('/api/oauth-login', { providerId: 'p_noauthurl', clientId: 'x' });
  assert.strictEqual(status, 400, 'missing authUrl rejected');
  assert.match(JSON.parse(body).error, /authUrl/i, 'names the missing authUrl');
}
{
  const { status, body } = await post('/api/oauth-login', { providerId: 'p_jwt', clientId: 'x' });
  assert.strictEqual(status, 400, 'jwt-bearer grant rejected (browser login is refresh_token only)');
  assert.match(JSON.parse(body).error, /refresh_token/i, 'explains the grant restriction');
}
{
  const { status, body } = await post('/api/oauth-login', { providerId: 'p_oauth', clientId: '' });
  assert.strictEqual(status, 400, 'missing clientId rejected before opening a browser');
  assert.match(JSON.parse(body).error, /client id/i, 'names the missing Client ID');
}
{
  const { status } = await post('/api/oauth-login', { providerId: 'nope', clientId: 'x' });
  assert.strictEqual(status, 404, 'unknown provider → 404');
}

// ── Teardown ──
globalThis.fetch = realFetch;
await new Promise((r) => server.close(r));
fs.rmSync(TMP_HOME, { recursive: true, force: true });

console.log('✔ web account endpoints self-check passed (test-account ok/fail/guards + oauth-login guards)');

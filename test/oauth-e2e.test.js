// End-to-end check for OAuth2 provider auth through the REAL router.
// Spawns the router + a mock token endpoint + a mock upstream on loopback, seeds
// an authType='oauth2' provider, and proves the router mints an access token and
// forwards it as `Authorization: Bearer`, replacing whatever the client sent.
// Also proves a revoked grant (invalid_grant) disables the account and rotates.
// Run: node test/oauth-e2e.test.js
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate HOME before importing config/server (config resolves CONFIG_DIR at import).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bobby-oauth-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { startRouterServer } = await import('../src/server.js');
const { store } = await import('../src/store.js');
const { _clearTokenCache } = await import('../src/oauth.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function post(port, path, bodyObj, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const r = http.request(
      { host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders } },
      async (res) => { let b = ''; for await (const c of res) b += c; resolve({ status: res.statusCode, body: b }); },
    );
    r.on('error', reject);
    r.write(body); r.end();
  });
}

// ── Mock OAuth token endpoint: refresh_token grant -> access token ──
let tokenHits = 0, lastGrant = null, lastRefresh = null, tokenMode = 'ok';
const tokenSrv = http.createServer((req, res) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    tokenHits++;
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    lastGrant = form.get('grant_type');
    lastRefresh = form.get('refresh_token');
    if (tokenMode === 'revoked') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid_grant"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'minted-token-123', expires_in: 3600, token_type: 'Bearer' }));
  });
});
await new Promise((r) => tokenSrv.listen(0, '127.0.0.1', r));
const tokenUrl = `http://127.0.0.1:${tokenSrv.address().port}/token`;

// ── Mock upstream: records the Authorization header it received ──
let upstreamHits = 0, lastAuth = null, lastClientKeyLeaked = null;
const upstream = http.createServer((req, res) => {
  upstreamHits++;
  lastAuth = req.headers['authorization'] || null;
  // If the client's bogus key leaked through in any auth header, catch it.
  lastClientKeyLeaked = req.headers['x-api-key'] || null;
  let chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

// ── Seed an oauth2 provider (OpenAI-format so no translation muddies the auth test) ──
function seed(accounts) {
  store.replace({
    providers: [{
      id: 'oauthprov', name: 'OAuth Prov', baseUrlTemplate: upstreamBase, apiFormat: 'openai',
      authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl },
      models: ['gpt-4o'],
      credentials: [{ label: 'Refresh Token', key: 'refreshToken', secret: true, required: true }],
      accounts,
    }],
  });
}

const port = await freePort();
const server = await startRouterServer(port, true);

// ── Case 1: happy path — router mints a token and sends it as Bearer ──
_clearTokenCache();
seed([{ id: 'a1', name: 'acct1', status: 'active', credentials: { refreshToken: 'rt-good', clientId: 'cid' }, usageCount: 0 }]);

const r1 = await post(port, '/v1/chat/completions', { model: 'oauthprov/gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
  { 'Authorization': 'Bearer sk-bobby-bogus-client-key' }); // client sends a junk key the router must replace

assert.strictEqual(r1.status, 200, 'router forwarded the chat request');
assert.strictEqual(tokenHits, 1, 'token endpoint hit exactly once to mint');
assert.strictEqual(lastGrant, 'refresh_token', 'refresh_token grant used');
assert.strictEqual(lastRefresh, 'rt-good', 'the account refresh token was exchanged');
assert.strictEqual(lastAuth, 'Bearer minted-token-123', 'upstream got the MINTED token as Bearer, not the client key');
assert.strictEqual(lastClientKeyLeaked, null, 'the client bogus key did not leak upstream');

// ── Case 2: cache — a second request reuses the token, no second mint ──
const r2 = await post(port, '/v1/chat/completions', { model: 'oauthprov/gpt-4o', messages: [{ role: 'user', content: 'again' }] });
assert.strictEqual(r2.status, 200);
assert.strictEqual(tokenHits, 1, 'cached token reused — no extra mint');
assert.strictEqual(upstreamHits, 2, 'both requests reached the upstream');

// ── Case 3: revoked grant — invalid_grant disables the account (no active left -> 429) ──
_clearTokenCache();
tokenMode = 'revoked';
seed([{ id: 'a1', name: 'acct1', status: 'active', credentials: { refreshToken: 'rt-revoked' }, usageCount: 0 }]);
const upstreamBefore = upstreamHits;
const r3 = await post(port, '/v1/chat/completions', { model: 'oauthprov/gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
assert.notStrictEqual(r3.status, 200, 'a revoked grant does not produce a 200');
assert.strictEqual(upstreamHits, upstreamBefore, 'a dead grant never reached the upstream (synthetic 401)');
const acct = store.get().providers[0].accounts[0];
assert.strictEqual(acct.authFailed, true, 'revoked grant marked the account authFailed (no auto-revive)');

// ── Teardown ──
await new Promise((r) => server.close(r));
await new Promise((r) => upstream.close(r));
await new Promise((r) => tokenSrv.close(r));
fs.rmSync(TMP_HOME, { recursive: true, force: true });

console.log('✔ oauth e2e self-check passed (mint+Bearer, client-key stripped, cache reuse, invalid_grant -> authFailed)');

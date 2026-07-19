// Self-check for OAuth2 access-token resolution: static-key passthrough, cache
// hits, expiry-buffer refetch, invalid_grant flagging, and RS256 JWT signing for
// the service-account grant. No network — fetch is injected. Run: node test/oauth.test.js
import assert from 'node:assert';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  resolveAccessToken, refreshAccessToken, buildServiceAccountJWT,
  normalizeAuthType, invalidateToken, _clearTokenCache,
} from '../src/oauth.js';

// A fake token endpoint: counts calls so we can prove caching, and returns a
// scripted body/status. Shaped like fetch's Response (ok/status/text()).
function makeFetch(script) {
  const state = { calls: 0 };
  const fn = async (url, opts) => {
    state.calls++;
    state.lastUrl = url;
    state.lastBody = opts?.body;
    const r = typeof script === 'function' ? script(state) : script;
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  fn.state = state;
  return fn;
}

// ── normalizeAuthType: unknown -> apikey (mirrors normalizeFormat) ──
assert.strictEqual(normalizeAuthType('oauth2'), 'oauth2');
assert.strictEqual(normalizeAuthType('apikey'), 'apikey');
assert.strictEqual(normalizeAuthType(undefined), 'apikey', 'missing -> apikey');
assert.strictEqual(normalizeAuthType('weird'), 'apikey', 'unknown -> apikey');

// ── Static-key path: no network, returns the stored key exactly like getApiKey ──
{
  _clearTokenCache();
  const provider = { credentials: [{ key: 'apiKey', secret: true, required: true }] };
  const account = { id: 'a1', credentials: { apiKey: 'sk-static-123' } };
  const f = makeFetch({ status: 200, body: {} });
  const tok = await resolveAccessToken(provider, account, f);
  assert.strictEqual(tok, 'sk-static-123', 'static key returned verbatim');
  assert.strictEqual(f.state.calls, 0, 'static path must NOT hit the token endpoint');
}

// ── refresh_token grant: mints a token and sends the right form fields ──
{
  _clearTokenCache();
  const provider = {
    authType: 'oauth2',
    oauth: { grantType: 'refresh_token', tokenUrl: 'https://oauth.example/token' },
    credentials: [{ key: 'refreshToken', secret: true }],
  };
  const account = { id: 'r1', credentials: { refreshToken: 'rt-abc', clientId: 'cid', clientSecret: 'csec' } };
  const f = makeFetch({ status: 200, body: { access_token: 'at-1', expires_in: 3600 } });
  const tok = await resolveAccessToken(provider, account, f, 1_000_000);
  assert.strictEqual(tok, 'at-1');
  assert.strictEqual(f.state.calls, 1);
  assert.match(f.state.lastBody, /grant_type=refresh_token/, 'grant_type set');
  assert.match(f.state.lastBody, /refresh_token=rt-abc/, 'refresh token sent');
  assert.match(f.state.lastBody, /client_id=cid/, 'client id sent');
}

// ── Cache: a second call within the token lifetime does NOT refetch ──
{
  _clearTokenCache();
  const provider = { authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl: 'u' }, credentials: [] };
  const account = { id: 'c1', credentials: { refreshToken: 'rt' } };
  const f = makeFetch({ status: 200, body: { access_token: 'at-cached', expires_in: 3600 } });
  const t0 = 1_000_000;
  const a = await resolveAccessToken(provider, account, f, t0);
  const b = await resolveAccessToken(provider, account, f, t0 + 5_000); // 5s later, well within lifetime
  assert.strictEqual(a, b, 'same token returned');
  assert.strictEqual(f.state.calls, 1, 'cache hit: no second fetch');
}

// ── Expiry buffer: a token inside the 60s buffer is treated as stale -> refetch ──
{
  _clearTokenCache();
  const provider = { authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl: 'u' }, credentials: [] };
  const account = { id: 'e1', credentials: { refreshToken: 'rt' } };
  let n = 0;
  const f = makeFetch(() => ({ status: 200, body: { access_token: `at-${++n}`, expires_in: 3600 } }));
  const t0 = 1_000_000;
  const a = await resolveAccessToken(provider, account, f, t0);              // expiresAt = t0 + 3600s
  // Jump to 30s before expiry (inside the 60s buffer) -> must re-mint.
  const b = await resolveAccessToken(provider, account, f, t0 + 3600_000 - 30_000);
  assert.strictEqual(a, 'at-1');
  assert.strictEqual(b, 'at-2', 'token within expiry buffer is refreshed');
  assert.strictEqual(f.state.calls, 2);
}

// ── expires_in omitted -> falls back to default lifetime (still cacheable) ──
{
  _clearTokenCache();
  const provider = { authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl: 'u' }, credentials: [] };
  const account = { id: 'd1', credentials: { refreshToken: 'rt' } };
  const f = makeFetch({ status: 200, body: { access_token: 'at-nodefault' } }); // no expires_in
  const a = await resolveAccessToken(provider, account, f, 1_000_000);
  const b = await resolveAccessToken(provider, account, f, 1_000_000 + 60_000); // 1min later
  assert.strictEqual(a, b, 'default lifetime keeps it cached');
  assert.strictEqual(f.state.calls, 1);
}

// ── invalid_grant: revoked refresh token -> throws with invalidGrant flag ──
{
  _clearTokenCache();
  const provider = { authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl: 'u' }, credentials: [] };
  const account = { id: 'x1', credentials: { refreshToken: 'revoked' } };
  const f = makeFetch({ status: 400, body: { error: 'invalid_grant' } });
  await assert.rejects(
    () => resolveAccessToken(provider, account, f),
    (err) => { assert.strictEqual(err.invalidGrant, true, 'invalid_grant flagged for authFailed handling'); return true; },
  );
}

// ── 500 from token endpoint is transient, NOT invalid_grant ──
{
  _clearTokenCache();
  const provider = { authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl: 'u' }, credentials: [] };
  const account = { id: 'x2', credentials: { refreshToken: 'rt' } };
  const f = makeFetch({ status: 500, body: { error: 'internal' } });
  await assert.rejects(
    () => resolveAccessToken(provider, account, f),
    (err) => { assert.strictEqual(err.invalidGrant, false, '5xx is transient, not permanent'); return true; },
  );
}

// ── jwt-bearer grant: signs a valid RS256 assertion the endpoint can verify ──
{
  _clearTokenCache();
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const oauth = { grantType: 'jwt-bearer', tokenUrl: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform' };
  const creds = { clientEmail: 'svc@proj.iam.gserviceaccount.com', privateKey: pem };

  // Build + verify the JWT directly (no network): header.claim.signature, RS256.
  const now = 1_700_000_000_000;
  const jwt = buildServiceAccountJWT(creds, oauth, now);
  const [h64, c64, sig] = jwt.split('.');
  assert.ok(h64 && c64 && sig, 'three-segment JWT');

  const header = JSON.parse(Buffer.from(h64, 'base64url'));
  const claim = JSON.parse(Buffer.from(c64, 'base64url'));
  assert.strictEqual(header.alg, 'RS256');
  assert.strictEqual(claim.iss, creds.clientEmail, 'iss = service account email');
  assert.strictEqual(claim.aud, oauth.tokenUrl, 'aud = token endpoint');
  assert.strictEqual(claim.scope, oauth.scope, 'scope carried');
  assert.strictEqual(claim.iat, Math.floor(now / 1000));

  // Signature must verify against the public key over "header.claim".
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h64}.${c64}`);
  const sigStd = sig.replace(/-/g, '+').replace(/_/g, '/');
  assert.strictEqual(verifier.verify(publicKey, sigStd, 'base64'), true, 'RS256 signature verifies');

  // And the full refresh path sends the assertion with the jwt-bearer grant type.
  const f = makeFetch({ status: 200, body: { access_token: 'at-sa', expires_in: 3600 } });
  const provider = { authType: 'oauth2', oauth, credentials: [] };
  const tok = await resolveAccessToken(provider, { id: 'sa1', credentials: creds }, f, now);
  assert.strictEqual(tok, 'at-sa');
  assert.match(decodeURIComponent(f.state.lastBody), /grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer/, 'jwt-bearer grant type');
  assert.match(f.state.lastBody, /assertion=/, 'assertion sent');
}

// ── Concurrent cache misses coalesce: N parallel calls mint ONE token ──
// A slow token endpoint (resolves on a deferred promise) guarantees all three
// calls overlap on the same miss. Without dedup each would fire its own fetch.
{
  _clearTokenCache();
  const provider = { authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl: 'u' }, credentials: [] };
  const account = { id: 'race1', credentials: { refreshToken: 'rt' } };
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const f = async (url, opts) => {
    f.state.calls++;
    await gate; // hold every in-flight fetch until we let them go
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: `at-${++n}`, expires_in: 3600 }) };
  };
  f.state = { calls: 0 };
  const p = [
    resolveAccessToken(provider, account, f, 1_000_000),
    resolveAccessToken(provider, account, f, 1_000_000),
    resolveAccessToken(provider, account, f, 1_000_000),
  ];
  release();
  const toks = await Promise.all(p);
  assert.strictEqual(f.state.calls, 1, 'concurrent misses mint exactly one token');
  assert.deepStrictEqual(toks, ['at-1', 'at-1', 'at-1'], 'all callers get the same token');
}

// ── invalidateToken: forces a re-mint on the next call ──
{
  _clearTokenCache();
  const provider = { authType: 'oauth2', oauth: { grantType: 'refresh_token', tokenUrl: 'u' }, credentials: [] };
  const account = { id: 'inv1', credentials: { refreshToken: 'rt' } };
  let n = 0;
  const f = makeFetch(() => ({ status: 200, body: { access_token: `at-${++n}`, expires_in: 3600 } }));
  const a = await resolveAccessToken(provider, account, f, 1_000_000);
  invalidateToken('inv1');
  const b = await resolveAccessToken(provider, account, f, 1_000_000 + 1000);
  assert.strictEqual(a, 'at-1');
  assert.strictEqual(b, 'at-2', 'invalidated token is re-minted');
  assert.strictEqual(f.state.calls, 2);
}

console.log('✔ oauth self-check passed (static passthrough, cache, expiry buffer, invalid_grant, jwt-bearer RS256)');

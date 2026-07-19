// Self-check for the browser Authorization-Code + PKCE flow. No real browser: the
// injected openFn plays the role of the browser by GETting the loopback /callback
// with a code (or a bad state). The token exchange is a mock fetch. Run:
//   node test/oauth-flow.test.js
import assert from 'node:assert';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { makePkcePair, runBrowserAuthFlow } from '../src/oauth-flow.js';

// ── makePkcePair: challenge = base64url(sha256(verifier)), URL-safe, unpadded ──
{
  const { verifier, challenge } = makePkcePair();
  assert.ok(verifier.length >= 43, 'verifier meets RFC 7636 min length');
  assert.ok(!/[+/=]/.test(verifier) && !/[+/=]/.test(challenge), 'both are base64url (no +/=)');
  const expected = createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(challenge, expected, 'challenge is S256 of the verifier');
  const a = makePkcePair(), b = makePkcePair();
  assert.notStrictEqual(a.verifier, b.verifier, 'verifiers are random per call');
}

// A mock token endpoint that returns a refresh_token on authorization_code.
function makeTokenServerFetch(script) {
  const state = { calls: 0 };
  const fn = async (url, opts) => {
    state.calls++;
    state.lastForm = new URLSearchParams(opts.body);
    const r = typeof script === 'function' ? script(state) : script;
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  fn.state = state;
  return fn;
}

// openFn stand-in for the browser: parse the auth URL, then GET the loopback
// redirect_uri with the given query (code/state). Returns once the callback page
// responds, mimicking a real browser round-trip.
function browserThatCallsBack({ code, stateOverride, error }) {
  return (fullAuthUrl) => {
    const au = new URL(fullAuthUrl);
    const redirectUri = au.searchParams.get('redirect_uri');
    const realState = au.searchParams.get('state');
    const cb = new URL(redirectUri);
    if (error) cb.searchParams.set('error', error);
    else {
      if (code) cb.searchParams.set('code', code);
      cb.searchParams.set('state', stateOverride ?? realState);
    }
    // Fire-and-forget GET; the flow's callback handler resolves off this.
    http.get(cb.toString(), (res) => { res.resume(); }).on('error', () => {});
  };
}

const base = {
  authUrl: 'https://accounts.example/auth',
  tokenUrl: 'https://oauth.example/token',
  clientId: 'client-abc',
  scope: 'openid offline_access',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  timeoutMs: 5000,
};

// ── Happy path: browser returns code -> flow exchanges it -> refresh_token back ──
{
  const fetchImpl = makeTokenServerFetch({ status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } });
  const result = await runBrowserAuthFlow({
    ...base, fetchImpl,
    openFn: browserThatCallsBack({ code: 'auth-code-xyz' }),
  });
  assert.strictEqual(result.refreshToken, 'rt-1', 'refresh token captured');
  assert.strictEqual(result.accessToken, 'at-1');
  assert.strictEqual(result.expiresIn, 3600);
  // The exchange must send the PKCE verifier + authorization_code grant.
  assert.strictEqual(fetchImpl.state.lastForm.get('grant_type'), 'authorization_code');
  assert.strictEqual(fetchImpl.state.lastForm.get('code'), 'auth-code-xyz');
  assert.ok(fetchImpl.state.lastForm.get('code_verifier'), 'code_verifier sent for PKCE');
  assert.strictEqual(fetchImpl.state.lastForm.get('client_id'), 'client-abc');
}

// ── CSRF: a callback with the wrong state is rejected, no token exchange ──
{
  const fetchImpl = makeTokenServerFetch({ status: 200, body: { access_token: 'x', refresh_token: 'y' } });
  await assert.rejects(
    () => runBrowserAuthFlow({ ...base, fetchImpl, openFn: browserThatCallsBack({ code: 'c', stateOverride: 'tampered' }) }),
    /state mismatch/i,
    'wrong state aborts the flow',
  );
  assert.strictEqual(fetchImpl.state.calls, 0, 'no token exchange after a state mismatch');
}

// ── Provider denies consent: ?error=access_denied -> reject ──
{
  const fetchImpl = makeTokenServerFetch({ status: 200, body: {} });
  await assert.rejects(
    () => runBrowserAuthFlow({ ...base, fetchImpl, openFn: browserThatCallsBack({ error: 'access_denied' }) }),
    /access_denied/,
    'denied consent rejects',
  );
}

// ── No refresh_token returned -> actionable error (offline access missing) ──
{
  const fetchImpl = makeTokenServerFetch({ status: 200, body: { access_token: 'at-only' } }); // no refresh_token
  await assert.rejects(
    () => runBrowserAuthFlow({ ...base, fetchImpl, openFn: browserThatCallsBack({ code: 'c' }) }),
    /no refresh_token/i,
    'missing refresh token is a clear error',
  );
}

console.log('✔ oauth-flow self-check passed (PKCE pair, code exchange, CSRF state guard, denial, no-refresh-token)');

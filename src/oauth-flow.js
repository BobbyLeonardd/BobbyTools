// Interactive browser OAuth (Authorization Code + PKCE) — the one-time consent
// flow that turns "I have a Google/OAuth login" into a stored refresh_token, which
// oauth.js then silently exchanges for access tokens forever after.
//
// Why PKCE + loopback (no client secret in the URL, no hosted callback): this is a
// CLI on the user's machine — a "public client". PKCE (RFC 7636) lets it prove it
// started the flow without embedding a secret. The redirect lands on a throwaway
// http://127.0.0.1:<port> server we spin up just for this exchange; the browser is
// the only thing that ever talks to it. Zero dependencies: crypto + http + a
// platform-specific "open the browser" shell command.

import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

// base64url of raw bytes, no padding — PKCE + state want URL-safe tokens.
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE pair: a high-entropy verifier we keep, and its SHA-256 challenge we send.
// The token endpoint later recomputes the hash of the verifier and compares — so
// only the process that generated the verifier can redeem the code.
export function makePkcePair() {
  const verifier = b64url(randomBytes(32)); // 43 chars, within RFC 7636's 43..128
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// Best-effort "open this URL in the user's browser". If it fails (headless box,
// no GUI), the caller still prints the URL so the user can paste it manually.
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  // On Windows, `start` is a cmd builtin; the empty "" is the window-title arg so a
  // URL with spaces/quotes doesn't get eaten. URL is passed as an arg (not shell-
  // interpolated) to avoid injection.
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // swallow — caller prints the URL as fallback
    child.unref();
  } catch { /* ignore — manual paste fallback */ }
}

/**
 * Run the full browser authorization-code + PKCE flow and return the tokens.
 *
 * @param {object} opts
 *   authUrl     - provider's authorization endpoint (e.g. accounts.google.com/o/oauth2/v2/auth)
 *   tokenUrl    - provider's token endpoint (for the code->token exchange)
 *   clientId    - OAuth client id (public client)
 *   clientSecret- optional; some "installed app" clients still require it at exchange
 *   scope       - space-delimited scopes; must include offline access to get a refresh_token
 *   extraAuthParams - provider-specific query params (Google needs access_type=offline & prompt=consent)
 *   openFn/fetchImpl/timeoutMs - injectable seams for tests
 *
 * @returns {Promise<{refreshToken, accessToken, expiresIn, raw}>}
 */
export async function runBrowserAuthFlow(opts) {
  const {
    authUrl, tokenUrl, clientId, clientSecret, scope = '',
    extraAuthParams = {}, openFn = openBrowser, fetchImpl = fetch,
    timeoutMs = 300_000, onPrompt,
  } = opts;

  const { verifier, challenge } = makePkcePair();
  const state = b64url(randomBytes(16)); // CSRF guard: must echo back unchanged

  // Bind the loopback callback server on an ephemeral port BEFORE building the
  // redirect_uri (we need the actual port). 127.0.0.1 only — never 0.0.0.0.
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extraAuthParams,
  });
  const fullAuthUrl = `${authUrl}?${authParams.toString()}`;

  // Wait for the browser to hit /callback with ?code&state (or ?error).
  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`OAuth flow timed out after ${Math.round(timeoutMs / 1000)}s (no browser callback)`));
    }, timeoutMs);

    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');

      // Always answer the browser so the user sees a clean "done" page, then
      // resolve/reject the flow.
      const finish = (ok, msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><meta charset=utf-8><title>BobbyTools</title>
          <body style="font-family:system-ui;background:#0b0b0b;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
          <div style="text-align:center"><h1 style="color:${ok ? '#4ade80' : '#f87171'}">${ok ? '✓ Authorized' : '✗ Failed'}</h1>
          <p>${msg}</p><p style="opacity:.6">You can close this tab and return to the terminal.</p></div>`);
        clearTimeout(timer);
      };

      if (err) { finish(false, `Provider returned: ${err}`); return reject(new Error(`OAuth denied: ${err}`)); }
      // CSRF: reject a callback whose state we didn't issue.
      if (gotState !== state) { finish(false, 'State mismatch (possible CSRF).'); return reject(new Error('OAuth state mismatch, aborting for safety')); }
      if (!code) { finish(false, 'No authorization code in callback.'); return reject(new Error('OAuth callback missing code')); }
      finish(true, 'Token stored. BobbyTools will refresh it automatically.');
      resolve(code);
    });
  });

  if (onPrompt) onPrompt(fullAuthUrl);
  openFn(fullAuthUrl);

  let code;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  // Exchange the code (+ verifier) for tokens. PKCE means the verifier — not a
  // client secret — is what authenticates the exchange, though we include the
  // secret too when the provider's client type requires it.
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (clientSecret) form.set('client_secret', clientSecret);

  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}

  if (!res.ok || !data.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${data.error || text.slice(0, 200)}`);
  }
  if (!data.refresh_token) {
    // No refresh token = the provider won't let us refresh silently later. Almost
    // always means the offline-access params were missing, or consent was already
    // granted (Google only returns it on first consent unless prompt=consent).
    throw new Error('Provider returned no refresh_token. Ensure offline access (e.g. access_type=offline & prompt=consent) and revoke prior consent, then retry.');
  }

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || null,
    raw: data,
  };
}

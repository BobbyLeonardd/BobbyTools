// OAuth2 access-token resolution for providers that authenticate with a login
// account instead of a static API key.
//
// Why this exists: some providers (Google Vertex AI, user-OAuth apps) don't hand
// out a long-lived API key. They give you a *refresh token* (from a browser
// consent flow) or a *service-account private key*, and you must exchange that
// for a short-lived access token (~1h) — refreshing before it expires. A static
// key never changes, so getApiKey() just reads it; an OAuth token must be minted
// and re-minted, which is what this module does.
//
// Design mirrors the existing free-form credential model: a provider declares
// authType='oauth2' + an `oauth` block (grant type + token URL); the account
// stores the same {key: value} credentials the CLI prompted for (refreshToken, or
// clientEmail + privateKey). Access tokens are cached IN MEMORY only, keyed by
// account.id — they're short-lived secrets, not worth writing to config.json
// (churns the file, widens the leak surface). A restart just re-mints them.
//
// Pure-ish: the only I/O is the token fetch, which is injected (fetchImpl) so the
// whole thing is testable without network. No dependencies — JWT signing (RS256)
// for the service-account grant uses Node's built-in crypto.

import { createSign } from 'node:crypto';
import { getApiKey } from './helpers.js';

// Refresh this many ms BEFORE the token actually expires, so an in-flight request
// never races the expiry. A token with <buffer left is treated as already stale.
const EXPIRY_BUFFER_MS = 60_000;
// Fallback lifetime when the token endpoint omits expires_in (rare, but spec-legal).
const DEFAULT_EXPIRES_IN_S = 3600;

// account.id -> { accessToken, expiresAt(ms) }. Module-scoped: one router process,
// one cache. Not persisted — see file header.
const tokenCache = new Map();

// Normalize an arbitrary authType to a known key (default: apikey), mirroring
// normalizeFormat() in translate.js — an unknown value behaves like the old
// static-key path rather than throwing.
export function normalizeAuthType(t) {
  return t === 'oauth2' ? 'oauth2' : 'apikey';
}

// base64url without padding — the encoding JWT uses for every segment.
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build and RS256-sign a JWT assertion for the service-account (jwt-bearer) grant.
 * Google signs {iss, scope, aud, iat, exp} with the account's private key; the
 * token endpoint verifies it against the service account's public key and returns
 * an access token. Pure + synchronous — no network, just crypto.
 */
export function buildServiceAccountJWT(creds, oauth, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600; // assertion lifetime; the ACCESS token's lifetime is separate
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: creds.clientEmail,
    scope: oauth.scope || creds.scope || '',
    aud: oauth.tokenUrl,
    iat,
    exp,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  // Private keys pasted through a CLI/JSON often carry literal "\n" instead of real
  // newlines; PEM parsing needs the real thing.
  const pem = String(creds.privateKey || '').replace(/\\n/g, '\n');
  const signature = createSign('RSA-SHA256').update(signingInput).sign(pem, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

/**
 * Exchange a grant for a fresh access token. Supports the two grants a provider
 * declares via oauth.grantType:
 *   - 'refresh_token' : the common user-OAuth path (client_id/secret + refresh_token)
 *   - 'jwt-bearer'    : Google service accounts (sign a JWT, no client secret)
 *
 * Returns { accessToken, expiresAt(ms) }. Throws on failure; a revoked/invalid
 * grant is flagged err.invalidGrant=true so the caller can disable the account
 * permanently (same treatment as a 401 on a static key) instead of retrying.
 */
export async function refreshAccessToken(provider, account, fetchImpl = fetch, now = Date.now()) {
  const oauth = provider.oauth || {};
  const creds = account.credentials || {};
  const grant = oauth.grantType === 'jwt-bearer' ? 'jwt-bearer' : 'refresh_token';

  const form = new URLSearchParams();
  if (grant === 'jwt-bearer') {
    form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    form.set('assertion', buildServiceAccountJWT(creds, oauth, now));
  } else {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', creds.refreshToken || '');
    if (creds.clientId) form.set('client_id', creds.clientId);
    if (creds.clientSecret) form.set('client_secret', creds.clientSecret);
  }

  const res = await fetchImpl(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}

  if (!res.ok || !data.access_token) {
    const err = new Error(`OAuth token refresh failed (${res.status}): ${data.error || text.slice(0, 200)}`);
    // invalid_grant = the refresh token/assertion is revoked or expired — permanent,
    // no amount of retrying fixes it. The caller disables the account (authFailed).
    err.invalidGrant = res.status === 400 || res.status === 401 || data.error === 'invalid_grant';
    throw err;
  }

  const lifetimeS = Number(data.expires_in) > 0 ? Number(data.expires_in) : DEFAULT_EXPIRES_IN_S;
  return { accessToken: data.access_token, expiresAt: now + lifetimeS * 1000 };
}

/**
 * The one function the router/CLI calls to get a usable bearer credential for an
 * account, regardless of how it authenticates.
 *
 * - authType !== 'oauth2' → the static-key path, unchanged: returns getApiKey()
 *   synchronously-in-spirit (still async for one call site, but does NO network).
 * - authType === 'oauth2' → return a cached access token if it has more than the
 *   expiry buffer left, otherwise mint a fresh one and cache it.
 *
 * fetchImpl/now are injected for tests. Returns the token string (or null when a
 * static key is simply absent — same as getApiKey today).
 */
export async function resolveAccessToken(provider, account, fetchImpl = fetch, now = Date.now()) {
  if (normalizeAuthType(provider?.authType) !== 'oauth2') {
    return getApiKey(provider, account); // static key: no network, old behavior
  }
  const cached = tokenCache.get(account.id);
  if (cached && cached.expiresAt - now > EXPIRY_BUFFER_MS) return cached.accessToken;

  const fresh = await refreshAccessToken(provider, account, fetchImpl, now);
  tokenCache.set(account.id, fresh);
  return fresh.accessToken;
}

// Drop a cached token (e.g. after the upstream rejects it mid-flight, so the next
// call re-mints instead of resending a token the provider already refused).
export function invalidateToken(accountId) {
  tokenCache.delete(accountId);
}

// Test seam: clear the whole cache between test cases.
export function _clearTokenCache() {
  tokenCache.clear();
}

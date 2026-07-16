// Shared helper functions used across modules.

/**
 * Replace {key} placeholders in baseUrlTemplate with account credential values.
 */
export function resolveBaseUrl(provider, account) {
  let url = provider.baseUrlTemplate;
  if (account?.credentials) {
    for (const [key, value] of Object.entries(account.credentials)) {
      url = url.replaceAll(`{${key}}`, value || '');
    }
  }
  return url;
}

/**
 * Extract the API key (first secret credential) from an account.
 */
export function getApiKey(provider, account) {
  const field =
    provider.credentials.find((c) => c.secret && c.required !== false) ||
    provider.credentials.find((c) => c.secret);
  return field ? account.credentials[field.key] || null : null;
}

/**
 * Build the full env var map for launching a CLI tool.
 */
export function buildEnvVars(provider, account, model) {
  const env = {};

  // Resolved base URL
  env[provider.baseUrlEnvVar || 'OPENAI_BASE_URL'] = resolveBaseUrl(provider, account);

  // Each credential's env var
  for (const cred of provider.credentials) {
    if (cred.envVar && account.credentials[cred.key]) {
      env[cred.envVar] = account.credentials[cred.key];
    }
  }

  // Model
  if (model) {
    env.OPENAI_MODEL = model;
    env.MODEL = model;
  }

  return env;
}

/**
 * Mask a value for display. Secrets show first 6 + last 4 chars.
 */
export function maskValue(value, isSecret) {
  if (!value) return '(empty)';
  if (!isSecret) return value;
  if (value.length <= 8) return '*'.repeat(value.length);
  return value.slice(0, 6) + '...' + value.slice(-4);
}

/**
 * Auto-revive accounts that were limited by the router once their cooldown expires.
 * Only revives accounts limited BY the router (they carry `limitedAt`); accounts
 * toggled to "limited" manually have no `limitedAt` and stay limited until the user
 * flips them back. Mutates config in place; returns true if anything changed.
 *
 * ponytail: fixed cooldown window — doesn't distinguish per-minute vs per-day (RPM/RPD)
 * limits, so a daily-limited key gets retried early and just re-limits itself.
 * Upgrade path: honor the upstream `Retry-After` header (store it as the revive time).
 */
export const LIMIT_COOLDOWN_MS = 60_000;

export function reviveLimitedAccounts(config, cooldownMs = LIMIT_COOLDOWN_MS, now = Date.now()) {
  let changed = false;
  for (const provider of config.providers || []) {
    for (const account of provider.accounts || []) {
      if (account.status === 'limited' && account.limitedAt && now - account.limitedAt >= cooldownMs) {
        account.status = 'active';
        delete account.limitedAt;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * True if a base URL points back at this machine (a local router), so the
 * /v1/models aggregator can skip it and avoid an inception/fractal loop.
 * Covers the common loopback spellings; a LAN IP like 192.168.x pointing at
 * your own box can't be detected without probing network interfaces.
 *
 * ponytail: substring match, not a real host parse — a remote provider whose
 * path happened to contain "localhost" would be skipped too. Fine here since
 * these tokens don't appear in real cloud hostnames. Upgrade path: new URL(u).hostname.
 */
export function isLocalUrl(url) {
  const u = (url || '').toLowerCase();
  return (
    u.includes('127.0.0.1') ||
    u.includes('localhost') ||
    u.includes('0.0.0.0') ||
    u.includes('[::1]') ||
    u.includes('::1')
  );
}

/**
 * Compare two semver-ish version strings ("3.9.0" vs "3.10.0").
 * Returns 1 if a > b, -1 if a < b, 0 if equal. Compares numerically per
 * segment (so 3.10 > 3.9, which a plain string compare gets wrong). Missing
 * segments count as 0; non-numeric junk in a segment counts as 0.
 */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i], 10) || 0;
    const nb = parseInt(pb[i], 10) || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Slug used as the routable prefix for a provider (e.g. "My Router" -> "my-router").
 * Must match the resolver in server.js so emitted model ids stay routable.
 */
export function slugify(name) {
  return (name || '').toLowerCase().trim().replace(/\s+/g, '-');
}

/**
 * True if another provider already owns this name's slug. Pass excludeId to skip
 * the provider being renamed (so renaming to the same name isn't a "collision").
 */
export function slugTaken(config, name, excludeId = null) {
  const slug = slugify(name);
  return (config.providers || []).some(
    (p) => p.id !== excludeId && slugify(p.name) === slug,
  );
}

/**
 * Human-readable relative time.
 */
export function timeAgo(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

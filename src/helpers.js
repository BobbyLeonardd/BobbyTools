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
 * Human-readable relative time.
 */
export function timeAgo(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

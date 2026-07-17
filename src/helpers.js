// Shared helper functions used across modules.

/**
 * fetch() with a CONNECT timeout only — not a total timeout.
 *
 * The timer aborts the request if headers don't arrive within `connectMs`, so a
 * dead/hung provider can't stall forever. But it's cleared the moment fetch
 * resolves (headers received), so a long streaming body is never cut off — an
 * LLM can stream for minutes and we won't touch it.
 *
 * The caller owns `controller`, so the same signal also lets them abort mid-
 * stream (e.g. when the client disconnects). `fetchImpl` is injectable for tests.
 *
 * ponytail: connect-only bound. A provider that sends headers then stalls
 * mid-stream isn't caught here (upgrade path: an idle-between-chunks timer).
 */
export async function fetchWithConnectTimeout(url, opts, controller, connectMs, fetchImpl = fetch) {
  const timer = setTimeout(() => controller.abort(), connectMs);
  try {
    return await fetchImpl(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
 * Only revives accounts limited BY the router that carry `limitedAt` (a transient
 * 429/402). Accounts limited manually, OR disabled by a permanent auth failure
 * (401/403 → `authFailed`, no `limitedAt`), have no `limitedAt` and stay limited
 * until the user flips them back. Mutates config in place; returns true if changed.
 *
 * Honors a per-account `retryAfterMs` (set from the upstream `Retry-After` header)
 * as the revive delay, falling back to the fixed `cooldownMs` when absent — so a
 * provider that says "wait 5 minutes" is respected instead of retried at 60s.
 */
export const LIMIT_COOLDOWN_MS = 60_000;

export function reviveLimitedAccounts(config, cooldownMs = LIMIT_COOLDOWN_MS, now = Date.now()) {
  let changed = false;
  for (const provider of config.providers || []) {
    for (const account of provider.accounts || []) {
      const delay = account.retryAfterMs ?? cooldownMs;
      if (account.status === 'limited' && account.limitedAt && now - account.limitedAt >= delay) {
        account.status = 'active';
        delete account.limitedAt;
        delete account.retryAfterMs;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Parse an HTTP `Retry-After` header into a delay in ms (or null if absent/bad).
 * Two legal forms per RFC 7231: delta-seconds ("120") or an HTTP-date. Negative
 * or past values clamp to 0 (retry now). Returns null when the header is missing
 * or unparseable, so the caller falls back to the fixed cooldown.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10) * 1000);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - now);
  return null;
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

/**
 * Normalize a freshly-fetched model list for a provider, auto-building aliases.
 *
 * The problem: some providers advertise ids already prefixed with their own name
 * (genfity's /v1/models returns "genfity/glm-5.2"). Stored as-is in
 * provider.models, routing would need "genfity/genfity/glm-5.2" (the router
 * splits the FIRST segment off as the provider). So we strip a leading
 * "<own-slug>/" to get the friendly, routable name ("glm-5.2") — and record an
 * alias friendly→advertised so the UPSTREAM still receives the exact id it
 * published (some providers reject the bare name; sending back their own string
 * can never misroute). Deterministic, no guessing.
 *
 * Returns { models: friendlyNames[], aliases: { friendly: advertised } }. A model
 * that wasn't self-prefixed passes through unchanged with no alias — so a provider
 * whose ids are already clean behaves exactly as before.
 */
export function normalizeFetchedModels(provider, rawIds = []) {
  const slug = slugify(provider?.name);
  const prefix = slug ? slug + '/' : null;
  const models = [];
  const aliases = {};
  for (const raw of rawIds) {
    if (typeof raw !== 'string' || !raw) continue;
    let friendly = raw;
    if (prefix && raw.toLowerCase().startsWith(prefix)) {
      const stripped = raw.slice(prefix.length);
      if (stripped) { friendly = stripped; aliases[friendly] = raw; } // alias back to the advertised id
    }
    models.push(friendly);
  }
  return { models: [...new Set(models)], aliases };
}

/**
 * Resolve the upstream model id a provider should actually be sent, given the
 * name the client asked for. A provider MAY carry a `modelAliases` map,
 * { friendlyName: upstreamModelId }, so one friendly name (e.g. "glm-5.2") can
 * map to whatever each provider actually calls that model ("glm-5.2",
 * "genfity/glm-5.2", "GLM-5.2-Chat"). Falls back to the name as-is when there's
 * no alias — so a provider with no map behaves exactly as before.
 */
export function resolveModelId(provider, requested) {
  const aliases = provider?.modelAliases;
  if (aliases) {
    if (requested in aliases) return aliases[requested];           // exact alias wins
    // Case-insensitive alias: "GLM-5.2" asked, "glm-5.2" mapped. Deterministic —
    // exact is tried first, so this only fires when no exact key matched.
    const lc = requested?.toLowerCase();
    for (const k in aliases) if (k.toLowerCase() === lc) return aliases[k];
  }
  return requested;
}

/**
 * True if a provider can serve `requested` — either it lists the id (exact, or
 * differing only in case), or it has an alias for that friendly name. This is what
 * makes cross-provider fallback actually fire: the old code did
 * `provider.models.includes(actualModel)`, an exact-string match that almost never
 * held because each provider spells the same model differently. Matching a shared
 * friendly name case-insensitively lets "glm-5.2" fall back to a provider that
 * lists "GLM-5.2". Still no fuzzy guessing — only exact-modulo-case.
 */
export function providerServesModel(provider, requested) {
  const lc = requested?.toLowerCase();
  if (provider?.modelAliases) {
    for (const k in provider.modelAliases) if (k.toLowerCase() === lc) return true;
  }
  return Array.isArray(provider?.models) && provider.models.some((m) => m?.toLowerCase() === lc);
}

/**
 * Find the next provider (other than excludeId) that has an active account AND
 * can serve `requested` (exact id or alias). Args read as "exclude this provider,
 * find one that serves this model". Centralizes the fallback predicate so both
 * fallback sites in server.js agree and neither drifts.
 */
export function findFallbackProvider(config, excludeId, requested) {
  return (config?.providers || []).find(
    (p) => p.id !== excludeId
      && p.accounts?.some((a) => a.status === 'active')
      && providerServesModel(p, requested),
  );
}

/**
 * Roll up config + router logs into the numbers the live dashboard shows, so the
 * client just renders and never re-derives. Pure: no Date.now(), no I/O — `now`
 * and `cooldownMs` are injected, which also makes it testable.
 *
 * Per account we compute recoversInMs: for a router-limited key (has limitedAt)
 * it's how long until reviveLimitedAccounts flips it back (0 = due now). A
 * manually-limited key (no limitedAt) never auto-revives, so it's null — the UI
 * shows "manual" not a countdown. Request tallies come from the in-memory log
 * ring; lastMinute is the live throughput signal ("is the router doing work?").
 */
export function computeStats(config, logs = [], cooldownMs = LIMIT_COOLDOWN_MS, now = Date.now()) {
  const totals = { providers: 0, accounts: 0, active: 0, limited: 0 };
  const providers = [];

  for (const p of config?.providers || []) {
    totals.providers++;
    let active = 0, limited = 0;
    const accounts = [];
    for (const a of p.accounts || []) {
      totals.accounts++;
      const isActive = a.status === 'active';
      if (isActive) { active++; totals.active++; } else { limited++; totals.limited++; }

      let recoversInMs = null; // null = active, manual-limited, or auth-failed (never auto-revives)
      if (!isActive && a.limitedAt) {
        recoversInMs = Math.max(0, a.limitedAt + (a.retryAfterMs ?? cooldownMs) - now);
      }
      accounts.push({
        id: a.id,
        name: a.name,
        status: a.status,
        usageCount: a.usageCount || 0,
        recoversInMs,
        authFailed: a.authFailed || false, // dead key (401/403) vs a transient/manual limit
      });
    }
    providers.push({ id: p.id, name: p.name, total: accounts.length, active, limited, accounts });
  }

  const requests = { total: logs.length, success: 0, limit: 0, error: 0, pending: 0, lastMinute: 0 };
  for (const l of logs) {
    if (l.status === 'success') requests.success++;
    else if (l.status === 'limit') requests.limit++;
    else if (l.status === 'error') requests.error++;
    else requests.pending++;
    const t = Date.parse(l.timestamp);
    if (!Number.isNaN(t) && now - t < 60_000) requests.lastMinute++;
  }

  return { totals, requests, providers };
}

/**
 * Roll up the persisted log ring into per-provider and per-model metrics for the
 * observability view: request counts by status, success rate, average latency,
 * and requests-in-the-last-minute (live throughput). Pure — `now` is injected.
 *
 * Latency is the connect latency recorded per entry (time to first byte from the
 * upstream); entries without it (older logs, or ones that errored before the
 * fetch resolved) are simply excluded from the average, never counted as 0.
 *
 * ponytail: O(n) single pass over the bounded ring (<=100 entries), recomputed on
 * each /api/metrics hit. Fine at this size; if the ring ever grows large, the
 * upgrade path is an incremental tally updated on each push instead of a rescan.
 */
export function rollupMetrics(logs = [], now = Date.now()) {
  const blank = () => ({ total: 0, success: 0, limit: 0, error: 0, pending: 0, lastMinute: 0, latSum: 0, latN: 0 });
  const overall = blank();
  const byProvider = new Map();
  const byModel = new Map();

  const bump = (m, l) => {
    m.total++;
    if (m[l.status] !== undefined) m[l.status]++; else m.pending++;
    const t = Date.parse(l.timestamp);
    if (!Number.isNaN(t) && now - t < 60_000) m.lastMinute++;
    if (typeof l.latencyMs === 'number' && l.latencyMs >= 0) { m.latSum += l.latencyMs; m.latN++; }
  };
  const get = (map, k) => { let m = map.get(k); if (!m) { m = blank(); map.set(k, m); } return m; };

  for (const l of logs) {
    bump(overall, l);
    bump(get(byProvider, l.provider || 'Unknown'), l);
    bump(get(byModel, l.model || 'Unknown'), l);
  }

  // Derive successRate (integer %) + avgLatencyMs, drop the running sums. Rate is
  // over TERMINAL requests (pending excluded from the denominator); 0 when nothing
  // has finished. avgLatencyMs is null when no entry recorded a latency (never 0,
  // so the UI can tell "fast" from "unmeasured").
  const finalize = (m, key, keyName) => {
    const done = m.success + m.limit + m.error;
    const out = {
      total: m.total, success: m.success, limit: m.limit, error: m.error, pending: m.pending,
      lastMinute: m.lastMinute,
      successRate: done ? Math.round((m.success / done) * 100) : 0,
      avgLatencyMs: m.latN ? Math.round(m.latSum / m.latN) : null,
    };
    if (key) out[key] = keyName;
    return out;
  };
  // Arrays (not maps) so the dashboard just .map()s a table; busiest first.
  const rows = (map, key) => [...map].map(([k, m]) => finalize(m, key, k)).sort((a, b) => b.total - a.total);

  return {
    ...finalize(overall),
    providers: rows(byProvider, 'provider'),
    models: rows(byModel, 'model'),
  };
}

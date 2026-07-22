// Shared helper functions used across modules.

import net from 'node:net';

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
 * The secret credential field a provider authenticates with (first required
 * secret, else first secret). Shared by getApiKey and anthropicUsesBearer so
 * both agree on "which credential is the key".
 */
function primarySecretCred(provider) {
  return (
    provider.credentials.find((c) => c.secret && c.required !== false) ||
    provider.credentials.find((c) => c.secret) ||
    null
  );
}

/**
 * Extract the API key (first secret credential) from an account.
 */
export function getApiKey(provider, account) {
  const field = primarySecretCred(provider);
  return field ? account.credentials[field.key] || null : null;
}

/**
 * Anthropic-format gateways split into two auth conventions for the SAME static
 * secret: native Anthropic wants `x-api-key`, while many third-party gateways
 * (agentrouter, etc.) want `Authorization: Bearer` and document the credential
 * as ANTHROPIC_AUTH_TOKEN. The config already encodes this — the credential's
 * envVar is exactly what the provider's own docs told the user to set — so we
 * read that instead of inventing a new field/toggle. Pure: provider in, bool out.
 *
 * ponytail: inference is by env-var name (ANTHROPIC_AUTH_TOKEN => Bearer). A
 * bearer gateway that names its credential something else won't be detected;
 * upgrade path is an explicit provider.authHeader field if one ever shows up.
 */
export function anthropicUsesBearer(provider) {
  const field = primarySecretCred(provider);
  return field?.envVar === 'ANTHROPIC_AUTH_TOKEN';
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

// Loopback hostnames the control plane trusts. A browser can only reach the
// router as one of these; anything else in the Host header means the request
// arrived via a rebound DNS name (a remote site whose domain was pointed at
// 127.0.0.1 to slip past the same-origin policy).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

// Pull just the hostname out of a Host header ("127.0.0.1:13337" -> "127.0.0.1")
// or an Origin/Referer URL ("http://localhost:13337/x" -> "localhost"). Returns
// '' when it can't be parsed, so a malformed value fails the loopback check.
function hostnameOf(value) {
  if (!value) return '';
  const s = String(value).trim();
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).hostname.toLowerCase(); } catch { return ''; }
  }
  // Bare authority ("host:port"). Strip the port; keep [::1] brackets intact.
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(s);
  return (m ? m[1] : s).toLowerCase();
}

/**
 * Guard for the control plane (`/` dashboard + `/api/*`), which can read the
 * whole config (API keys) and overwrite it. The router binds 127.0.0.1, but that
 * is NOT enough: your own browser is a local process, so any site you visit can
 * POST to http://127.0.0.1:13337/api/config (CSRF, wiping providers), and a
 * rebound DNS name can GET /api/config to read your keys. This closes both
 * without a login:
 *   - Host must be a loopback name (rejects DNS-rebinding reads).
 *   - Origin/Referer, when present, must also be loopback (rejects cross-site
 *     writes). Absent Origin is fine — same-origin GETs and non-browser callers
 *     (curl) omit it; the Host check still applies.
 * The proxy path (/v1/*) does NOT use this — it's hit by local CLIs that carry
 * no Origin and authenticate with their own bearer key. Pure: headers in, bool out.
 */
export function isTrustedControlRequest(headers = {}) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(headers.host))) return false;
  const cross = headers.origin || headers.referer;
  if (cross && !LOOPBACK_HOSTS.has(hostnameOf(cross))) return false;
  return true;
}

// Default loopback port the router binds when no `-p`/`--port` is passed.
// Single source of truth — every code path that hardcodes the port number
// (CLI menu's Stop/Logs/running-detect, the daemon, error hints) reads this.
export const DEFAULT_ROUTER_PORT = 13337;

/**
 * The port the running router is expected on. The user picks a port via
 * `bobby serve-bg -p N`; startDashboardDaemon() records it as `config.routerPort`
 * so the CLI menu (a SEPARATE process) can still reach it for Stop / View Logs /
 * "is it running?" — without that, the menu hardcoded 13337 and broke the moment
 * someone ran the daemon on a different port. Falls back to the default when no
 * port has been recorded yet.
 */
export function getRouterPort(config) {
  const n = config?.routerPort;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_ROUTER_PORT;
}

/**
 * True when something is already accepting TCP connections on the loopback port.
 * Used by the daemon spawner to bail loudly BEFORE spawning a child that would
 * silently die on EADDRINUSE — the child runs with stdio ignored, so without this
 * probe the parent would print "success" and open a browser to a dead router.
 *
 * connect → in use; error/timeout → free. Resolves true/false (never rejects).
 */
export function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (inUse) => { socket.destroy(); resolve(inUse); };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false)); // ECONNREFUSED = nothing there = free
  });
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
 * Pull a port from CLI args (`-p <n>` or `--port <n>`), falling back to `fallback`.
 *
 * Validated, not just parsed: a missing value, non-numeric, or out-of-range
 * (1–65535) input returns the fallback rather than a NaN/garbage port. Both
 * `serve` and `serve-bg` share this so the two commands can't drift apart —
 * previously `serve` did a bare `parseInt` (so `serve -p abc` bound a NaN port)
 * and `serve-bg` ignored the flag entirely.
 */
export function parsePortArg(args = [], fallback = DEFAULT_ROUTER_PORT) {
  const i = args.indexOf('-p') !== -1 ? args.indexOf('-p') : args.indexOf('--port');
  if (i === -1) return fallback;
  const n = parseInt(args[i + 1], 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
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
 * Pull per-model pricing out of a raw /models response, for the cost view. Only
 * OpenRouter (and a couple of compatible aggregators) actually publish price in
 * their model list: each entry carries `pricing: { prompt, completion }` in USD
 * PER TOKEN, as strings. We convert to USD per 1M tokens (the unit the dashboard
 * editor + rollup use) and key by the SAME id the router logs (the advertised id,
 * i.e. what m.id / m.name is), so the numbers line up with metrics rows.
 *
 * A free model publishes "0" → we skip it (0 cost is the default anyway; storing
 * it just clutters the editor). Anything without a numeric price is ignored — a
 * provider that doesn't expose pricing simply yields {} and the manual editor
 * stays the source of truth for it. Never throws on odd shapes.
 */
export function extractModelPricing(rawModels = []) {
  const pricing = {};
  const perM = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n * 1e6 : undefined; };
  for (const m of Array.isArray(rawModels) ? rawModels : []) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || m.name;
    if (!id || !m.pricing) continue;
    const inRate = perM(m.pricing.prompt ?? m.pricing.input);
    const outRate = perM(m.pricing.completion ?? m.pricing.output);
    const entry = {};
    if (inRate !== undefined) entry.in = inRate;
    if (outRate !== undefined) entry.out = outRate;
    if (Object.keys(entry).length) pricing[id] = entry;
  }
  return pricing;
}

/**
 * Build the upstream URL to POST a chat request to, given the provider's base URL
 * and the wire format it speaks. The endpoint suffix is format-fixed (OpenAI wants
 * /chat/completions, Anthropic /messages, Responses /responses, Gemini a
 * model-scoped verb) — but the API-VERSION segment (/v1, /v1beta) belongs to the
 * base URL, and providers spell it inconsistently.
 *
 * Why this exists (the glm-5.2 bug): gateways like api.hcnsec.cn / agentrouter.org
 * are added with a bare origin base URL ("https://api.hcnsec.cn") yet their
 * Anthropic endpoint lives at /v1/messages. The old code hardcoded "/messages",
 * so a bare base URL got POSTed to https://api.hcnsec.cn/messages — which returns
 * the site's HTML homepage with HTTP 200, and the client chokes parsing it. The
 * fix: ensure the version prefix is present exactly once. If the base URL already
 * ends in the needed version segment we don't add it again; otherwise we do.
 *
 * - openai / anthropic / responses : version is /v1, suffix /chat/completions |
 *   /messages | /responses.
 * - gemini : version is /v1beta and the verb carries the model; base URLs
 *   conventionally omit it, and a trailing /v1 or /v1beta is normalized off first.
 *
 * `wantsStream` only affects gemini (its verb differs when streaming). `model` is
 * needed for the gemini path. Pure — no I/O.
 */
export function buildTargetUrl(baseUrl, providerFmt, { model, wantsStream } = {}) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  if (providerFmt === 'gemini') {
    const root = base.replace(/\/v1(beta)?$/, '');
    const verb = wantsStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return `${root}/v1beta/models/${encodeURIComponent(model)}:${verb}`;
  }
  // openai gateways carry the version IN the base URL and it's spelled every which
  // way (/v1, /v3/openai, /openai/v1, /v1/solar) — so we trust the base and just
  // append the bare endpoint. anthropic/responses instead put the version in the
  // well-known path (/v1/messages, /v1/responses) and are added with a bare origin
  // base, so we prepend /v1 there — unless the user already tacked it on the base.
  if (providerFmt === 'openai') return base + '/chat/completions';
  const suffix = providerFmt === 'responses' ? '/responses' : '/messages';
  const versioned = /\/v1$/.test(base) ? base : `${base}/v1`;
  return versioned + suffix;
}

/**
 * Resolve a "combo" — a user-defined, ordered list of `provider/model` specs the
 * router tries in turn, dropping to the NEXT model only when the current one has
 * no live account left anywhere. Combos live in `config.combos` as
 * { comboName: ["groq/llama-3.3-70b", "openrouter/anthropic/claude-3-haiku"] }.
 *
 * Returns the spec array (only entries that look like provider/model) when `name`
 * matches a combo (exact, then case-insensitive — same rule as model aliases), or
 * null when it isn't a combo, so the caller treats a plain request as a
 * one-element list. Unlike the model-locked cross-provider fallback, a combo MAY
 * change the model between entries — that's the whole point, and it only happens
 * for names the user explicitly defined as combos.
 */
export function resolveComboSpecs(config, name) {
  const combos = config?.combos;
  if (!combos || !name) return null;
  const clean = (arr) => arr.filter((s) => typeof s === 'string' && s.includes('/'));
  if (Array.isArray(combos[name])) return clean(combos[name]);
  const lc = name.toLowerCase();
  for (const k in combos) {
    if (k.toLowerCase() === lc && Array.isArray(combos[k])) return clean(combos[k]);
  }
  return null;
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
  const blank = () => ({ total: 0, success: 0, limit: 0, error: 0, pending: 0, lastMinute: 0, latSum: 0, latN: 0, inTok: 0, outTok: 0, cacheTok: 0 });
  const overall = blank();
  const byProvider = new Map();
  const byModel = new Map();

  const bump = (m, l) => {
    m.total++;
    if (m[l.status] !== undefined) m[l.status]++; else m.pending++;
    // Token counts are only present on entries the sniffer could measure; a
    // missing field adds 0, so unmeasured requests never inflate the totals.
    if (typeof l.inputTokens === 'number') m.inTok += l.inputTokens;
    if (typeof l.outputTokens === 'number') m.outTok += l.outputTokens;
    if (typeof l.cachedTokens === 'number') m.cacheTok += l.cachedTokens;
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
      inputTokens: m.inTok, outputTokens: m.outTok, cachedTokens: m.cacheTok,
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

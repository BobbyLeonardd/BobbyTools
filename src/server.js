import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { store } from './store.js';
import { logStore } from './logstore.js';
import { resolveBaseUrl, reviveLimitedAccounts, slugify, isLocalUrl, fetchWithConnectTimeout, computeStats, parseRetryAfter, rollupMetrics, resolveModelId, findFallbackProvider, isTrustedControlRequest, resolveComboSpecs, normalizeFetchedModels, extractModelPricing, DEFAULT_ROUTER_PORT } from './helpers.js';
import {
  translateRequest, translateResponse, translateStream, normalizeFormat, sniffUsage,
} from './translate.js';
import { resolveAccessToken, normalizeAuthType, invalidateToken } from './oauth.js';
import { PROVIDER_TEMPLATES } from './templates.js';
import { VERSION } from './ui.js';
import chalk from 'chalk';

// Request logs live in logStore (a persistent, bounded ring hydrated from disk).
// How long to wait for a provider to START responding (send headers). Once the
// stream is flowing this timer is cleared, so long LLM answers are never cut off.
const CONNECT_TIMEOUT_MS = 30_000;

// How many trailing bytes of a response we retain to sniff token usage. Usage
// lives at the END (final SSE frame / usage key at the tail of a JSON body), so
// we keep the tail, not the head. Bounds memory on huge streams; usage past this
// window is simply not recovered (the request logs as unmeasured, never wrong).
const USAGE_TAIL_CAP = 256 * 1024;

// Forward a passthrough body chunk-by-chunk (unchanged bytes, still lazy) while
// keeping a rolling tail for usage sniffing. Yields every chunk so callers use it
// exactly like the raw body — in a for-await to res.write, or as the source of
// translateStream. Calls sink(tailText) once the body ends.
// ponytail: a multibyte UTF-8 char can be split at the tail cutoff; the first
// partial line then fails to parse and is skipped — fine, usage is a whole frame.
export async function* tapTail(body, sink) {
  let tail = Buffer.alloc(0);
  // sink runs in finally, not after the loop: a cross-format translate whose
  // provider is OpenAI ends on a `data: [DONE]` frame, and the downstream
  // reframer breaks on it — that closes this generator early (.return()), so
  // code placed after the for-await would be skipped and usage never sniffed.
  // finally fires on both natural end and early close, and the usage frame
  // always precedes [DONE] in the byte stream, so the tail already holds it.
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      tail = tail.length ? Buffer.concat([tail, buf]) : buf;
      if (tail.length > USAGE_TAIL_CAP) tail = tail.subarray(tail.length - USAGE_TAIL_CAP);
      yield chunk;
    }
  } finally {
    sink(tail.toString('utf-8'));
  }
}

// Stamp sniffed token counts onto a log entry (in place) and persist. No-op when
// the body reported no usage, so entries without it read as unmeasured, not zero.
function recordUsage(logEntry, usage) {
  if (!logEntry || !usage) return;
  if (usage.inputTokens !== undefined) logEntry.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) logEntry.outputTokens = usage.outputTokens;
  if (usage.cachedTokens !== undefined) logEntry.cachedTokens = usage.cachedTokens;
  logStore.touch();
}

export async function startRouterServer(port = DEFAULT_ROUTER_PORT, background = false) {
  // Best-effort flush on process teardown (Ctrl+C, SIGTERM) so the last stat
  // bumps aren't lost. 'exit' can only run sync work — store.flush() is sync.
  // SIGINT/SIGTERM don't fire 'exit' on their own, so bounce them through exit().
  process.on('exit', () => { try { store.flush(); } catch {} try { logStore.flush(); } catch {} });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const server = http.createServer(async (req, res) => {

    // Control plane (dashboard + /api/*) reads/writes the config, which holds
    // API keys. Gate it to loopback Host + same-origin so a site you visit can't
    // CSRF-wipe your providers or read your keys via DNS-rebinding. The proxy
    // path (/v1/*, /models) is exempt — it's hit by local CLIs with no Origin.
    const isControlPlane = req.url === '/' || req.url.startsWith('/api/');
    if (isControlPlane && !isTrustedControlRequest(req.headers)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: control plane is loopback-only (cross-origin/rebinding blocked)' }));
      return;
    }

    // --- 0. WEB DASHBOARD ENDPOINTS ---
    if (req.method === 'GET' && req.url === '/') {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      try {
        const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch (err) {
        res.writeHead(500);
        res.end('Dashboard file not found');
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: VERSION }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      store.reloadIfChanged();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(store.get()));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/templates') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const tpls = PROVIDER_TEMPLATES.map(t => ({ id: t.name.toLowerCase().replace(/[^a-z0-9]/g, '-'), ...t }));
      res.end(JSON.stringify(tpls));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logStore.all()));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/stats') {
      // Live status: aggregate config + recent logs into one snapshot. Reload
      // first so a CLI edit is reflected, and revive expired cooldowns so the
      // "limited until" countdown a client shows matches what routing will do.
      store.reloadIfChanged();
      const config = store.get();
      if (reviveLimitedAccounts(config)) store.scheduleWrite();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(computeStats(config, logStore.all())));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/metrics') {
      // Per-provider/-model rollup of the persisted log ring: success/limit/error
      // counts, error rate, avg latency, requests-per-minute.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rollupMetrics(logStore.all())));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/config') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const conf = JSON.parse(body);
          // Reject anything that isn't a real config so a single malformed POST
          // (e.g. a CSRF hit against localhost) can't nuke the whole file.
          if (!conf || typeof conf !== 'object' || !Array.isArray(conf.providers)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid config: "providers" array is required' }));
            return;
          }
          // Dashboard save: replace the whole in-memory config and persist NOW
          // (user pressed save — it must land, not sit in the debounce window).
          store.replace(conf);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch(e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    // Fetch a provider's model list from its own /models endpoint, server-side.
    // The browser can't do this itself (CORS + it never holds the real key); the
    // router can, using the same helpers the CLI's "Fetch Models" uses. Body:
    // { providerId }. Returns { models, aliases } — the client merges + saves via
    // POST /api/config, exactly like the CLI does. Never touches disk here.
    if (req.method === 'POST' && req.url === '/api/fetch-models') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const { providerId } = JSON.parse(body || '{}');
          store.reloadIfChanged();
          const provider = store.get().providers.find(p => p.id === providerId);
          if (!provider) { res.writeHead(404); res.end(JSON.stringify({ error: 'Provider not found' })); return; }
          if (!provider.modelsEndpoint) { res.writeHead(400); res.end(JSON.stringify({ error: 'Provider has no models endpoint: add models manually' })); return; }
          const account = (provider.accounts || [])[0];
          if (!account) { res.writeHead(400); res.end(JSON.stringify({ error: 'Add an account first: fetching needs a key' })); return; }
          const baseUrl = resolveBaseUrl(provider, account).replace(/\/+$/, '');
          // Same self-loop guard as the CLI: a local provider points back at us.
          if (isLocalUrl(baseUrl)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Local provider is manual-only (fetch disabled to avoid a self-loop)' })); return; }
          const apiKey = await resolveAccessToken(provider, account);
          const headers = {};
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          const controller = new AbortController();
          const upstream = await fetchWithConnectTimeout(`${baseUrl}${provider.modelsEndpoint}`, { method: 'GET', headers }, controller, CONNECT_TIMEOUT_MS);
          if (!upstream.ok) { res.writeHead(502); res.end(JSON.stringify({ error: `Provider returned HTTP ${upstream.status}` })); return; }
          const data = await upstream.json();
          const raw = data.data || data.models || data.result || data;
          const ids = (Array.isArray(raw) ? raw : []).map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
          const { models, aliases } = normalizeFetchedModels(provider, ids);
          // OpenRouter (and a few aggregators) publish per-model price in the same
          // list; pull it out so the cost view auto-fills. Empty {} for providers
          // that don't — the manual editor stays authoritative for those.
          const pricing = extractModelPricing(Array.isArray(raw) ? raw : []);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models, aliases, pricing }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message || 'fetch failed' }));
        }
      });
      return;
    }
    // Test one account's connectivity server-side (the browser can't — it never
    // holds the real key, and CORS blocks it). Mirrors the CLI's testAccount:
    // resolve the credential (static key OR a minted OAuth token — a bad refresh
    // token surfaces as a failure here, which is the point), then GET the
    // provider's models endpoint. Body: { providerId, accountId }.
    // Returns { ok, status, message }. Never touches disk.
    if (req.method === 'POST' && req.url === '/api/test-account') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const { providerId, accountId } = JSON.parse(body || '{}');
          store.reloadIfChanged();
          const provider = store.get().providers.find(p => p.id === providerId);
          if (!provider) { res.writeHead(404); res.end(JSON.stringify({ error: 'Provider not found' })); return; }
          const account = (provider.accounts || []).find(a => a.id === accountId);
          if (!account) { res.writeHead(404); res.end(JSON.stringify({ error: 'Account not found' })); return; }
          const baseUrl = resolveBaseUrl(provider, account).replace(/\/+$/, '');
          const url = provider.modelsEndpoint ? `${baseUrl}${provider.modelsEndpoint}` : `${baseUrl}/models`;
          let apiKey;
          try {
            apiKey = await resolveAccessToken(provider, account);
          } catch (tokenErr) {
            // A dead OAuth grant (bad/revoked refresh token) fails to mint — that's
            // exactly the "is this account usable?" answer Test exists to give.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, status: 0, message: `Token mint failed: ${tokenErr.message}` }));
            return;
          }
          const headers = {};
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          const controller = new AbortController();
          const upstream = await fetchWithConnectTimeout(url, { method: 'GET', headers }, controller, CONNECT_TIMEOUT_MS);
          const message = upstream.ok
            ? `Connection OK (HTTP ${upstream.status})`
            : `HTTP ${upstream.status}: ${(await upstream.text().catch(() => '')).slice(0, 120) || upstream.statusText}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: upstream.ok, status: upstream.status, message }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message || 'test failed' }));
        }
      });
      return;
    }

    // Run the browser OAuth consent flow server-side and return the refresh_token.
    // The router is a local process on the same box as the browser, so it can do
    // exactly what the CLI does (accounts.js): open the browser, catch the callback
    // on a throwaway loopback port, exchange the code. The dashboard can't do this
    // itself (no local socket, no client secret handling). Body:
    // { providerId, clientId, clientSecret? }. Returns { refreshToken }.
    // The client merges it into the account creds and saves via POST /api/config.
    if (req.method === 'POST' && req.url === '/api/oauth-login') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const { providerId, clientId, clientSecret } = JSON.parse(body || '{}');
          store.reloadIfChanged();
          const provider = store.get().providers.find(p => p.id === providerId);
          if (!provider) { res.writeHead(404); res.end(JSON.stringify({ error: 'Provider not found' })); return; }
          // Same preconditions the CLI checks before offering browser login.
          if (normalizeAuthType(provider.authType) !== 'oauth2') { res.writeHead(400); res.end(JSON.stringify({ error: 'Provider is not OAuth (authType must be oauth2)' })); return; }
          if ((provider.oauth?.grantType || 'refresh_token') !== 'refresh_token') { res.writeHead(400); res.end(JSON.stringify({ error: 'Browser login only applies to the refresh_token grant' })); return; }
          if (!provider.oauth?.authUrl) { res.writeHead(400); res.end(JSON.stringify({ error: 'Provider has no oauth.authUrl: set it in Edit Provider first' })); return; }
          if (!clientId) { res.writeHead(400); res.end(JSON.stringify({ error: 'OAuth Client ID is required to start browser login' })); return; }
          const { runBrowserAuthFlow } = await import('./oauth-flow.js');
          const tokens = await runBrowserAuthFlow({
            authUrl: provider.oauth.authUrl,
            tokenUrl: provider.oauth.tokenUrl,
            clientId,
            clientSecret: clientSecret || undefined,
            scope: provider.oauth.scope || '',
            extraAuthParams: provider.oauth.extraAuthParams || {},
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ refreshToken: tokens.refreshToken }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message || 'browser login failed' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/shutdown') {
      store.flush(); // persist any pending debounced write before exiting
      logStore.flush();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, 100);
      return;
    }

    // --- 1. ENDPOINT GET /v1/models ---
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      // External edit (CLI/hand) wins over our in-memory copy — reload if changed.
      store.reloadIfChanged();
      const config = store.get();
      let aggregatedModels = [];

      for (const provider of config.providers) {
        // Cegah "Inception" / Infinite Fractal Loop kalo user masukin LocalRouter ke dalem config.
        // Skip any provider pointing back at a local address (localhost, 127.x, 0.0.0.0, ::1).
        if (isLocalUrl(provider.baseUrlTemplate)) {
          continue;
        }

        // Prefix with the name-slug, not the raw UUID id, so model names read
        // like "groq/llama3-70b-8192". The chat resolver already matches on
        // name-slug (see below), so this stays routable.
        const slug = slugify(provider.name);
        if (provider.models && provider.models.length > 0) {
          for (const model of provider.models) {
            aggregatedModels.push({
              id: `${slug}/${model}`,
              object: 'model',
              owned_by: provider.name
            });
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: aggregatedModels }));
      return;
    }

    // --- 1b. ENDPOINT POST /v1/images/generations | /v1/images/edits ---
    // OpenAI Images API (image-generation models like gpt-image live here on most
    // aggregators). No hub translation: this is an OpenAI-shaped endpoint both sides,
    // so we just key-rotate + fail over across accounts like chat/completions does,
    // then byte-passthrough the upstream's JSON (image data + b64_json).
    //
    // ponytail: no cross-format pivot and no combos here — a client asking for
    // images pins the model it asked for, and the Images wire format has no hub
    // equivalent in Anthropic/Gemini/Responses. If a provider ever returns a
    // non-OpenAI shape here we'd need a translator; none observed so far.
    if (req.method === 'POST' && /\/v1\/images\/(generations|edits)$/.test(req.url)) {
      let chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          // A form-data(edits) body isn't JSON; only generations is. edits may be
          // multipart — pass it through untouched (can't read model from JSON).
          let payload = {};
          const isJson = !req.headers['content-type']?.includes('multipart/form-data');
          if (isJson) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

          store.reloadIfChanged();
          const config = store.get();
          if (reviveLimitedAccounts(config)) store.scheduleWrite();

          // Resolve provider from the requested model id (format groq/dall-e-3),
          // same rule as chat: match by slug or raw id.
          const modelStr = payload.model || '';
          const slash = modelStr.indexOf('/');
          if (slash < 1) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Image generation needs a model in provider/model form' }));
            return;
          }
          const providerQuery = modelStr.slice(0, slash).toLowerCase();
          let provider = config.providers.find((p) => p.id.toLowerCase() === providerQuery || slugify(p.name) === providerQuery);
          if (!provider) { res.writeHead(404); res.end(JSON.stringify({ error: `Provider '${providerQuery}' not found` })); return; }

          let active = provider.accounts.filter((a) => a.status === 'active');
          if (active.length === 0) {
            const fb = findFallbackProvider(config, provider.id, modelStr.slice(slash + 1));
            if (!fb) { res.writeHead(429); res.end(JSON.stringify({ error: `No active accounts for '${provider.name}'` })); return; }
            provider = fb;
            active = provider.accounts.filter((a) => a.status === 'active');
          }
          active.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));

          // Rewrite model to THIS provider's upstream id (alias map, same as chat),
          // so the upstream receives "dall-e-3", not "groq/dall-e-3".
          const actualModel = resolveModelId(provider, modelStr.slice(slash + 1));
          let outRaw = raw;
          if (isJson) {
            payload.model = actualModel;
            outRaw = JSON.stringify(payload);
          }
          let attempt = 0;
          const maxAttempts = active.length;
          let sent = false;
          while (!sent && attempt < maxAttempts) {
            const account = active[attempt];
            account.lastUsed = Date.now();
            store.scheduleWrite();

            const baseUrl = resolveBaseUrl(provider, account).replace(/\/+$/, '');
            // The client hit /v1/images/... — strip the /v1 prefix the router mounts
            // and forward the trailing path. Most providers expect /v1/images/... too.
            const pathTail = req.url.startsWith('/v1/') ? req.url.slice(3) : req.url;
            const targetUrl = baseUrl + pathTail;

            const headers = { ...req.headers };
            delete headers.host;
            delete headers['transfer-encoding'];
            delete headers['connection'];
            delete headers['keep-alive'];
            delete headers['content-length']; // recompute below
            const body = isJson ? outRaw : Buffer.concat(chunks);
            headers['content-length'] = Buffer.byteLength(body);
            // Static key, or a minted OAuth access token. A dead grant is turned
            // into a synthetic 401 so the rotate-on-limit branch below handles it,
            // same as the chat path.
            let apiKey = null, oauthAuthFailed = false;
            try {
              apiKey = await resolveAccessToken(provider, account);
            } catch (tokenErr) {
              if (!tokenErr?.invalidGrant) throw tokenErr;
              oauthAuthFailed = true;
            }
            const isOauth = normalizeAuthType(provider.authType) === 'oauth2';
            // Images providers all use Bearer or x-api-key; reuse the openai-side auth
            // logic (Bearer default, x-api-key if the client sent one). OAuth always
            // Bearer, replacing whatever bogus auth the client sent.
            if (apiKey) {
              if (isOauth) { delete headers['x-api-key']; headers['authorization'] = `Bearer ${apiKey}`; }
              else if (headers['x-api-key']) headers['x-api-key'] = apiKey;
              else headers['authorization'] = `Bearer ${apiKey}`;
            }

            const controller = new AbortController();
            const onClose = () => { if (!res.writableEnded) controller.abort(); };
            res.on('close', onClose);

            const logEntry = logStore.push({ id: randomUUID(), timestamp: new Date().toISOString(), provider: provider.name, account: account.name, model: modelStr, status: 'pending' });
            const t0 = Date.now();
            const response = oauthAuthFailed
              ? { status: 401, ok: false, headers: { get: () => null }, body: null }
              : await fetchWithConnectTimeout(targetUrl, { method: 'POST', headers, body }, controller, CONNECT_TIMEOUT_MS);
            logEntry.latencyMs = Date.now() - t0;

            if (response.status === 429 || response.status === 401 || response.status === 403 || response.status === 402) {
              logEntry.status = 'limit';
              logStore.touch();
              if (isOauth) invalidateToken(account.id); // drop the rejected/limited token
              const permanent = response.status === 401 || response.status === 403;
              const p = config.providers.find((x) => x.id === provider.id);
              const a = p?.accounts.find((x) => x.id === account.id);
              if (a) {
                a.status = 'limited';
                if (permanent) { a.authFailed = true; delete a.limitedAt; delete a.retryAfterMs; }
                else { a.limitedAt = Date.now(); delete a.authFailed; const ra = parseRetryAfter(response.headers.get('retry-after')); if (ra != null) a.retryAfterMs = ra; else delete a.retryAfterMs; }
              }
              store.scheduleWrite();
              attempt++;
              continue;
            }

            logEntry.status = response.ok ? 'success' : 'error';
            logStore.touch();
            if (response.ok) { const a = config.providers.find((x) => x.id === provider.id)?.accounts.find((x) => x.id === account.id); if (a) { a.usageCount = (a.usageCount || 0) + 1; store.scheduleWrite(); } }

            sent = true;
            const respHeaders = Object.fromEntries(response.headers.entries());
            delete respHeaders['content-encoding'];
            delete respHeaders['content-length'];
            res.writeHead(response.status, respHeaders);
            for await (const c of response.body || []) res.write(c);
            res.end();
          }
          if (!sent) { res.writeHead(429); res.end(JSON.stringify({ error: `All accounts for '${provider.name}' hit limits (images)` })); }
        } catch (err) {
          if (err?.name !== 'AbortError') {
            logStore.push({ id: randomUUID(), timestamp: new Date().toISOString(), provider: 'Unknown', account: 'Unknown', model: 'Unknown', status: 'error', error: err.message });
            process.stdout.write('\x1b[2K\r' + chalk.red('[ROUTER] Image error: ') + (err.message || err));
          }
          if (res.headersSent) res.end();
          else { res.writeHead(err?.name === 'AbortError' ? 504 : 500); res.end(err?.name === 'AbortError' ? 'aborted' : 'Router Internal Error'); }
        }
      });
      return;
    }

    // --- 2. ENDPOINT POST /v1/chat/completions ---
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      try {
        const payloadStr = Buffer.concat(body).toString('utf8');
        const payload = JSON.parse(payloadStr);

        // Pick up any external edit (CLI/hand edit) before we touch state, then
        // work on the SHARED in-memory config so concurrent requests can't clobber
        // each other's field writes.
        store.reloadIfChanged();
        const config = store.get();
        // Revive accounts whose limit cooldown has expired before picking one.
        if (reviveLimitedAccounts(config)) store.scheduleWrite();

        // Inbound wire format is fixed by the path the client hit: Anthropic
        // clients (claude-code) POST /v1/messages; OpenAI clients POST
        // /v1/chat/completions; Gemini clients POST …/models/{model}:generate…;
        // OpenAI Responses clients POST /v1/responses. This never changes across
        // spec/account/provider fallback, so decide it once. The provider's
        // format is decided per iteration inside the loop (a fallback may differ).
        const inboundFmt =
          req.url.includes('/messages') ? 'anthropic' :
          /:(?:stream)?[gG]enerateContent/.test(req.url) ? 'gemini' :
          req.url.includes('/responses') ? 'responses' :
          'openai';

        // Gemini carries the model in the URL and signals streaming via the verb
        // (:streamGenerateContent), not body fields. Normalize both onto the
        // payload so the shared model-routing + stream logic below works unchanged.
        if (inboundFmt === 'gemini') {
          const m = /\/models\/(.+?):(stream)?[gG]enerateContent/.exec(req.url);
          if (m && !payload.model) payload.model = decodeURIComponent(m[1]);
          if (m && m[2]) payload.stream = true;
        }

        // A combo is a user-defined ordered list of provider/model specs; a plain
        // request is just a one-element list. The router tries each spec in turn,
        // dropping to the NEXT only when the current model has no live account left
        // anywhere (its own accounts + any model-locked cross-provider fallback).
        // Only combos may change the model between specs — a plain request never does.
        const comboSpecs = resolveComboSpecs(config, payload.model);
        const modelSpecs = comboSpecs && comboSpecs.length ? comboSpecs : [payload.model || ''];
        const isCombo = !!(comboSpecs && comboSpecs.length);

        const wantsStream = payload.stream === true;

        // One close listener for the whole request (not per-iteration, or rotating
        // across N accounts would stack N listeners). It aborts whichever fetch is
        // currently in flight if the client (CLI) disconnects mid-request.
        //
        // Watch RES, not REQ: the request (readable) stream emits 'close' as soon as
        // its body is fully read — which for a normal POST happens immediately, long
        // before the upstream responds. Listening on req.close therefore aborts EVERY
        // request the instant the body arrives (→ spurious 504s). res.close fires when
        // the client actually hangs up; the writableEnded guard means a normal
        // res.end() (response already sent) never triggers a bogus abort.
        let activeController = null;
        const onClientClose = () => { if (!res.writableEnded) activeController?.abort(); };
        res.on('close', onClientClose);

        // Outer loop over combo specs (one iteration for a plain request). Each
        // spec runs the full account-rotation + cross-provider fallback pipeline;
        // when a spec is fully exhausted we advance to the next combo model.
        let handled = false;   // a response was sent (success or a real upstream error)
        let lastError = null;  // for the final "all specs exhausted" message
        for (const spec of modelSpecs) {
          const modelParts = (spec || '').split('/');
          if (modelParts.length < 2) {
            // A malformed spec: for a plain request that's a 400; inside a combo we
            // skip the bad entry rather than fail the whole combo.
            if (isCombo) { lastError = `bad combo entry "${spec}" (need provider/model)`; continue; }
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Model format must be providerId/modelName' }));
            return;
          }

          const providerQuery = modelParts[0].toLowerCase();
          const actualModel = modelParts.slice(1).join('/');

          let provider = config.providers.find(p =>
            p.id.toLowerCase() === providerQuery || slugify(p.name) === providerQuery
          );

          if (!provider) {
            if (isCombo) { lastError = `provider '${providerQuery}' not found`; continue; }
            res.writeHead(404);
            res.end(JSON.stringify({ error: `Provider '${providerQuery}' not found in BobbyTools` }));
            return;
          }

          let activeAccounts = provider.accounts.filter(a => a.status === 'active');

          if (activeAccounts.length === 0) {
            const fallbackProvider = findFallbackProvider(config, provider.id, actualModel);
            if (fallbackProvider) {
              process.stdout.write('\x1b[2K\r' + chalk.magenta(`[FALLBACK] ${provider.name} out of accounts. Auto-switching to ${fallbackProvider.name} for ${actualModel}...\n`));
              provider = fallbackProvider;
              activeAccounts = provider.accounts.filter(a => a.status === 'active');
            } else {
              // No account for this model anywhere. In a combo, drop to the next
              // model; a plain request has nothing left to try.
              lastError = `no active accounts for '${provider.name}' and no fallback`;
              if (isCombo) { process.stdout.write('\x1b[2K\r' + chalk.magenta(`[COMBO] ${actualModel} unavailable, trying next model...\n`)); continue; }
              res.writeHead(429);
              res.end(JSON.stringify({ error: `No active accounts left for provider '${provider.name}' and no fallback found.` }));
              return;
            }
          }

          activeAccounts.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
          let currentAccount = activeAccounts[0];

          currentAccount.lastUsed = Date.now();
          store.scheduleWrite();

          let attempt = 0;
          let maxAttempts = activeAccounts.length;

          // The ONLY ways out of this loop are a `return` (success or a real
          // upstream response was sent) or falling through (every account +
          // cross-provider fallback for this spec is limited). Reaching past the
          // loop therefore means "spec exhausted" — advance to the next combo model.
          while (attempt < maxAttempts) {
          const baseUrl = resolveBaseUrl(provider, currentAccount).replace(/\/+$/, '');
          // Provider wire format, decided per iteration — a fallback provider may
          // differ from the one the request started on. Default 'openai' so every
          // pre-existing provider (no apiFormat field) normalizes to openai —
          // behaves exactly as before. Unknown values fall back to openai too.
          const providerFmt = normalizeFormat(provider.apiFormat);

          // Resolve the friendly model name to THIS provider's upstream id (an
          // alias map, if any) — so "glm-5.2" can mean "genfity/glm-5.2" upstream
          // on one provider and "GLM-5.2" on another. No alias = the name as-is
          // (exactly the old behavior). Done per iteration: a fallback provider
          // may map the same friendly name to a different id.
          payload.model = resolveModelId(provider, actualModel);

          // Translate the request body only when the client's format differs from
          // the provider's. Same format = plain re-serialize (model may have been
          // remapped above); different format = translate. Passthrough stays the
          // hot path — no cross-format work when inbound already matches.
          let outObj;
          if (inboundFmt !== providerFmt) {
            // Pivot the request from the client's format to the provider's,
            // through the OpenAI hub (see translate.js FORMATS).
            outObj = translateRequest(payload, inboundFmt, providerFmt);
          } else if (providerFmt === 'gemini') {
            // Same-format Gemini passthrough: model/stream were hoisted from the
            // URL onto the payload for routing; strip them so the outbound body is
            // a clean GenerateContentRequest (Gemini doesn't want them in-body).
            const { model, stream, ...geminiBody } = payload;
            outObj = geminiBody;
          } else {
            outObj = payload;
          }

          // Ask OpenAI-format providers to emit token usage on STREAMED responses.
          // Unlike anthropic/gemini/responses (which always report usage in the
          // stream), OpenAI chat.completions only appends the final usage frame when
          // the request carries stream_options.include_usage — and CLIs (opencode,
          // aider, cursor…) don't send it. Without this the observability tap has
          // nothing to sniff and every streamed request reads as "—". We inject it
          // so usage tracking works transparently; non-stream already returns usage.
          //
          // ponytail: on the OpenAI->OpenAI passthrough this forwards one extra
          // trailing frame `data:{choices:[],usage:{…}}` to the client. That's valid
          // OpenAI SSE (any include_usage response has it) and the official SDKs the
          // common CLIs use handle it; a hand-rolled client that blindly reads
          // choices[0] on every frame could trip. If that ever bites, the upgrade
          // path is to strip the empty-choices usage frame in the fast path instead
          // of forwarding it — at the cost of parsing the SSE there (loses byte-for-
          // byte passthrough), so we don't pay that unless a real client needs it.
          if (providerFmt === 'openai' && outObj && outObj.stream === true) {
            outObj.stream_options = { ...(outObj.stream_options || {}), include_usage: true };
          }

          const outBody = JSON.stringify(outObj);

          // Endpoint path must match what the PROVIDER expects, not what the client
          // sent. OpenAI wants /chat/completions, Anthropic /messages, Gemini a
          // model-scoped verb (/v1beta/models/{model}:generateContent, or
          // :streamGenerateContent?alt=sse when streaming — Gemini carries the
          // model in the URL, not the body). When formats already match we keep
          // the client's own suffix (covers /v1beta and other variants).
          let endpointPath;
          if (inboundFmt === providerFmt) {
            endpointPath = req.url.startsWith('/v1/') ? req.url.slice(3) : req.url;
          } else if (providerFmt === 'gemini') {
            const verb = wantsStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
            endpointPath = `/v1beta/models/${encodeURIComponent(payload.model)}:${verb}`;
          } else if (providerFmt === 'anthropic') {
            endpointPath = '/messages';
          } else if (providerFmt === 'responses') {
            endpointPath = '/responses';
          } else {
            endpointPath = '/chat/completions';
          }
          // Gemini base URLs are conventionally the API root (…/v1beta lives in the
          // path we build), so strip a trailing /v1 or /v1beta the user may have set.
          const effectiveBase = providerFmt === 'gemini'
            ? baseUrl.replace(/\/v1(beta)?$/, '')
            : baseUrl;
          const targetUrl = effectiveBase + endpointPath;

          // Resolve the outbound credential. For apikey providers this is the
          // stored secret (unchanged). For oauth2 providers it mints/refreshes a
          // short-lived access token. A permanently-bad grant (revoked refresh
          // token) throws invalidGrant — we translate that into the SAME path a
          // 401 on a static key takes below (disable the account, rotate/fallback),
          // instead of duplicating that logic here. A transient token error
          // (network/5xx) rethrows to the outer catch.
          let apiKey = null;
          let oauthAuthFailed = false;
          try {
            apiKey = await resolveAccessToken(provider, currentAccount);
          } catch (tokenErr) {
            if (!tokenErr?.invalidGrant) throw tokenErr;
            oauthAuthFailed = true;
          }

          const headers = { ...req.headers };
          delete headers.host;
          // Strip hop-by-hop / body-framing headers copied from the inbound request.
          // We send our own content-length below; leaving the client's transfer-encoding
          // (e.g. "chunked" when the client didn't set content-length) makes undici reject
          // the outbound fetch with UND_ERR_INVALID_ARG (can't have both). connection/
          // keep-alive are per-hop and mustn't be forwarded either.
          delete headers['transfer-encoding'];
          delete headers['connection'];
          delete headers['keep-alive'];
          headers['content-length'] = Buffer.byteLength(outBody);
          // Auth placement depends on the PROVIDER's format, not the client's.
          // When we translate across formats the client's own auth header (e.g.
          // an Anthropic client's x-api-key) is meaningless to the target and
          // must be replaced by the scheme the provider expects — otherwise a
          // stale/wrong-scheme credential leaks through. Strip all known auth
          // headers first, then set the right one for the provider.
          // OAuth providers authenticate with a Bearer access token regardless of
          // wire format — even Gemini, which uses x-goog-api-key for a STATIC key,
          // takes an OAuth token as `Authorization: Bearer`. So for oauth2 we always
          // strip the client's auth and set Bearer, skipping the format-specific
          // placement below (which is only right for provider-issued static keys).
          const isOauth = normalizeAuthType(provider.authType) === 'oauth2';
          if (inboundFmt !== providerFmt || isOauth) {
            delete headers['x-api-key'];
            delete headers['api-key'];
            delete headers['x-goog-api-key'];
            delete headers['authorization'];
          }
          if (apiKey && isOauth) {
            headers['authorization'] = `Bearer ${apiKey}`;
            if (providerFmt === 'anthropic' && !headers['anthropic-version']) {
              headers['anthropic-version'] = '2023-06-01';
            }
          } else if (apiKey) {
            if (providerFmt === 'gemini') {
              headers['x-goog-api-key'] = apiKey; // Gemini: key in x-goog-api-key header
            } else if (providerFmt === 'anthropic') {
              headers['x-api-key'] = apiKey;
              // Anthropic requires a version header; supply a default when the
              // client didn't send one (e.g. an OpenAI client we translated).
              if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
            } else if (headers['x-api-key']) {
              headers['x-api-key'] = apiKey;
            } else if (headers['api-key']) {
              headers['api-key'] = apiKey;
            } else if (headers['x-goog-api-key']) {
              headers['x-goog-api-key'] = apiKey;
            } else {
              headers['authorization'] = `Bearer ${apiKey}`;
            }
          }

          process.stdout.write('\x1b[2K\r' + chalk.cyan(`[ROUTER] Routing to ${provider.name} (${currentAccount.name}) -> ${actualModel}`));

          const logEntry = logStore.push({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            provider: provider.name,
            account: currentAccount.name,
            model: actualModel,
            status: 'pending'
          });

          // Connect-timeout only (see fetchWithConnectTimeout): a dead provider
          // can't hang forever, but a long stream is never cut off. The shared
          // controller also lets onClientClose abort this fetch mid-stream.
          //
          // A dead OAuth grant never reaches the network: we synthesize a 401 so
          // the auth-failure branch below disables the account and rotates, exactly
          // as if the provider had rejected the token. No Retry-After (permanent).
          activeController = new AbortController();
          const t0 = Date.now();
          const response = oauthAuthFailed
            ? { status: 401, ok: false, headers: { get: () => null }, body: null }
            : await fetchWithConnectTimeout(
                targetUrl,
                { method: 'POST', headers, body: outBody },
                activeController,
                CONNECT_TIMEOUT_MS,
              );
          logEntry.latencyMs = Date.now() - t0; // upstream time-to-headers (routing latency, not stream duration)

          if (response.status === 429 || response.status === 401 || response.status === 403 || response.status === 402) {
            // 401/403 = the key itself is rejected (bad/revoked/forbidden). That's
            // permanent — retrying it every 60s just burns a request slot forever,
            // so we disable it (authFailed, no limitedAt) and it won't auto-revive
            // until the user fixes the key. 429/402 = transient rate/quota limit:
            // mark limitedAt so it auto-revives, honoring Retry-After when given.
            const permanent = response.status === 401 || response.status === 403;
            logEntry.status = 'limit';
            logStore.touch(); // persist the finalized 'limit' status + latency
            const kind = permanent ? 'auth failed (key rejected)' : 'hit limit';
            process.stdout.write('\x1b[2K\r' + chalk.yellow(`[ROUTER] Account "${currentAccount.name}" ${kind} (${response.status}). Auto-rotating...`));

            // Drop any cached OAuth token for this account: it was either rejected
            // (401/403) or the account is going limited, so the next attempt must
            // mint a fresh one rather than resend a token the provider refused.
            if (normalizeAuthType(provider.authType) === 'oauth2') invalidateToken(currentAccount.id);

            const p = config.providers.find(x => x.id === provider.id);
            const a = p?.accounts.find(x => x.id === currentAccount.id);
            if (a) {
              a.status = 'limited';
              if (permanent) {
                a.authFailed = true;
                delete a.limitedAt;      // no auto-revive for a dead key
                delete a.retryAfterMs;
              } else {
                a.limitedAt = Date.now();
                delete a.authFailed;
                const ra = parseRetryAfter(response.headers.get('retry-after'));
                if (ra != null) a.retryAfterMs = ra; else delete a.retryAfterMs;
              }
            }

            const nextAccount = p?.accounts.find(x => x.status === 'active' && x.id !== currentAccount.id);
            if (nextAccount) {
              currentAccount = nextAccount;
              currentAccount.lastUsed = Date.now();
              store.scheduleWrite();
              attempt++;
              continue; 
            } else {
               const fallback = findFallbackProvider(config, provider.id, actualModel);
               if (fallback) {
                 process.stdout.write('\x1b[2K\r' + chalk.magenta(`[FALLBACK] ${provider.name} accounts exhausted. Switching to ${fallback.name}...\n`));
                 provider = fallback;
                 let fallbackActive = provider.accounts.filter(ax => ax.status === 'active');
                 fallbackActive.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
                 currentAccount = fallbackActive[0];
                 currentAccount.lastUsed = Date.now();
                 store.scheduleWrite();
                 attempt = 0;
                 maxAttempts = fallbackActive.length;
                 continue;
               }
               process.stdout.write('\x1b[2K\r' + chalk.red(`[ROUTER] All accounts for ${provider.name} are limited.`));
               store.scheduleWrite();
               break;
            }
          }

          logEntry.status = response.ok ? 'success' : 'error';
          logStore.touch(); // persist the finalized status + latency
          if (response.ok) {
            const p = config.providers.find(x => x.id === provider.id);
            const a = p?.accounts.find(x => x.id === currentAccount.id);
            if (a) {
              a.usageCount = (a.usageCount || 0) + 1;
              store.scheduleWrite();
            }
          }

          const responseHeaders = Object.fromEntries(response.headers.entries());
          // undici fetch already decompressed the body, so the upstream content-encoding
          // and content-length no longer match what we stream out. Drop both and let
          // the response go out chunked, otherwise the client truncates/hangs.
          delete responseHeaders['content-encoding'];
          delete responseHeaders['content-length'];

          // FAST PATH: formats match → byte-for-byte passthrough, exactly as before.
          // Still lazy: tapTail forwards each chunk untouched, only retaining a
          // bounded tail to sniff token usage once the body ends. On success we
          // stamp the log entry; a failed/error body just yields no usage.
          if (inboundFmt === providerFmt || !response.body) {
            res.writeHead(response.status, responseHeaders);
            if (response.body) {
              for await (const chunk of tapTail(response.body, (tail) => {
                if (response.ok) recordUsage(logEntry, sniffUsage(tail, wantsStream));
              })) res.write(chunk);
            }
            res.end();
            return;
          }

          // TRANSLATE the response back into the format the client expects.
          if (wantsStream) {
            // SSE reframing. content-type must announce an event stream; length is
            // unknown (chunked). The generator yields ready-to-write text frames.
            responseHeaders['content-type'] = 'text/event-stream; charset=utf-8';
            res.writeHead(response.status, responseHeaders);
            // Sniff the provider's RAW stream (providerFmt) via the tap, then
            // reframe the tapped stream into the client's format. Both stay lazy.
            const tapped = tapTail(response.body, (tail) => {
              if (response.ok) recordUsage(logEntry, sniffUsage(tail, true));
            });
            const gen = translateStream(tapped, providerFmt, inboundFmt, { model: actualModel });
            for await (const frame of gen) res.write(frame);
            res.end();
            return;
          }

          // Non-streaming: buffer the whole body, parse, translate, send as JSON.
          const raw = await response.text();
          if (response.ok) recordUsage(logEntry, sniffUsage(raw, false));
          let outText = raw;
          try {
            const parsed = JSON.parse(raw);
            // Pivot the response from the provider's format back to the
            // client's, through the OpenAI hub.
            const translated = translateResponse(parsed, providerFmt, inboundFmt);
            outText = JSON.stringify(translated);
          } catch {
            // Not JSON (an upstream error page, etc.) — pass the raw body through
            // untouched rather than turning a real error into a parse crash.
          }
          responseHeaders['content-type'] = 'application/json';
          res.writeHead(response.status, responseHeaders);
          res.end(outText);
          handled = true;
          return;
          } // end while (account rotation for this spec)

          // Fell through the while = every account + fallback for THIS spec is
          // limited. A combo drops to the next model; a plain request is done.
          lastError = `all accounts for '${actualModel}' hit limits`;
          if (isCombo) {
            process.stdout.write('\x1b[2K\r' + chalk.magenta(`[COMBO] ${actualModel} exhausted, trying next model...\n`));
            continue;
          }
          res.writeHead(429);
          res.end(JSON.stringify({ error: 'All accounts for this provider hit limits' }));
          handled = true;
          return;
        } // end for (combo specs)

        // Only reached when every combo spec was exhausted without a response.
        if (!handled) {
          res.writeHead(429);
          res.end(JSON.stringify({ error: `All combo models exhausted${lastError ? ` (last: ${lastError})` : ''}` }));
        }

      } catch (err) {
        // AbortError = we cancelled the fetch on purpose (client hung up, or the
        // connect timer fired). Not a real error — don't spam it as one.
        const aborted = err?.name === 'AbortError';
        if (!aborted) {
          logStore.push({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            provider: 'Unknown',
            account: 'Unknown',
            model: 'Unknown',
            status: 'error',
            error: err.message
          }); // push already schedules the persist
          process.stdout.write('\x1b[2K\r' + chalk.red('[ROUTER] Error: ') + (err.message || err));
        }

        // If we already started streaming, headers are sent — writeHead would throw
        // ("headers already sent"). Just end the (broken) response quietly.
        if (res.headersSent) {
          res.end();
        } else {
          res.writeHead(aborted ? 504 : 500);
          res.end(aborted ? 'Upstream timed out or client disconnected' : 'Router Internal Error');
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(chalk.red(`\n  ✖ Port ${port} udah kepake.`));
        console.log(chalk.gray(`    Kemungkinan router lain udah jalan di situ. Cek dengan `) + chalk.yellow('bobby list') + chalk.gray(`, atau pakai port lain: `) + chalk.yellow(`bobby serve -p 13338`));
      } else {
        console.log(chalk.red(`\n  ✖ Router gagal jalan: ${err.message}`));
      }
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(chalk.green.bold(`\n  🚀 BobbyTools Local Router Berjalan di Port ${port}`));
      console.log(chalk.gray('  ' + '─'.repeat(50)));
      
      console.log(chalk.cyan.bold('\n  📖 CARA PAKAI:'));
      console.log(chalk.white(`  1. Buka terminal baru (yang ini biarin nyala).`));
      console.log(chalk.white(`  2. Set env vars di terminal baru (pilih sesuai CLI lo):`));
      console.log(chalk.red(`     ⚠️  PENTING (beda OS beda cara):`));
      console.log(chalk.gray(`     - Mac/Linux/GitBash  : pakai `) + chalk.yellow(`export VAR="nilai"`));
      console.log(chalk.gray(`     - Windows PowerShell : pakai `) + chalk.yellow(`$env:VAR="nilai"`));
      console.log(chalk.gray(`     - Windows CMD        : pakai `) + chalk.yellow(`set VAR="nilai"`));
      console.log(chalk.gray(`     (Contoh di bawah pakai gaya Mac/Linux, silakan sesuaikan)`));
      
      console.log(chalk.gray(`\n     [Standar OpenAI - Paling banyak dipakai (opencode, aider, cursor)]`));
      console.log(chalk.yellow(`     export OPENAI_BASE_URL="http://127.0.0.1:${port}/v1"`));
      console.log(chalk.yellow(`     export OPENAI_API_KEY="sk-bobby"`));
      
      console.log(chalk.gray(`\n     [Standar Anthropic - Untuk claude-code dll]`));
      console.log(chalk.yellow(`     export ANTHROPIC_BASE_URL="http://127.0.0.1:${port}/v1"`));
      console.log(chalk.yellow(`     export ANTHROPIC_API_KEY="sk-bobby"`));

      console.log(chalk.gray(`\n     [Standar Lainnya - Google Gemini / Groq / Cohere]`));
      console.log(chalk.yellow(`     export GEMINI_BASE_URL="http://127.0.0.1:${port}/v1"   export GEMINI_API_KEY="sk-bobby"`));
      console.log(chalk.yellow(`     export GROQ_BASE_URL="http://127.0.0.1:${port}/v1"     export GROQ_API_KEY="sk-bobby"`));

      console.log(chalk.white(`\n  3. Panggil CLI favorit lo, gabungin provider + model:`));
      console.log(chalk.yellow(`     <nama-cli> -m <nama-provider>/<nama-model>`));
      console.log(chalk.gray(`     Contoh 1: opencode -m groq/llama3-70b-8192`));
      console.log(chalk.gray(`     Contoh 2: aider --model openrouter/anthropic/claude-3-haiku`));
      console.log(chalk.gray(`     Contoh 3: claude -m google/gemini-1.5-pro`));

      console.log(chalk.cyan.bold('\n  ✨ Yang kejadian di belakang layar:'));
      console.log(chalk.white(`  - Bobby motong nama depan (misal "groq"), terus nyari akun Groq lo.`));
      console.log(chalk.white(`  - Akun itu kena limit (429)? Bobby lompat ke akun Groq berikutnya,`));
      console.log(chalk.white(`    opencode/aider lo gak berhenti, gak error.`));
      console.log(chalk.white(`  - Semua provider yang lo daftarin (custom juga) udah nyatu di sini.`));

      console.log(chalk.gray('\n  ' + '─'.repeat(50)));
      console.log(chalk.yellow.bold(`  Pencet 'q' (atau 'b') terus Enter buat matiin router & keluar...\n`));
    });

    const onData = (data) => {
      const key = data.toString().trim().toLowerCase();
      if (key === 'b' || key === 'q') {
        console.log(chalk.yellow('\nRouter dimatiin. Sampai ketemu lagi, bro!'));
        process.stdin.off('data', onData);
        process.stdin.pause();
        // Foreground `serve` is a direct command, not launched from the menu —
        // so quitting means exiting to the shell. server.close() alone can hang
        // waiting on keep-alive connections, so stop accepting then exit hard.
        server.close();
        process.exit(0);
      }
    };
    
    if (!background) {
      process.stdin.resume();
      process.stdin.on('data', onData);
    } else {
      resolve(server); // surface the server so background callers can close it
    }
  });
}

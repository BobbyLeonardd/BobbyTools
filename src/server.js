import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { store } from './store.js';
import { logStore } from './logstore.js';
import { resolveBaseUrl, reviveLimitedAccounts, slugify, isLocalUrl, fetchWithConnectTimeout, computeStats, parseRetryAfter, rollupMetrics, resolveModelId, findFallbackProvider } from './helpers.js';
import {
  anthropicReqToOpenai, openaiReqToAnthropic,
  anthropicRespToOpenai, openaiRespToAnthropic,
  anthropicStreamToOpenai, openaiStreamToAnthropic,
} from './translate.js';
import { PROVIDER_TEMPLATES } from './templates.js';
import chalk from 'chalk';

// Request logs live in logStore (a persistent, bounded ring hydrated from disk).
// How long to wait for a provider to START responding (send headers). Once the
// stream is flowing this timer is cleared, so long LLM answers are never cut off.
const CONNECT_TIMEOUT_MS = 30_000;

export async function startRouterServer(port = 13337, background = false) {
  // Best-effort flush on process teardown (Ctrl+C, SIGTERM) so the last stat
  // bumps aren't lost. 'exit' can only run sync work — store.flush() is sync.
  // SIGINT/SIGTERM don't fire 'exit' on their own, so bounce them through exit().
  process.on('exit', () => { try { store.flush(); } catch {} try { logStore.flush(); } catch {} });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const server = http.createServer(async (req, res) => {
    
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
      res.end(JSON.stringify({ status: 'ok' }));
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

        const modelParts = (payload.model || '').split('/');
        if (modelParts.length < 2) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Model format must be providerId/modelName' }));
          return;
        }

        const providerQuery = modelParts[0].toLowerCase();
        const actualModel = modelParts.slice(1).join('/');

        // Pick up any external edit (CLI/hand edit) before we touch state, then
        // work on the SHARED in-memory config so concurrent requests can't clobber
        // each other's field writes.
        store.reloadIfChanged();
        const config = store.get();
        // Revive accounts whose limit cooldown has expired before picking one.
        if (reviveLimitedAccounts(config)) store.scheduleWrite();

        let provider = config.providers.find(p =>
          p.id.toLowerCase() === providerQuery || slugify(p.name) === providerQuery
        );

        if (!provider) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Provider '${providerQuery}' not found in BobbyTools` }));
          return;
        }

        // `actualModel` is the FRIENDLY name the client asked for (provider prefix
        // stripped). The concrete upstream id can differ per provider (aliases),
        // so payload.model is resolved per loop iteration below, not here.
        // Inbound wire format is fixed by the path the client hit: Anthropic
        // clients (claude-code) POST /v1/messages; OpenAI clients POST
        // /v1/chat/completions. This never changes across account/provider
        // fallback, so decide it once. The provider's format is decided per
        // iteration inside the loop (a fallback provider may differ).
        const inboundFmt = req.url.includes('/messages') ? 'anthropic' : 'openai';
        const wantsStream = payload.stream === true;

        let activeAccounts = provider.accounts.filter(a => a.status === 'active');
        
        if (activeAccounts.length === 0) {
          const fallbackProvider = findFallbackProvider(config, provider.id, actualModel);
          if (fallbackProvider) {
            process.stdout.write('\x1b[2K\r' + chalk.magenta(`[FALLBACK] ${provider.name} out of accounts. Auto-switching to ${fallbackProvider.name} for ${actualModel}...\n`));
            provider = fallbackProvider;
            activeAccounts = provider.accounts.filter(a => a.status === 'active');
          } else {
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

        while (attempt < maxAttempts) {
          const baseUrl = resolveBaseUrl(provider, currentAccount).replace(/\/+$/, '');
          // Provider wire format, decided per iteration — a fallback provider may
          // differ from the one the request started on. Default 'openai' so every
          // pre-existing provider (no apiFormat field) behaves exactly as before.
          const providerFmt = provider.apiFormat === 'anthropic' ? 'anthropic' : 'openai';

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
          let outBody;
          if (inboundFmt !== providerFmt) {
            const translated = inboundFmt === 'anthropic'
              ? anthropicReqToOpenai(payload)   // claude-code -> OpenAI provider
              : openaiReqToAnthropic(payload);  // OpenAI client -> Anthropic provider
            outBody = JSON.stringify(translated);
          } else {
            outBody = JSON.stringify(payload);
          }

          // Endpoint path must match what the PROVIDER expects, not what the client
          // sent: an OpenAI provider wants /chat/completions, an Anthropic one wants
          // /messages. When formats already match we keep the client's own suffix
          // (covers /v1beta and other variants without a lookup table).
          let endpointPath = req.url.startsWith('/v1/') ? req.url.slice(3) : req.url;
          if (inboundFmt !== providerFmt) {
            endpointPath = providerFmt === 'anthropic' ? '/messages' : '/chat/completions';
          }
          const targetUrl = baseUrl + endpointPath;

          const primaryCred = provider.credentials.find(c => c.secret) || provider.credentials[0];
          let apiKey = null;
          if (primaryCred) {
            apiKey = currentAccount.credentials[primaryCred.key];
          }

          const headers = { ...req.headers };
          delete headers.host;
          headers['content-length'] = Buffer.byteLength(outBody);
          if (apiKey) {
            if (headers['x-api-key']) {
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
          activeController = new AbortController();
          const t0 = Date.now();
          const response = await fetchWithConnectTimeout(
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
          if (inboundFmt === providerFmt || !response.body) {
            res.writeHead(response.status, responseHeaders);
            if (response.body) {
              for await (const chunk of response.body) res.write(chunk);
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
            const gen = inboundFmt === 'anthropic'
              ? openaiStreamToAnthropic(response.body, { model: actualModel })  // client wants Anthropic, provider streamed OpenAI
              : anthropicStreamToOpenai(response.body, { model: actualModel }); // client wants OpenAI, provider streamed Anthropic
            for await (const frame of gen) res.write(frame);
            res.end();
            return;
          }

          // Non-streaming: buffer the whole body, parse, translate, send as JSON.
          const raw = await response.text();
          let outText = raw;
          try {
            const parsed = JSON.parse(raw);
            const translated = inboundFmt === 'anthropic'
              ? openaiRespToAnthropic(parsed)  // client wants Anthropic, provider returned OpenAI
              : anthropicRespToOpenai(parsed); // client wants OpenAI, provider returned Anthropic
            outText = JSON.stringify(translated);
          } catch {
            // Not JSON (an upstream error page, etc.) — pass the raw body through
            // untouched rather than turning a real error into a parse crash.
          }
          responseHeaders['content-type'] = 'application/json';
          res.writeHead(response.status, responseHeaders);
          res.end(outText);
          return;
        }

        res.writeHead(429);
        res.end(JSON.stringify({ error: 'All accounts for this provider hit limits' }));

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
      
      console.log(chalk.cyan.bold('\n  📖 TUTORIAL CARA PAKAI:'));
      console.log(chalk.white(`  1. Buka terminal baru (biarkan terminal ini menyala).`));
      console.log(chalk.white(`  2. Atur env vars di terminal baru (pilih sesuai bawaan CLI-mu):`));
      console.log(chalk.red(`     ⚠️  PENTING (Beda OS Beda Cara):`));
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

      console.log(chalk.white(`\n  3. Panggil CLI favoritmu dan gabungkan Provider + Model:`));
      console.log(chalk.yellow(`     <nama-cli> -m <nama-provider>/<nama-model>`));
      console.log(chalk.gray(`     Contoh 1: opencode -m groq/llama3-70b-8192`));
      console.log(chalk.gray(`     Contoh 2: aider --model openrouter/anthropic/claude-3-haiku`));
      console.log(chalk.gray(`     Contoh 3: claude -m google/gemini-1.5-pro`));
      
      console.log(chalk.cyan.bold('\n  ✨ MAGIC YANG TERJADI:'));
      console.log(chalk.white(`  - Router akan memotong nama depan (misal: "groq") dan mencari akun Groq-mu.`));
      console.log(chalk.white(`  - Jika akun tersebut limit (Error 429), router otomatis muter ke akun Groq`));
      console.log(chalk.white(`    berikutnya TANPA membuat opencode/aider berhenti/error.`));
      console.log(chalk.white(`  - Semua provider yang kamu daftarkan (termasuk custom) sudah tergabung di sini!`));

      console.log(chalk.gray('\n  ' + '─'.repeat(50)));
      console.log(chalk.yellow.bold(`  Tekan 'q' (atau 'b') lalu Enter untuk mematikan router & keluar...\n`));
    });

    const onData = (data) => {
      const key = data.toString().trim().toLowerCase();
      if (key === 'b' || key === 'q') {
        console.log(chalk.yellow('\nMematikan router. Sampai jumpa!'));
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
      resolve(); // if background, resolve immediately to not block anything (though it runs in detached process anyway)
    }
  });
}

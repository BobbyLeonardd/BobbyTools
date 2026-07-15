import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { getConfig, saveConfig } from './config.js';
import { resolveBaseUrl } from './helpers.js';
import { PROVIDER_TEMPLATES } from './templates.js';
import chalk from 'chalk';

const requestLogs = [];
const MAX_LOGS = 100;

export async function startRouterServer(port = 13337, background = false) {
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getConfig()));
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
      res.end(JSON.stringify(requestLogs));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/config') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const conf = JSON.parse(body);
          saveConfig(conf);
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, 100);
      return;
    }

    // --- 1. ENDPOINT GET /v1/models ---
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      const config = getConfig();
      let aggregatedModels = [];

      for (const provider of config.providers) {
        // Cegah "Inception" / Infinite Fractal Loop kalo user masukin LocalRouter ke dalem config
        const url = provider.baseUrl || provider.url || '';
        if (url.includes('127.0.0.1') || url.includes('localhost')) {
          continue;
        }

        if (provider.models && provider.models.length > 0) {
          for (const model of provider.models) {
            aggregatedModels.push({
              id: `${provider.id}/${model}`,
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

        const config = getConfig();
        let provider = config.providers.find(p => 
          p.id.toLowerCase() === providerQuery || p.name.toLowerCase().replace(/\s+/g, '-') === providerQuery
        );

        if (!provider) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Provider '${providerQuery}' not found in BobbyTools` }));
          return;
        }

        payload.model = actualModel;
        const newPayloadStr = JSON.stringify(payload);

        let activeAccounts = provider.accounts.filter(a => a.status === 'active');
        
        if (activeAccounts.length === 0) {
          const fallbackProvider = config.providers.find(p => p.id !== provider.id && p.accounts.some(a => a.status === 'active') && p.models && p.models.includes(actualModel));
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
        saveConfig(config);

        let attempt = 0;
        let maxAttempts = activeAccounts.length;

        while (attempt < maxAttempts) {
          const baseUrl = resolveBaseUrl(provider, currentAccount).replace(/\/+$/, '');
          // CLI usually sends /v1/chat/completions. We want to extract /chat/completions
          // and append it to the provider's base URL which already includes /v1 for most providers.
          let endpointPath = req.url;
          if (endpointPath.startsWith('/v1/')) {
            endpointPath = endpointPath.slice(3); // becomes /chat/completions
          }
          const targetUrl = baseUrl + endpointPath;

          const primaryCred = provider.credentials.find(c => c.secret) || provider.credentials[0];
          let apiKey = null;
          if (primaryCred) {
            apiKey = currentAccount.credentials[primaryCred.key];
          }

          const headers = { ...req.headers };
          delete headers.host;
          headers['content-length'] = Buffer.byteLength(newPayloadStr);
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

          const logEntry = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            provider: provider.name,
            account: currentAccount.name,
            model: actualModel,
            status: 'pending'
          };
          requestLogs.unshift(logEntry);
          if (requestLogs.length > MAX_LOGS) requestLogs.pop();

          const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: newPayloadStr,
          });

          if (response.status === 429 || response.status === 401 || response.status === 402) {
            logEntry.status = 'limit';
            process.stdout.write('\x1b[2K\r' + chalk.yellow(`[ROUTER] Account "${currentAccount.name}" hit limit (${response.status}). Auto-rotating...`));
            
            const p = config.providers.find(x => x.id === provider.id);
            const a = p?.accounts.find(x => x.id === currentAccount.id);
            if (a) a.status = 'limited';
            
            const nextAccount = p?.accounts.find(x => x.status === 'active' && x.id !== currentAccount.id);
            if (nextAccount) {
              currentAccount = nextAccount;
              currentAccount.lastUsed = Date.now();
              saveConfig(config);
              attempt++;
              continue; 
            } else {
               const fallback = config.providers.find(px => px.id !== provider.id && px.accounts.some(ax => ax.status === 'active') && px.models && px.models.includes(actualModel));
               if (fallback) {
                 process.stdout.write('\x1b[2K\r' + chalk.magenta(`[FALLBACK] ${provider.name} accounts exhausted. Switching to ${fallback.name}...\n`));
                 provider = fallback;
                 let fallbackActive = provider.accounts.filter(ax => ax.status === 'active');
                 fallbackActive.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
                 currentAccount = fallbackActive[0];
                 currentAccount.lastUsed = Date.now();
                 saveConfig(config);
                 attempt = 0;
                 maxAttempts = fallbackActive.length;
                 continue;
               }
               process.stdout.write('\x1b[2K\r' + chalk.red(`[ROUTER] All accounts for ${provider.name} are limited.`));
               saveConfig(config);
               break; 
            }
          }

          logEntry.status = response.ok ? 'success' : 'error';
          if (response.ok) {
            const p = config.providers.find(x => x.id === provider.id);
            const a = p?.accounts.find(x => x.id === currentAccount.id);
            if (a) {
              a.usageCount = (a.usageCount || 0) + 1;
              saveConfig(config);
            }
          }

          const responseHeaders = Object.fromEntries(response.headers.entries());
          delete responseHeaders['content-encoding'];
          
          res.writeHead(response.status, responseHeaders);
          if (response.body) {
            for await (const chunk of response.body) {
              res.write(chunk);
            }
          }
          res.end();
          return;
        }

        res.writeHead(429);
        res.end(JSON.stringify({ error: 'All accounts for this provider hit limits' }));

      } catch (err) {
        requestLogs.unshift({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          provider: 'Unknown',
          account: 'Unknown',
          model: 'Unknown',
          status: 'error',
          error: err.message
        });
        if (requestLogs.length > MAX_LOGS) requestLogs.pop();
        
        process.stdout.write('\x1b[2K\r' + chalk.red('[ROUTER] Error: ') + (err.message || err));
        res.writeHead(500);
        res.end('Router Internal Error');
      }
    });
  });

  return new Promise((resolve) => {
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
      console.log(chalk.yellow.bold(`  Tekan 'b' atau 'q' lalu Enter untuk kembali ke Menu Utama...\n`));
    });

    const onData = (data) => {
      const key = data.toString().trim().toLowerCase();
      if (key === 'b' || key === 'q') {
        console.log(chalk.yellow('\nMematikan router dan kembali ke menu...'));
        process.stdin.off('data', onData);
        process.stdin.pause();
        server.close(() => {
          resolve();
        });
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

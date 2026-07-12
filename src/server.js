import http from 'http';
import { getConfig, saveConfig } from './config.js';
import { resolveBaseUrl } from './helpers.js';
import chalk from 'chalk';

export async function startRouterServer(port = 13337) {
  const server = http.createServer(async (req, res) => {
    
    // --- 1. ENDPOINT GET /v1/models ---
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      const config = getConfig();
      let aggregatedModels = [];

      for (const provider of config.providers) {
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
        const provider = config.providers.find(p => 
          p.id.toLowerCase() === providerQuery || p.name.toLowerCase().replace(/\s+/g, '-') === providerQuery
        );

        if (!provider) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Provider '${providerQuery}' not found in BobbyTools` }));
          return;
        }

        payload.model = actualModel;
        const newPayloadStr = JSON.stringify(payload);

        let currentAccount = provider.accounts.find(a => a.status === 'active');
        if (!currentAccount) {
          res.writeHead(429);
          res.end(JSON.stringify({ error: `No active accounts left for provider '${provider.name}'` }));
          return;
        }

        let attempt = 0;
        const maxAttempts = provider.accounts.length;

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
             headers['Authorization'] = `Bearer ${apiKey}`;
          }

          console.log(chalk.cyan(`[ROUTER] Routing to ${provider.name} (${currentAccount.name}) -> ${actualModel}`));

          const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: newPayloadStr,
          });

          if (response.status === 429 || response.status === 401 || response.status === 402) {
            console.log(chalk.yellow(`[ROUTER] Account "${currentAccount.name}" hit limit (${response.status}). Auto-rotating...`));
            
            const p = config.providers.find(x => x.id === provider.id);
            const a = p?.accounts.find(x => x.id === currentAccount.id);
            if (a) a.status = 'limited';
            
            const nextAccount = p?.accounts.find(x => x.status === 'active' && x.id !== currentAccount.id);
            if (nextAccount) {
              currentAccount = nextAccount;
              saveConfig(config);
              attempt++;
              continue; 
            } else {
               console.log(chalk.red(`[ROUTER] All accounts for ${provider.name} are limited.`));
               saveConfig(config);
               break; 
            }
          }

          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
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
        console.error(chalk.red('[ROUTER] Error:'), err);
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
      console.log(chalk.white(`  2. Atur env vars di terminal baru tersebut:`));
      console.log(chalk.yellow(`     export OPENAI_BASE_URL="http://127.0.0.1:${port}/v1"`));
      console.log(chalk.yellow(`     export OPENAI_API_KEY="sk-bobby" `) + chalk.gray(`(Bebas isi apa saja)`));
      console.log(chalk.white(`  3. Panggil CLI favoritmu dan format nama modelnya seperti ini:`));
      console.log(chalk.yellow(`     opencode -m <nama-provider>/<nama-model>`));
      console.log(chalk.gray(`     Contoh: opencode -m groq/llama3-70b-8192`));
      console.log(chalk.gray(`     Contoh: aider --model openrouter/anthropic/claude-3-haiku`));
      
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
        server.close(() => {
          process.stdin.off('data', onData);
          resolve();
        });
      }
    };
    process.stdin.on('data', onData);
  });
}

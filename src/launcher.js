import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getConfig, saveConfig } from './config.js';
import { selectProvider } from './providers.js';
import { selectModel } from './models.js';
import { buildEnvVars, resolveBaseUrl, timeAgo, getApiKey } from './helpers.js';
import { success, error, info, warn, dim, label, divider, clearScreen, pause, showBanner, statusDot } from './ui.js';

function syncOpencodeConfig(config, provider, account, model) {
  const configDir = path.join(os.homedir(), '.config', 'opencode');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const configPath = path.join(configDir, 'opencode.json');
  let opencodeConfig = { provider: {} };
  
  if (fs.existsSync(configPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (existing.provider) opencodeConfig = existing;
    } catch (e) {
      // Ignore parse errors, overwrite
    }
  }

  const primaryCred = provider.credentials.find(c => c.secret) || provider.credentials[0];
  let apiKey = '';
  if (primaryCred && account.credentials[primaryCred.key]) {
    apiKey = account.credentials[primaryCred.key];
  }
  
  const modelsDict = {};
  if (Array.isArray(provider.models)) {
    for (const m of provider.models) {
      modelsDict[m] = { name: m };
    }
  }
  if (model) {
    modelsDict[model] = { name: model };
  }

  opencodeConfig.provider[provider.id] = {
    npm: provider.opencodeNpm || '@ai-sdk/openai-compatible',
    name: provider.name,
    options: {
      baseURL: resolveBaseUrl(provider, account),
      apiKey: apiKey
    },
    models: modelsDict
  };
  
  fs.writeFileSync(configPath, JSON.stringify(opencodeConfig, null, 2));
}

// ── Full interactive launch ──

export async function launchSession() {
  const config = getConfig();

  let step = 0;
  let provider, account, model, cli;

  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  🚀 Start Session\n'));

    if (step === 0) {
      provider = await selectProvider(config, 'Select Provider');
      if (!provider) return; // Exit to main menu

      if (provider.accounts.length === 0) {
        error(`No accounts for "${provider.name}". Add accounts first!`);
        await pause();
        // stays at step 0
      } else {
        step = 1;
      }
    } else if (step === 1) {
      account = await selectAccountForLaunch(provider);
      if (!account) { step = 0; continue; }
      if (provider.skipModelSelection) {
        model = null;
        step = 3;
        continue;
      }
      step = 2;
    } else if (step === 2) {
      model = await selectModel(provider, account);
      if (!model) { step = 1; continue; }
      step = 3;
    } else if (step === 3) {
      if (provider.defaultCli) {
        cli = provider.defaultCli;
        step = 4;
      } else {
        cli = await selectCliTool(config);
        if (!cli) { step = 2; continue; }
        step = 4;
      }
    } else if (step === 4) {
      // Actually, since doLaunch doesn't fail backwards (it just returns to main menu), 
      // we don't have to worry about "going back" from step 4.
      await doLaunch(config, provider, account, model, cli);
      return;
    }
  }
}

// ── Quick launch (reuse last session) ──

export async function quickLaunch() {
  const config = getConfig();

  if (!config.lastSession) {
    warn('No previous session. Starting interactive...');
    await pause();
    return launchSession();
  }

  const { providerId, accountId, model, cli } = config.lastSession;
  const provider = config.providers.find((p) => p.id === providerId);
  if (!provider) {
    warn('Previous provider no longer exists.');
    await pause();
    return launchSession();
  }

  const account = provider.accounts.find((a) => a.id === accountId);
  if (!account) {
    warn('Previous account no longer exists.');
    await pause();
    return launchSession();
  }

  if (account.status === 'limited') {
    warn(`"${account.name}" is marked as limited.`);
    const activeAlt = provider.accounts.find((a) => a.status === 'active');
    if (!activeAlt) {
      error('No active accounts available!');
      await pause();
      return;
    }
    info(`Switching to "${activeAlt.name}" instead.`);
    return doLaunch(config, provider, activeAlt, model, cli);
  }

  await doLaunch(config, provider, account, model, cli);
}

// ── Core launch logic ──

async function doLaunch(config, provider, account, model, cli) {
  // Build env vars from credential system
  const env = buildEnvVars(provider, account, model);

  console.log();
  divider();
  info(chalk.bold('Launching Session'));
  label('Provider', provider.name);
  label('Account', `${account.name} ${statusDot(account.status)}`);
  if (model) label('Model', model);
  label('CLI', cli);
  if (!provider.skipModelSelection) {
    label('Base URL', resolveBaseUrl(provider, account));
  }

  // Show all env vars being set
  const envKeys = Object.keys(env);
  label('Env Vars', envKeys.join(', '));
  divider();
  console.log();

  // Update tracking
  account.lastUsed = new Date().toISOString();
  account.usageCount++;
  provider.lastAccountId = account.id;
  config.lastSession = { providerId: provider.id, accountId: account.id, model, cli };
  saveConfig(config);

  // CLI-specific args
  let command = cli;
  let args = [];
  if (cli === 'aider' && model) args = ['--model', `openai/${model}`];
  if (cli === 'agy' && model) args = ['--model', model];
  if (cli === 'claude' && model) args = ['--model', model];
  if (cli === 'opencode' && model) {
    syncOpencodeConfig(config, provider, account, model);
    args = ['-m', `${provider.id}/${model}`];
  }

  info(`Starting ${cli}... (Ctrl+C to exit)`);
  console.log();

  const code = await launchCommand(command, args, env);

  console.log();
  if (code === 0) {
    success('Session ended.');
  } else {
    warn(`Session exited with code ${code}`);

    // Smart post-session: ask if account hit its limit
    try {
      const hitLimit = await confirm({
        message: `Did "${account.name}" hit its rate limit?`,
        default: false,
      });

      if (hitLimit) {
        const freshConfig = getConfig();
        const p = freshConfig.providers.find((x) => x.id === provider.id);
        const a = p?.accounts.find((x) => x.id === account.id);
        if (a) {
          a.status = 'limited';
          saveConfig(freshConfig);
          success(`"${account.name}" marked as limited.`);
        }

        const nextActive = p?.accounts.find(
          (x) => x.status === 'active' && x.id !== account.id,
        );
        if (nextActive) {
          info(`Next active account: ${chalk.bold(nextActive.name)}`);
          dim('Run "bobby" or "bobby go" to continue.');
        } else {
          warn('No more active accounts for this provider!');
        }
      }
    } catch {
      // Ctrl+C on the prompt — fine
    }
  }
  await pause();
}

// ── Account selection for launch ──
// NO auto-rotation. Defaults to last-used account.
// User picks "🔄 Next" when they want to switch.

async function selectAccountForLaunch(provider) {
  const activeAccounts = provider.accounts.filter((a) => a.status === 'active');

  if (activeAccounts.length === 0) {
    error('No active accounts! All marked as limited.');
    await pause();
    return null;
  }

  const { search } = await import('@inquirer/prompts');

  return search({
    message: 'Select Account',
    source: async (term) => {
      term = (term || '').toLowerCase();
      
      const results = [];
      const showBack = term === '' || '[0] back'.includes(term) || '0' === term;
      
      if (showBack) {
        results.push({ name: chalk.gray('[0] ↩️  Back'), value: null });
      }
      
      for (const acc of provider.accounts) {
        const status = statusDot(acc.status);
        const current = acc.id === provider.lastAccountId ? chalk.yellow(' ← last used') : '';
        const lastUsed = acc.lastUsed ? chalk.gray(` (${timeAgo(acc.lastUsed)})`) : chalk.gray(' (never)');
        const displayName = `${status} ${acc.name}${lastUsed}${current}`;
        
        if (acc.name.toLowerCase().includes(term)) {
          results.push({ name: displayName, value: acc });
        }
      }
      
      return results;
    },
    pageSize: 15
  });
}

export async function selectCliTool(config, message = 'Target CLI command to launch') {
  const cmd = await input({ message: `${message} (e.g. opencode) (type "<" to go back):`, default: 'opencode' });
  if (cmd === '<') return null;
  if (!cmd.trim()) return selectCliTool(config, message);
  return cmd.trim();
}

// ── Spawn child process ──

function launchCommand(command, args, envVars) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ...envVars },
    });
    child.on('error', (err) => {
      error(`Failed to launch "${command}": ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}

import { select, input, confirm, password } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfig, saveConfig } from './config.js';
import { resolveBaseUrl, maskValue, timeAgo } from './helpers.js';
import { resolveAccessToken, normalizeAuthType } from './oauth.js';
import { success, error, warn, info, dim, divider, clearScreen, pause, showBanner, statusDot } from './ui.js';
import { randomUUID } from 'crypto';

export async function manageAccounts(providerId) {
  while (true) {
    clearScreen();
    showBanner();

    const config = getConfig();
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) {
      error('Provider not found!');
      await pause();
      return;
    }

    console.log(chalk.bold('  👤 Manage Accounts\n'));
    info(`Provider: ${chalk.bold(provider.name)}`);
    if (provider.credentials.length > 1) {
      dim(`Credential fields: ${provider.credentials.map((c) => c.label).join(', ')}`);
    }
    console.log();

    const choices = [{ name: '➕  Add Account', value: 'add' }];

    if (provider.accounts.length > 0) {
      choices.push(
        { name: '📋  List Accounts', value: 'list' },
        { name: '✏️   Edit Account', value: 'edit' },
        { name: '🗑️   Delete Account', value: 'delete' },
        { name: '🔍  Test Account', value: 'test' },
        { name: '🔄  Toggle Status (active/limited)', value: 'toggle' },
      );
    }

    choices.push({ name: '↩️   Back', value: 'back' });

    const action = await select({ message: 'Account Management', choices });
    if (action === 'back') return;

    switch (action) {
      case 'add': await addAccount(config, provider); break;
      case 'list': 
        clearScreen();
        showBanner();
        listAccounts(provider); 
        await pause();
        break;
      case 'edit': await editAccount(config, provider); break;
      case 'delete': await deleteAccount(config, provider); break;
      case 'test': await testAccount(provider); break;
      case 'toggle': await toggleAccount(config, provider); break;
    }
  }
}

// ── Add account — dynamically prompts for each credential field ──

async function addAccount(config, provider) {
  let step = 0;
  let name;
  const credentials = {};

  while (true) {
    if (step === 0) {
      name = await input({ message: 'Account name (e.g. tuyul-1, type "<" to cancel):', default: name || '' });
      if (name === '<') return;
      if (!name) continue;
      step = 1;
    } else if (step > 0 && step <= provider.credentials.length) {
      const credIndex = step - 1;
      const cred = provider.credentials[credIndex];
      const isOptional = cred.required === false;
      const promptFn = cred.secret ? password : input;
      
      const opts = {
        message: `${cred.label}${isOptional ? ' (optional)' : ''} (type "<" to go back):`,
      };
      if (cred.secret) opts.mask = '*';
      if (cred.default) opts.default = cred.default;
      
      // For password, default value behaves differently, but we pass it anyway
      const value = await promptFn(opts);
      
      if (value === '<') { step--; continue; }

      if (!value && !isOptional && !cred.default) {
        error(`${cred.label} is required!`);
        continue; // Stay on same step
      }

      if (value || cred.default) {
        credentials[cred.key] = value || cred.default;
      }
      step++;
    } else {
      break; // Completed all fields
    }
  }

  // OAuth login providers (browser consent flow): if this is a refresh_token grant
  // and the user didn't paste a refresh token by hand, run the browser flow now to
  // obtain one. The clientId/clientSecret they just entered feed straight into it.
  const isOauthLogin = normalizeAuthType(provider.authType) === 'oauth2'
    && (provider.oauth?.grantType || 'refresh_token') === 'refresh_token'
    && provider.oauth?.authUrl;
  if (isOauthLogin && !credentials.refreshToken) {
    if (!credentials.clientId) {
      error('OAuth Client ID is required to start the browser login. Add it and retry.');
      await pause();
      return;
    }
    const ok = await confirm({ message: 'Open your browser to sign in and authorize now?', default: true });
    if (ok) {
      try {
        const { runBrowserAuthFlow } = await import('./oauth-flow.js');
        info('Opening browser… complete the consent, then return here.');
        const tokens = await runBrowserAuthFlow({
          authUrl: provider.oauth.authUrl,
          tokenUrl: provider.oauth.tokenUrl,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret || undefined,
          scope: provider.oauth.scope || '',
          extraAuthParams: provider.oauth.extraAuthParams || {},
          onPrompt: (url) => dim(`If the browser didn't open, visit:\n  ${url}`),
        });
        credentials.refreshToken = tokens.refreshToken;
        success('Authorized. Refresh token stored.');
      } catch (err) {
        error(`Browser login failed: ${err.message}`);
        dim('You can paste a Refresh Token manually instead, or retry.');
        await pause();
        return;
      }
    } else {
      warn('Skipped browser login. This account has no refresh token and will fail until you add one.');
    }
  }

  const account = {
    id: randomUUID(),
    name,
    credentials,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastUsed: null,
    usageCount: 0,
  };

  provider.accounts.push(account);
  saveConfig(config);
  success(`Account "${name}" added to ${provider.name}!`);
  await pause();
}

// ── List accounts — shows all credential fields masked ──

function listAccounts(provider) {
  console.log(chalk.bold('  📋 Account List\n'));
  if (provider.accounts.length === 0) {
    dim('No accounts configured.');
    return;
  }

  for (const acc of provider.accounts) {
    const status = statusDot(acc.status, true);
    const lastUsed = acc.lastUsed ? timeAgo(acc.lastUsed) : 'never';
    const isCurrent = provider.lastAccountId === acc.id ? chalk.yellow(' ← current') : '';

    console.log(`  ${chalk.bold(acc.name)} ${status}${isCurrent}`);

    for (const cred of provider.credentials) {
      const val = acc.credentials[cred.key];
      if (val) dim(`${cred.label}: ${maskValue(val, cred.secret)}`);
    }

    dim(`Used: ${acc.usageCount}x | Last: ${lastUsed}`);
    divider();
  }
}

// ── Edit account — can edit name or any credential field ──

async function editAccount(config, provider) {
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  ✏️  Edit Account\n'));

    const account = await pickAccount(provider, 'Select account to edit');
    if (!account) return;

    while (true) {
      clearScreen();
      showBanner();
      console.log(chalk.bold(`  ✏️  Editing: ${account.name} (Provider: ${provider.name})\n`));
      const choices = [{ name: `Name: ${account.name}`, value: '__name__' }];

      for (const cred of provider.credentials) {
        const val = account.credentials[cred.key];
        choices.push({
          name: `${cred.label}: ${maskValue(val, cred.secret)}`,
          value: cred.key,
        });
      }
      choices.push({ name: '↩️  Back', value: 'back' });

      const field = await select({ message: `Edit ${account.name}`, choices });
      if (field === 'back') break; // break inner loop, go back to select account

      if (field === '__name__') {
        const newName = await input({ message: 'New name (type "<" to cancel):', default: account.name });
        if (newName === '<') continue;
        if (newName) account.name = newName;
      } else {
        const cred = provider.credentials.find((c) => c.key === field);
        const promptFn = cred.secret ? password : input;
        const opts = { message: `New ${cred.label} (type "<" to cancel):` };
        if (cred.secret) opts.mask = '*';

        const newValue = await promptFn(opts);
        if (newValue === '<') continue;
        if (newValue) account.credentials[field] = newValue;
      }

      saveConfig(config);
      success('Account updated!');
      await pause();
    }
  }
}

// ── Delete ──

async function deleteAccount(config, provider) {
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  🗑️  Delete Account(s)\n'));

    if (provider.accounts.length === 0) {
      error('No accounts to delete!');
      await pause();
      return;
    }

    const { checkbox } = await import('@inquirer/prompts');
    
    const choices = provider.accounts.map(a => ({
      name: `${statusDot(a.status)} ${a.name}`,
      value: a.id
    }));

    dim('Press <Space> to select, <Enter> to confirm, or <Enter> with 0 selected to cancel.');
    console.log();
    
    const selectedIds = await checkbox({
      message: 'Select account(s) to delete:',
      choices,
      pageSize: 15
    });

    if (selectedIds.length === 0) return;

    const confirmed = await confirm({ message: `Delete ${selectedIds.length} account(s)?`, default: false });
    if (!confirmed) continue;

    provider.accounts = provider.accounts.filter((a) => !selectedIds.includes(a.id));
    if (selectedIds.includes(provider.lastAccountId)) provider.lastAccountId = null;
    
    saveConfig(config);
    success(`Deleted ${selectedIds.length} account(s)!`);
    await pause();
    return;
  }
}

// ── Test connection ──

async function testAccount(provider) {
  const account = await pickAccount(provider, 'Select account to test');
  if (!account) return;

  info('Testing connection...');
  try {
    const baseUrl = resolveBaseUrl(provider, account);
    // Static key for apikey providers, a minted OAuth token for oauth2 ones — a
    // failed token mint (bad refresh token) surfaces as a caught "Connection
    // failed" below, which is exactly what "Test Account" is for.
    const apiKey = await resolveAccessToken(provider, account);
    const url = provider.modelsEndpoint
      ? `${baseUrl}${provider.modelsEndpoint}`
      : `${baseUrl}/models`;

    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });

    if (res.ok) {
      success(`Connection OK! (HTTP ${res.status})`);
    } else {
      const body = await res.text().catch(() => '');
      error(`HTTP ${res.status}: ${res.statusText}${body ? `: ${body.slice(0, 120)}` : ''}`);
    }
  } catch (err) {
    error(`Connection failed: ${err.message}`);
  }
  await pause();
}

// ── Toggle status ──

async function toggleAccount(config, provider) {
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  🔄  Toggle Account Status\n'));

    if (provider.accounts.length === 0) {
      error('No accounts to toggle!');
      await pause();
      return;
    }

    const { checkbox } = await import('@inquirer/prompts');
    
    const choices = provider.accounts.map(a => ({
      name: `${statusDot(a.status)} ${a.name} ${chalk.gray(`(${a.status})`)}`,
      value: a.id
    }));
    
    dim('Press <Space> to select, <a> to select all, <Enter> to confirm, or <Enter> with 0 selected to cancel.');
    console.log();
    
    const selectedIds = await checkbox({
      message: 'Select account(s) to toggle their status:',
      choices,
      pageSize: 15
    });

    if (selectedIds.length === 0) return;

    for (const id of selectedIds) {
      const acc = provider.accounts.find(a => a.id === id);
      if (acc) {
        acc.status = acc.status === 'active' ? 'limited' : 'active';
        // Flipping back to active means the user fixed/accepts the key — clear the
        // router's limit bookkeeping so a revived key starts clean.
        if (acc.status === 'active') { delete acc.limitedAt; delete acc.retryAfterMs; delete acc.authFailed; }
      }
    }
    
    saveConfig(config);
    success(`Toggled status for ${selectedIds.length} account(s)!`);
    await pause();
    return;
  }
}

// ── Account picker ──

async function pickAccount(provider, message) {
  if (provider.accounts.length === 0) {
    error('No accounts. Add one first!');
    return null;
  }

  const { search } = await import('@inquirer/prompts');

  return search({
    message,
    source: async (term) => {
      term = (term || '').toLowerCase();
      
      const results = [];
      const showBack = term === '' || '[0] back'.includes(term) || '0' === term;
      
      if (showBack) {
        results.push({ name: chalk.gray('[0] ↩️  Back'), value: null });
      }
      
      for (const a of provider.accounts) {
        const displayName = `${statusDot(a.status)} ${a.name}`;
        if (a.name.toLowerCase().includes(term)) {
          results.push({ name: displayName, value: a });
        }
      }
      
      return results;
    }
  });
}

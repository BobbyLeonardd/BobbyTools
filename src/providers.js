import { select, input, confirm, Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfig, saveConfig } from './config.js';
import { slugTaken, isLocalUrl, normalizeFetchedModels } from './helpers.js';
import { PROVIDER_TEMPLATES } from './templates.js';
import { success, error, warn, info, dim, divider, clearScreen, pause, showBanner } from './ui.js';
import { manageAccounts } from './accounts.js';
import { randomUUID } from 'crypto';

export async function manageProviders() {
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  📦 Manage Providers\n'));

    const config = getConfig();

    const choices = [{ name: '➕  Add Provider', value: 'add' }];

    if (config.providers.length > 0) {
      choices.push(
        { name: '📋  List Providers', value: 'list' },
        { name: '✏️   Edit Provider', value: 'edit' },
        { name: '🗑️   Delete Provider', value: 'delete' },
        { name: '👤  Manage Accounts', value: 'accounts' },
      );
    }

    choices.push({ name: '↩️   Back', value: 'back' });

    const action = await select({ message: 'Provider Management', choices, pageSize: 15 });
    if (action === 'back') return;

    switch (action) {
      case 'add': await addProvider(); break;
      case 'list': 
        clearScreen();
        showBanner();
        listProviders(); 
        await pause();
        break;
      case 'edit': await editProvider(); break;
      case 'delete': await deleteProvider(); break;
      case 'accounts': await accountsMenu(); break;
    }
  }
}

// ── Add Provider ──

async function addProvider() {
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  ➕ Add Provider\n'));

    const source = await select({
      message: 'How to add?',
      pageSize: 15,
      choices: [
        { name: `📦  From Template (${PROVIDER_TEMPLATES.length} providers)`, value: 'template' },
        { name: '✍️   Custom Provider', value: 'custom' },
        { name: '↩️   Back', value: 'back' },
      ],
    });
    if (source === 'back') return;

    const provider = source === 'template'
      ? await addFromTemplate()
      : await addCustom();

    if (provider === 'back') continue;
    if (!provider) return;

    const config = getConfig();
    config.providers.push(provider);
    saveConfig(config);
    success(`Provider "${provider.name}" added with ${provider.credentials.length} credential field(s)!`);
    info('Next: add accounts via Manage Providers → Manage Accounts');
    await pause();
    return;
  }
}

async function addFromTemplate() {
  const cloud = PROVIDER_TEMPLATES.filter((t) => t.category === 'cloud');
  const local = PROVIDER_TEMPLATES.filter((t) => t.category === 'local');

  const { search } = await import('@inquirer/prompts');

  const template = await search({
    message: 'Select Provider Template',
    source: async (term) => {
      term = (term || '').toLowerCase();
      
      const results = [];
      const showBack = term === '' || '[0] back'.includes(term) || '0' === term;
      
      if (showBack) {
        results.push({ name: chalk.gray('[0] ↩️  Back'), value: 'back' });
      }

      const matchTemplate = (t) => t.name.toLowerCase().includes(term) || (t.description && t.description.toLowerCase().includes(term));
      
      const matchedCloud = cloud.filter(matchTemplate);
      const matchedLocal = local.filter(matchTemplate);

      if (matchedCloud.length > 0) {
        results.push(new Separator(chalk.gray('── Cloud Providers ──')));
        matchedCloud.forEach(t => results.push({ name: `${t.name} ${chalk.gray('— ' + t.description)}`, value: t }));
      }

      if (matchedLocal.length > 0) {
        results.push(new Separator(chalk.gray('── Local Providers ──')));
        matchedLocal.forEach(t => results.push({ name: `${t.name} ${chalk.gray('— ' + t.description)}`, value: t }));
      }
      
      return results;
    }
  });

  if (template === 'back') return 'back';

  const confirmAdd = await select({
    message: `Add ${template.name}?`,
    choices: [
      { name: 'Yes', value: true },
      { name: 'No', value: false },
      { name: '↩️  Back', value: 'back' }
    ]
  });
  if (confirmAdd === 'back' || !confirmAdd) return 'back';

  // Two providers whose names slugify the same would collide in the router
  // (model prefix "groq/..." resolves to whichever is first). Ask for a
  // distinct name instead of silently shadowing the existing one.
  let name = template.name;
  while (slugTaken(getConfig(), name)) {
    warn(`A provider named "${name}" already exists.`);
    const alt = await input({ message: 'Enter a distinct name (e.g. "Groq 2") (type "<" to cancel):', default: `${name} 2` });
    if (alt === '<') return 'back';
    name = alt.trim();
    if (!name) name = template.name;
  }

  let cli = template.defaultCli;
  if (!cli) {
    const { selectCliTool } = await import('./launcher.js');
    const config = getConfig();
    cli = await selectCliTool(config, `Default CLI tool for ${template.name}?`);
    if (!cli) return 'back';
  }

  return {
    id: randomUUID(),
    name,
    baseUrlTemplate: template.baseUrlTemplate,
    modelsEndpoint: template.modelsEndpoint,
    baseUrlEnvVar: template.baseUrlEnvVar,
    credentials: structuredClone(template.credentials),
    defaultCli: cli,
    accounts: [],
    models: [],
    lastAccountId: null,
    skipModelSelection: template.skipModelSelection || false,
  };
}

async function addCustom() {
  let step = 0;
  let name, baseUrlTemplate, hasModels, baseUrlEnvVar, apiKeyEnv;
  let credentials = [];
  let extraFields = [];
  
  // State for the dynamic extra fields loop
  let currentExtraFieldIndex = 0;
  let tempExtraField = {};
  let extraStep = 0; // sub-steps for extra fields

  while (true) {
    if (step === 0) {
      clearScreen();
      showBanner();
      console.log(chalk.bold('  ✍️  Custom Provider Setup\n'));
      name = await input({ message: 'Provider name (type "<" to cancel):', default: name || '' });
      if (name === '<') return 'back';
      if (!name) continue;
      if (slugTaken(getConfig(), name)) {
        error(`A provider named "${name}" already exists (names must be unique). Pick another.`);
        await pause();
        name = '';
        continue;
      }
      step = 1;
    } 
    else if (step === 1) {
      console.log();
      info('URL supports {fieldName} placeholders for per-account values');
      dim('Example: https://api.cf.com/{accountId}/v1');
      baseUrlTemplate = await input({ message: 'Base URL template (type "<" to go back):', default: baseUrlTemplate || '' });
      if (baseUrlTemplate === '<') { step = 0; continue; }
      if (!baseUrlTemplate) continue;
      step = 2;
    } 
    else if (step === 2) {
      const choice = await select({
        message: 'Has /models endpoint?',
        choices: [
          { name: 'Yes', value: true },
          { name: 'No', value: false },
          { name: '↩️  Back', value: 'back' }
        ]
      });
      if (choice === 'back') { step = 1; continue; }
      hasModels = choice;
      step = 3;
    } 
    else if (step === 3) {
      baseUrlEnvVar = await input({
        message: 'Env var name for base URL (type "<" to go back):',
        default: baseUrlEnvVar || 'OPENAI_BASE_URL',
      });
      if (baseUrlEnvVar === '<') { step = 2; continue; }
      step = 4;
    } 
    else if (step === 4) {
      console.log();
      info('Define credential fields for each account.');
      dim('Most providers just need an API Key.');
      apiKeyEnv = await input({
        message: 'API Key env var name (type "<" to go back):',
        default: apiKeyEnv || 'OPENAI_API_KEY',
      });
      if (apiKeyEnv === '<') { step = 3; continue; }
      step = 5;
    } 
    else if (step === 5) {
      const choice = await select({
        message: 'Add extra credential fields (Account ID, Org ID, etc.)?',
        choices: [
          { name: 'No, finish setup', value: false },
          { name: 'Yes, add extra field', value: true },
          { name: '↩️  Back', value: 'back' }
        ]
      });
      if (choice === 'back') { step = 4; continue; }
      
      if (!choice) {
        // Finish setup
        credentials = [{
          label: 'API Key',
          key: 'apiKey',
          envVar: apiKeyEnv,
          secret: true,
          required: true,
        }];
        // Append any completed extra fields
        credentials.push(...extraFields);
        step = 7;
      } else {
        // Enter extra fields loop
        step = 6;
        currentExtraFieldIndex = extraFields.length;
        tempExtraField = {};
        extraStep = 0;
      }
    }
    // ── Extra Fields Sub-Machine ──
    else if (step === 6) {
      if (extraStep === 0) {
        console.log();
        dim(`Extra credential #${currentExtraFieldIndex + 1}:`);
        const label = await input({ message: 'Label (e.g. "Account ID") (type "<" to go back):', default: tempExtraField.label || '' });
        if (label === '<') { step = 5; continue; }
        if (!label) continue;
        tempExtraField.label = label;
        extraStep = 1;
      }
      else if (extraStep === 1) {
        const defaultKey = tempExtraField.label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const key = await input({
          message: 'Key identifier (type "<" to go back):',
          default: tempExtraField.key || defaultKey,
        });
        if (key === '<') { extraStep = 0; continue; }
        if (!key) continue;
        tempExtraField.key = key;
        extraStep = 2;
      }
      else if (extraStep === 2) {
        const envVar = await input({ message: 'Env var (leave empty if none, "<" to go back):', default: tempExtraField.envVar || '' });
        if (envVar === '<') { extraStep = 1; continue; }
        tempExtraField.envVar = envVar;
        extraStep = 3;
      }
      else if (extraStep === 3) {
        const secret = await select({
          message: 'Is this a secret?',
          choices: [
            { name: 'Yes', value: true },
            { name: 'No', value: false },
            { name: '↩️  Back', value: 'back' }
          ]
        });
        if (secret === 'back') { extraStep = 2; continue; }
        tempExtraField.secret = secret;
        extraStep = 4;
      }
      else if (extraStep === 4) {
        const required = await select({
          message: 'Is this required?',
          choices: [
            { name: 'Yes', value: true },
            { name: 'No', value: false },
            { name: '↩️  Back', value: 'back' }
          ]
        });
        if (required === 'back') { extraStep = 3; continue; }
        tempExtraField.required = required;
        
        if (!required) {
          extraStep = 5;
        } else {
          extraFields.push({ ...tempExtraField });
          step = 5; // Go back to "Add more?" question
        }
      }
      else if (extraStep === 5) {
        const defaultVal = await input({ message: 'Default value (leave empty for none, "<" to go back):', default: tempExtraField.default || '' });
        if (defaultVal === '<') { extraStep = 4; continue; }
        tempExtraField.default = defaultVal;
        extraFields.push({ ...tempExtraField });
        step = 5; // Go back to "Add more?" question
      }
    }
    // ── CLI Tool Selection ──
    else if (step === 7) {
      const { selectCliTool } = await import('./launcher.js');
      const config = getConfig();
      const cli = await selectCliTool(config, 'Default CLI tool for this provider?');
      if (!cli) { step = 5; continue; } // go back to extra fields prompt
      
      return {
        id: randomUUID(),
        name,
        baseUrlTemplate,
        modelsEndpoint: hasModels ? '/models' : null,
        baseUrlEnvVar,
        credentials,
        defaultCli: cli,
        accounts: [],
        models: [],
        lastAccountId: null,
      };
    }
  }
}

// ── List ──

function listProviders() {
  const config = getConfig();
  console.log();

  if (config.providers.length === 0) {
    dim('No providers configured.');
    return;
  }

  for (const p of config.providers) {
    const acctInfo = p.accounts.length > 0
      ? chalk.green(`${p.accounts.length} account(s)`)
      : chalk.gray('no accounts');
    const modelInfo = p.models.length > 0
      ? `${p.models.length} models cached`
      : p.modelsEndpoint ? 'fetchable' : 'manual';

    console.log(chalk.bold(`  📦 ${p.name}`) + ` [${acctInfo}]`);
    dim(`URL: ${p.baseUrlTemplate}`);
    dim(`Models: ${modelInfo}`);
    dim(`Credentials: ${p.credentials.map((c) => c.label).join(', ')}`);

    const envVars = [p.baseUrlEnvVar, ...p.credentials.filter((c) => c.envVar).map((c) => c.envVar)];
    dim(`Env vars: ${envVars.join(', ')}`);
    divider();
  }
}

// ── Edit ──

async function editProvider() {
  const config = getConfig();
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  ✏️  Edit Provider\n'));

    const provider = await selectProvider(config, 'Select provider to edit');
    if (!provider) return;

    while (true) {
      clearScreen();
      showBanner();
      console.log(chalk.bold(`  ✏️  Editing: ${provider.name}\n`));
      const choices = [
        { name: `Name: ${provider.name}`, value: 'name' },
        { name: `Base URL: ${provider.baseUrlTemplate}`, value: 'baseUrlTemplate' },
        { name: `Edit Models: ${provider.models?.length || 0} cached${provider.modelsEndpoint ? ', endpoint: ' + provider.modelsEndpoint : ', manual'}`, value: 'models' },
        { name: `Base URL Env: ${provider.baseUrlEnvVar}`, value: 'baseUrlEnvVar' },
      ];

      // Dynamically add all credentials for Env Var editing
      provider.credentials.forEach((cred, i) => {
        choices.push({ name: `${cred.label} Env: ${cred.envVar || '(none)'}`, value: `credEnv_${i}` });
      });

      choices.push(
        { name: `Opencode Plugin: ${provider.opencodeNpm || '@ai-sdk/openai-compatible'}`, value: 'opencodeNpm' },
        { name: `API Format: ${provider.apiFormat === 'anthropic' ? 'anthropic (Messages API)' : 'openai (Chat Completions)'}`, value: 'apiFormat' },
        { name: `Default CLI: ${provider.defaultCli || '(none)'}`, value: 'defaultCli' },
        { name: chalk.gray('↩️  Back'), value: 'back' }
      );

      const field = await select({ message: `Edit ${provider.name}`, choices, pageSize: 15 });
      if (field === 'back') break; // break inner loop, go back to select provider

      if (field === 'models') {
        await editModels(config, provider);
        continue;
      }

      if (field === 'defaultCli') {
        const { selectCliTool } = await import('./launcher.js');
        const newCli = await selectCliTool(config, 'Select new default CLI');
        if (!newCli) continue;
        provider.defaultCli = newCli;
        saveConfig(config);
        success('Provider updated!');
        await pause();
        continue;
      }

      // Wire format this provider speaks. Default 'openai' (most providers).
      // Set 'anthropic' only for a native Anthropic Messages endpoint (e.g.
      // api.anthropic.com) — the router translates when it differs from the
      // format the client sent. See src/translate.js.
      if (field === 'apiFormat') {
        const newFmt = await select({
          message: 'API format this provider speaks',
          choices: [
            { name: 'openai — Chat Completions (Groq, OpenRouter, most)', value: 'openai' },
            { name: 'anthropic — Messages API (api.anthropic.com)', value: 'anthropic' },
          ],
          default: provider.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
        });
        provider.apiFormat = newFmt;
        saveConfig(config);
        success('Provider updated!');
        await pause();
        continue;
      }

      if (field === 'opencodeNpm') {
        const newVal = await input({ message: 'Opencode Plugin (e.g. @ai-sdk/anthropic) (type "<" to cancel):', default: provider.opencodeNpm || '@ai-sdk/openai-compatible' });
        if (newVal === '<') continue;
        provider.opencodeNpm = newVal || null;
        saveConfig(config);
        success('Provider updated!');
        await pause();
        continue;
      }

      if (field.startsWith('credEnv_')) {
        const idx = parseInt(field.split('_')[1], 10);
        const cred = provider.credentials[idx];
        const newVal = await input({ message: `${cred.label} Env Var (type "<" to cancel):`, default: cred.envVar || '' });
        if (newVal === '<') continue;
        cred.envVar = newVal || null;
        saveConfig(config);
        success('Provider updated!');
        await pause();
        continue;
      }

      const current = provider[field] || '';
      const newValue = await input({ message: 'New value (type "<" to cancel):', default: current });
      if (newValue === '<') continue;

      // Renaming to a name another provider already owns (by slug) would make
      // the router ambiguous. Reject it — excludeId lets us keep our own name.
      if (field === 'name') {
        const trimmed = (newValue || '').trim();
        if (!trimmed) { error('Name cannot be empty.'); await pause(); continue; }
        if (slugTaken(config, trimmed, provider.id)) {
          error(`Another provider already uses the name "${trimmed}". Names must be unique.`);
          await pause();
          continue;
        }
        provider.name = trimmed;
        saveConfig(config);
        success('Provider updated!');
        await pause();
        continue;
      }

      provider[field] = newValue || null;
      saveConfig(config);
      success('Provider updated!');
      await pause();
    }
  }
}

// ── Edit Models (CRUD + endpoint) ──
// Manages provider.models for a single provider. Handles both endpoint-backed
// providers (fetch/refresh from the API) and manual-only ones (just add/remove).

async function editModels(config, provider) {
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold(`  🧠  Edit Models: ${provider.name}\n`));

    const count = provider.models?.length || 0;
    const local = isLocalUrl(provider.baseUrlTemplate);
    info(`${count} model(s) cached`);
    dim(local
      ? 'Local base URL — manual entry only (endpoint fetch disabled to avoid loops)'
      : provider.modelsEndpoint
        ? `Endpoint: ${provider.baseUrlTemplate}${provider.modelsEndpoint}`
        : 'No models endpoint — manual entry only');
    console.log();

    const choices = [{ name: '➕  Add Model (manual)', value: 'add' }];

    if (count > 0) {
      choices.push(
        { name: '📋  List Models', value: 'list' },
        { name: '✏️   Rename Model', value: 'rename' },
        { name: '🗑️   Delete Model(s)', value: 'delete' },
      );
    }

    // Fetch only makes sense for a remote endpoint. Local URLs are manual-only.
    if (provider.modelsEndpoint && !local) {
      choices.push({ name: '🔄  Fetch/Refresh from Endpoint', value: 'fetch' });
    }

    choices.push(
      { name: `🔗  Models Endpoint: ${provider.modelsEndpoint || '(none)'}`, value: 'endpoint' },
      { name: chalk.gray('↩️   Back'), value: 'back' },
    );

    const action = await select({ message: 'Model Management', choices, pageSize: 15 });
    if (action === 'back') return;

    switch (action) {
      case 'add': await addModel(config, provider); break;
      case 'list':
        clearScreen();
        showBanner();
        console.log(chalk.bold(`  📋 Models — ${provider.name}\n`));
        provider.models.forEach((m, i) => console.log(`  ${chalk.gray(`${i + 1}.`)} ${m}`));
        await pause();
        break;
      case 'rename': await renameModel(config, provider); break;
      case 'delete': await deleteModels(config, provider); break;
      case 'fetch': await fetchModelsInto(config, provider); break;
      case 'endpoint': await editModelsEndpoint(config, provider); break;
    }
  }
}

async function addModel(config, provider) {
  if (!provider.models) provider.models = [];
  while (true) {
    const name = await input({ message: 'Model name/ID (type "<" to cancel):' });
    if (name === '<' || !name.trim()) return;
    const model = name.trim();
    if (provider.models.includes(model)) {
      warn(`"${model}" already exists.`);
      await pause();
      return;
    }
    provider.models.push(model);
    saveConfig(config);
    success(`Added "${model}".`);
    await pause();
    return;
  }
}

async function renameModel(config, provider) {
  const target = await pickModel(provider, 'Select model to rename');
  if (!target) return;
  const newName = await input({ message: 'New name (type "<" to cancel):', default: target });
  if (newName === '<' || !newName.trim()) return;
  const renamed = newName.trim();
  if (renamed !== target && provider.models.includes(renamed)) {
    warn(`"${renamed}" already exists.`);
    await pause();
    return;
  }
  provider.models[provider.models.indexOf(target)] = renamed;
  saveConfig(config);
  success(`Renamed to "${renamed}".`);
  await pause();
}

async function deleteModels(config, provider) {
  const { checkbox } = await import('@inquirer/prompts');
  const choices = provider.models.map((m) => ({ name: m, value: m }));

  dim('Press <Space> to select, <Enter> to confirm, or <Enter> with 0 selected to cancel.');
  console.log();

  const selected = await checkbox({ message: 'Select model(s) to delete:', choices, pageSize: 15 });
  if (selected.length === 0) return;

  const confirmed = await confirm({ message: `Delete ${selected.length} model(s)?`, default: false });
  if (!confirmed) return;

  provider.models = provider.models.filter((m) => !selected.includes(m));
  saveConfig(config);
  success(`Deleted ${selected.length} model(s).`);
  await pause();
}

async function fetchModelsInto(config, provider) {
  if (provider.accounts.length === 0) {
    error('Need at least one account to fetch models (uses its API key).');
    await pause();
    return;
  }
  // Fetch uses an account's credentials — prefer an active one.
  const account = provider.accounts.find((a) => a.status === 'active') || provider.accounts[0];

  const { fetchModels } = await import('./models.js');
  const fetched = await fetchModels(provider, account);
  if (!fetched || fetched.length === 0) {
    warn('No models returned. Endpoint or key may be wrong.');
    await pause();
    return;
  }

  // Auto-clean self-prefixed ids (e.g. genfity's "genfity/glm-5.2" -> "glm-5.2")
  // and record aliases back to the advertised id so upstream still gets what it
  // published. Keeps stored names routable without any hand-editing.
  const { models: cleaned, aliases } = normalizeFetchedModels(provider, fetched);
  const before = new Set(provider.models || []);
  const merged = [...new Set([...(provider.models || []), ...cleaned])].sort();
  const added = merged.filter((m) => !before.has(m)).length;
  provider.models = merged;
  if (Object.keys(aliases).length) {
    provider.modelAliases = { ...(provider.modelAliases || {}), ...aliases };
  }
  saveConfig(config);
  const aliasNote = Object.keys(aliases).length ? `, ${Object.keys(aliases).length} auto-aliased` : '';
  success(`Fetched ${fetched.length} model(s) — ${added} new, ${merged.length} total${aliasNote}.`);
  await pause();
}

async function editModelsEndpoint(config, provider) {
  info('Path appended to Base URL for listing models (e.g. /models).');
  dim('Leave empty for manual-only providers.');
  const newVal = await input({
    message: 'Models endpoint (type "<" to cancel):',
    default: provider.modelsEndpoint || '',
  });
  if (newVal === '<') return;
  provider.modelsEndpoint = newVal.trim() || null;
  saveConfig(config);
  success('Models endpoint updated!');
  await pause();
}

async function pickModel(provider, message) {
  const { search } = await import('@inquirer/prompts');
  return search({
    message,
    source: async (term) => {
      term = (term || '').toLowerCase();
      const results = [];
      if (term === '' || '[0] back'.includes(term) || '0' === term) {
        results.push({ name: chalk.gray('[0] ↩️  Back'), value: null });
      }
      for (const m of provider.models) {
        if (m.toLowerCase().includes(term)) results.push({ name: m, value: m });
      }
      return results;
    },
    pageSize: 15,
  });
}

// ── Delete ──

async function deleteProvider() {
  const config = getConfig();
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  🗑️  Delete Provider(s)\n'));

    if (config.providers.length === 0) {
      error('No providers to delete!');
      await pause();
      return;
    }

    const { checkbox } = await import('@inquirer/prompts');
    
    const choices = config.providers.map(p => ({
      name: `${p.name} ${chalk.gray(`(${p.accounts.length} accts)`)}`,
      value: p.id
    }));
    
    dim('Press <Space> to select, <Enter> to confirm, or <Enter> with 0 selected to cancel.');
    console.log();
    
    const selectedIds = await checkbox({
      message: 'Select provider(s) to delete:',
      choices,
      pageSize: 15
    });

    if (selectedIds.length === 0) return;

    const confirmed = await confirm({
      message: `Delete ${selectedIds.length} provider(s)?`,
      default: false,
    });

    if (!confirmed) continue;

    config.providers = config.providers.filter((p) => !selectedIds.includes(p.id));
    if (config.lastSession && selectedIds.includes(config.lastSession.providerId)) {
      config.lastSession = null;
    }
    saveConfig(config);
    success(`Deleted ${selectedIds.length} provider(s)!`);
    await pause();
    return;
  }
}

// ── Accounts sub-menu ──

async function accountsMenu() {
  const config = getConfig();
  while (true) {
    const provider = await selectProvider(config, 'Manage accounts for');
    if (!provider) return;
    await manageAccounts(provider.id);
  }
}

// ── Shared selector (exported for launcher) ──

export async function selectProvider(configOrNull, message = 'Select provider') {
  const config = configOrNull || getConfig();

  if (config.providers.length === 0) {
    error('No providers configured. Add one first!');
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
      
      for (const p of config.providers) {
        const displayName = `${p.name} ${chalk.gray(`(${p.accounts.length} accts)`)}`;
        if (p.name.toLowerCase().includes(term)) {
          results.push({ name: displayName, value: p });
        }
      }
      
      return results;
    }
  });
}

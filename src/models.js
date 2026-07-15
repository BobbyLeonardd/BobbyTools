import { search, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfig, saveConfig } from './config.js';
import { resolveBaseUrl, getApiKey } from './helpers.js';
import { success, warn, info, dim } from './ui.js';

export async function fetchModels(provider, account) {
  if (!provider.modelsEndpoint) return null;

  try {
    const baseUrl = resolveBaseUrl(provider, account);
    const apiKey = getApiKey(provider, account);
    const url = `${baseUrl}${provider.modelsEndpoint}`;

    info(`Fetching models from ${chalk.dim(url)}...`);

    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

    if (!res.ok) {
      warn(`Failed to fetch models (HTTP ${res.status})`);
      return null;
    }

    const data = await res.json();
    const raw = data.data || data.models || data.result || data;
    const models = (Array.isArray(raw) ? raw : [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean)
      .sort();

    return models.length > 0 ? models : null;
  } catch (err) {
    warn(`Could not fetch models: ${err.message}`);
    return null;
  }
}

export async function selectModel(provider, account) {
  let models = await fetchModels(provider, account);

  // Always get fresh config so we don't rely on stale in-memory data
  const config = getConfig();
  const p = config.providers.find((pr) => pr.id === provider.id);

  if (models && models.length > 0) {
    // Cache fetched models
    if (p) {
      p.models = models;
      saveConfig(config);
    }
  } else if (p && p.models && p.models.length > 0) {
    info('Using cached model list');
    models = p.models;
  } else if (provider.models && provider.models.length > 0) {
    info('Using cached model list');
    models = provider.models;
  }

  const selected = await search({
    message: `Select Model (${provider.name})`,
    source: async (term) => {
      term = term || '';
      const termLower = term.toLowerCase();
      
      const results = [];
      const showBack = termLower === '' || '[0] back'.includes(termLower) || '0' === termLower;
      const showManual = termLower === '' || '[m] manual custom'.includes(termLower) || 'm' === termLower;
      
      if (showBack) {
        results.push({ name: chalk.gray('[0] ↩️  Back'), value: null });
      }
      if (showManual) {
        results.push({ name: chalk.cyan('[m] ✍️  Enter model manually'), value: '__manual__' });
      }
      
      if (models && models.length > 0) {
        for (const m of models) {
          if (m.toLowerCase().includes(termLower)) {
            results.push({ name: m, value: m });
          }
        }
      }
      
      return results;
    },
    pageSize: 15
  });

  if (selected === null) return null;

  if (selected === '__manual__') {
    const model = await input({ message: 'Model name/ID (type "<" to go back):' });
    if (model === '<') return selectModel(provider, account);
    if (!model) return selectModel(provider, account);

    // Cache manual entry
    const config = getConfig();
    const p = config.providers.find((pr) => pr.id === provider.id);
    if (p) {
      if (!p.models) p.models = [];
      if (!p.models.includes(model)) {
        p.models.push(model);
        saveConfig(config);
      }
    }
    // Update the in-memory provider reference too, just in case
    if (!provider.models) provider.models = [];
    if (!provider.models.includes(model)) provider.models.push(model);
    return model;
  }

  return selected;
}

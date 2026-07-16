import { readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.bobbytools');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CONFIG_BACKUP = join(CONFIG_DIR, 'config.backup.json');

const DEFAULT_CONFIG = {
  version: 3,
  lastSession: null,
  providers: [],
};

export function getConfigPath() {
  return CONFIG_DIR;
}

export function getConfig() {
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    let config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    config = migrateConfig(config);
    return { ...DEFAULT_CONFIG, ...config };
  } catch {
    // Main config corrupted — try backup
    if (existsSync(CONFIG_BACKUP)) {
      try {
        let config = JSON.parse(readFileSync(CONFIG_BACKUP, 'utf-8'));
        config = migrateConfig(config);
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
        return { ...DEFAULT_CONFIG, ...config };
      } catch {
        // Backup also bad
      }
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

const CONFIG_TMP = join(CONFIG_DIR, 'config.tmp.json');

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // Auto-backup before overwrite
  if (existsSync(CONFIG_FILE)) {
    try { copyFileSync(CONFIG_FILE, CONFIG_BACKUP); } catch {}
  }
  // Write-then-rename: a crash mid-write leaves the stale (valid) config.json
  // instead of a half-written one. rename is atomic on the same filesystem.
  writeFileSync(CONFIG_TMP, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(CONFIG_TMP, CONFIG_FILE);
}

// ── Migrations ──

function migrateConfig(config) {
  if (config.version >= 3) return config;

  // v1 -> v2 (credentials)
  for (const provider of config.providers || []) {
    // baseUrl → baseUrlTemplate
    if (provider.baseUrl && !provider.baseUrlTemplate) {
      provider.baseUrlTemplate = provider.baseUrl;
      delete provider.baseUrl;
    }

    // envKeyName/envBaseName → credentials[] + baseUrlEnvVar
    if (!provider.credentials) {
      provider.credentials = [
        {
          label: 'API Key',
          key: 'apiKey',
          envVar: provider.envKeyName || 'OPENAI_API_KEY',
          secret: true,
          required: true,
        },
      ];
    }
    if (!provider.baseUrlEnvVar) {
      provider.baseUrlEnvVar = provider.envBaseName || 'OPENAI_BASE_URL';
    }
    delete provider.envKeyName;
    delete provider.envBaseName;

    // Account apiKey → credentials object
    for (const account of provider.accounts || []) {
      if (account.apiKey !== undefined && !account.credentials) {
        account.credentials = { apiKey: account.apiKey };
        delete account.apiKey;
      }
    }
    
    // defaultCli fallback
    if (!provider.defaultCli) {
      provider.defaultCli = config.settings?.defaultCli || 'opencode';
    }
  }

  // Cleanup old global keys
  if (config.cliTools) delete config.cliTools;
  if (config.settings) delete config.settings;

  config.version = 3;
  return config;
}

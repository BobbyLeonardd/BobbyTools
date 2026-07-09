import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { showBanner, VERSION, dim, info, success, error, warn, divider, clearScreen, pause } from './ui.js';
import { getConfig, saveConfig, getConfigPath } from './config.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { manageProviders } from './providers.js';
import { launchSession, quickLaunch } from './launcher.js';
import { PROVIDER_TEMPLATES } from './templates.js';

export async function main() {
  // Handle CLI args
  const args = process.argv.slice(2);

  if (args.includes('-v') || args.includes('--version')) {
    console.log(`bobbytools v${VERSION}`);
    return;
  }

  if (args.includes('-h') || args.includes('--help')) {
    showHelp();
    return;
  }

  try {
    if (args[0] === 'go') {
      clearScreen();
      showBanner();
      await quickLaunch();
      return;
    }

    if (args[0] === 'list') {
      clearScreen();
      showBanner();
      showFullStatus();
      return;
    }

    if (args[0] === 'update') {
      clearScreen();
      showBanner();
      await updateBobbyTools();
      return;
    }

    // Interactive mode
    while (true) {
      try {
        await mainMenu();
        break; // Only reached if process.exit is skipped somehow
      } catch (err) {
        // Graceful Ctrl+C handling -> Return to main menu instead of exiting
        if (
          err?.name === 'ExitPromptError' ||
          err?.message?.includes('User force closed')
        ) {
          console.log();
          process.exit(0);
        }
        console.error(chalk.red(`\n  Fatal: ${err.message}`));
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(chalk.red(`\n  Fatal: ${err.message}`));
    process.exit(1);
  }
}

// ── Main menu loop ──

async function mainMenu() {
  backgroundFetch(); // Fire and forget update checker

  while (true) {
    clearScreen();
    showBanner();
    notifyUpdateIfAvailable();
    showQuickStatus();

    const config = getConfig();

    const choices = [{ name: '🚀  Start Session', value: 'launch' }];

    if (config.lastSession) {
      const p = config.providers.find((x) => x.id === config.lastSession.providerId);
      const hint = p
        ? `${p.name} / ${config.lastSession.model}`
        : 'last config';
      choices.push({
        name: `⚡  Quick Launch ${chalk.gray(`(${hint})`)}`,
        value: 'quick',
      });
    }

    choices.push(
      { name: '📦  Manage Providers', value: 'providers' },
      { name: '🔧  Settings', value: 'settings' },
      { name: '❌  Exit', value: 'exit' },
    );

    const action = await select({ message: 'What would you like to do?', choices });

    switch (action) {
      case 'launch':
        await launchSession();
        break;
      case 'quick':
        await quickLaunch();
        break;
      case 'providers':
        await manageProviders();
        break;
      case 'settings':
        await manageSettings();
        break;
      case 'exit':
        console.log();
        dim('Bye! 👋');
        process.exit(0);
    }
  }
}

// ── Status display ──

function showQuickStatus() {
  const config = getConfig();
  const pc = config.providers.length;
  const ac = config.providers.reduce((s, p) => s + p.accounts.length, 0);

  if (pc > 0) {
    dim(`${pc} provider(s), ${ac} account(s) configured`);
  } else {
    dim('No providers yet — add one to get started!');
  }
  console.log();
}

// ── Update Notification ──

function notifyUpdateIfAvailable() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const rootDir = path.join(__dirname, '..');
  const gitDir = path.join(rootDir, '.git');
  
  if (!fs.existsSync(gitDir)) return;

  try {
    const res = spawnSync('git', ['rev-list', 'HEAD..origin/main', '--count'], { cwd: rootDir, encoding: 'utf8' });
    if (res.status === 0) {
      const count = parseInt(res.stdout.trim(), 10);
      if (count > 0) {
        console.log(chalk.yellow(`  ✨ Update tersedia (${count} commits)! Ketik ${chalk.bold('bobby update')} untuk memperbarui.\n`));
      }
    }
  } catch (e) {
    // Ignore errors (git not found, etc)
  }
}

function backgroundFetch() {
  const config = getConfig();
  const now = Date.now();
  // Check once every 12 hours
  if (config.lastUpdateCheck && now - config.lastUpdateCheck < 12 * 60 * 60 * 1000) return;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const rootDir = path.join(__dirname, '..');
  const gitDir = path.join(rootDir, '.git');
  
  if (!fs.existsSync(gitDir)) return;

  try {
    const child = spawn('git', ['fetch', 'origin', 'main'], {
      cwd: rootDir,
      detached: true,
      stdio: 'ignore' // Silently fetch in background
    });
    child.unref();

    config.lastUpdateCheck = now;
    saveConfig(config);
  } catch (e) {}
}

function showFullStatus() {
  const config = getConfig();

  if (config.providers.length === 0) {
    dim('No providers configured.');
    return;
  }

  for (const p of config.providers) {
    const credLabels = p.credentials.map((c) => c.label).join(', ');
    console.log(
      chalk.bold(`  📦 ${p.name}`) + chalk.gray(` | ${p.baseUrlTemplate}`),
    );
    dim(`Credentials: ${credLabels}`);

    if (p.accounts.length === 0) {
      dim('No accounts');
    } else {
      for (const a of p.accounts) {
        const status = a.status === 'active' ? chalk.green('●') : chalk.red('●');
        const current = p.lastAccountId === a.id ? chalk.yellow(' ← current') : '';
        console.log(`    ${status} ${a.name} (used ${a.usageCount}x)${current}`);
      }
    }
    console.log();
  }
}

// ── Settings ──

async function manageSettings() {
  const config = getConfig();

  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  🔧 Settings\n'));

    const action = await select({
      message: 'Settings',
      choices: [
        { name: 'Manage CLI Tools list', value: 'cliTools' },
        {
          name: chalk.gray(`Config: ${getConfigPath()}`),
          value: 'info',
          disabled: true,
        },
        { name: '↩️  Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    if (action === 'cliTools') {
      await manageCliTools(config);
    }
  }
}

async function manageCliTools(config) {
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  🛠️ Manage CLI Tools\n'));

    const action = await select({
      message: `CLI Tools: ${config.cliTools.join(', ')}`,
      choices: [
        { name: '➕  Add', value: 'add' },
        { name: '🗑️   Remove', value: 'remove' },
        { name: '↩️   Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    if (action === 'add') {
      const name = await input({ message: 'CLI command name (type "<" to cancel):' });
      if (name === '<') continue;
      if (name && !config.cliTools.includes(name)) {
        config.cliTools.push(name);
        saveConfig(config);
        success(`"${name}" added!`);
        await pause();
      }
    }

    if (action === 'remove') {
      if (config.cliTools.length <= 1) {
        error('Need at least one CLI tool.');
        await pause();
        continue;
      }
      const tool = await select({
        message: 'Remove which?',
        choices: [
          ...config.cliTools.map((t) => ({ name: t, value: t })),
          { name: chalk.gray('↩️  Back'), value: 'back' },
        ],
      });
      if (tool === 'back') continue;
      config.cliTools = config.cliTools.filter((t) => t !== tool);
      saveConfig(config);
      success(`"${tool}" removed!`);
      await pause();
    }
  }
}

// ── Help ──

function showHelp() {
  showBanner();
  console.log(chalk.white.bold('  Usage:'));
  console.log(chalk.gray('    bobby') + '           Interactive menu');
  console.log(chalk.gray('    bobby go') + '        Quick launch (last session)');
  console.log(chalk.gray('    bobby list') + '      Show all providers & accounts');
  console.log(chalk.gray('    bobby update') + '    Update BobbyTools from GitHub');
  console.log(chalk.gray('    bobby -v') + '        Version');
  console.log(chalk.gray('    bobby -h') + '        This help');
  console.log();
  console.log(chalk.white.bold('  Flow:'));
  console.log(chalk.gray(`    1. Add provider (from ${PROVIDER_TEMPLATES.length} templates or custom)`));
  console.log(chalk.gray('    2. Add accounts (API keys) to the provider'));
  console.log(chalk.gray('    3. Start Session → pick provider → account → model → CLI'));
  console.log(chalk.gray('    4. BobbyTools launches your CLI with the right env vars'));
  console.log();
  console.log(chalk.white.bold('  Round Robin:'));
  console.log(chalk.gray('    Accounts do NOT auto-rotate. You stay on the same account'));
  console.log(chalk.gray('    until YOU pick "Next (Round Robin)" to switch. No wasted quota.'));
  console.log();
}

// ── Update ──

async function updateBobbyTools() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const rootDir = path.join(__dirname, '..');
  
  console.log();
  divider();
  info(chalk.bold('Checking for updates...'));

  const gitDir = path.join(rootDir, '.git');
  if (!fs.existsSync(gitDir)) {
    error('Cannot update via git. This installation was not cloned from GitHub.');
    warn('If you installed via npm directly, try: npm update -g bobbytools');
    return;
  }

  info('Pulling latest changes from GitHub (origin main)...');
  
  const runCmd = (command, args, cwd) => new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: true, cwd });
    child.on('error', (err) => resolve({ code: 1, err }));
    child.on('close', (code) => resolve({ code }));
  });

  const pullResult = await runCmd('git', ['pull', 'origin', 'main'], rootDir);
  
  if (pullResult.code !== 0) {
    error('Failed to pull latest changes. You might have uncommitted local changes.');
    return;
  }

  info('Ensuring dependencies are up to date...');
  const npmResult = await runCmd('npm', ['install'], rootDir);

  if (npmResult.code !== 0) {
    error('Failed to update npm dependencies.');
    return;
  }

  console.log();
  success('BobbyTools is now up to date! 🎉');
  dim('Run "bobby" to start using the new version.');
  divider();
  console.log();
}

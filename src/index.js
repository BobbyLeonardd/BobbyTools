import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { showBanner, VERSION, dim, info, success, error, warn, divider, clearScreen, pause } from './ui.js';
import { getConfig, saveConfig, getConfigPath } from './config.js';
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
  while (true) {
    clearScreen();
    showBanner();
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
        {
          name: `Default CLI: ${chalk.white(config.settings.defaultCli)}`,
          value: 'defaultCli',
        },
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

    if (action === 'defaultCli') {
      const cli = await select({
        message: 'Set default CLI tool',
        choices: config.cliTools.map((t) => ({ name: t, value: t })),
      });
      config.settings.defaultCli = cli;
      saveConfig(config);
      success(`Default CLI → "${cli}"`);
      await pause();
    }

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
        choices: config.cliTools.map((t) => ({ name: t, value: t })),
      });
      config.cliTools = config.cliTools.filter((t) => t !== tool);
      if (config.settings.defaultCli === tool) {
        config.settings.defaultCli = config.cliTools[0];
      }
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

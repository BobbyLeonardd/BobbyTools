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

    if (args[0] === 'serve') {
      const portIndex = args.indexOf('-p') !== -1 ? args.indexOf('-p') : args.indexOf('--port');
      const port = portIndex !== -1 ? parseInt(args[portIndex + 1]) : 13337;
      clearScreen();
      showBanner();
      const { startRouterServer } = await import('./server.js');
      await startRouterServer(port, false);
      return;
    }
    
    if (args[0] === 'serve-bg') {
      const { startRouterServer } = await import('./server.js');
      await startRouterServer(13337, true);
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

    const routerRunning = await isRouterRunning();

    if (routerRunning) {
      choices.push({ name: '🛑  Stop Web Dashboard (Running)', value: 'stop_serve' });
      choices.push({ name: '📜  Router Activity Logs', value: 'router_logs' });
    } else {
      choices.push({ name: '🌐  Start Web Dashboard (Background)', value: 'serve_bg' });
    }

    choices.push(
      { name: '📦  Manage Providers', value: 'providers' },
      { name: '🔧  Settings', value: 'settings' },
      { name: '📖  Cara Pakai (Tutorial)', value: 'tutorial' },
      { name: '❌  Exit', value: 'exit' },
    );

    const action = await select({ message: 'What would you like to do?', choices, pageSize: 15 });

    switch (action) {
      case 'launch':
        await launchSession();
        break;
      case 'quick':
        await quickLaunch();
        break;
      case 'serve_bg':
        clearScreen();
        showBanner();
        console.log(chalk.cyan('🚀 Memulai Web Dashboard di background...'));
        const scriptPath = process.argv[1];
        const child = spawn(process.argv[0], [scriptPath, 'serve-bg'], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        
        // Auto-launch browser
        const url = 'http://127.0.0.1:13337';
        const { exec } = await import('child_process');
        const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${startCmd} ${url}`);

        console.log(chalk.green('✅ Web Dashboard berhasil jalan di background!'));
        console.log(chalk.white('Browser otomatis dibuka ke: ') + chalk.yellow.bold(url));
        console.log(chalk.gray('Terminal ini bebas ditutup.\n'));
        await pause();
        break;
      case 'stop_serve':
        try {
          await fetch('http://127.0.0.1:13337/api/shutdown', { method: 'POST' });
          success('Web Dashboard berhasil dimatikan.');
        } catch (e) {
          error('Gagal mematikan dashboard: ' + e.message);
        }
        await pause();
        break;
      case 'router_logs':
        await viewRouterLogs();
        break;
      case 'providers':
        await manageProviders();
        break;
      case 'settings':
        await manageSettings();
        break;
      case 'tutorial':
        await showTutorial();
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

// ── Router Logs ──

async function viewRouterLogs() {
  clearScreen();
  showBanner();
  console.log(chalk.bold('  📜 Router Activity Logs\n'));
  try {
    const res = await fetch('http://127.0.0.1:13337/api/logs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const logs = await res.json();
    
    if (logs.length === 0) {
      console.log(chalk.gray('  Belum ada request yang masuk ke router.'));
    } else {
      for (const l of logs) {
        const d = new Date(l.timestamp);
        const timeStr = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
        let statusText = chalk.yellow('Processing...');
        if(l.status === 'success') statusText = chalk.green('Success');
        else if(l.status === 'limit') statusText = chalk.red('Limit (429)');
        else if(l.status === 'error') statusText = chalk.red('Error');
        
        console.log(`  [${chalk.gray(timeStr)}] ${chalk.cyan(l.provider)} (${chalk.blue(l.account)}) -> ${chalk.white(l.model)} : ${statusText}`);
      }
    }
  } catch (err) {
    error('Gagal mengambil log dari router: ' + err.message);
  }
  console.log();
  await pause();
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
      pageSize: 15,
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
      pageSize: 15,
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
        pageSize: 15,
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

// ── Tutorial ──

async function showTutorial() {
  clearScreen();
  showBanner();
  console.log(chalk.cyan.bold('  📖 PANDUAN CARA PAKAI BOBBYTOOLS\n'));
  
  console.log(chalk.white.bold('  MODE 1: Classic Launcher (Paling Gampang)'));
  console.log(chalk.gray('  Cocok buat lu yang cuma mau jalanin opencode/aider pake 1 akun API.'));
  console.log(chalk.white('  1. Pilih ') + chalk.yellow('📦 Manage Providers') + chalk.white(' -> ') + chalk.yellow('➕ Add Provider') + chalk.white(' (Misal: Groq)'));
  console.log(chalk.white('  2. Pilih ') + chalk.yellow('Manage Accounts') + chalk.white(' -> ') + chalk.yellow('➕ Add Account') + chalk.white(' -> Masukin API Key lu.'));
  console.log(chalk.white('  3. Balik ke menu awal, pilih ') + chalk.yellow('🚀 Start Session') + chalk.white('.'));
  console.log(chalk.white('  4. Pilih Provider -> Akun -> Model -> Target CLI (misal: opencode).'));
  console.log(chalk.gray('  Beres! Bobby bakal ngebuka CLI lu dengan env vars yang udah kesuntik.\n'));

  console.log(chalk.white.bold('  MODE 2: 9Router Mode + Web Dashboard (Auto-Rotate Anti Limit)'));
  console.log(chalk.gray('  Cocok kalo lu punya banyak API Key gratisan dan males gonta-ganti pas kena limit.'));
  console.log(chalk.white('  1. Daftarin provider dan masukin SEMUA akun/API key lu (kayak langkah di atas).'));
  console.log(chalk.white('  2. Dari menu utama, pilih ') + chalk.yellow('🌐 Start Web Dashboard (Background)'));
  console.log(chalk.white('  3. Terminal lu bakal ngasih URL ') + chalk.cyan('http://127.0.0.1:13337') + chalk.white('. Lu bebas nutup terminalnya.'));
  console.log(chalk.white('  4. Set Env Vars CLI lu biar nembak ke router (localhost:13337).'));
  console.log(chalk.gray('     Mac/Linux: ') + chalk.yellow('export OPENAI_BASE_URL="http://127.0.0.1:13337/v1"'));
  console.log(chalk.gray('     Windows  : ') + chalk.yellow('$env:OPENAI_BASE_URL="http://127.0.0.1:13337/v1"'));
  console.log(chalk.white('  5. Panggil CLI lu pake format model: ') + chalk.yellow('<provider>/<model>'));
  console.log(chalk.gray('     Contoh: opencode -m groq/llama3-70b-8192\n'));
  
  console.log(chalk.cyan.bold('  PRO-TIPS:'));
  console.log(chalk.gray('  - Ketik ') + chalk.yellow('bobby go') + chalk.gray(' di terminal buat langsung ngebuka sesi terakhir lu tanpa lewat menu.'));
  console.log(chalk.gray('  - Kalo akun lu limit di Router Mode, Bobby otomatis geser ke akun selanjutnya (Load Balancing).'));
  console.log(chalk.gray('  - Kalo SEMUA akun lo abis, Bobby otomatis loncat nyari provider lain yang punya model yang sama (Universal Fallback)!'));
  console.log();
  await pause();
}

// ── Help ──

function showHelp() {
  showBanner();
  console.log(chalk.white.bold('  Usage:'));
  console.log(chalk.gray('    bobby') + '           Interactive menu');
  console.log(chalk.gray('    bobby go') + '        Quick launch (last session)');
  console.log(chalk.gray('    bobby serve') + '     Start Local AI Router (foreground)');
  console.log(chalk.gray('    bobby serve-bg') + '  Start Local AI Router (background / daemon)');
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
  console.log(chalk.white.bold('  Smart Auto-Rotate & Fallback (v3.0.0):'));
  console.log(chalk.gray('    In Router Mode (serve), BobbyTools automatically rotates API keys'));
  console.log(chalk.gray('    when hitting a 429 limit, and will fallback to a different provider'));
  console.log(chalk.gray('    if all accounts are exhausted (Universal Fallback).'));
  console.log();
}

// ── Update ──

async function updateBobbyTools() {
  console.log();
  divider();
  info(chalk.bold('Cara Update BobbyTools:'));
  console.log();
  console.log(chalk.white('  Karena lu instal via NPM, jalanin command ini di terminal:\n'));
  console.log(chalk.yellow.bold('  npm update -g bobbytools\n'));
  divider();
  console.log();
  await pause();
}

async function isRouterRunning() {
  try {
    const res = await fetch('http://127.0.0.1:13337/api/ping', { method: 'GET' });
    if (res.ok) return true;
  } catch (e) {
    return false;
  }
  return false;
}

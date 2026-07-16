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
        { name: chalk.red('⚠️  Factory Reset Semua Data'), value: 'reset' },
        {
          name: chalk.gray(`Config File: ${getConfigPath()}`),
          value: 'info',
          disabled: true,
        },
        { name: '↩️  Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    if (action === 'reset') {
      const confirm = await select({
        message: chalk.red('BAHAYA: Hapus SEMUA data API Key, Akun, dan Provider secara permanen?'),
        choices: [
          { name: 'Tidak, kembali', value: false },
          { name: chalk.red('Ya, reset semua!'), value: true },
        ]
      });

      if (confirm) {
        config.providers = [];
        delete config.cliTools;
        delete config.settings;
        saveConfig(config);
        success('Factory Reset berhasil! BobbyTools kembali suci.');
        await pause();
        return;
      }
    }
  }
}

// ── Tutorial ──

async function showTutorial() {
  clearScreen();
  showBanner();
  console.log(chalk.cyan.bold('  📖 PANDUAN LENGKAP BOBBYTOOLS (Biar Lo Ga Keder)\n'));
  
  console.log(chalk.gray('  Duduk manis. Baca bentar, gue tulis ini sekali biar gak ditanyain mulu.'));
  console.log(chalk.gray('  Konsep intinya cuma satu: lo simpen semua API key di sini, Bobby yang ngatur'));
  console.log(chalk.gray('  giliran + rotasi pas kena limit. Ada dua cara makenya:\n'));
  console.log(chalk.white('    1. Mode Web/Router  ') + chalk.gray('- satu server buat semua CLI, auto-rotate nyala. (rekomendasi)'));
  console.log(chalk.white('    2. Mode Klasik      ') + chalk.gray('- launcher interaktif, sekali jalan satu sesi.\n'));

  divider();
  console.log(chalk.white.bold('\n  🔥 MODE 1: WEB / ROUTER\n'));
  console.log(chalk.gray('  Bobby jalan jadi server lokal (port 13337). CLI lo nembak ke situ, Bobby'));
  console.log(chalk.gray('  yang nyuntikin key asli + muterin akun kalo ada yang limit.\n'));

  console.log(chalk.white('  Langkah 1. ') + chalk.gray('Dari menu utama, pilih ') + chalk.yellow('🌐 Start Web Dashboard (Background)') + chalk.gray('.'));
  console.log(chalk.gray('             Browser kebuka otomatis ke ') + chalk.cyan('http://127.0.0.1:13337') + chalk.gray('. Terminal ini boleh ditutup,'));
  console.log(chalk.gray('             server-nya udah jadi daemon di background.'));
  console.log(chalk.white('  Langkah 2. ') + chalk.gray('Di web: ') + chalk.yellow('Add Provider') + chalk.gray(' (misal Groq) -> tambahin SEMUA akun/key yang lo punya.'));
  console.log(chalk.gray('             Makin banyak akun, makin lama lo kebal limit.'));
  console.log(chalk.white('  Langkah 3. ') + chalk.gray('Buka terminal ngoding lo (aider/opencode/cursor/claude), arahin ke Bobby:'));
  console.log(chalk.gray('             Mac/Linux/GitBash : ') + chalk.yellow('export OPENAI_BASE_URL="http://127.0.0.1:13337/v1"'));
  console.log(chalk.gray('             Windows PowerShell: ') + chalk.yellow('$env:OPENAI_BASE_URL="http://127.0.0.1:13337/v1"'));
  console.log(chalk.gray('             Windows CMD       : ') + chalk.yellow('set OPENAI_BASE_URL=http://127.0.0.1:13337/v1'));
  console.log(chalk.gray('             API key-nya isi apa aja (') + chalk.yellow('sk-bobby') + chalk.gray('), Bobby gak peduli — yang asli dia yang pegang.'));
  console.log(chalk.white('  Langkah 4. ') + chalk.gray('Panggil model pake format ') + chalk.yellow('<provider>/<model>') + chalk.gray(':'));
  console.log(chalk.gray('             ') + chalk.cyan('opencode -m groq/llama3-70b-8192'));
  console.log(chalk.gray('             ') + chalk.cyan('aider --model openrouter/anthropic/claude-3-haiku'));
  console.log(chalk.gray('             Nama depan (') + chalk.cyan('groq') + chalk.gray(') = nama provider lo, huruf kecil, spasi jadi "-".\n'));

  console.log(chalk.green('  Yang kejadian di belakang layar:'));
  console.log(chalk.gray('  • ') + chalk.white('Auto-rotate: ') + chalk.gray('akun kena 429/401/402 -> Bobby lompat ke akun aktif berikutnya, retry, CLI lo gak tau apa-apa.'));
  console.log(chalk.gray('  • ') + chalk.white('Cooldown:    ') + chalk.gray('akun yang kena limit auto-balik "aktif" setelah nunggu sebentar. Gak perlu reset manual.'));
  console.log(chalk.gray('  • ') + chalk.white('Fallback:    ') + chalk.gray('kalo semua akun 1 provider abis, Bobby cari provider LAIN yang punya model sama.\n'));

  divider();
  console.log(chalk.white.bold('\n  💻 MODE 2: KLASIK (LAUNCHER)\n'));
  console.log(chalk.gray('  Buat yang males buka browser & males ngetik export. Sekali jalan, satu sesi.\n'));
  console.log(chalk.white('  Langkah 1. ') + chalk.gray('Ketik ') + chalk.yellow('bobby') + chalk.gray('.'));
  console.log(chalk.white('  Langkah 2. ') + chalk.yellow('📦 Manage Providers') + chalk.gray(' -> Add Provider (sekalian isi Target CLI, misal opencode).'));
  console.log(chalk.white('  Langkah 3. ') + chalk.yellow('👤 Manage Accounts') + chalk.gray(' -> masukin API key lo.'));
  console.log(chalk.white('  Langkah 4. ') + chalk.gray('Balik ke menu, ') + chalk.yellow('🚀 Start Session') + chalk.gray(' -> pilih Provider, Akun, Model.'));
  console.log(chalk.gray('             Bobby nutup dirinya sendiri, ngebuka CLI target dengan key udah kesuntik di memori.\n'));

  divider();
  console.log(chalk.white.bold('\n  🧠 NGATUR MODEL (Manage Providers -> Edit Provider -> Edit Models)\n'));
  console.log(chalk.gray('  Tiap provider punya daftar model sendiri. Di menu Edit Models lo bisa:'));
  console.log(chalk.gray('  • ') + chalk.white('Add/Rename/Delete') + chalk.gray(' model manual.'));
  console.log(chalk.gray('  • ') + chalk.white('Fetch/Refresh') + chalk.gray(' — narik daftar model langsung dari API provider (kalo dia punya endpoint /models).'));
  console.log(chalk.gray('  • ') + chalk.white('Set Models Endpoint') + chalk.gray(' — path buat nge-fetch tadi. Kosongin = provider jadi manual-only.\n'));
  console.log(chalk.yellow('  ⚠  Provider dengan Base URL lokal (localhost/127.0.0.1) = manual-only.'));
  console.log(chalk.gray('     Fetch-nya sengaja dimatiin biar gak nyerep model dari router sendiri (bikin loop & nama aneh).'));
  console.log(chalk.gray('     Jadi buat provider lokal, tambahin model-nya pake tangan aja.\n'));

  divider();
  console.log(chalk.cyan.bold('\n  💤 TIPS MALAS:'));
  console.log(chalk.gray('  • ') + chalk.yellow('bobby go') + chalk.gray('   — langsung buka sesi terakhir, tanpa klik-klik.'));
  console.log(chalk.gray('  • ') + chalk.yellow('bobby list') + chalk.gray(' — intip semua provider + akun tanpa masuk menu.'));
  console.log(chalk.gray('  • ') + chalk.yellow('bobby -h') + chalk.gray('   — daftar semua perintah.'));
  console.log(chalk.gray('  • Config lo polos di ') + chalk.cyan('~/.bobbytools/config.json') + chalk.gray('. Jangan commit ke git publik.\n'));
  await pause();
}

// ── Help ──

function showHelp() {
  showBanner();
  console.log(chalk.cyan.bold('  📚 DAFTAR PERINTAH (COMMANDS) BOBBYTOOLS:\n'));
  
  console.log(chalk.yellow('  1. 💻 bobby'));
  console.log(chalk.white('     Ngebuka menu utama interaktif (buat nambah akun, pilih model, dll).\n'));
  
  console.log(chalk.yellow('  2. 🚀 bobby go'));
  console.log(chalk.white('     Jalan pintas orang malas. Langsung ngebuka sesi terakhir lu tanpa harus lewat menu klik-klik lagi.\n'));
  
  console.log(chalk.yellow('  3. 🌐 bobby serve'));
  console.log(chalk.white('     Nyalain Local AI Router / Web Dashboard tapi di depan layar (foreground). Kalo terminalnya lu tutup, servernya ikut mati.\n'));
  
  console.log(chalk.yellow('  4. 👻 bobby serve-bg'));
  console.log(chalk.white('     Nyalain Local AI Router / Web Dashboard di belakang layar (background). Terminal bebas lu tutup, server tetep jalan jadi setan/daemon, plus otomatis ngebukain browser ke http://127.0.0.1:13337.\n'));
  
  console.log(chalk.yellow('  5. 📜 bobby list'));
  console.log(chalk.white('     Nampilin daftar lengkap semua Provider dan API Key (Akun) yang udah lu simpen, tanpa masuk ke menu.\n'));
  
  console.log(chalk.yellow('  6. 🔄 bobby update'));
  console.log(chalk.white('     Ngasih tau instruksi cara update BobbyTools ke versi paling baru dari NPM.\n'));
  
  console.log(chalk.yellow('  7. ℹ️  bobby -v (atau --version)'));
  console.log(chalk.white('     Ngecek versi BobbyTools yang lagi lu pake sekarang.\n'));
  
  console.log(chalk.yellow('  8. ❓ bobby -h (atau --help)'));
  console.log(chalk.white('     Nampilin contekan/bantuan ini.\n'));

  console.log(chalk.white.bold('  🔥 Flow Mode Klasik:'));
  console.log(chalk.gray('    1. Add provider -> 2. Add accounts -> 3. Start Session -> 4. Gas Ngoding'));
  console.log();
  console.log(chalk.white.bold('  🔥 Flow Mode Router:'));
  console.log(chalk.gray('    1. bobby serve-bg -> 2. export OPENAI_BASE_URL="http://127.0.0.1:13337/v1" -> 3. Gas Ngoding (Anti-Limit 429)'));
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

import chalk from 'chalk';
import { createRequire } from 'module';

// Single source of truth: read the version straight from package.json so `bobby
// -v`, the banner, and `bobby update`'s compare can never drift from what npm
// actually published. createRequire loads JSON on every Node 18+ without the
// import-assertion syntax that changed between versions.
export const VERSION = createRequire(import.meta.url)('../package.json').version;

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');

export function showBanner() {
  const logo = `
    ____        __    __        ______            __    
   / __ )____  / /_  / /_  __  /_  __/___  ____  / /____
  / __  / __ \\/ __ \\/ __ \\/ / / / / / __ \\/ __ \\/ / ___/
 / /_/ / /_/ / /_/ / /_/ / /_/ / / / /_/ / /_/ / /__  / 
/_____/\\____/_.___/_.___/\\__, /_/  \\____/\\____/_/____/  
                        /____/                          
`;
  console.log(BRAND.bold(logo));
  console.log(ACCENT.bold(`                                           v${VERSION}`));
  console.log(chalk.gray('        Ngatur Provider AI & Launcher CLI'));
  console.log(ACCENT('  ───────────────────────────────────────────────────'));
  console.log();
}

// Account status marker. Shape carries the meaning (filled ● = active, hollow
// ○ = limited) so red/green colorblind users can still tell them apart — color
// alone fails ~8% of men. `withText` appends the word for standalone lines.
export function statusDot(status, withText = false) {
  const active = status === 'active';
  const glyph = active ? '●' : '○';
  const tint = active ? chalk.green : chalk.red;
  return tint(withText ? `${glyph} ${status}` : glyph);
}

export const success = (msg) => console.log(chalk.green('  ✔ ') + msg);
export const error = (msg) => console.log(chalk.red('  ✖ ') + msg);
export const warn = (msg) => console.log(chalk.yellow('  ⚠ ') + msg);
export const info = (msg) => console.log(chalk.cyan('  ℹ ') + msg);
export const dim = (msg) => console.log(chalk.gray('    ' + msg));
export const label = (key, val) => console.log(chalk.gray(`    ${key}: `) + chalk.white(val));
export const divider = () => console.log(chalk.gray('  ─────────────────────────────────'));

export function clearScreen() {
  console.clear();
}

export async function pause() {
  console.log();
  const { input } = await import('@inquirer/prompts');
  await input({ message: chalk.gray('Pencet Enter buat lanjut (atau ketik "<" buat balik)...') });
}

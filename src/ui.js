import chalk from 'chalk';

export const VERSION = '2.0.0';

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');

export function showBanner() {
  console.log();
  console.log(BRAND.bold('  ⚡ BobbyTools ') + chalk.gray(`v${VERSION}`));
  console.log(chalk.gray('     AI Provider Manager & CLI Launcher'));
  console.log(BRAND('  ──────────────────────────────────────'));
  console.log();
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
  await input({ message: chalk.gray('Press Enter to continue (or type "<" to go back)...') });
}

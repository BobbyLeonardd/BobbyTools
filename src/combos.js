import { select, input, confirm, Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfig, saveConfig } from './config.js';
import { success, error, warn, info, dim, divider, clearScreen, pause, showBanner } from './ui.js';

// A combo is a user-defined ordered fallback list stored in config.combos as
// { comboName: ["provider/model", ...] }. The router (resolveComboSpecs) tries
// each spec in turn, dropping to the next only when the current model is out of
// live keys everywhere. This menu is the CLI surface for creating/editing them;
// the dashboard has an equivalent panel. Both write the same config.combos shape.

export async function manageCombos() {
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  🔀 Manage Combos\n'));
    dim('  Combo itu daftar model cadangan lo sendiri, urut. Panggil pake namanya');
    dim('  (misal bobby -m daily-driver), nanti router nyoba tiap model urutan,');
    dim('  turun ke bawah cuma pas yang atas udah abis semua key-nya.\n');

    const config = getConfig();
    const combos = config.combos || {};
    const names = Object.keys(combos);

    if (names.length > 0) {
      console.log(chalk.bold('  Combo yang udah ada:'));
      for (const name of names) {
        const specs = Array.isArray(combos[name]) ? combos[name] : [];
        console.log(`    ${chalk.cyan(name)} ${chalk.gray('->')} ${specs.map((s, i) => `${i + 1}. ${s}`).join(chalk.gray('  ->  ')) || chalk.gray('(kosong)')}`);
      }
      console.log('');
    }

    const choices = [{ name: '➕  New Combo', value: 'add' }];
    if (names.length > 0) {
      choices.push(
        { name: '✏️   Edit Combo', value: 'edit' },
        { name: '🗑️   Delete Combo', value: 'delete' },
      );
    }
    choices.push({ name: '↩️   Back', value: 'back' });

    const action = await select({ message: 'Mau ngapain?', choices, pageSize: 15 });
    if (action === 'back') return;

    switch (action) {
      case 'add': await editCombo(null); break;
      case 'edit': {
        const name = await select({
          message: 'Combo yang mana?',
          choices: [...names.map(n => ({ name: n, value: n })), new Separator(), { name: '↩️  Back', value: '__back' }],
          pageSize: 15,
        });
        if (name !== '__back') await editCombo(name);
        break;
      }
      case 'delete': {
        const name = await select({
          message: 'Hapus combo yang mana?',
          choices: [...names.map(n => ({ name: n, value: n })), new Separator(), { name: '↩️  Back', value: '__back' }],
          pageSize: 15,
        });
        if (name === '__back') break;
        if (await confirm({ message: `Hapus combo "${name}"?`, default: false })) {
          const cfg = getConfig();
          if (cfg.combos) delete cfg.combos[name];
          saveConfig(cfg);
          success(`Combo "${name}" dihapus.`);
          await pause();
        }
        break;
      }
    }
  }
}

// Build/edit the ordered spec list for one combo. `originalName` is null for a
// new combo, or the existing key when editing (allows rename).
async function editCombo(originalName) {
  const config = getConfig();
  const combos = config.combos || {};
  let steps = originalName && Array.isArray(combos[originalName]) ? [...combos[originalName]] : [];

  // Name first (prefilled when editing).
  const name = (await input({
    message: 'Nama combo (yang lo ketik di -m):',
    default: originalName || '',
    validate: (v) => {
      const t = (v || '').trim();
      if (!t) return 'Nama gak boleh kosong.';
      if (t.includes('/')) return 'Nama gak boleh ada "/" (itu keliatan kayak provider/model).';
      return true;
    },
  })).trim();

  // Inner loop: add/reorder/remove steps until the user is done.
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold(`  🔀 Combo: ${chalk.cyan(name)}\n`));
    if (steps.length === 0) {
      dim('  Belum ada model di rantai.\n');
    } else {
      console.log(chalk.bold('  Urutan fallback (paling atas dicoba duluan):'));
      steps.forEach((s, i) => console.log(`    ${chalk.gray(`${i + 1}.`)} ${s}`));
      console.log('');
    }

    const choices = [{ name: '➕  Add a model', value: 'add' }];
    if (steps.length > 0) {
      choices.push({ name: '🔃  Reorder / remove', value: 'reorder' });
    }
    choices.push(
      new Separator(),
      { name: chalk.green('💾  Save combo'), value: 'save' },
      { name: '❌  Cancel (discard)', value: 'cancel' },
    );

    const action = await select({ message: 'Edit combo', choices, pageSize: 15 });

    if (action === 'cancel') return;
    if (action === 'save') {
      if (steps.length === 0) { error('Tambahin minimal satu model dulu sebelum nyimpen.'); await pause(); continue; }
      const cfg = getConfig();
      if (!cfg.combos) cfg.combos = {};
      // Rename: drop the old key.
      if (originalName && originalName !== name) delete cfg.combos[originalName];
      if (name !== originalName && cfg.combos[name]) {
        if (!(await confirm({ message: `Combo namanya "${name}" udah ada. Timpa aja?`, default: false }))) continue;
      }
      cfg.combos[name] = [...steps];
      saveConfig(cfg);
      success(`Combo "${name}" kesimpen.`);
      await pause();
      return;
    }
    if (action === 'add') {
      const spec = await pickSpec(config);
      if (spec) {
        if (steps.includes(spec)) { warn('Model itu udah ada di rantai.'); await pause(); }
        else steps.push(spec);
      }
    }
    if (action === 'reorder') {
      steps = await reorderSteps(steps);
    }
  }
}

// Pick one provider/model spec. Offers registered models when known, plus a
// manual-entry escape hatch (a model the provider hasn't synced yet).
async function pickSpec(config) {
  const providers = config.providers || [];
  if (providers.length === 0) { warn('Belum ada provider. Tambahin dulu satu.'); await pause(); return null; }

  const provId = await select({
    message: 'Provider:',
    choices: [...providers.map(p => ({ name: p.name, value: p.id })), new Separator(), { name: '↩️  Back', value: '__back' }],
    pageSize: 15,
  });
  if (provId === '__back') return null;

  const provider = providers.find(p => p.id === provId);
  const models = Array.isArray(provider.models) ? provider.models : [];

  let model;
  if (models.length > 0) {
    model = await select({
      message: 'Model:',
      choices: [...models.map(m => ({ name: m, value: m })), new Separator(), { name: '✍️  Ketik nama model manual', value: '__manual' }],
      pageSize: 15,
    });
  } else {
    model = '__manual';
  }
  if (model === '__manual') {
    model = (await input({ message: 'Nama model:', validate: (v) => (v || '').trim() ? true : 'Gak boleh kosong.' })).trim();
  }
  return `${provId}/${model}`;
}

// Remove entries and/or move them up/down. Loops until the user is done.
async function reorderSteps(steps) {
  let s = [...steps];
  while (true) {
    clearScreen();
    showBanner();
    console.log(chalk.bold('  🔃 Reorder / remove\n'));
    s.forEach((spec, i) => console.log(`    ${chalk.gray(`${i + 1}.`)} ${spec}`));
    console.log('');

    if (s.length === 0) { dim('  Chain is empty now.\n'); return s; }

    const action = await select({
      message: 'Pilih model buat digeser/dihapus, atau kelar',
      choices: [
        ...s.map((spec, i) => ({ name: `${i + 1}. ${spec}`, value: String(i) })),
        new Separator(),
        { name: '✅  Done', value: '__done' },
      ],
      pageSize: 15,
    });
    if (action === '__done') return s;

    const idx = parseInt(action, 10);
    const op = await select({
      message: `"${s[idx]}"`,
      choices: [
        { name: '⬆️   Move up', value: 'up' },
        { name: '⬇️   Move down', value: 'down' },
        { name: chalk.red('🗑️   Remove'), value: 'remove' },
        { name: '↩️   Back', value: 'back' },
      ],
    });
    if (op === 'back') continue;
    if (op === 'remove') { s.splice(idx, 1); continue; }
    if (op === 'up' && idx > 0) { [s[idx - 1], s[idx]] = [s[idx], s[idx - 1]]; }
    if (op === 'down' && idx < s.length - 1) { [s[idx + 1], s[idx]] = [s[idx], s[idx + 1]]; }
  }
}

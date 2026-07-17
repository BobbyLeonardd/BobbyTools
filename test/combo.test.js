// Self-check for combo resolution (user-defined ordered model-fallback lists).
// Run: node test/combo.test.js
import assert from 'node:assert';
import { resolveComboSpecs } from '../src/helpers.js';

const config = {
  combos: {
    'daily-driver': ['groq/llama-3.3-70b', 'openrouter/anthropic/claude-3-haiku'],
    'Vision': ['genfity/gemini-3.5-flash'],
    'messy': ['groq/llama-3.3-70b', 'not-a-spec', '', 'openrouter/x/y'],
    'empty': [],
    'bad': 'notanarray',
  },
  providers: [],
};

// Exact name -> its spec list.
assert.deepStrictEqual(
  resolveComboSpecs(config, 'daily-driver'),
  ['groq/llama-3.3-70b', 'openrouter/anthropic/claude-3-haiku'],
  'exact combo name resolves to its ordered specs');

// Case-insensitive match (same rule as model aliases), exact tried first.
assert.deepStrictEqual(
  resolveComboSpecs(config, 'vision'),
  ['genfity/gemini-3.5-flash'],
  'case-insensitive combo name still resolves');
assert.deepStrictEqual(
  resolveComboSpecs(config, 'VISION'),
  ['genfity/gemini-3.5-flash'],
  'upper-case combo name resolves');

// Entries without a "/" (not provider/model) are dropped so a bad line can't
// derail routing; blanks dropped too.
assert.deepStrictEqual(
  resolveComboSpecs(config, 'messy'),
  ['groq/llama-3.3-70b', 'openrouter/x/y'],
  'non-provider/model entries are filtered out');

// A real model request (not a combo name) returns null -> caller treats it as a
// plain one-element list, exactly the old behavior.
assert.strictEqual(resolveComboSpecs(config, 'groq/llama-3.3-70b'), null, 'a plain provider/model is not a combo');
assert.strictEqual(resolveComboSpecs(config, 'nope'), null, 'unknown name is not a combo');

// A combo defined as an empty array resolves to [] (caller: nothing to try ->
// falls back to plain path since length is 0).
assert.deepStrictEqual(resolveComboSpecs(config, 'empty'), [], 'empty combo list resolves to empty array');

// A combo value that isn't an array is ignored (null), never crashes.
assert.strictEqual(resolveComboSpecs(config, 'bad'), null, 'non-array combo value is ignored');

// No combos configured at all, or missing name -> null (old behavior preserved).
assert.strictEqual(resolveComboSpecs({ providers: [] }, 'daily-driver'), null, 'no combos map -> null');
assert.strictEqual(resolveComboSpecs(config, null), null, 'null name -> null');
assert.strictEqual(resolveComboSpecs(config, undefined), null, 'undefined name -> null');
assert.strictEqual(resolveComboSpecs(null, 'x'), null, 'null config -> null');

console.log('✔ combo resolution self-check passed');

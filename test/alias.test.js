// Self-check for model-alias resolution + alias-aware cross-provider fallback.
// Run: node test/alias.test.js
import assert from 'node:assert';
import { resolveModelId, providerServesModel, findFallbackProvider, normalizeFetchedModels } from '../src/helpers.js';

// ── resolveModelId: friendly name -> this provider's upstream id ──
{
  // No alias map at all → name passed through unchanged (old behavior preserved).
  assert.strictEqual(resolveModelId({ name: 'p' }, 'glm-5.2'), 'glm-5.2', 'no aliases -> as-is');
  // Alias present → mapped to the provider's own upstream spelling.
  const genfity = { name: 'genfity', modelAliases: { 'glm-5.2': 'genfity/glm-5.2' } };
  assert.strictEqual(resolveModelId(genfity, 'glm-5.2'), 'genfity/glm-5.2', 'alias maps to upstream id');
  // A name not in the map → still as-is (only listed names are remapped).
  assert.strictEqual(resolveModelId(genfity, 'gpt-4o'), 'gpt-4o', 'unlisted name -> as-is');
  // Null-safe.
  assert.strictEqual(resolveModelId(null, 'x'), 'x', 'null provider -> requested as-is');
  assert.strictEqual(resolveModelId(undefined, 'x'), 'x', 'undefined provider -> requested as-is');
}

// ── providerServesModel: exact id OR alias key both count ──
{
  const byModels = { name: 'a', models: ['glm-5.2', 'gpt-4o'] };
  assert.strictEqual(providerServesModel(byModels, 'glm-5.2'), true, 'exact model id listed');
  assert.strictEqual(providerServesModel(byModels, 'nope'), false, 'unlisted -> false');

  const byAlias = { name: 'b', models: ['GLM-5.2-Chat'], modelAliases: { 'glm-5.2': 'GLM-5.2-Chat' } };
  assert.strictEqual(providerServesModel(byAlias, 'glm-5.2'), true, 'served via alias key even though models[] spells it differently');

  // No models, no aliases → serves nothing.
  assert.strictEqual(providerServesModel({ name: 'c' }, 'glm-5.2'), false, 'nothing declared -> false');
  assert.strictEqual(providerServesModel(null, 'x'), false, 'null provider -> false');
}

// ── findFallbackProvider: the actual bug fix ──
// The old code required provider.models.includes(actualModel) — an exact string
// match that almost never held because each provider spells the model differently.
// Now a shared FRIENDLY name matches via each provider's alias map.
{
  const config = {
    providers: [
      { id: 'p1', name: 'primary', models: ['glm-5.2'], accounts: [{ status: 'limited' }] },
      // Different upstream spelling — old exact-match would MISS this.
      { id: 'p2', name: 'genfity', modelAliases: { 'glm-5.2': 'genfity/glm-5.2' }, accounts: [{ status: 'active' }] },
      // Serves the model but has no active account — must be skipped.
      { id: 'p3', name: 'dead', models: ['glm-5.2'], accounts: [{ status: 'limited' }] },
    ],
  };

  const fb = findFallbackProvider(config, 'p1', 'glm-5.2');
  assert.strictEqual(fb?.id, 'p2', 'falls back to the alias-matching provider with an active account (old exact-match would have missed it)');

  // Excludes the origin provider even if it would otherwise match.
  const none = findFallbackProvider(
    { providers: [{ id: 'only', name: 'x', models: ['m'], accounts: [{ status: 'active' }] }] },
    'only', 'm',
  );
  assert.strictEqual(none, undefined, 'origin provider is excluded from its own fallback');

  // No provider serves the model → undefined (caller returns 429).
  assert.strictEqual(findFallbackProvider(config, 'p1', 'unknown-model'), undefined, 'no server -> undefined');
  // Empty/missing config is safe.
  assert.strictEqual(findFallbackProvider({}, 'x', 'm'), undefined, 'empty config -> undefined');
}

// ── case-insensitive resolution: "GLM-5.2" asked, "glm-5.2" mapped ──
// Exact match still wins first (deterministic); case-fold only fires as a fallback.
{
  const p = { name: 'g', modelAliases: { 'glm-5.2': 'genfity/glm-5.2' } };
  assert.strictEqual(resolveModelId(p, 'GLM-5.2'), 'genfity/glm-5.2', 'case-insensitive alias hit');
  assert.strictEqual(providerServesModel({ name: 'g', models: ['GLM-5.2'] }, 'glm-5.2'), true, 'case-insensitive model match');
  // Exact beats case-fold when both a lower and exact key exist.
  const both = { name: 'g', modelAliases: { 'Model': 'EXACT', 'model': 'lower' } };
  assert.strictEqual(resolveModelId(both, 'Model'), 'EXACT', 'exact key wins over case-fold');
}

// ── normalizeFetchedModels: auto-strip self-prefix + build alias back ──
{
  const genfity = { name: 'genfity' };
  const { models, aliases } = normalizeFetchedModels(genfity, ['genfity/glm-5.2', 'genfity/gpt-5.4']);
  assert.deepStrictEqual(models, ['glm-5.2', 'gpt-5.4'], 'own-slug prefix stripped to friendly, routable names');
  assert.deepStrictEqual(aliases, { 'glm-5.2': 'genfity/glm-5.2', 'gpt-5.4': 'genfity/gpt-5.4' }, 'alias records the advertised id so upstream still gets it');

  // Ids that are NOT self-prefixed pass through untouched, no alias (old behavior).
  const clean = normalizeFetchedModels({ name: 'groq' }, ['llama-3.1', 'mixtral']);
  assert.deepStrictEqual(clean.models, ['llama-3.1', 'mixtral'], 'clean ids pass through');
  assert.deepStrictEqual(clean.aliases, {}, 'no alias when nothing was prefixed');

  // Only the provider's OWN slug is stripped — a different vendor prefix is a real
  // part of the id (e.g. OpenRouter's "anthropic/claude-3"), left alone.
  const or = normalizeFetchedModels({ name: 'openrouter' }, ['anthropic/claude-3', 'openrouter/free-model']);
  assert.deepStrictEqual(or.models, ['anthropic/claude-3', 'free-model'], 'foreign prefix kept, own slug stripped');
  assert.deepStrictEqual(or.aliases, { 'free-model': 'openrouter/free-model' }, 'alias only for the self-prefixed one');

  // Dedup + junk-safe.
  const dup = normalizeFetchedModels({ name: 'x' }, ['a', 'a', null, '', 'b']);
  assert.deepStrictEqual(dup.models, ['a', 'b'], 'deduped, null/empty dropped');
}

console.log('✔ model-alias + fallback self-check passed');

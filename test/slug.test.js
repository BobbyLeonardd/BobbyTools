// Self-check for provider slug uniqueness logic.
// Run: node test/slug.test.js
import assert from 'node:assert';
import { slugify, slugTaken, isLocalUrl, compareVersions } from '../src/helpers.js';

// slugify: lowercases, trims, collapses spaces to dashes.
assert.strictEqual(slugify('Groq'), 'groq');
assert.strictEqual(slugify('  My Router  '), 'my-router');
assert.strictEqual(slugify('My   Router'), 'my-router');
assert.strictEqual(slugify(''), '');
assert.strictEqual(slugify(undefined), '');

const config = {
  providers: [
    { id: '1', name: 'Groq' },
    { id: '2', name: 'My Router' },
  ],
};

// Adding: a name whose slug already exists is taken.
assert.strictEqual(slugTaken(config, 'Groq'), true, 'exact existing name is taken');
assert.strictEqual(slugTaken(config, 'groq'), true, 'case-insensitive collision');
assert.strictEqual(slugTaken(config, 'my   router'), true, 'whitespace-normalized collision');
assert.strictEqual(slugTaken(config, 'Groq 2'), false, 'distinct name is free');
assert.strictEqual(slugTaken(config, 'OpenRouter'), false, 'unrelated name is free');

// Renaming: excludeId lets a provider keep its own name.
assert.strictEqual(slugTaken(config, 'Groq', '1'), false, 'provider may keep its own name');
assert.strictEqual(slugTaken(config, 'My Router', '1'), true, 'cannot rename onto another provider');

// Empty/missing providers list is safe.
assert.strictEqual(slugTaken({}, 'Anything'), false, 'no providers -> nothing taken');

// isLocalUrl: catches loopback spellings so the /models aggregator skips them.
assert.strictEqual(isLocalUrl('http://127.0.0.1:13337/v1'), true, '127.0.0.1');
assert.strictEqual(isLocalUrl('http://localhost:13337/v1'), true, 'localhost');
assert.strictEqual(isLocalUrl('http://0.0.0.0:13337/v1'), true, '0.0.0.0');
assert.strictEqual(isLocalUrl('http://[::1]:13337/v1'), true, 'ipv6 loopback');
assert.strictEqual(isLocalUrl('https://ai.genfity.com'), false, 'real cloud host is not local');
assert.strictEqual(isLocalUrl('https://api.kagiro.net/v1'), false, 'real cloud host is not local');
assert.strictEqual(isLocalUrl(''), false, 'empty is not local');
assert.strictEqual(isLocalUrl(undefined), false, 'undefined is not local');

// compareVersions: numeric per-segment, so 3.10 > 3.9 (string compare gets this wrong).
assert.strictEqual(compareVersions('3.2.0', '3.1.0'), 1, 'newer minor');
assert.strictEqual(compareVersions('3.1.0', '3.2.0'), -1, 'older minor');
assert.strictEqual(compareVersions('3.1.0', '3.1.0'), 0, 'equal');
assert.strictEqual(compareVersions('3.10.0', '3.9.0'), 1, '3.10 > 3.9 (not string compare)');
assert.strictEqual(compareVersions('3.2', '3.2.0'), 0, 'missing segment counts as 0');
assert.strictEqual(compareVersions('4.0.0', '3.99.99'), 1, 'major wins');
assert.strictEqual(compareVersions('', '0.0.0'), 0, 'empty equals zero');

console.log('✔ slug + isLocalUrl + compareVersions self-check passed');

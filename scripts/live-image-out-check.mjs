// LIVE validation of image-OUTPUT translation (stage 9) against a REAL provider
// that returns a generated image. Not part of the test suite: needs network + a
// real key. Reads creds from env (never hardcoded):
//
//   VE_KEY=... VE_BASE=https://api.vectorengine.ai VE_MODEL=gemini-3.1-flash-image \
//     node scripts/live-image-out-check.mjs
//
// Flow: hit the provider's native Gemini :generateContent, get a real inlineData
// image back, then push that Gemini response through the SAME dispatcher server.js
// uses (translateResponse) and assert the image survives to Responses and degrades
// cleanly to OpenAI/Anthropic. This exercises the real generation -> translation
// path, not a synthetic fixture.
import { translateResponse } from '../src/translate.js';

const BASE = (process.env.VE_BASE || 'https://api.vectorengine.ai').replace(/\/+$/, '');
const KEY = process.env.VE_KEY;
const MODEL = process.env.VE_MODEL || 'gemini-3.1-flash-image';
if (!KEY) { console.error('set VE_KEY'); process.exit(1); }
console.log(`provider: ${BASE} | model: ${MODEL}`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✘', m); } };

// ── 1) Get a REAL generated image from the provider (native Gemini format) ──
console.log('\n[1] provider :generateContent -> inlineData image');
const r = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
  method: 'POST',
  headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ contents: [{ parts: [{ text: 'Generate a simple solid red square, 64x64 pixels. Output the image.' }] }] }),
});
const gemBody = await r.json();
if (gemBody.error) { console.error('  provider error:', gemBody.error.message); process.exit(1); }
const gParts = gemBody?.candidates?.[0]?.content?.parts || [];
const gImg = gParts.find((p) => p.inlineData || p.inline_data);
const srcData = (gImg?.inlineData || gImg?.inline_data)?.data || '';
const srcMime = (gImg?.inlineData || gImg?.inline_data)?.mimeType || (gImg?.inlineData || gImg?.inline_data)?.mime_type;
ok(!!srcData && srcData.length > 100, `provider returned inlineData (${srcMime}, ${srcData.length} b64 chars)`);
if (!srcData) { console.log('\n✘ no image from provider — cannot test'); process.exit(1); }

// ── 2) gemini -> responses: the image must survive as image_generation_call ──
console.log('\n[2] translateResponse gemini -> responses');
const resp = translateResponse(gemBody, 'gemini', 'responses');
const igItem = (resp.output || []).find((o) => o.type === 'image_generation_call');
ok(!!igItem, 'produced an image_generation_call item');
ok(igItem?.result === srcData, 'base64 preserved byte-for-byte through gemini->responses');
ok(!!igItem?.output_format, `output_format set: ${igItem?.output_format}`);

// ── 3) round-trip back: responses -> gemini, image must still be intact ──
console.log('\n[3] round-trip responses -> gemini');
const back = translateResponse(resp, 'responses', 'gemini');
const bImg = (back?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
ok((bImg?.inlineData || bImg?.inline_data)?.data === srcData, 'image survives gemini->responses->gemini round-trip');

// ── 4) graceful degradation to OpenAI Chat (no image slot) ──
console.log('\n[4] gemini -> openai (degrade, must not leak base64)');
const oai = translateResponse(gemBody, 'gemini', 'openai');
const oaiContent = oai?.choices?.[0]?.message?.content;
ok(typeof oaiContent === 'string' || oaiContent === null, 'openai content is a string/null, never an array');
ok(!JSON.stringify(oai).includes(srcData), 'raw image base64 never leaks to an openai client');
ok(/image omitted/i.test(JSON.stringify(oai)), 'image drop is marked, not silent');

// ── 5) graceful degradation to Anthropic (no image block) ──
console.log('\n[5] gemini -> anthropic (degrade, must not leak base64)');
const anth = translateResponse(gemBody, 'gemini', 'anthropic');
ok(!(anth.content || []).some((b) => b.type === 'image'), 'no bogus image block emitted to anthropic');
ok(!JSON.stringify(anth).includes(srcData), 'raw image base64 never leaks to an anthropic client');

console.log(`\n${fail === 0 ? '✔ ALL LIVE IMAGE-OUTPUT CHECKS PASSED' : '✘ SOME CHECKS FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

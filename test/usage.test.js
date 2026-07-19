// Self-check for token-usage sniffing (the fast-path observability tap).
// Run: node test/usage.test.js
//
// sniffUsage pulls {inputTokens,outputTokens,cachedTokens} out of a raw response
// body — the SAME bytes the router streams through untouched — for every wire
// format, both streamed and non-streamed. This is what feeds the usage dashboard;
// if it silently returns null the whole feature reads as "unmeasured", so the
// merge-across-frames and per-format field names are the things worth pinning.
import assert from 'node:assert';
import { sniffUsage } from '../src/translate.js';
import { extractModelPricing } from '../src/helpers.js';
import { tapTail } from '../src/server.js';

// ── NON-STREAM: one JSON body per format ──

// OpenAI / chat.completions: usage.{prompt,completion}_tokens (+ cached detail).
(function openaiNonStream() {
  const body = JSON.stringify({
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
  });
  const u = sniffUsage(body, false);
  assert.deepStrictEqual(u, { inputTokens: 12, outputTokens: 5, cachedTokens: 4 }, 'openai non-stream usage');
})();

// Anthropic /messages: usage.{input,output}_tokens (+ cache_read_input_tokens).
(function anthropicNonStream() {
  const body = JSON.stringify({
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 10 },
  });
  const u = sniffUsage(body, false);
  assert.deepStrictEqual(u, { inputTokens: 20, outputTokens: 7, cachedTokens: 10 }, 'anthropic non-stream usage');
})();

// Gemini generateContent: usageMetadata.{prompt,candidates}TokenCount.
(function geminiNonStream() {
  const body = JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9, cachedContentTokenCount: 3 },
  });
  const u = sniffUsage(body, false);
  assert.deepStrictEqual(u, { inputTokens: 30, outputTokens: 9, cachedTokens: 3 }, 'gemini non-stream usage');
})();

// ── STREAM: usage lives in the final data: frame(s) ──

// OpenAI SSE with stream_options.include_usage: usage rides the last frame.
(function openaiStream() {
  const text =
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n' +
    'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 11 } }) + '\n\n' +
    'data: [DONE]\n\n';
  const u = sniffUsage(text, true);
  assert.deepStrictEqual(u, { inputTokens: 40, outputTokens: 11 }, 'openai stream usage from final frame');
})();

// Anthropic SSE splits usage: input at message_start, output at message_delta.
// The merge must reunite them (a naive last-frame read would miss input).
(function anthropicStreamSplit() {
  const text =
    'event: message_start\n' +
    'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } }) + '\n\n' +
    'event: message_delta\n' +
    'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 13 } }) + '\n\n';
  const u = sniffUsage(text, true);
  assert.deepStrictEqual(u, { inputTokens: 50, outputTokens: 13 }, 'anthropic split-frame usage reunited');
})();

// Gemini SSE: cumulative usageMetadata on the final chunk wins.
(function geminiStream() {
  const text =
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'h' }] } }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 1 } }) + '\n\n' +
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'i' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 8 } }) + '\n\n';
  const u = sniffUsage(text, true);
  assert.deepStrictEqual(u, { inputTokens: 60, outputTokens: 8 }, 'gemini stream final cumulative usage');
})();

// ── ROBUSTNESS: bad/empty input never throws, returns null (reads as unmeasured) ──
(function robustness() {
  assert.strictEqual(sniffUsage('', false), null, 'empty body -> null');
  assert.strictEqual(sniffUsage('not json at all', false), null, 'garbage non-stream -> null');
  assert.strictEqual(sniffUsage('data: {"choices":[]}\n\n', true), null, 'stream with no usage -> null');
  // A truncated tail (multibyte char / partial frame split by USAGE_TAIL_CAP): the
  // broken first line is skipped, a later intact usage frame still lands.
  const truncated =
    '{"choices":[{"delta":{"content":"\xef\xbf' + // dangling partial UTF-8
    '\ndata: ' + JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } }) + '\n\n';
  assert.deepStrictEqual(sniffUsage(truncated, true), { inputTokens: 1, outputTokens: 2 }, 'partial leading frame skipped, later usage recovered');
})();

// ── PRICING: OpenRouter-style per-model price extraction (auto-fills cost view) ──
// OpenRouter publishes pricing.{prompt,completion} in USD PER TOKEN as strings;
// we convert to USD per 1M tokens (the editor + rollup unit) and key by the id
// the router logs. Free models ("0") and un-priced providers are skipped.
(function pricing() {
  const raw = [
    { id: 'anthropic/claude-3-haiku', pricing: { prompt: '0.00000025', completion: '0.00000125' } },
    { id: 'meta/llama-free', pricing: { prompt: '0', completion: '0' } }, // free -> skipped
    { id: 'no-price-model' },                                             // no pricing -> skipped
    'a-bare-string-id',                                                   // odd shape -> ignored
  ];
  const p = extractModelPricing(raw);
  // 0.00000025 * 1e6 = 0.25 per 1M in; 0.00000125 * 1e6 = 1.25 per 1M out.
  assert.deepStrictEqual(p['anthropic/claude-3-haiku'], { in: 0.25, out: 1.25 }, 'per-token -> per-1M, keyed by advertised id');
  assert.ok(!('meta/llama-free' in p), 'free model (price 0) skipped');
  assert.ok(!('no-price-model' in p), 'model without pricing skipped');
  assert.deepStrictEqual(extractModelPricing([]), {}, 'empty list -> {}');
  assert.deepStrictEqual(extractModelPricing(null), {}, 'non-array -> {} (never throws)');
})();

// ── TAP: the sink must fire even when the consumer breaks early ──
// Regression for the bug where cross-format translate FROM an OpenAI provider
// logged no tokens: OpenAI is the only wire format that ends on `data: [DONE]`,
// and the downstream reframer breaks on it. That early break closes tapTail via
// .return(), so a sink() placed AFTER the for-await loop never ran and usage was
// never sniffed. sink() lives in a finally now, so it must fire on early close.
await (async function tapSinkOnEarlyBreak() {
  async function* body() {
    yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n');
    yield Buffer.from('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 11 } }) + '\n\n');
    yield Buffer.from('data: [DONE]\n\n');
  }
  let captured = 'sink-never-ran';
  // Consume the tap the way the reframer does: stop as soon as [DONE] is seen.
  for await (const chunk of tapTail(body(), (tail) => { captured = sniffUsage(tail, true); })) {
    if (chunk.toString().includes('[DONE]')) break;
  }
  assert.deepStrictEqual(captured, { inputTokens: 40, outputTokens: 11 }, 'tapTail sink fires on early break (usage still sniffed)');
})();

console.log('✔ usage self-check passed (sniffUsage: openai/anthropic/gemini, stream + non-stream, split-frame merge, robustness; + extractModelPricing + tapTail early-break sink)');

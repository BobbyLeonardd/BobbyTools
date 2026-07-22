// Self-check for the Gemini tool-call finish_reason fix. Gemini returns
// finishReason "STOP" even when the candidate carries functionCall parts, so
// mapping the finish purely from GEMINI_FINISH_TO_OAI produced tool_calls with
// finish_reason "stop" — agent loops that branch on finish_reason never run the
// tool. Fix gates on whether a call was actually emitted (matches the openai /
// responses spokes). Run: node test/geminifinish.test.js
import assert from 'node:assert';
import { translateResponse, translateStream } from '../src/translate.js';

// ── non-stream: functionCall present => tool_calls, not stop ──
const gToolResp = {
  candidates: [{ content: { role: 'model', parts: [
    { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
  ] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
};
const oai = translateResponse(gToolResp, 'gemini', 'openai');
assert.strictEqual(oai.choices[0].finish_reason, 'tool_calls', 'functionCall + STOP -> tool_calls');
assert.strictEqual(oai.choices[0].message.tool_calls[0].function.name, 'get_weather', 'tool name preserved');

// ── regression: plain text + STOP still maps to stop ──
const gTextResp = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};
assert.strictEqual(translateResponse(gTextResp, 'gemini', 'openai').choices[0].finish_reason, 'stop', 'text + STOP -> stop');

// ── stream: two functionCalls in SEPARATE chunks get distinct indices and a
//    tool_calls finish (the slot/sawTool hoist fix) ──
async function collectOpenaiStream() {
  const frames = [
    'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"a","args":{}}}]},"finishReason":"","index":0}]}\n\n',
    'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"b","args":{}}}]},"finishReason":"STOP","index":0}]}\n\n',
  ];
  async function* src() { for (const f of frames) yield f; }
  const events = [];
  for await (const frame of translateStream(src(), 'gemini', 'openai', { model: 'm' })) {
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); if (d && d !== '[DONE]') { try { events.push(JSON.parse(d)); } catch {} } }
    }
  }
  return events;
}
const ev = await collectOpenaiStream();
const toolDeltas = ev.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);
assert.deepStrictEqual(toolDeltas.map((t) => t.index), [0, 1], 'two calls across chunks -> indices 0,1 (not 0,0)');
assert.deepStrictEqual(toolDeltas.map((t) => t.function.name), ['a', 'b'], 'both call names survive');
const finish = ev.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean);
assert.deepStrictEqual(finish, ['tool_calls'], 'stream finish_reason -> tool_calls');

console.log('geminifinish.test.js: PASS');

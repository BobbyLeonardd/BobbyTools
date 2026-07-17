// One-shot LIVE validation of the translation layer against a real dual-format
// provider (reproduces exactly what src/server.js does, in-process). NOT part of
// the test suite: needs network + a real API key (read from HCN_KEY env, never
// hardcoded). Run: HCN_KEY=... node scripts/live-translate-check.mjs
import {
  anthropicReqToOpenai, openaiReqToAnthropic,
  anthropicRespToOpenai, openaiRespToAnthropic,
  anthropicStreamToOpenai, openaiStreamToAnthropic,
} from '../src/translate.js';

const BASE = process.env.LIVE_BASE || 'https://api.hcnsec.cn';
const KEY = process.env.HCN_KEY;
const MODEL = process.env.HCN_MODEL || 'glm-5.2';
if (!KEY) { console.error('set HCN_KEY'); process.exit(1); }
console.log(`provider: ${BASE} | model: ${MODEL}`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✘', m); } };

// ── Scenario A: Anthropic client -> OpenAI provider (the headline case) ──
// claude-code speaks Anthropic. Provider is OpenAI-format. server.js translates
// the request to OpenAI, POSTs /chat/completions, translates the reply back.
async function anthropicClientNonStream() {
  console.log('\n[A] Anthropic client -> OpenAI provider (non-stream)');
  const clientReq = { model: MODEL, max_tokens: 40, messages: [{ role: 'user', content: 'reply with exactly: ROUNDTRIP_OK' }] };
  const oaiReq = anthropicReqToOpenai(clientReq);
  ok(Array.isArray(oaiReq.messages) && oaiReq.max_tokens === 40, 'req translated to OpenAI shape');
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...oaiReq, model: MODEL }),
  });
  const oaiResp = await r.json();
  const anthResp = openaiRespToAnthropic(oaiResp);
  ok(anthResp.type === 'message' && anthResp.role === 'assistant', 'resp translated back to Anthropic message');
  const text = (anthResp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  ok(text.includes('ROUNDTRIP_OK'), `content preserved through roundtrip: ${JSON.stringify(text)}`);
  ok(anthResp.stop_reason === 'end_turn', `stop_reason mapped: ${anthResp.stop_reason}`);
  ok(anthResp.usage?.input_tokens > 0 && anthResp.usage?.output_tokens > 0, `usage mapped: ${JSON.stringify(anthResp.usage)}`);
}

async function anthropicClientStream() {
  console.log('\n[A] Anthropic client -> OpenAI provider (STREAM)');
  const clientReq = { model: MODEL, max_tokens: 40, stream: true, messages: [{ role: 'user', content: 'count: one two three' }] };
  const oaiReq = anthropicReqToOpenai(clientReq);
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...oaiReq, model: MODEL, stream: true }),
  });
  ok(r.ok, `upstream stream opened (${r.status})`);
  const events = [];
  for await (const frame of openaiStreamToAnthropic(r.body, { model: MODEL })) {
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); if (d) { try { events.push(JSON.parse(d)); } catch {} } }
    }
  }
  const types = events.map(e => e.type);
  ok(types[0] === 'message_start', 'stream opens with message_start');
  ok(types.includes('content_block_start') && types.includes('content_block_delta'), 'text block streamed');
  ok(types[types.length - 1] === 'message_stop', 'stream closes with message_stop');
  const text = events.filter(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta').map(e => e.delta.text).join('');
  ok(text.length > 0, `streamed text reassembled: ${JSON.stringify(text.slice(0, 60))}`);
}

// ── Scenario B: OpenAI client -> Anthropic provider (the reverse case) ──
// Client speaks OpenAI. Provider hit as native Anthropic /v1/messages.
async function openaiClientNonStream() {
  console.log('\n[B] OpenAI client -> Anthropic provider (non-stream)');
  const clientReq = { model: MODEL, messages: [{ role: 'user', content: 'reply with exactly: REVERSE_OK' }], max_tokens: 40 };
  const anthReq = openaiReqToAnthropic(clientReq);
  ok(anthReq.max_tokens === 40 && Array.isArray(anthReq.messages), 'req translated to Anthropic shape');
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ ...anthReq, model: MODEL }),
  });
  const anthResp = await r.json();
  const oaiResp = anthropicRespToOpenai(anthResp);
  ok(oaiResp.object === 'chat.completion' && oaiResp.choices?.length, 'resp translated back to OpenAI shape');
  const text = oaiResp.choices?.[0]?.message?.content || '';
  ok(text.includes('REVERSE_OK'), `content preserved through roundtrip: ${JSON.stringify(text)}`);
  ok(oaiResp.choices?.[0]?.finish_reason === 'stop', `finish_reason mapped: ${oaiResp.choices?.[0]?.finish_reason}`);
}

// ── Scenario C: tool calls (Anthropic client -> OpenAI provider) ──
async function toolCallRoundtrip() {
  console.log('\n[C] Tool calls: Anthropic client -> OpenAI provider');
  const clientReq = {
    model: MODEL, max_tokens: 200,
    tools: [{ name: 'get_weather', description: 'Get weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
  };
  const oaiReq = anthropicReqToOpenai(clientReq);
  ok(oaiReq.tools?.[0]?.type === 'function' && oaiReq.tools?.[0]?.function?.name === 'get_weather', 'tools translated to OpenAI function shape');
  ok(oaiReq.tools?.[0]?.function?.parameters?.required?.includes('city'), 'input_schema -> parameters');
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...oaiReq, model: MODEL }),
  });
  const oaiResp = await r.json();
  const anthResp = openaiRespToAnthropic(oaiResp);
  const toolUse = (anthResp.content || []).find(b => b.type === 'tool_use');
  if (toolUse) {
    ok(toolUse.name === 'get_weather', `tool_use block returned: ${toolUse.name}`);
    ok(toolUse.input && typeof toolUse.input === 'object', `tool input parsed to object: ${JSON.stringify(toolUse.input)}`);
    ok(anthResp.stop_reason === 'tool_use', `stop_reason tool_use: ${anthResp.stop_reason}`);
  } else {
    console.log('  ⚠ model did not call the tool (model choice, not a translation failure); stop_reason=', anthResp.stop_reason);
  }
}

try {
  await anthropicClientNonStream();
  await anthropicClientStream();
  await openaiClientNonStream();
  await toolCallRoundtrip();
} catch (e) {
  console.error('\nERROR during live check:', e.message);
  fail++;
}
console.log(`\n${fail === 0 ? '✔ ALL LIVE CHECKS PASSED' : '✘ SOME CHECKS FAILED'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

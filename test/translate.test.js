// Self-check for the Anthropic <-> OpenAI translation layer.
// Run: node test/translate.test.js
import assert from 'node:assert';
import {
  openaiReqToAnthropic,
  anthropicReqToOpenai,
  anthropicRespToOpenai,
  openaiRespToAnthropic,
  openaiStreamToAnthropic,
  anthropicStreamToOpenai,
  translateRequest,
  translateResponse,
  translateStream,
  normalizeFormat,
  FORMATS,
} from '../src/translate.js';

// ── REQUEST: OpenAI -> Anthropic ──
// system message is lifted out to the top-level `system` field; max_tokens is
// filled in when the client omitted it (Anthropic requires it).
{
  const oai = {
    model: 'claude-3-5-sonnet',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello.' },
    ],
    temperature: 0.5,
    stop: 'END',
  };
  const a = openaiReqToAnthropic(oai);
  assert.strictEqual(a.system, 'You are terse.', 'system lifted to top-level field');
  assert.strictEqual(a.messages.length, 2, 'system removed from messages array');
  assert.deepStrictEqual(a.messages[0], { role: 'user', content: 'Hi' }, 'user message preserved');
  assert.strictEqual(a.max_tokens, 4096, 'missing max_tokens defaults (Anthropic requires it)');
  assert.strictEqual(a.temperature, 0.5, 'temperature passed through');
  assert.deepStrictEqual(a.stop_sequences, ['END'], 'stop string -> stop_sequences array');
}

// Multiple system messages join; explicit max_tokens is honored.
{
  const a = openaiReqToAnthropic({
    model: 'm',
    messages: [
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'q' },
    ],
    max_tokens: 100,
  });
  assert.strictEqual(a.system, 'A\n\nB', 'multiple system messages joined');
  assert.strictEqual(a.max_tokens, 100, 'explicit max_tokens honored');
}

// ── REQUEST: Anthropic -> OpenAI ──
// top-level `system` becomes a leading system message; content blocks flatten to text.
{
  const anth = {
    model: 'gpt-4o',
    system: 'You are terse.',
    max_tokens: 512,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] }, // block array
      { role: 'assistant', content: 'Hello.' },                   // plain string
    ],
    stop_sequences: ['STOP'],
  };
  const o = anthropicReqToOpenai(anth);
  assert.strictEqual(o.messages.length, 3, 'system prepended as a message');
  assert.deepStrictEqual(o.messages[0], { role: 'system', content: 'You are terse.' }, 'system message first');
  assert.deepStrictEqual(o.messages[1], { role: 'user', content: 'Hi' }, 'text blocks flattened to string');
  assert.strictEqual(o.max_tokens, 512, 'max_tokens passed through');
  assert.deepStrictEqual(o.stop, ['STOP'], 'stop_sequences -> stop');
}

// ── RESPONSE: Anthropic -> OpenAI ──
{
  const anth = {
    id: 'msg_1',
    model: 'claude',
    content: [{ type: 'text', text: 'The answer is 42.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const o = anthropicRespToOpenai(anth);
  assert.strictEqual(o.object, 'chat.completion');
  assert.strictEqual(o.choices[0].message.content, 'The answer is 42.', 'text extracted');
  assert.strictEqual(o.choices[0].finish_reason, 'stop', 'end_turn -> stop');
  assert.deepStrictEqual(o.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 'usage mapped + totaled');
}

// ── RESPONSE: OpenAI -> Anthropic ──
{
  const oai = {
    id: 'cmpl_1',
    model: 'gpt-4o',
    choices: [{ index: 0, message: { role: 'assistant', content: 'The answer is 42.' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const a = openaiRespToAnthropic(oai);
  assert.strictEqual(a.type, 'message');
  assert.strictEqual(a.role, 'assistant');
  assert.deepStrictEqual(a.content, [{ type: 'text', text: 'The answer is 42.' }], 'text wrapped in a content block');
  assert.strictEqual(a.stop_reason, 'max_tokens', 'length -> max_tokens');
  assert.deepStrictEqual(a.usage, { input_tokens: 10, output_tokens: 5 }, 'usage mapped');
}

// Empty content yields an empty content array (not [{text:''}]).
{
  const a = openaiRespToAnthropic({ model: 'm', choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] });
  assert.deepStrictEqual(a.content, [], 'empty content -> empty array');
}

// ── ROUNDTRIP: OpenAI req -> Anthropic -> back preserves the essentials ──
{
  const orig = {
    model: 'm',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ],
    max_tokens: 256,
  };
  const back = anthropicReqToOpenai(openaiReqToAnthropic(orig));
  assert.deepStrictEqual(back.messages, orig.messages, 'req roundtrip preserves messages');
  assert.strictEqual(back.max_tokens, 256, 'req roundtrip preserves max_tokens');
}

// ── TOOLS: request tool definitions map both ways ──
{
  const oaiTools = [
    { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
  ];
  const a = openaiReqToAnthropic({ model: 'm', messages: [{ role: 'user', content: 'w?' }], tools: oaiTools, tool_choice: 'auto' });
  assert.deepStrictEqual(
    a.tools,
    [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    'OpenAI function tool -> Anthropic tool (parameters -> input_schema)',
  );
  assert.deepStrictEqual(a.tool_choice, { type: 'auto' }, "tool_choice 'auto' -> {type:'auto'}");

  // ...and back.
  const o = anthropicReqToOpenai({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'w?' }], tools: a.tools, tool_choice: { type: 'any' } });
  assert.deepStrictEqual(o.tools, oaiTools, 'Anthropic tool -> OpenAI function tool roundtrip');
  assert.strictEqual(o.tool_choice, 'required', "tool_choice {type:'any'} -> 'required'");
}

// ── TOOLS: forced-tool choice maps both ways ──
{
  const a = openaiReqToAnthropic({ model: 'm', messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'function', function: { name: 'foo' } } });
  assert.deepStrictEqual(a.tool_choice, { type: 'tool', name: 'foo' }, 'forced OpenAI tool -> Anthropic {type:tool,name}');
  const o = anthropicReqToOpenai({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'tool', name: 'foo' } });
  assert.deepStrictEqual(o.tool_choice, { type: 'function', function: { name: 'foo' } }, 'forced Anthropic tool -> OpenAI {type:function}');
}

// ── TOOLS: assistant tool_calls <-> tool_use blocks (request history) ──
{
  // OpenAI assistant with tool_calls -> Anthropic assistant with tool_use blocks.
  const oaiMsg = {
    model: 'm',
    messages: [
      { role: 'user', content: 'weather in NYC?' },
      { role: 'assistant', content: 'let me check', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '72F' },
    ],
  };
  const a = openaiReqToAnthropic(oaiMsg);
  const asst = a.messages.find((m) => m.role === 'assistant');
  assert.deepStrictEqual(
    asst.content,
    [{ type: 'text', text: 'let me check' }, { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } }],
    'assistant tool_calls -> text + tool_use blocks; arguments string -> input object',
  );
  const toolResult = a.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.deepStrictEqual(
    toolResult.content,
    [{ type: 'tool_result', tool_use_id: 'call_1', content: '72F' }],
    "OpenAI 'tool' message -> Anthropic user tool_result block",
  );

  // ...and back: Anthropic history -> OpenAI.
  const o = anthropicReqToOpenai({ model: 'm', max_tokens: 10, messages: a.messages });
  const backAsst = o.messages.find((m) => m.role === 'assistant');
  assert.strictEqual(backAsst.content, 'let me check', 'roundtrip: assistant text preserved');
  assert.deepStrictEqual(
    backAsst.tool_calls,
    [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }],
    'roundtrip: tool_use -> tool_calls; input object -> arguments string',
  );
  const backTool = o.messages.find((m) => m.role === 'tool');
  assert.deepStrictEqual(backTool, { role: 'tool', tool_call_id: 'call_1', content: '72F' }, 'roundtrip: tool_result -> tool message');
}

// ── TOOLS: response tool_calls <-> tool_use ──
{
  // OpenAI response with a tool call -> Anthropic tool_use content block.
  const oaiResp = {
    id: 'c1', model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
  const a = openaiRespToAnthropic(oaiResp);
  assert.deepStrictEqual(
    a.content,
    [{ type: 'tool_use', id: 'call_9', name: 'search', input: { q: 'cats' } }],
    'response tool_calls -> tool_use block (arguments string -> input object)',
  );
  assert.strictEqual(a.stop_reason, 'tool_use', 'finish_reason tool_calls -> stop_reason tool_use');

  // ...and back.
  const o = anthropicRespToOpenai(a);
  assert.strictEqual(o.choices[0].message.content, null, 'no text -> null content');
  assert.deepStrictEqual(
    o.choices[0].message.tool_calls,
    [{ id: 'call_9', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } }],
    'roundtrip: tool_use -> tool_calls',
  );
  assert.strictEqual(o.choices[0].finish_reason, 'tool_calls', 'roundtrip: stop_reason -> finish_reason');
}

// ── TOOLS: mixed text + tool_use response (Anthropic -> OpenAI) ──
{
  const a = {
    model: 'm',
    content: [
      { type: 'text', text: 'Searching now.' },
      { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 2 },
  };
  const o = anthropicRespToOpenai(a);
  assert.strictEqual(o.choices[0].message.content, 'Searching now.', 'leading text preserved alongside tool_calls');
  assert.strictEqual(o.choices[0].message.tool_calls.length, 1, 'one tool call emitted');
}

// ── STREAMING ──
// Helpers: turn an array of strings into an async iterable (a fake response.body),
// and drain a generator into the list of SSE data-payloads it produced.
async function* fromChunks(chunks) { for (const c of chunks) yield c; }
async function drain(gen) {
  const frames = [];
  for await (const f of gen) frames.push(f);
  return frames;
}
// Extract the JSON payloads from produced SSE frames (skipping [DONE]).
function dataPayloads(frames) {
  const out = [];
  for (const f of frames) {
    for (const line of f.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) {
        const d = t.slice(5).trim();
        if (d && d !== '[DONE]') out.push(JSON.parse(d));
      }
    }
  }
  return out;
}

// STREAM: OpenAI SSE -> Anthropic SSE. Text deltas become content_block_delta,
// and the envelope opens/closes exactly once.
{
  const stream = [
    'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const frames = await drain(openaiStreamToAnthropic(fromChunks(stream)));
  const types = dataPayloads(frames).map((p) => p.type);
  assert.deepStrictEqual(
    types,
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
    'OpenAI->Anthropic stream: correct event sequence',
  );
  const text = dataPayloads(frames).filter((p) => p.type === 'content_block_delta').map((p) => p.delta.text).join('');
  assert.strictEqual(text, 'Hello', 'text deltas concatenate to the full message');
  const md = dataPayloads(frames).find((p) => p.type === 'message_delta');
  assert.strictEqual(md.delta.stop_reason, 'end_turn', 'finish_reason stop -> end_turn');
}

// STREAM: Anthropic SSE -> OpenAI SSE. Ends with a [DONE] sentinel; text arrives
// via delta.content.
{
  const stream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const frames = await drain(anthropicStreamToOpenai(fromChunks(stream)));
  assert.ok(frames[frames.length - 1].includes('[DONE]'), 'OpenAI stream terminates with [DONE]');
  const payloads = dataPayloads(frames);
  assert.ok(payloads.every((p) => p.object === 'chat.completion.chunk'), 'every frame is a chat.completion.chunk');
  const text = payloads.map((p) => p.choices[0].delta.content || '').join('');
  assert.strictEqual(text, 'Hi there', 'text deltas concatenate');
  const last = payloads[payloads.length - 1];
  assert.strictEqual(last.choices[0].finish_reason, 'stop', 'end_turn -> stop on the final chunk');
}

// STREAM: SSE frames split across chunk boundaries still parse (a single logical
// `data:` line arrives in three physical pieces).
{
  const split = [
    'data: {"choices":[{"delta":{"con',
    'tent":"split"},"finish_rea',
    'son":null}]}\n\ndata: [DONE]\n\n',
  ];
  const frames = await drain(openaiStreamToAnthropic(fromChunks(split)));
  const text = dataPayloads(frames).filter((p) => p.type === 'content_block_delta').map((p) => p.delta.text).join('');
  assert.strictEqual(text, 'split', 'frame split mid-line across chunks is buffered and parsed');
}

// STREAM tool calls: OpenAI SSE -> Anthropic SSE. tool_calls arrive as an id+name
// fragment then argument-string fragments; they must reframe into a tool_use block
// with input_json_delta fragments, after any text block.
{
  const stream = [
    'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Let me check."},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const payloads = dataPayloads(await drain(openaiStreamToAnthropic(fromChunks(stream))));
  const types = payloads.map((p) => p.type);
  // text block (0) opens+delta+stop, then tool block (1) opens+deltas+stop.
  assert.deepStrictEqual(
    types.filter((t) => t.startsWith('content_block')),
    ['content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop'],
    'text block closes before the tool block opens',
  );
  const toolStart = payloads.find((p) => p.type === 'content_block_start' && p.content_block?.type === 'tool_use');
  assert.strictEqual(toolStart.content_block.name, 'get_weather', 'tool name carried on the block start');
  assert.strictEqual(toolStart.index, 1, 'tool_use is the second block (after text)');
  const json = payloads.filter((p) => p.type === 'content_block_delta' && p.delta.type === 'input_json_delta').map((p) => p.delta.partial_json).join('');
  assert.strictEqual(json, '{"city":"Paris"}', 'argument fragments concatenate into valid JSON');
  const md = payloads.find((p) => p.type === 'message_delta');
  assert.strictEqual(md.delta.stop_reason, 'tool_use', 'tool_calls -> tool_use stop reason');
}

// STREAM tool calls: Anthropic SSE -> OpenAI SSE. A tool_use block start emits the
// tool_call header; input_json_delta fragments become argument-string deltas.
{
  const stream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const payloads = dataPayloads(await drain(anthropicStreamToOpenai(fromChunks(stream))));
  // Header fragment: id + name, empty args.
  const header = payloads.find((p) => p.choices[0].delta.tool_calls?.[0]?.id);
  assert.strictEqual(header.choices[0].delta.tool_calls[0].function.name, 'get_weather', 'tool name on the header fragment');
  assert.strictEqual(header.choices[0].delta.tool_calls[0].index, 0, 'first tool_call gets OpenAI index 0');
  // Argument fragments concatenate to valid JSON.
  const args = payloads
    .map((p) => p.choices[0].delta.tool_calls?.[0]?.function?.arguments)
    .filter((a) => a != null && a !== '')
    .join('');
  assert.strictEqual(args, '{"city":"Paris"}', 'argument fragments concatenate into valid JSON');
  const last = payloads[payloads.length - 1];
  assert.strictEqual(last.choices[0].finish_reason, 'tool_calls', 'tool_use -> tool_calls finish reason');
}

// ── IMAGES: base64 + URL blocks survive the hop both ways ──
{
  // Anthropic client (text + base64 image) -> OpenAI provider.
  const anth = {
    model: 'm', max_tokens: 50,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      ],
    }],
  };
  const o = anthropicReqToOpenai(anth);
  assert.deepStrictEqual(
    o.messages[0].content,
    [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ],
    'Anthropic base64 image -> OpenAI image_url data URI (text kept alongside)',
  );

  // ...and back: OpenAI image_url (data URI) -> Anthropic base64 block.
  const a = openaiReqToAnthropic({ model: 'm', messages: [{ role: 'user', content: o.messages[0].content }] });
  assert.deepStrictEqual(
    a.messages[0].content,
    [
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    ],
    'OpenAI data-URI image -> Anthropic base64 source roundtrip',
  );
}

// A remote image URL (not base64) maps both ways without corruption.
{
  const o = anthropicReqToOpenai({
    model: 'm', max_tokens: 10,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
  });
  assert.deepStrictEqual(o.messages[0].content, [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }], 'Anthropic url image -> OpenAI image_url');
  const a = openaiReqToAnthropic({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] });
  assert.deepStrictEqual(a.messages[0].content, [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }], 'OpenAI url image -> Anthropic url source');
}

// Text-only content still collapses to a plain string (no regression: images
// only turn content into an array when an image is actually present).
{
  const o = anthropicReqToOpenai({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'just text' }] }] });
  assert.strictEqual(o.messages[0].content, 'just text', 'text-only block array still collapses to a string');
}

// ══════════════════════════════════════════════════════════════════════════
// HUB-AND-SPOKE DISPATCHERS
// ══════════════════════════════════════════════════════════════════════════

// normalizeFormat: known keys pass through, everything else -> openai.
{
  assert.strictEqual(normalizeFormat('openai'), 'openai');
  assert.strictEqual(normalizeFormat('anthropic'), 'anthropic');
  assert.strictEqual(normalizeFormat(undefined), 'openai', 'missing apiFormat -> openai (back-compat)');
  assert.strictEqual(normalizeFormat('bogus'), 'openai', 'unknown apiFormat -> openai');
}

// Same-format dispatch is a no-op (returns the input untouched, identity).
{
  const p = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  assert.strictEqual(translateRequest(p, 'openai', 'openai'), p, 'req same-format is identity');
  assert.strictEqual(translateResponse(p, 'anthropic', 'anthropic'), p, 'resp same-format is identity');
}

// translateRequest through the hub must equal calling the spoke fn directly
// (anthropic is a hub spoke, so openai->anthropic == openaiReqToAnthropic).
{
  const oai = { model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], temperature: 0.3 };
  assert.deepStrictEqual(
    translateRequest(oai, 'openai', 'anthropic'),
    openaiReqToAnthropic(oai),
    'dispatch openai->anthropic == direct openaiReqToAnthropic',
  );
  const anth = { model: 'm', max_tokens: 50, system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
  assert.deepStrictEqual(
    translateRequest(anth, 'anthropic', 'openai'),
    anthropicReqToOpenai(anth),
    'dispatch anthropic->openai == direct anthropicReqToOpenai',
  );
}

// translateResponse both ways matches the direct spoke fns.
{
  const oaiResp = { id: 'x', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'yo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  assert.deepStrictEqual(translateResponse(oaiResp, 'openai', 'anthropic'), openaiRespToAnthropic(oaiResp), 'resp dispatch openai->anthropic');
  const anthResp = { id: 'y', model: 'm', content: [{ type: 'text', text: 'yo' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } };
  assert.deepStrictEqual(translateResponse(anthResp, 'anthropic', 'openai'), anthropicRespToOpenai(anthResp), 'resp dispatch anthropic->openai');
}

// Registry integrity: every spoke implements the full 6-function contract.
{
  const keys = ['reqToHub', 'reqFromHub', 'respToHub', 'respFromHub', 'streamToHub', 'streamFromHub'];
  for (const [name, spoke] of Object.entries(FORMATS)) {
    for (const k of keys) {
      assert.strictEqual(typeof spoke[k], 'function', `FORMATS.${name}.${k} must be a function`);
    }
  }
}

// translateStream through the hub equals the direct streaming generator.
// (Async, so this lives in a promise the module awaits before the final log.)
async function streamDispatchCheck() {
  // Provider streamed OpenAI, client wants Anthropic: dispatch == openaiStreamToAnthropic.
  const oaiFrames = [
    'data: {"id":"c1","model":"m","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  async function* src() { for (const f of oaiFrames) yield f; }
  async function collect(gen) { let out = ''; for await (const f of gen) out += f; return out; }
  const viaDispatch = await collect(translateStream(src(), 'openai', 'anthropic', { model: 'm' }));
  const viaDirect = await collect(openaiStreamToAnthropic(src(), { model: 'm' }));
  assert.strictEqual(viaDispatch, viaDirect, 'stream dispatch openai->anthropic == direct generator');

  // Same-format stream is a straight passthrough of the source.
  const passthrough = await collect(translateStream(src(), 'openai', 'openai', {}));
  assert.strictEqual(passthrough, oaiFrames.join(''), 'stream same-format is byte passthrough');
}

// ══════════════════════════════════════════════════════════════════════════
// GEMINI spoke — via the dispatchers (which is how server.js calls it).
// ══════════════════════════════════════════════════════════════════════════

// gemini registered with the full 6-fn contract.
{
  assert.ok(FORMATS.gemini, 'gemini spoke registered');
  assert.strictEqual(normalizeFormat('gemini'), 'gemini');
}

// REQUEST openai -> gemini: system lifts to systemInstruction, assistant->model,
// generationConfig carries limits, content becomes parts[].
{
  const oai = {
    model: 'gemini-x',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    max_tokens: 128, temperature: 0.4, stop: 'END',
  };
  const g = translateRequest(oai, 'openai', 'gemini');
  assert.deepStrictEqual(g.systemInstruction, { parts: [{ text: 'be terse' }] }, 'system -> systemInstruction');
  assert.strictEqual(g.contents.length, 2, 'system removed from contents');
  assert.deepStrictEqual(g.contents[0], { role: 'user', parts: [{ text: 'hi' }] }, 'user turn');
  assert.strictEqual(g.contents[1].role, 'model', 'assistant role -> model');
  assert.strictEqual(g.generationConfig.maxOutputTokens, 128, 'max_tokens -> maxOutputTokens');
  assert.strictEqual(g.generationConfig.temperature, 0.4, 'temperature passed');
  assert.deepStrictEqual(g.generationConfig.stopSequences, ['END'], 'stop -> stopSequences');
}

// REQUEST gemini -> openai: the inverse pulls systemInstruction back into a
// system message and model->assistant.
{
  const g = {
    model: 'gemini-x',
    systemInstruction: { parts: [{ text: 'be terse' }] },
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ],
    generationConfig: { maxOutputTokens: 64, temperature: 0.2 },
  };
  const oai = translateRequest(g, 'gemini', 'openai');
  assert.strictEqual(oai.messages[0].role, 'system', 'systemInstruction -> system message');
  assert.strictEqual(oai.messages[0].content, 'be terse');
  assert.strictEqual(oai.messages[2].role, 'assistant', 'model -> assistant');
  assert.strictEqual(oai.max_tokens, 64, 'maxOutputTokens -> max_tokens');
}

// RESPONSE gemini -> openai: candidates/parts/finishReason/usageMetadata mapped.
{
  const g = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'the answer' }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    modelVersion: 'gemini-x',
  };
  const oai = translateResponse(g, 'gemini', 'openai');
  assert.strictEqual(oai.object, 'chat.completion');
  assert.strictEqual(oai.choices[0].message.content, 'the answer', 'text mapped');
  assert.strictEqual(oai.choices[0].finish_reason, 'stop', 'STOP -> stop');
  assert.deepStrictEqual(oai.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, 'usage mapped');
}

// RESPONSE openai -> gemini: MAX_TOKENS mapping + parts shape.
{
  const oai = { model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'length' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
  const g = translateResponse(oai, 'openai', 'gemini');
  assert.deepStrictEqual(g.candidates[0].content.parts, [{ text: 'hi' }], 'content -> text part');
  assert.strictEqual(g.candidates[0].finishReason, 'MAX_TOKENS', 'length -> MAX_TOKENS');
  assert.strictEqual(g.usageMetadata.promptTokenCount, 2, 'usage mapped');
}

// TOOL calls survive gemini <-> openai (functionCall <-> tool_calls).
{
  // openai assistant tool_call -> gemini functionCall part
  const oai = { model: 'm', messages: [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    { role: 'tool', name: 'get_weather', tool_call_id: 'c1', content: '{"temp":20}' },
  ] };
  const g = translateRequest(oai, 'openai', 'gemini');
  const modelTurn = g.contents.find((c) => c.role === 'model');
  assert.ok(modelTurn.parts.some((p) => p.functionCall?.name === 'get_weather'), 'tool_call -> functionCall');
  assert.deepStrictEqual(modelTurn.parts.find((p) => p.functionCall).functionCall.args, { city: 'Paris' }, 'args parsed to object');
  const respTurn = g.contents.find((c) => c.parts.some((p) => p.functionResponse));
  assert.strictEqual(respTurn.parts[0].functionResponse.name, 'get_weather', 'tool result -> functionResponse');
  assert.deepStrictEqual(respTurn.parts[0].functionResponse.response, { temp: 20 }, 'tool result object preserved');
}

// IMAGES: base64 data URL <-> Gemini inlineData both ways.
{
  const oai = { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] };
  const g = translateRequest(oai, 'openai', 'gemini');
  assert.deepStrictEqual(g.contents[0].parts, [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }], 'data URL -> inlineData');
  const back = translateRequest(g, 'gemini', 'openai');
  assert.deepStrictEqual(back.messages.at(-1).content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }], 'inlineData -> data URL');
}

// CROSS-SPOKE PIVOT: anthropic client <-> gemini provider, through the hub, with
// zero direct anthropic<->gemini code. This is the whole point of the design.
{
  const anthReq = { model: 'm', max_tokens: 50, system: 'be brief', messages: [{ role: 'user', content: 'ping' }] };
  const g = translateRequest(anthReq, 'anthropic', 'gemini');
  assert.deepStrictEqual(g.systemInstruction, { parts: [{ text: 'be brief' }] }, 'anthropic system -> gemini systemInstruction (via hub)');
  assert.deepStrictEqual(g.contents[0], { role: 'user', parts: [{ text: 'ping' }] }, 'anthropic message -> gemini content (via hub)');
  assert.strictEqual(g.generationConfig.maxOutputTokens, 50, 'anthropic max_tokens -> gemini maxOutputTokens (via hub)');

  // gemini response -> anthropic response, through the hub.
  const gResp = { candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } };
  const anthResp = translateResponse(gResp, 'gemini', 'anthropic');
  assert.strictEqual(anthResp.type, 'message', 'gemini resp -> anthropic message (via hub)');
  assert.strictEqual(anthResp.content?.[0]?.text, 'pong', 'text preserved across pivot');
  assert.strictEqual(anthResp.stop_reason, 'end_turn', 'STOP -> stop -> end_turn across pivot');
  assert.strictEqual(anthResp.usage?.input_tokens, 4, 'usage preserved across pivot');
}

// STREAM PIVOT: gemini provider stream -> anthropic client, through the hub.
async function geminiStreamPivotCheck() {
  const gFrames = [
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]},"finishReason":"","index":0}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n',
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"","index":0}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
  ];
  async function* src() { for (const f of gFrames) yield f; }
  const events = [];
  for await (const frame of translateStream(src(), 'gemini', 'anthropic', { model: 'm' })) {
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); if (d) { try { events.push(JSON.parse(d)); } catch {} } }
    }
  }
  const types = events.map((e) => e.type);
  assert.strictEqual(types[0], 'message_start', 'gemini->anthropic stream opens with message_start');
  assert.strictEqual(types.at(-1), 'message_stop', 'closes with message_stop');
  const text = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
  assert.strictEqual(text, 'Hello', 'streamed text reassembled across gemini->hub->anthropic pivot');
}
await geminiStreamPivotCheck();

// ══════════════════════════════════════════════════════════════════════════
// RESPONSES spoke — OpenAI /v1/responses format.
// ══════════════════════════════════════════════════════════════════════════

{
  assert.ok(FORMATS.responses, 'responses spoke registered');
  assert.strictEqual(normalizeFormat('responses'), 'responses');
}

// REQUEST openai -> responses: system -> instructions, messages -> input[],
// max_tokens -> max_output_tokens, tools flattened (no nested function wrapper).
{
  const oai = {
    model: 'gpt-x',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
    max_tokens: 200, temperature: 0.5,
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
  };
  const r = translateRequest(oai, 'openai', 'responses');
  assert.strictEqual(r.instructions, 'be terse', 'system -> instructions');
  assert.deepStrictEqual(r.input, [{ role: 'user', content: 'hi' }], 'messages -> input[]');
  assert.strictEqual(r.max_output_tokens, 200, 'max_tokens -> max_output_tokens');
  assert.deepStrictEqual(r.tools, [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }], 'tools flattened');
  assert.strictEqual(r.tools[0].function, undefined, 'no nested function wrapper');
}

// REQUEST responses -> openai: instructions -> system, string input -> user msg.
{
  const r = { model: 'gpt-x', instructions: 'be terse', input: 'hello', max_output_tokens: 50 };
  const oai = translateRequest(r, 'responses', 'openai');
  assert.strictEqual(oai.messages[0].role, 'system');
  assert.strictEqual(oai.messages[0].content, 'be terse', 'instructions -> system');
  assert.deepStrictEqual(oai.messages[1], { role: 'user', content: 'hello' }, 'string input -> user message');
  assert.strictEqual(oai.max_tokens, 50, 'max_output_tokens -> max_tokens');
}

// REQUEST responses array input with input_text/input_image parts -> openai.
{
  const r = { model: 'gpt-x', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,ZZ' }] },
  ] };
  const oai = translateRequest(r, 'responses', 'openai');
  assert.deepStrictEqual(oai.messages[0].content, [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,ZZ' } },
  ], 'input_text/input_image -> text/image_url');
  // round-trip back
  const back = translateRequest(oai, 'openai', 'responses');
  assert.deepStrictEqual(back.input[0].content, [
    { type: 'input_text', text: 'look' },
    { type: 'input_image', image_url: 'data:image/png;base64,ZZ' },
  ], 'openai content -> responses input parts');
}

// RESPONSE responses -> openai: output[] message/output_text -> content, usage.
{
  const r = {
    id: 'resp_1', model: 'gpt-x',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'the answer', annotations: [] }] }],
    usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
  };
  const oai = translateResponse(r, 'responses', 'openai');
  assert.strictEqual(oai.choices[0].message.content, 'the answer', 'output_text -> content');
  assert.strictEqual(oai.choices[0].finish_reason, 'stop');
  assert.deepStrictEqual(oai.usage, { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }, 'usage mapped');
}

// RESPONSE openai -> responses: content -> output message; usage renamed.
{
  const oai = { id: 'x', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
  const r = translateResponse(oai, 'openai', 'responses');
  assert.strictEqual(r.object, 'response');
  assert.strictEqual(r.output[0].type, 'message');
  assert.strictEqual(r.output[0].content[0].text, 'hi', 'content -> output_text');
  assert.deepStrictEqual(r.usage, { input_tokens: 2, output_tokens: 1, total_tokens: 3 }, 'usage renamed');
}

// TOOL calls survive responses <-> openai (function_call <-> tool_calls).
{
  // responses request: assistant function_call + function_call_output items.
  const r = { model: 'm', input: [
    { role: 'user', content: 'weather?' },
    { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    { type: 'function_call_output', call_id: 'c1', output: '{"temp":20}' },
  ] };
  const oai = translateRequest(r, 'responses', 'openai');
  const asst = oai.messages.find((m) => m.role === 'assistant');
  assert.strictEqual(asst.tool_calls[0].function.name, 'get_weather', 'function_call -> tool_call');
  assert.strictEqual(asst.tool_calls[0].id, 'c1', 'call_id -> tool_call id');
  const tool = oai.messages.find((m) => m.role === 'tool');
  assert.strictEqual(tool.tool_call_id, 'c1', 'function_call_output -> tool message');
  assert.strictEqual(tool.content, '{"temp":20}', 'output preserved');
  // response with a function_call output item -> openai tool_calls
  const rResp = { model: 'm', output: [{ type: 'function_call', call_id: 'c9', name: 'f', arguments: '{"a":1}', status: 'completed' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const oaiResp = translateResponse(rResp, 'responses', 'openai');
  assert.strictEqual(oaiResp.choices[0].message.tool_calls[0].function.name, 'f', 'function_call output -> tool_call');
  assert.strictEqual(oaiResp.choices[0].finish_reason, 'tool_calls', 'finish_reason tool_calls');
}

// CROSS-SPOKE PIVOT: anthropic client <-> responses provider, through the hub.
{
  const anthReq = { model: 'm', max_tokens: 30, system: 'brief', messages: [{ role: 'user', content: 'ping' }] };
  const r = translateRequest(anthReq, 'anthropic', 'responses');
  assert.strictEqual(r.instructions, 'brief', 'anthropic system -> responses instructions (via hub)');
  assert.deepStrictEqual(r.input, [{ role: 'user', content: 'ping' }], 'anthropic msg -> responses input (via hub)');
  assert.strictEqual(r.max_output_tokens, 30, 'max_tokens mapped across pivot');
  const rResp = { id: 'x', model: 'm', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
  const anthResp = translateResponse(rResp, 'responses', 'anthropic');
  assert.strictEqual(anthResp.content?.[0]?.text, 'pong', 'responses -> anthropic text across pivot');
  assert.strictEqual(anthResp.usage?.input_tokens, 3, 'usage across pivot');
}

// STREAM: responses provider stream -> openai client, through the hub.
async function responsesStreamPivotCheck() {
  const rFrames = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","object":"response","status":"in_progress","output":[]}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"Hel"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"lo"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
  ];
  async function* src() { for (const f of rFrames) yield f; }
  const chunks = [];
  for await (const frame of translateStream(src(), 'responses', 'openai', { model: 'm' })) {
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); if (d && d !== '[DONE]') { try { chunks.push(JSON.parse(d)); } catch {} } }
    }
  }
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
  assert.strictEqual(text, 'Hello', 'responses->openai stream text reassembled');
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'), 'stream closes with finish_reason stop');
}
await responsesStreamPivotCheck();

// STREAM: openai client stream -> responses provider (semantic events emitted).
async function openaiToResponsesStreamCheck() {
  const oaiFrames = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ];
  async function* src() { for (const f of oaiFrames) yield f; }
  const events = [];
  for await (const frame of translateStream(src(), 'openai', 'responses', { model: 'm' })) {
    // Responses frames carry a `type` inside data; collect them.
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); if (d) { try { events.push(JSON.parse(d)); } catch {} } }
    }
  }
  const types = events.map((e) => e.type);
  assert.ok(types.includes('response.created'), 'emits response.created');
  assert.ok(types.includes('response.output_text.delta'), 'emits output_text.delta');
  assert.strictEqual(types.at(-1), 'response.completed', 'closes with response.completed');
  const completed = events.at(-1);
  assert.strictEqual(completed.response.output_text, 'Hi', 'completed carries assembled text');
  assert.strictEqual(completed.response.usage.input_tokens, 2, 'completed carries usage');
}
await openaiToResponsesStreamCheck();

// ══════════════════════════════════════════════════════════════════════════
// STAGE 9 — image OUTPUT translation (Gemini <-> Responses, the two formats that
// can emit images). Covers non-stream + stream, cross-pivot, and graceful
// degradation for formats that can't carry image output (openai/anthropic).
// ══════════════════════════════════════════════════════════════════════════

const B64 = 'aGVsbG8='; // "hello" — stands in for image bytes.

// NON-STREAM: gemini provider returns an image -> responses client sees an
// image_generation_call item carrying the bare base64 in `result`.
{
  const gemini = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: B64 } }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 },
  };
  const r = translateResponse(gemini, 'gemini', 'responses');
  const img = r.output.find((o) => o.type === 'image_generation_call');
  assert.ok(img, 'gemini image -> responses image_generation_call item');
  assert.strictEqual(img.result, B64, 'bare base64 preserved in result');
  assert.strictEqual(img.output_format, 'png', 'mime -> output_format');
  const msg = r.output.find((o) => o.type === 'message');
  assert.strictEqual(msg.content[0].text, 'here you go', 'accompanying text preserved');
}

// NON-STREAM: responses provider returns an image -> gemini client sees inlineData.
{
  const responses = {
    id: 'resp_1', model: 'gpt-x',
    output: [{ type: 'image_generation_call', id: 'ig_0', status: 'completed', result: B64, output_format: 'jpeg' }],
    usage: { input_tokens: 2, output_tokens: 9, total_tokens: 11 },
  };
  const g = translateResponse(responses, 'responses', 'gemini');
  const part = g.candidates[0].content.parts.find((p) => p.inlineData);
  assert.ok(part, 'responses image -> gemini inlineData part');
  assert.strictEqual(part.inlineData.data, B64, 'base64 preserved');
  assert.strictEqual(part.inlineData.mimeType, 'image/jpeg', 'output_format -> mimeType');
}

// NON-STREAM round-trip: gemini -> responses -> gemini keeps the image intact.
{
  const gemini = {
    candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: {},
  };
  const back = translateResponse(translateResponse(gemini, 'gemini', 'responses'), 'responses', 'gemini');
  const part = back.candidates[0].content.parts.find((p) => p.inlineData);
  assert.strictEqual(part?.inlineData?.data, B64, 'image survives gemini->responses->gemini round-trip');
}

// NON-STREAM degradation: gemini image -> openai client drops the image but keeps
// text and leaves a visible marker (OpenAI chat can't carry image output).
{
  const gemini = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'text part' }, { inlineData: { mimeType: 'image/png', data: B64 } }] }, finishReason: 'STOP' }],
    usageMetadata: {},
  };
  const oai = translateResponse(gemini, 'gemini', 'openai');
  assert.strictEqual(typeof oai.choices[0].message.content, 'string', 'openai content is a string, never an array');
  assert.ok(oai.choices[0].message.content.includes('text part'), 'text kept');
  assert.ok(/image omitted/i.test(oai.choices[0].message.content), 'image drop is marked, not silent');
}

// NON-STREAM degradation: responses image -> anthropic client marks the omission.
{
  const responses = { model: 'm', output: [{ type: 'image_generation_call', result: B64, output_format: 'png', status: 'completed' }], usage: {} };
  const anth = translateResponse(responses, 'responses', 'anthropic');
  const textBlock = anth.content.find((b) => b.type === 'text');
  assert.ok(textBlock && /image omitted/i.test(textBlock.text), 'anthropic marks the dropped image');
  assert.ok(!anth.content.some((b) => b.type === 'image'), 'no bogus image block emitted');
}

// STREAM: gemini provider streams an image -> responses client gets a
// partial_image event and a final image_generation_call item in response.completed.
async function geminiImageStreamToResponses() {
  const geminiFrames = [
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'drawing' }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }) + '\n\n',
  ];
  async function* src() { for (const f of geminiFrames) yield f; }
  const events = [];
  for await (const frame of translateStream(src(), 'gemini', 'responses', { model: 'm' })) {
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); if (d) { try { events.push(JSON.parse(d)); } catch {} } }
    }
  }
  assert.ok(events.some((e) => e.type === 'response.image_generation_call.partial_image' && e.partial_image_b64 === B64), 'streams a partial_image event with the base64');
  const completed = events.at(-1);
  assert.strictEqual(completed.type, 'response.completed', 'closes with response.completed');
  const img = completed.response.output.find((o) => o.type === 'image_generation_call');
  assert.strictEqual(img?.result, B64, 'final image_generation_call item carries the image');
}
await geminiImageStreamToResponses();

// STREAM: responses provider streams an image -> gemini client gets an inlineData
// part. Responses collapses progressive partials to the final image (see ponytail).
async function responsesImageStreamToGemini() {
  const respFrames = [
    'data: ' + JSON.stringify({ type: 'response.created', response: { output: [] } }) + '\n\n',
    'data: ' + JSON.stringify({ type: 'response.image_generation_call.partial_image', partial_image_index: 0, partial_image_b64: 'cGFydGlhbA==' }) + '\n\n',
    'data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'image_generation_call', result: B64, output_format: 'png', status: 'completed' }] } }) + '\n\n',
  ];
  async function* src() { for (const f of respFrames) yield f; }
  const parts = [];
  for await (const frame of translateStream(src(), 'responses', 'gemini', { model: 'm' })) {
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); if (d && d !== '[DONE]') { try { const f = JSON.parse(d); for (const p of f.candidates?.[0]?.content?.parts || []) parts.push(p); } catch {} } }
    }
  }
  const img = parts.find((p) => p.inlineData);
  assert.strictEqual(img?.inlineData?.data, B64, 'final (not partial) image reaches gemini as inlineData');
}
await responsesImageStreamToGemini();

// STREAM degradation: gemini image stream -> openai client. The base64 must NOT
// leak into a delta; the omission is marked once, and text still flows.
async function geminiImageStreamToOpenaiDegrades() {
  const geminiFrames = [
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }) + '\n\n',
  ];
  async function* src() { for (const f of geminiFrames) yield f; }
  let raw = '';
  const chunks = [];
  for await (const frame of translateStream(src(), 'gemini', 'openai', { model: 'm' })) {
    raw += frame;
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); if (d && d !== '[DONE]') { try { chunks.push(JSON.parse(d)); } catch {} } }
    }
  }
  assert.ok(!raw.includes(B64), 'image base64 never leaks to an openai client');
  assert.ok(!chunks.some((c) => c.choices?.[0]?.delta?.images), 'hub-internal delta.images is stripped');
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
  assert.ok(text.includes('hi'), 'text still flows');
  assert.ok(/image omitted/i.test(text), 'omission marked once in the stream');
}
await geminiImageStreamToOpenaiDegrades();

// STREAM degradation: gemini image stream -> anthropic client. No image leaks;
// the omission surfaces as a text_delta marker.
async function geminiImageStreamToAnthropicDegrades() {
  const geminiFrames = [
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }] }) + '\n\n',
    'data: ' + JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }) + '\n\n',
  ];
  async function* src() { for (const f of geminiFrames) yield f; }
  let raw = '';
  let markerText = '';
  for await (const frame of translateStream(src(), 'gemini', 'anthropic', { model: 'm' })) {
    raw += frame;
    for (const line of frame.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('data:')) { const d = t.slice(5).trim(); try { const ev = JSON.parse(d); if (ev.delta?.type === 'text_delta') markerText += ev.delta.text; } catch {} }
    }
  }
  assert.ok(!raw.includes(B64), 'image base64 never leaks to an anthropic client');
  assert.ok(/image omitted/i.test(markerText), 'anthropic stream marks the dropped image');
}
await geminiImageStreamToAnthropicDegrades();

console.log('✔ translate self-check passed (stage 9: + image output translation & graceful degradation)');

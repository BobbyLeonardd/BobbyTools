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

console.log('✔ translate self-check passed (stage 5: + images, both ways)');

// Anthropic Messages <-> OpenAI Chat Completions format translation.
//
// Why this exists: claude-code (and other Anthropic-native clients) speak the
// Anthropic Messages API; most cheap/free providers (Groq, OpenRouter, etc.)
// speak OpenAI Chat Completions. Without translation, pointing claude-code at an
// OpenAI-format provider just fails. The router stays a passthrough whenever the
// inbound format already matches the provider (see server.js fast path); these
// functions only run when the two differ.
//
// Pure, no I/O — every function takes data in and returns data out, so each is a
// one-line assert away from a test. Deps: none.
//
// Format shapes (the parts that matter here):
//   OpenAI req : { model, messages:[{role:'system'|'user'|'assistant', content}], max_tokens?, ... }
//   Anthropic  : { model, system?, messages:[{role:'user'|'assistant', content}], max_tokens }
//   OpenAI resp: { choices:[{message:{role,content}, finish_reason}], usage:{prompt_tokens,completion_tokens,total_tokens} }
//   Anthropic  : { content:[{type:'text',text}], stop_reason, usage:{input_tokens,output_tokens} }
//
// Handles both ways: text, tool calls (tool_use/tool_result/tools/tool_choice),
// image blocks (base64 + url), and streaming SSE.
// ponytail: images translate on the REQUEST path (client -> provider); a model
// that streams an image back is not reframed (no mainstream provider does yet).
// Non-base64 data URIs and unknown source kinds are dropped, never thrown.

// Anthropic requires max_tokens; OpenAI treats it as optional. When translating
// OpenAI->Anthropic and the client omitted it, we must supply one.
const DEFAULT_MAX_TOKENS = 4096;

// ── stop-reason / finish-reason mapping ──
// OpenAI finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
// Anthropic stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence'
const FINISH_TO_STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };
const STOP_TO_FINISH = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' };

/**
 * Flatten an Anthropic content value to a plain text string.
 * Content is either a string or an array of blocks; here we keep only text
 * blocks and join them. (Image blocks are dropped — see the ponytail note.)
 */
function anthropicContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// A tool_result's content can be a plain string or an array of blocks; OpenAI's
// tool message wants a single string. Flatten blocks to text.
function toolResultContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : JSON.stringify(b)))
    .join('');
}

// ── image blocks ──
// Anthropic: { type:'image', source:{ type:'base64', media_type, data } | { type:'url', url } }
// OpenAI:    { type:'image_url', image_url:{ url } }  (url is a data: URI or an https URL)
// A block that can't be represented (unknown source kind) is dropped, never thrown.
function anthropicImageToOpenai(source) {
  if (!source) return null;
  if (source.type === 'base64' && source.data) {
    return { type: 'image_url', image_url: { url: `data:${source.media_type || 'image/png'};base64,${source.data}` } };
  }
  if (source.type === 'url' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}
function openaiImageToAnthropic(imageUrl) {
  const url = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url;
  if (!url) return null;
  // data:<media_type>;base64,<data>  → Anthropic base64 source. The `s` flag lets
  // the data run span the whole string; only base64 data URIs are representable.
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (url.startsWith('data:')) return null; // non-base64 data URI — Anthropic can't take it
  return { type: 'image', source: { type: 'url', url } };
}

// Convert a whole content value between formats, PRESERVING images. Text-only
// content collapses to a plain string (exactly the old anthropicContentToText
// output — zero change for the common path); mixed/image content becomes the
// destination format's parts/blocks array so images survive the hop.
function anthropicContentToOpenai(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
    else if (b?.type === 'image') { const img = anthropicImageToOpenai(b.source); if (img) parts.push(img); }
  }
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('');
  return parts;
}
function openaiContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks = [];
  for (const p of content) {
    if (p?.type === 'text' && typeof p.text === 'string') blocks.push({ type: 'text', text: p.text });
    else if (p?.type === 'image_url') { const img = openaiImageToAnthropic(p.image_url); if (img) blocks.push(img); }
  }
  if (blocks.every((b) => b.type === 'text')) return blocks.map((b) => b.text).join('');
  return blocks;
}

// OpenAI tool_calls carry arguments as a JSON *string*; Anthropic tool_use
// carries input as an *object*. These two guard the string<->object crossing so
// a malformed arguments string can't throw mid-translation.
function argsStringToObject(str) {
  if (str == null || str === '') return {};
  try { return JSON.parse(str); } catch { return {}; }
}
function argsObjectToString(obj) {
  return JSON.stringify(obj ?? {});
}

// ── tools[] / tool_choice mapping (request) ──
// OpenAI: { type:'function', function:{ name, description, parameters } }
// Anthropic: { name, description, input_schema }
function openaiToolsToAnthropic(tools) {
  return (tools || [])
    .filter((t) => t && (t.type === 'function' ? t.function : t.name))
    .map((t) => {
      const fn = t.function || t;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters || { type: 'object', properties: {} } };
    });
}
function anthropicToolsToOpenai(tools) {
  return (tools || [])
    .filter((t) => t && t.name)
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } } }));
}
// OpenAI tool_choice: 'auto'|'none'|'required'|{type:'function',function:{name}}
// Anthropic tool_choice: {type:'auto'|'any'|'tool', name?}
function openaiToolChoiceToAnthropic(tc) {
  if (tc == null) return undefined;
  if (tc === 'auto') return { type: 'auto' };
  if (tc === 'required') return { type: 'any' };
  if (tc === 'none') return undefined; // Anthropic has no direct 'none'; omit + drop tools upstream if needed
  if (typeof tc === 'object' && tc.function?.name) return { type: 'tool', name: tc.function.name };
  return undefined;
}
function anthropicToolChoiceToOpenai(tc) {
  if (tc == null) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

// ── REQUEST: OpenAI-shaped body -> Anthropic-shaped body ──
// Client sent OpenAI, provider wants Anthropic.
export function openaiReqToAnthropic(payload) {
  const messages = [];
  const systemParts = [];

  for (const m of payload.messages || []) {
    if (m.role === 'system') {
      // Anthropic carries system as a top-level field, not a message.
      systemParts.push(typeof m.content === 'string' ? m.content : anthropicContentToText(m.content));
      continue;
    }
    // OpenAI 'tool' role -> Anthropic user message carrying a tool_result block.
    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: toolResultContentToText(m.content) }],
      });
      continue;
    }
    // Assistant message with tool_calls -> Anthropic assistant with tool_use blocks
    // (text, if any, becomes a leading text block).
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      const text = typeof m.content === 'string' ? m.content : anthropicContentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: argsStringToObject(tc.function?.arguments) });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    messages.push({ role: m.role, content: openaiContentToAnthropic(m.content) });
  }

  const out = {
    model: payload.model,
    messages,
    max_tokens: payload.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (payload.temperature != null) out.temperature = payload.temperature;
  if (payload.top_p != null) out.top_p = payload.top_p;
  if (payload.stream != null) out.stream = payload.stream;
  // OpenAI 'stop' (string | string[]) -> Anthropic 'stop_sequences' (string[]).
  if (payload.stop != null) out.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  if (payload.tools) out.tools = openaiToolsToAnthropic(payload.tools);
  const tc = openaiToolChoiceToAnthropic(payload.tool_choice);
  if (tc) out.tool_choice = tc;
  return out;
}

// ── REQUEST: Anthropic-shaped body -> OpenAI-shaped body ──
// Client sent Anthropic (e.g. claude-code), provider wants OpenAI.
export function anthropicReqToOpenai(payload) {
  const messages = [];
  // Anthropic 'system' can be a string or an array of text blocks.
  if (payload.system != null) {
    const sys = typeof payload.system === 'string' ? payload.system : anthropicContentToText(payload.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }
  for (const m of payload.messages || []) {
    // A user turn may carry tool_result blocks; each maps to a separate OpenAI
    // 'tool' message. Any plain text/other blocks stay as one user message.
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')) {
      const textPart = anthropicContentToText(m.content);
      if (textPart) messages.push({ role: 'user', content: textPart });
      for (const b of m.content) {
        if (b?.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultContentToText(b.content) });
        }
      }
      continue;
    }
    // An assistant turn may carry tool_use blocks -> OpenAI assistant.tool_calls.
    if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_use')) {
      const text = anthropicContentToText(m.content);
      const toolCalls = m.content
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: argsObjectToString(b.input) } }));
      const msg = { role: 'assistant', content: text || null };
      msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    messages.push({ role: m.role, content: anthropicContentToOpenai(m.content) });
  }

  const out = { model: payload.model, messages };
  if (payload.max_tokens != null) out.max_tokens = payload.max_tokens;
  if (payload.temperature != null) out.temperature = payload.temperature;
  if (payload.top_p != null) out.top_p = payload.top_p;
  if (payload.stream != null) out.stream = payload.stream;
  if (payload.stop_sequences != null) out.stop = payload.stop_sequences;
  if (payload.tools) out.tools = anthropicToolsToOpenai(payload.tools);
  const tc = anthropicToolChoiceToOpenai(payload.tool_choice);
  if (tc) out.tool_choice = tc;
  return out;
}

// ── RESPONSE: Anthropic-shaped body -> OpenAI-shaped body ──
// Client expects OpenAI (it sent OpenAI), provider returned Anthropic.
export function anthropicRespToOpenai(body) {
  const text = anthropicContentToText(body.content);
  // Anthropic tool_use blocks -> OpenAI assistant.tool_calls.
  const toolUses = Array.isArray(body.content) ? body.content.filter((b) => b?.type === 'tool_use') : [];
  const inTok = body.usage?.input_tokens ?? 0;
  const outTok = body.usage?.output_tokens ?? 0;
  const message = { role: 'assistant', content: text || null };
  if (toolUses.length) {
    message.tool_calls = toolUses.map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: argsObjectToString(b.input) },
    }));
  }
  return {
    id: body.id || undefined,
    object: 'chat.completion',
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_TO_FINISH[body.stop_reason] ?? 'stop',
      },
    ],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// ── RESPONSE: OpenAI-shaped body -> Anthropic-shaped body ──
// Client expects Anthropic (it sent Anthropic), provider returned OpenAI.
export function openaiRespToAnthropic(body) {
  const choice = body.choices?.[0] || {};
  const text = typeof choice.message?.content === 'string' ? choice.message.content : anthropicContentToText(choice.message?.content);
  const promptTok = body.usage?.prompt_tokens ?? 0;
  const compTok = body.usage?.completion_tokens ?? 0;
  // OpenAI assistant.tool_calls -> Anthropic tool_use blocks. Text (if any) leads.
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const tc of choice.message?.tool_calls || []) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: argsStringToObject(tc.function?.arguments) });
  }
  return {
    id: body.id || undefined,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: FINISH_TO_STOP[choice.finish_reason] ?? 'end_turn',
    usage: { input_tokens: promptTok, output_tokens: compTok },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// STREAMING (SSE) translation.
//
// Non-stream translation above is object-in/object-out. Streaming is different:
// it reframes an *event stream* incrementally. Both directions are stateful async
// generators — they consume `response.body` (async iterable of Uint8Array/strings)
// and yield SSE text frames ready to res.write().
//
// OpenAI stream:  data: {choices:[{delta:{content}}]}\n\n ... data: [DONE]\n\n
// Anthropic stream: event: <type>\ndata: {type,...}\n\n  (message_start,
//   content_block_start, content_block_delta, content_block_stop, message_delta,
//   message_stop) — no [DONE] sentinel.
//
// STAGE 4 — text AND tool-call deltas both ways (OpenAI tool_calls argument
// fragments <-> Anthropic input_json_delta). Blocks are opened/closed lazily and
// index-mapped across the two schemes (OpenAI: independent tool_calls index +
// argument string fragments; Anthropic: sequential content-block index +
// partial_json). ponytail: image blocks in a stream are still dropped (rare in
// coding CLIs); upgrade path is a base64 image-block passthrough.
// ══════════════════════════════════════════════════════════════════════════

// Pull `data:` payloads out of an SSE byte/string stream, one at a time. Buffers
// across chunk boundaries so a frame split mid-line (common with real providers)
// still parses. `event:` lines are ignored — the Anthropic payload carries its
// own `type`, so we never need to correlate the two lines.
async function* sseData(source) {
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of source) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const t = line.trimStart();
      if (t.startsWith('data:')) yield t.slice(5).trim();
    }
  }
  const rest = buf.trim();
  if (rest.startsWith('data:')) yield rest.slice(5).trim();
}

const oaiFrame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const anthFrame = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;

// ── STREAM: OpenAI SSE -> Anthropic SSE ──
// Client sent Anthropic (claude-code), provider streamed OpenAI. We open the
// Anthropic envelope lazily (message_start on the first frame, content_block on
// the first text) and close it (content_block_stop/message_delta/message_stop)
// when the OpenAI stream signals finish_reason or ends.
export async function* openaiStreamToAnthropic(source, { model = 'unknown', id = 'msg_stream' } = {}) {
  let started = false, finish = null, outTokens = 0;
  // Anthropic blocks are sequential — only one open at a time, indexed 0,1,2…
  // We open lazily and close the current before opening the next. `openBlock`
  // tracks the live one; `toolMap` remembers which Anthropic block a given
  // OpenAI tool_call index landed in (arguments arrive in later chunks).
  let openBlock = null, nextIndex = 0;
  const toolMap = new Map();

  function* closeOpen() {
    if (openBlock) { yield anthFrame('content_block_stop', { type: 'content_block_stop', index: openBlock.index }); openBlock = null; }
  }

  for await (const data of sseData(source)) {
    if (data === '[DONE]') break;
    let f;
    try { f = JSON.parse(data); } catch { continue; }
    const choice = f.choices?.[0] || {};
    const delta = choice.delta || {};
    if (!started) {
      started = true;
      yield anthFrame('message_start', {
        type: 'message_start',
        message: { id: f.id || id, type: 'message', role: 'assistant', model: f.model || model, content: [], stop_reason: null, usage: { input_tokens: f.usage?.prompt_tokens ?? 0, output_tokens: 0 } },
      });
    }
    if (typeof delta.content === 'string' && delta.content.length) {
      if (openBlock?.kind !== 'text') {
        yield* closeOpen();
        openBlock = { kind: 'text', index: nextIndex++ };
        yield anthFrame('content_block_start', { type: 'content_block_start', index: openBlock.index, content_block: { type: 'text', text: '' } });
      }
      yield anthFrame('content_block_delta', { type: 'content_block_delta', index: openBlock.index, delta: { type: 'text_delta', text: delta.content } });
    }
    // Streamed tool calls: OpenAI sends id+name on the first fragment for a tool
    // index, then argument string fragments on later ones.
    for (const tc of delta.tool_calls || []) {
      const oaiIdx = tc.index ?? 0;
      if (!toolMap.has(oaiIdx)) {
        yield* closeOpen();
        const index = nextIndex++;
        toolMap.set(oaiIdx, index);
        openBlock = { kind: 'tool', index };
        yield anthFrame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tc.id || `call_${oaiIdx}`, name: tc.function?.name || '', input: {} } });
      }
      const frag = tc.function?.arguments;
      if (frag) {
        // ponytail: assumes providers stream a tool's argument fragments
        // contiguously (they do). If a later fragment arrives after another
        // block opened, its block is already closed and the fragment is dropped.
        const index = toolMap.get(oaiIdx);
        if (openBlock?.index === index) yield anthFrame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: frag } });
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    if (f.usage?.completion_tokens != null) outTokens = f.usage.completion_tokens;
  }
  // A stream that emitted nothing still needs a valid Anthropic envelope.
  if (!started) yield anthFrame('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  yield* closeOpen();
  yield anthFrame('message_delta', { type: 'message_delta', delta: { stop_reason: FINISH_TO_STOP[finish] ?? 'end_turn' }, usage: { output_tokens: outTokens } });
  yield anthFrame('message_stop', { type: 'message_stop' });
}

// ── STREAM: Anthropic SSE -> OpenAI SSE ──
// Client sent OpenAI, provider streamed Anthropic. Reframe each Anthropic event
// into an OpenAI chat.completion.chunk; close with the [DONE] sentinel OpenAI
// clients expect (Anthropic never sends one).
export async function* anthropicStreamToOpenai(source, { model = 'unknown', id = 'chatcmpl_stream' } = {}) {
  let msgId = id, msgModel = model, doneSent = false;
  // Map each Anthropic content-block index to an OpenAI tool_calls array index.
  // OpenAI numbers tool_calls from 0 independently of the block index, so a
  // tool_use at block 1 (after a text block at 0) is still tool_calls index 0.
  const toolSlot = new Map();
  let nextToolSlot = 0;
  const chunk = (choice) => oaiFrame({ id: msgId, object: 'chat.completion.chunk', model: msgModel, choices: [choice] });
  for await (const data of sseData(source)) {
    if (data === '[DONE]') continue;
    let f;
    try { f = JSON.parse(data); } catch { continue; }
    switch (f.type) {
      case 'message_start':
        msgId = f.message?.id || msgId;
        msgModel = f.message?.model || msgModel;
        yield chunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
        break;
      case 'content_block_start':
        // A tool_use block opening -> emit the OpenAI tool_call header (id+name)
        // now; arguments follow as input_json_delta fragments.
        if (f.content_block?.type === 'tool_use') {
          const slot = nextToolSlot++;
          toolSlot.set(f.index, slot);
          yield chunk({ index: 0, delta: { tool_calls: [{ index: slot, id: f.content_block.id, type: 'function', function: { name: f.content_block.name, arguments: '' } }] }, finish_reason: null });
        }
        break;
      case 'content_block_delta':
        if (f.delta?.type === 'text_delta') yield chunk({ index: 0, delta: { content: f.delta.text }, finish_reason: null });
        else if (f.delta?.type === 'input_json_delta') {
          const slot = toolSlot.get(f.index);
          if (slot != null) yield chunk({ index: 0, delta: { tool_calls: [{ index: slot, function: { arguments: f.delta.partial_json || '' } }] }, finish_reason: null });
        }
        break;
      case 'message_delta':
        if (f.delta?.stop_reason) yield chunk({ index: 0, delta: {}, finish_reason: STOP_TO_FINISH[f.delta.stop_reason] ?? 'stop' });
        break;
      case 'message_stop':
        yield 'data: [DONE]\n\n';
        doneSent = true;
        break;
    }
  }
  if (!doneSent) yield 'data: [DONE]\n\n';
}

// Exposed for tests / later stages.
export { anthropicContentToText, DEFAULT_MAX_TOKENS, sseData };

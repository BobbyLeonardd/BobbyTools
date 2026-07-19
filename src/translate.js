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
  let text = typeof choice.message?.content === 'string' ? choice.message.content : anthropicContentToText(choice.message?.content);
  // Anthropic assistant messages can't carry images (Claude never emits one), so a
  // model that returned an image can't be represented. Rather than drop it silently,
  // leave a visible marker so the client sees SOMETHING happened.
  if (Array.isArray(choice.message?.content) && choice.message.content.some((b) => b?.type === 'image_url')) {
    text = (text ? text + '\n\n' : '') + '[image omitted: target format cannot carry image output]';
  }
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
// partial_json).
//
// IMAGE OUTPUT (stage 9): the two formats that emit images (Gemini inlineData,
// Responses image_generation_call) carry them across the hub as a hub-internal
// `delta.images: [{ mime, data }]` field on an OpenAI chunk (base64). ONLY the
// gemini/responses spokes read/write it. Formats that can't represent image
// output (openai chat, anthropic) strip it and leave a one-time "[image omitted]"
// marker rather than leaking non-standard frames — see openaiStreamFromHub and
// the anthropic spoke. Anthropic input images in a *request* are already handled
// elsewhere; only streamed image OUTPUT is the concern here.
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
  let started = false, finish = null, outTokens = 0, markedImage = false;
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
    // Anthropic can't carry image output. If the hub is streaming one, don't leak
    // it — emit a one-time text marker (mirrors the non-stream openaiRespToAnthropic).
    let textDelta = typeof delta.content === 'string' ? delta.content : '';
    if (Array.isArray(delta.images) && delta.images.length && !markedImage) {
      markedImage = true;
      textDelta += (textDelta ? '\n\n' : '') + '[image omitted: Anthropic format cannot carry image output]';
    }
    if (textDelta.length) {
      if (openBlock?.kind !== 'text') {
        yield* closeOpen();
        openBlock = { kind: 'text', index: nextIndex++ };
        yield anthFrame('content_block_start', { type: 'content_block_start', index: openBlock.index, content_block: { type: 'text', text: '' } });
      }
      yield anthFrame('content_block_delta', { type: 'content_block_delta', index: openBlock.index, delta: { type: 'text_delta', text: textDelta } });
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

// ══════════════════════════════════════════════════════════════════════════
// GEMINI spoke — Google Generative Language `generateContent` format.
//
// Gemini's wire shape differs from OpenAI/Anthropic in every dimension, so this
// spoke translates to/from the OpenAI hub (never directly to Anthropic):
//   - messages -> `contents[]`, each { role, parts[] }; assistant role is "model"
//   - system prompt -> top-level `systemInstruction: { parts: [{text}] }`
//   - a Part is one of: {text}, {inlineData:{mimeType,data}}, {fileData:{...}},
//     {functionCall:{name,args}}, {functionResponse:{name,response}}
//   - tools -> [{ functionDeclarations: [{name,description,parameters}] }]
//   - response: candidates[0].content.parts[], finishReason (UPPERCASE enum),
//     usageMetadata:{promptTokenCount,candidatesTokenCount}
//   - stream: SSE where each `data:` is a full GenerateContentResponse chunk;
//     NO [DONE] sentinel (the last chunk carries finishReason).
// Field shapes verified against ai.google.dev/api/generate-content (Jan 2026).
// Endpoint/auth quirks (model in URL, x-goog-api-key) live in server.js, not here.
// ══════════════════════════════════════════════════════════════════════════

// Gemini finishReason (UPPERCASE) <-> OpenAI finish_reason.
const GEMINI_FINISH_TO_OAI = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', BLOCKLIST: 'content_filter', PROHIBITED_CONTENT: 'content_filter', SPII: 'content_filter', MALFORMED_FUNCTION_CALL: 'tool_calls', OTHER: 'stop' };
const OAI_FINISH_TO_GEMINI = { stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP', content_filter: 'SAFETY' };

// One OpenAI message-content value -> an array of Gemini parts. A string becomes
// a single text part; an array of OpenAI blocks maps text and image_url through.
function openaiContentToGeminiParts(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') { if (b) parts.push({ text: b }); continue; }
    if (b?.type === 'text' && b.text) parts.push({ text: b.text });
    else if (b?.type === 'image_url') {
      const url = typeof b.image_url === 'string' ? b.image_url : b.image_url?.url;
      const m = url && /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      else if (url) parts.push({ fileData: { fileUri: url } }); // remote URL
    }
  }
  return parts;
}

// Gemini parts -> a plain text string (text parts only; thoughtSignature/inline
// data ignored for the hub text field — tool calls are pulled out separately).
function geminiPartsToText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('');
}

// ── REQUEST: OpenAI hub -> Gemini ──
function openaiReqToGemini(payload) {
  const contents = [];
  const systemParts = [];
  for (const m of payload.messages || []) {
    if (m.role === 'system') {
      const t = typeof m.content === 'string' ? m.content : geminiPartsToText(openaiContentToGeminiParts(m.content));
      if (t) systemParts.push({ text: t });
      continue;
    }
    // OpenAI 'tool' role -> Gemini user turn carrying a functionResponse part.
    if (m.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name || m.tool_call_id || 'tool', response: safeJsonObject(m.content) } }] });
      continue;
    }
    // Assistant with tool_calls -> model turn with functionCall parts (+ any text).
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = [];
      const text = typeof m.content === 'string' ? m.content : geminiPartsToText(openaiContentToGeminiParts(m.content));
      if (text) parts.push({ text });
      for (const tc of m.tool_calls) parts.push({ functionCall: { name: tc.function?.name, args: argsStringToObject(tc.function?.arguments) } });
      contents.push({ role: 'model', parts });
      continue;
    }
    // Gemini uses "model" for the assistant role; "user" stays "user".
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: openaiContentToGeminiParts(m.content) });
  }

  const out = { contents };
  if (systemParts.length) out.systemInstruction = { parts: systemParts };
  const genCfg = {};
  if (payload.max_tokens != null) genCfg.maxOutputTokens = payload.max_tokens;
  if (payload.temperature != null) genCfg.temperature = payload.temperature;
  if (payload.top_p != null) genCfg.topP = payload.top_p;
  if (payload.stop != null) genCfg.stopSequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  if (Object.keys(genCfg).length) out.generationConfig = genCfg;
  if (Array.isArray(payload.tools) && payload.tools.length) {
    out.tools = [{ functionDeclarations: payload.tools.map((t) => ({ name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters })) }];
  }
  return out;
}

// A functionResponse.response must be a JSON object. OpenAI tool content is a
// string; wrap non-object/parse-failures under a `content` key so it's valid.
function safeJsonObject(content) {
  const text = toolResultContentToText(content);
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : { content: v }; }
  catch { return { content: text }; }
}

// ── REQUEST: Gemini -> OpenAI hub ──
function geminiReqToOpenai(payload) {
  const messages = [];
  const sysParts = payload.systemInstruction?.parts || payload.system_instruction?.parts;
  if (sysParts) {
    const t = geminiPartsToText(Array.isArray(sysParts) ? sysParts : [sysParts]);
    if (t) messages.push({ role: 'system', content: t });
  }
  for (const c of payload.contents || []) {
    const parts = c.parts || [];
    const funcCalls = parts.filter((p) => p?.functionCall);
    const funcResps = parts.filter((p) => p?.functionResponse);
    if (funcResps.length) {
      for (const p of funcResps) messages.push({ role: 'tool', name: p.functionResponse.name, tool_call_id: p.functionResponse.name, content: JSON.stringify(p.functionResponse.response ?? {}) });
      continue;
    }
    if (c.role === 'model' && funcCalls.length) {
      const text = geminiPartsToText(parts);
      messages.push({ role: 'assistant', content: text || null, tool_calls: funcCalls.map((p, i) => ({ id: `call_${i}`, type: 'function', function: { name: p.functionCall.name, arguments: argsObjectToString(p.functionCall.args) } })) });
      continue;
    }
    // Map parts back to OpenAI content: text + inlineData/fileData images.
    const content = geminiPartsToOpenaiContent(parts);
    messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content });
  }
  const out = { model: payload.model, messages };
  const g = payload.generationConfig || payload.generation_config || {};
  if (g.maxOutputTokens != null) out.max_tokens = g.maxOutputTokens;
  if (g.temperature != null) out.temperature = g.temperature;
  if (g.topP != null) out.top_p = g.topP;
  if (g.stopSequences != null) out.stop = g.stopSequences;
  const decls = (payload.tools || []).flatMap((t) => t.functionDeclarations || t.function_declarations || []);
  if (decls.length) out.tools = decls.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));
  return out;
}

// Gemini parts -> OpenAI message content. Collapses to a plain string when
// there's only text (mirrors the anthropic spoke's behavior), else an array.
function geminiPartsToOpenaiContent(parts) {
  if (!Array.isArray(parts)) return '';
  const out = [];
  for (const p of parts) {
    if (typeof p?.text === 'string') out.push({ type: 'text', text: p.text });
    else if (p?.inlineData || p?.inline_data) {
      const d = p.inlineData || p.inline_data;
      out.push({ type: 'image_url', image_url: { url: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}` } });
    } else if (p?.fileData || p?.file_data) {
      const d = p.fileData || p.file_data;
      if (d.fileUri || d.file_uri) out.push({ type: 'image_url', image_url: { url: d.fileUri || d.file_uri } });
    }
  }
  if (out.length === 1 && out[0].type === 'text') return out[0].text;
  if (out.length === 0) return '';
  return out;
}

// ── RESPONSE: Gemini -> OpenAI hub ──
function geminiRespToOpenai(body) {
  const cand = body.candidates?.[0] || {};
  const parts = cand.content?.parts || [];
  // Preserve image output: geminiPartsToOpenaiContent maps inlineData/fileData ->
  // image_url parts (collapsing to a plain string only when it's text-only), so a
  // model that RETURNS an image survives the hop instead of being flattened to text.
  const content = geminiPartsToOpenaiContent(parts);
  const funcCalls = parts.filter((p) => p?.functionCall);
  const message = { role: 'assistant', content: (Array.isArray(content) ? content.length : content) ? content : null };
  if (funcCalls.length) {
    message.tool_calls = funcCalls.map((p, i) => ({ id: `call_${i}`, type: 'function', function: { name: p.functionCall.name, arguments: argsObjectToString(p.functionCall.args) } }));
  }
  const promptTok = body.usageMetadata?.promptTokenCount ?? 0;
  const compTok = body.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    id: body.responseId || undefined,
    object: 'chat.completion',
    model: body.modelVersion || body.model,
    choices: [{ index: 0, message, finish_reason: GEMINI_FINISH_TO_OAI[cand.finishReason] ?? 'stop' }],
    usage: { prompt_tokens: promptTok, completion_tokens: compTok, total_tokens: promptTok + compTok },
  };
}

// ── RESPONSE: OpenAI hub -> Gemini ──
function openaiRespToGemini(body) {
  const choice = body.choices?.[0] || {};
  // openaiContentToGeminiParts preserves image_url -> inlineData/fileData, so an
  // image the hub is carrying (e.g. relayed from a Responses image_generation_call)
  // comes back out as a real Gemini image part, not just its text.
  const parts = typeof choice.message?.content === 'string'
    ? (choice.message.content ? [{ text: choice.message.content }] : [])
    : openaiContentToGeminiParts(choice.message?.content);
  for (const tc of choice.message?.tool_calls || []) parts.push({ functionCall: { name: tc.function?.name, args: argsStringToObject(tc.function?.arguments) } });
  const promptTok = body.usage?.prompt_tokens ?? 0;
  const compTok = body.usage?.completion_tokens ?? 0;
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: OAI_FINISH_TO_GEMINI[choice.finish_reason] ?? 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: promptTok, candidatesTokenCount: compTok, totalTokenCount: promptTok + compTok },
    modelVersion: body.model,
    responseId: body.id || undefined,
  };
}

// ── STREAM: Gemini SSE -> OpenAI SSE ──
// Each Gemini `data:` is a full GenerateContentResponse chunk with an incremental
// text part. We emit OpenAI chat.completion.chunk frames + a final [DONE].
async function* geminiStreamToOpenai(source, { model = 'unknown', id = 'chatcmpl_stream' } = {}) {
  const chunk = (delta, finish = null) => oaiFrame({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] });
  let started = false, finish = null;
  for await (const data of sseData(source)) {
    if (data === '[DONE]') break; // Gemini omits this, but tolerate it.
    let f; try { f = JSON.parse(data); } catch { continue; }
    const cand = f.candidates?.[0] || {};
    const parts = cand.content?.parts || [];
    if (!started) { started = true; yield chunk({ role: 'assistant' }); }
    const text = geminiPartsToText(parts);
    if (text) yield chunk({ content: text });
    // Image parts (inlineData) -> hub image delta. `delta.images` is a hub-internal
    // convention (see the streaming header note): only the gemini/responses spokes
    // read it, and it's stripped before any OpenAI/Anthropic client sees a frame.
    const images = geminiImagePartsToHub(parts);
    if (images.length) yield chunk({ images });
    let slot = 0;
    for (const p of parts) {
      if (p?.functionCall) yield chunk({ tool_calls: [{ index: slot, id: `call_${slot}`, type: 'function', function: { name: p.functionCall.name, arguments: argsObjectToString(p.functionCall.args) } }] }), slot++;
    }
    if (cand.finishReason) finish = cand.finishReason;
  }
  if (!started) yield chunk({ role: 'assistant' });
  yield chunk({}, GEMINI_FINISH_TO_OAI[finish] ?? 'stop');
  yield 'data: [DONE]\n\n';
}

// Pull image parts out of a Gemini parts[] as hub image deltas { mime, data }
// (base64). Shared by the stream + could be reused; keeps the inlineData/inline_data
// spelling tolerance in one place.
function geminiImagePartsToHub(parts) {
  const out = [];
  for (const p of parts || []) {
    const d = p?.inlineData || p?.inline_data;
    if (d?.data) out.push({ mime: d.mimeType || d.mime_type || 'image/png', data: d.data });
  }
  return out;
}

// ── STREAM: OpenAI SSE -> Gemini SSE ──
// Reframe OpenAI chunks into Gemini GenerateContentResponse chunks. No [DONE];
// the final chunk carries finishReason (Gemini clients end on it).
async function* openaiStreamToGemini(source, { model = 'unknown' } = {}) {
  const frame = (parts, finishReason, usage) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: finishReason || '', index: 0 }], ...(usage ? { usageMetadata: usage } : {}), modelVersion: model })}\n\n`;
  let finish = null, promptTok = 0, compTok = 0;
  const toolAccum = new Map(); // oaiIdx -> {name, args}
  for await (const data of sseData(source)) {
    if (data === '[DONE]') break;
    let f; try { f = JSON.parse(data); } catch { continue; }
    const delta = f.choices?.[0]?.delta || {};
    if (f.usage) { promptTok = f.usage.prompt_tokens ?? promptTok; compTok = f.usage.completion_tokens ?? compTok; }
    if (typeof delta.content === 'string' && delta.content.length) yield frame([{ text: delta.content }], '');
    // Hub image deltas -> Gemini inlineData parts, streamed as they arrive.
    for (const img of delta.images || []) yield frame([{ inlineData: { mimeType: img.mime || 'image/png', data: img.data } }], '');
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const acc = toolAccum.get(idx) || { name: '', args: '' };
      if (tc.function?.name) acc.name = tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      toolAccum.set(idx, acc);
    }
    if (f.choices?.[0]?.finish_reason) finish = f.choices[0].finish_reason;
  }
  // Flush any accumulated tool calls as functionCall parts on the final chunk.
  const finalParts = [];
  for (const acc of toolAccum.values()) finalParts.push({ functionCall: { name: acc.name, args: argsStringToObject(acc.args) } });
  yield frame(finalParts, OAI_FINISH_TO_GEMINI[finish] ?? 'STOP', { promptTokenCount: promptTok, candidatesTokenCount: compTok, totalTokenCount: promptTok + compTok });
}

// ══════════════════════════════════════════════════════════════════════════
// RESPONSES spoke — OpenAI's newer /v1/responses format.
//
// Same vendor as the hub but a different shape, so it's still a spoke:
//   - request: `input` is a string OR an array of items. A message item is
//     { role, content } where content is a string or parts of type
//     `input_text`{text} / `input_image`{image_url}. `instructions` is the
//     system prompt. Tool results are `function_call_output`{call_id,output}
//     items; assistant tool calls are `function_call`{call_id,name,arguments}.
//   - tools are FLAT: { type:'function', name, description, parameters } — no
//     nested `function` wrapper like Chat Completions uses.
//   - limits: `max_output_tokens` (not max_tokens).
//   - response: `output[]` holds `message` items (content parts of type
//     `output_text`{text}) and `function_call` items{call_id,name,arguments}.
//     `usage` is {input_tokens, output_tokens}.
//   - stream: semantic SSE events keyed by a `type` field — response.created,
//     response.output_text.delta{delta}, response.function_call_arguments.delta,
//     response.completed{response}. No [DONE] sentinel.
// Shapes verified against developers.openai.com Responses docs (Jan 2026).
// ══════════════════════════════════════════════════════════════════════════

// Responses `input` message content -> a plain text string (text parts only).
function responsesContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && (p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string').map((p) => p.text).join('');
}

// OpenAI hub message content -> Responses input parts (input_text/input_image).
function openaiContentToResponsesParts(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') { if (b) parts.push({ type: 'input_text', text: b }); continue; }
    if (b?.type === 'text' && b.text) parts.push({ type: 'input_text', text: b.text });
    else if (b?.type === 'image_url') {
      const url = typeof b.image_url === 'string' ? b.image_url : b.image_url?.url;
      if (url) parts.push({ type: 'input_image', image_url: url });
    }
  }
  return parts.length === 1 && parts[0].type === 'input_text' ? parts[0].text : parts;
}

// Responses parts -> OpenAI hub content (input_text/input_image -> text/image_url).
function responsesPartsToOpenaiContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if ((p?.type === 'input_text' || p?.type === 'output_text') && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    else if (p?.type === 'input_image' && p.image_url) out.push({ type: 'image_url', image_url: { url: p.image_url } });
  }
  if (out.length === 1 && out[0].type === 'text') return out[0].text;
  return out.length ? out : '';
}

// ── REQUEST: Responses -> OpenAI hub ──
function responsesReqToOpenai(payload) {
  const messages = [];
  if (payload.instructions) messages.push({ role: 'system', content: payload.instructions });
  const input = payload.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item?.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: toolResultContentToText(item.output) });
      } else if (item?.type === 'function_call') {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : argsObjectToString(item.arguments) } }] });
      } else if (item?.role) {
        // A message item; content may be string or input_* parts.
        messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: responsesPartsToOpenaiContent(item.content) });
      }
    }
  }
  const out = { model: payload.model, messages };
  if (payload.max_output_tokens != null) out.max_tokens = payload.max_output_tokens;
  if (payload.temperature != null) out.temperature = payload.temperature;
  if (payload.top_p != null) out.top_p = payload.top_p;
  if (payload.stream != null) out.stream = payload.stream;
  if (Array.isArray(payload.tools) && payload.tools.length) {
    // Responses tools are flat; keep only the function ones (skip hosted tools
    // like web_search that the hub has no equivalent for).
    const fns = payload.tools.filter((t) => t.type === 'function' || t.name);
    if (fns.length) out.tools = fns.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  return out;
}

// ── REQUEST: OpenAI hub -> Responses ──
function openaiReqToResponses(payload) {
  const input = [];
  let instructions;
  for (const m of payload.messages || []) {
    if (m.role === 'system') {
      const t = typeof m.content === 'string' ? m.content : responsesContentToText(openaiContentToResponsesParts(m.content));
      instructions = instructions ? `${instructions}\n\n${t}` : t;
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: toolResultContentToText(m.content) });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const text = typeof m.content === 'string' ? m.content : responsesContentToText(openaiContentToResponsesParts(m.content));
      if (text) input.push({ role: 'assistant', content: text });
      for (const tc of m.tool_calls) input.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? '{}' });
      continue;
    }
    input.push({ role: m.role, content: openaiContentToResponsesParts(m.content) });
  }
  const out = { model: payload.model, input };
  if (instructions) out.instructions = instructions;
  if (payload.max_tokens != null) out.max_output_tokens = payload.max_tokens;
  if (payload.temperature != null) out.temperature = payload.temperature;
  if (payload.top_p != null) out.top_p = payload.top_p;
  if (payload.stream != null) out.stream = payload.stream;
  if (Array.isArray(payload.tools) && payload.tools.length) {
    out.tools = payload.tools.map((t) => ({ type: 'function', name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters }));
  }
  return out;
}

// ── RESPONSE: Responses body -> OpenAI hub ──
function responsesRespToOpenai(body) {
  let text = '';
  const toolCalls = [];
  const images = []; // image_generation_call results -> hub image_url parts
  for (const item of body.output || []) {
    if (item?.type === 'message') {
      for (const c of item.content || []) if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
    } else if (item?.type === 'function_call') {
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : argsObjectToString(item.arguments) } });
    } else if (item?.type === 'image_generation_call' && typeof item.result === 'string' && item.result) {
      // result is a bare base64 image (no data: prefix). Wrap it as a data URI so
      // it rides the hub as a normal image_url part.
      const mt = item.output_format ? `image/${item.output_format}` : 'image/png';
      images.push({ type: 'image_url', image_url: { url: `data:${mt};base64,${item.result}` } });
    }
  }
  // Responses also exposes a convenience `output_text` aggregate; use it if the
  // structured walk found nothing (some minimal responses only set that).
  if (!text && typeof body.output_text === 'string') text = body.output_text;
  // Text-only stays a plain string (common path unchanged); an image present makes
  // content a parts array so the picture survives to the client's format.
  let content;
  if (images.length) { content = []; if (text) content.push({ type: 'text', text }); content.push(...images); }
  else content = text || null;
  const message = { role: 'assistant', content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const inTok = body.usage?.input_tokens ?? 0;
  const outTok = body.usage?.output_tokens ?? 0;
  return {
    id: body.id || undefined,
    object: 'chat.completion',
    model: body.model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// ── RESPONSE: OpenAI hub -> Responses body ──
function openaiRespToResponses(body) {
  const choice = body.choices?.[0] || {};
  const output = [];
  const text = typeof choice.message?.content === 'string' ? choice.message.content : responsesContentToText(openaiContentToResponsesParts(choice.message?.content));
  if (text) output.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  // Hub image parts (base64 data URIs) -> Responses image_generation_call items,
  // carrying the bare base64 in `result` (the shape a Responses client reads back).
  if (Array.isArray(choice.message?.content)) {
    let n = 0;
    for (const b of choice.message.content) {
      if (b?.type !== 'image_url') continue;
      const url = typeof b.image_url === 'string' ? b.image_url : b.image_url?.url;
      const m = url && /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (m) output.push({ type: 'image_generation_call', id: `ig_${n++}`, status: 'completed', result: m[2], output_format: (m[1].split('/')[1] || 'png') });
    }
  }
  for (const tc of choice.message?.tool_calls || []) output.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? '{}', status: 'completed' });
  const inTok = body.usage?.prompt_tokens ?? 0;
  const outTok = body.usage?.completion_tokens ?? 0;
  return {
    id: body.id || undefined,
    object: 'response',
    model: body.model,
    status: 'completed',
    output,
    output_text: text || '',
    usage: { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// ── STREAM: Responses SSE -> OpenAI hub SSE ──
// Responses emits semantic events keyed by a `type` field inside each data JSON.
// We care about text deltas, function-call argument deltas, and completion.
async function* responsesStreamToOpenai(source, { model = 'unknown', id = 'chatcmpl_stream' } = {}) {
  const chunk = (delta, finish = null) => oaiFrame({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] });
  let started = false, sawTool = false;
  // Map a Responses output_index for a function_call to an OpenAI tool_calls slot.
  const toolSlot = new Map();
  // ponytail: partial_image events are progressive previews of ONE final image,
  // so we collapse them — keep the latest b64 and emit a single image delta at the
  // end, instead of streaming N previews the destination would render as N pictures.
  // Upgrade path: pass partials through with a `partial:true` flag if a client wants
  // live previews.
  let lastImageB64 = null, imageMime = 'image/png';
  for await (const data of sseData(source)) {
    if (data === '[DONE]') break; // Responses omits this, but tolerate it.
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    if (!started) { started = true; yield chunk({ role: 'assistant' }); }
    switch (ev.type) {
      case 'response.output_text.delta':
        if (ev.delta) yield chunk({ content: ev.delta });
        break;
      case 'response.image_generation_call.partial_image':
        // Progressive preview: remember it as the current best, don't emit yet.
        if (ev.partial_image_b64) { lastImageB64 = ev.partial_image_b64; if (ev.output_format) imageMime = `image/${ev.output_format}`; }
        break;
      case 'response.completed':
        // Final image (if any) lives in the assembled output as an image_generation_call.
        for (const item of ev.response?.output || []) {
          if (item?.type === 'image_generation_call' && typeof item.result === 'string' && item.result) {
            lastImageB64 = item.result;
            if (item.output_format) imageMime = `image/${item.output_format}`;
          }
        }
        break;
      case 'response.output_item.added':
        if (ev.item?.type === 'function_call') {
          const oi = ev.output_index ?? toolSlot.size;
          const slot = toolSlot.size;
          toolSlot.set(oi, slot);
          sawTool = true;
          yield chunk({ tool_calls: [{ index: slot, id: ev.item.call_id || `call_${slot}`, type: 'function', function: { name: ev.item.name || '', arguments: '' } }] });
        }
        break;
      case 'response.function_call_arguments.delta': {
        const oi = ev.output_index ?? 0;
        const slot = toolSlot.get(oi) ?? 0;
        if (ev.delta) yield chunk({ tool_calls: [{ index: slot, function: { arguments: ev.delta } }] });
        break;
      }
      default:
        break; // response.created, .in_progress, .output_item.done, etc. — ignored.
    }
  }
  if (!started) yield chunk({ role: 'assistant' });
  // Emit the collapsed final image (hub image delta) before closing.
  if (lastImageB64) yield chunk({ images: [{ mime: imageMime, data: lastImageB64 }] });
  yield chunk({}, sawTool ? 'tool_calls' : 'stop');
  yield 'data: [DONE]\n\n';
}

// ── STREAM: OpenAI hub SSE -> Responses SSE ──
// Reframe OpenAI chunks into Responses semantic events. We emit response.created,
// text deltas, function-call item + argument deltas, then response.completed with
// the assembled response object (Responses clients read final state from it).
async function* openaiStreamToResponses(source, { model = 'unknown', id = 'resp_stream' } = {}) {
  const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
  let created = false, textStarted = false, fullText = '';
  let promptTok = 0, compTok = 0;
  const tools = new Map(); // oaiIdx -> { call_id, name, args, outputIndex }
  let outputIndex = 0;
  const images = []; // { data, mime } collected from hub image deltas
  let partialIdx = 0;
  for await (const data of sseData(source)) {
    if (data === '[DONE]') break;
    let f; try { f = JSON.parse(data); } catch { continue; }
    if (f.usage) { promptTok = f.usage.prompt_tokens ?? promptTok; compTok = f.usage.completion_tokens ?? compTok; }
    if (!created) {
      created = true;
      yield ev('response.created', { response: { id, object: 'response', model, status: 'in_progress', output: [] } });
    }
    const delta = f.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string' && delta.content.length) {
      if (!textStarted) {
        textStarted = true;
        yield ev('response.output_item.added', { output_index: outputIndex, item: { type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      }
      fullText += delta.content;
      yield ev('response.output_text.delta', { output_index: outputIndex, delta: delta.content });
    }
    // Hub image deltas -> Responses partial_image events (the shape a Responses
    // client reads incrementally); the final image_generation_call item is added
    // to response.output below.
    for (const img of delta.images || []) {
      images.push({ data: img.data, mime: img.mime || 'image/png' });
      yield ev('response.image_generation_call.partial_image', { partial_image_index: partialIdx++, partial_image_b64: img.data });
    }
    for (const tc of delta.tool_calls || []) {
      const oaiIdx = tc.index ?? 0;
      if (!tools.has(oaiIdx)) {
        if (textStarted) { yield ev('response.output_item.done', { output_index: outputIndex, item: { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText, annotations: [] }] } }); outputIndex++; textStarted = false; }
        const oi = ++outputIndex - 1;
        const rec = { call_id: tc.id || `call_${oaiIdx}`, name: tc.function?.name || '', args: '', outputIndex: oi };
        tools.set(oaiIdx, rec);
        yield ev('response.output_item.added', { output_index: oi, item: { type: 'function_call', call_id: rec.call_id, name: rec.name, arguments: '' } });
      }
      const rec = tools.get(oaiIdx);
      const frag = tc.function?.arguments;
      if (frag) { rec.args += frag; yield ev('response.function_call_arguments.delta', { output_index: rec.outputIndex, delta: frag }); }
    }
  }
  // Close whatever's open and assemble the final response.output[].
  const output = [];
  if (fullText) {
    if (textStarted) yield ev('response.output_item.done', { output_index: 0, item: { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText, annotations: [] }] } });
    output.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText, annotations: [] }] });
  }
  for (const rec of tools.values()) {
    yield ev('response.function_call_arguments.done', { output_index: rec.outputIndex, arguments: rec.args });
    output.push({ type: 'function_call', call_id: rec.call_id, name: rec.name, arguments: rec.args, status: 'completed' });
  }
  // Each collected image -> a completed image_generation_call item (bare base64 in
  // `result`, matching the non-stream shape a Responses client expects).
  images.forEach((img, i) => output.push({ type: 'image_generation_call', id: `ig_${i}`, status: 'completed', result: img.data, output_format: (img.mime.split('/')[1] || 'png') }));
  yield ev('response.completed', { response: { id, object: 'response', model, status: 'completed', output, output_text: fullText, usage: { input_tokens: promptTok, output_tokens: compTok, total_tokens: promptTok + compTok } } });
}

// ══════════════════════════════════════════════════════════════════════════
// FORMAT REGISTRY — hub-and-spoke translation.
//
// The hub (canonical intermediate) is OpenAI Chat Completions. Every other
// format is a "spoke" that knows only how to convert TO and FROM the hub — it
// never talks to another spoke directly. Anthropic <-> Gemini goes through the
// hub with zero cross-spoke code. Adding format N costs 6 functions (one per
// direction × 3 stages), not N pairwise translators — linear, not quadratic.
//
// Each spoke implements the same 6-function contract:
//   reqToHub(payload)          spoke request  -> OpenAI request
//   reqFromHub(payload)        OpenAI request -> spoke request
//   respToHub(body)            spoke response  -> OpenAI response
//   respFromHub(body)          OpenAI response -> spoke response
//   streamToHub(src, opts)     spoke SSE  -> OpenAI SSE frames (async gen)
//   streamFromHub(src, opts)   OpenAI SSE -> spoke SSE frames (async gen)
//
// The hub format (openai) uses identity for every function. Streaming composes:
// streamToHub yields OpenAI SSE *text frames*, which streamFromHub consumes as
// its source — sseData() already parses string frames, so generators chain.
// ══════════════════════════════════════════════════════════════════════════

const identity = (x) => x;
async function* identityStream(source) { yield* source; }

// OpenAI Chat Completions can't represent image OUTPUT (assistant content is a
// string). When translating TO openai from a spoke that produced an image, degrade
// gracefully instead of leaking a non-standard content array: keep the text, drop
// the image, leave a marker. These run ONLY on a real cross-format pivot to openai
// (from !== to); the byte-passthrough fast path in server.js never calls them, and
// openai->openai is skipped by the dispatcher — so existing paths are untouched.
function openaiRespFromHub(body) {
  const choice = body?.choices?.[0];
  const c = choice?.message?.content;
  if (Array.isArray(c)) {
    const text = c.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
    const hasImg = c.some((p) => p?.type === 'image_url');
    let out = text;
    if (hasImg) out = (text ? text + '\n\n' : '') + '[image omitted: OpenAI chat format cannot carry image output]';
    choice.message.content = out || null;
  }
  return body;
}
// Strip the hub-internal `delta.images` from OpenAI stream frames; surface a
// one-time text marker so an OpenAI client at least sees that an image was produced.
// Only rewrites frames that actually carry images — every other frame passes untouched.
async function* openaiStreamFromHub(source) {
  let noted = false;
  for await (const frame of source) {
    if (typeof frame !== 'string' || !frame.includes('"images"')) { yield frame; continue; }
    const m = /^data: ([\s\S]*)\n\n$/.exec(frame);
    if (!m) { yield frame; continue; }
    let obj; try { obj = JSON.parse(m[1]); } catch { yield frame; continue; }
    const delta = obj.choices?.[0]?.delta;
    if (delta?.images) {
      delete delta.images;
      if (!noted) { noted = true; delta.content = (delta.content || '') + '[image omitted: OpenAI chat format cannot carry image output]'; }
      if (Object.keys(delta).length === 0) continue; // nothing left to emit
    }
    yield oaiFrame(obj);
  }
}

export const FORMATS = {
  openai: {
    reqToHub: identity,
    reqFromHub: identity,
    respToHub: identity,
    respFromHub: openaiRespFromHub,
    streamToHub: identityStream,
    streamFromHub: openaiStreamFromHub,
  },
  anthropic: {
    reqToHub: anthropicReqToOpenai,
    reqFromHub: openaiReqToAnthropic,
    respToHub: anthropicRespToOpenai,
    respFromHub: openaiRespToAnthropic,
    streamToHub: anthropicStreamToOpenai,
    streamFromHub: openaiStreamToAnthropic,
  },
  gemini: {
    reqToHub: geminiReqToOpenai,
    reqFromHub: openaiReqToGemini,
    respToHub: geminiRespToOpenai,
    respFromHub: openaiRespToGemini,
    streamToHub: geminiStreamToOpenai,
    streamFromHub: openaiStreamToGemini,
  },
  responses: {
    reqToHub: responsesReqToOpenai,
    reqFromHub: openaiReqToResponses,
    respToHub: responsesRespToOpenai,
    respFromHub: openaiRespToResponses,
    streamToHub: responsesStreamToOpenai,
    streamFromHub: openaiStreamToResponses,
  },
};

// Normalize an arbitrary apiFormat value to a known key (default: openai).
export function normalizeFormat(fmt) {
  return Object.prototype.hasOwnProperty.call(FORMATS, fmt) ? fmt : 'openai';
}

// ── Dispatchers: pivot through the hub ──
// from === to is a no-op (the server's fast path already skips these, but the
// guard keeps the dispatchers correct if called directly). Otherwise: convert
// the source format up to the hub, then down to the target.

export function translateRequest(payload, from, to) {
  from = normalizeFormat(from); to = normalizeFormat(to);
  if (from === to) return payload;
  const hub = FORMATS[from].reqToHub(payload);
  return FORMATS[to].reqFromHub(hub);
}

export function translateResponse(body, from, to) {
  from = normalizeFormat(from); to = normalizeFormat(to);
  if (from === to) return body;
  const hub = FORMATS[from].respToHub(body);
  return FORMATS[to].respFromHub(hub);
}

// ── USAGE SNIFFING ──
// Token counts live in the response body (`usage`/`usageMetadata`), which the
// fast-path passthrough never parses. These pull them out AFTER the bytes have
// already been forwarded, so tracking costs nothing on the hot path.
//
// Format-agnostic on purpose: every provider format nests token counts under a
// slightly different key, but they never collide, so one reader covers all four
// (openai/anthropic/gemini/responses) plus their streaming envelopes. Returns
// raw {input,output,cached} (any field undefined if the body didn't report it),
// or null when nothing usage-shaped is present.
export function extractUsage(o) {
  if (!o || typeof o !== 'object') return null;
  // Unwrap the known envelopes: bare body, anthropic message_start (usage under
  // .message), responses' response.completed event (usage under .response).
  const u = o.usage || o.usageMetadata || o.response?.usage || o.response?.usageMetadata || o.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const pick = (v) => (typeof v === 'number' && v >= 0 ? v : undefined);
  const input = pick(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount);
  const output = pick(u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount);
  const cached = pick(u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cachedContentTokenCount);
  if (input === undefined && output === undefined && cached === undefined) return null;
  return { input, output, cached };
}

function normalizeUsage(u) {
  if (!u) return null;
  const out = {};
  if (u.input !== undefined) out.inputTokens = u.input;
  if (u.output !== undefined) out.outputTokens = u.output;
  if (u.cached !== undefined) out.cachedTokens = u.cached;
  return Object.keys(out).length ? out : null;
}

// Pull token usage out of a whole response body. `wasStream` picks the shape:
// an SSE event stream (scan every data: frame, merge per-field so anthropic's
// split input@message_start / output@message_delta reunites, and cumulative
// gemini/openai final-chunk counts land on the last value) vs a single JSON
// object. Returns {inputTokens?,outputTokens?,cachedTokens?} or null.
export function sniffUsage(text, wasStream) {
  if (!text) return null;
  if (!wasStream) {
    try { return normalizeUsage(extractUsage(JSON.parse(text))); } catch { return null; }
  }
  const merged = {};
  let found = false;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj; try { obj = JSON.parse(payload); } catch { continue; }
    const u = extractUsage(obj);
    if (!u) continue;
    found = true;
    // Per-field last-writer-wins: a frame that omits a field leaves the prior
    // value intact (message_delta has no input, so message_start's input holds).
    if (u.input !== undefined) merged.input = u.input;
    if (u.output !== undefined) merged.output = u.output;
    if (u.cached !== undefined) merged.cached = u.cached;
  }
  return found ? normalizeUsage(merged) : null;
}

// Stream stays lazy end-to-end: no buffering, generators compose. `from` is the
// provider's format (what it streamed), `to` is the client's format (what it
// expects). opts (model/id) flow to whichever spoke needs to synthesize them.
export function translateStream(source, from, to, opts = {}) {
  from = normalizeFormat(from); to = normalizeFormat(to);
  if (from === to) return source;
  const hubStream = FORMATS[from].streamToHub(source, opts);
  return FORMATS[to].streamFromHub(hubStream, opts);
}

// Exposed for tests / later stages.
export { anthropicContentToText, DEFAULT_MAX_TOKENS, sseData };

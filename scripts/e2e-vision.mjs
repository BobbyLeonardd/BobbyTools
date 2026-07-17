// End-to-end VISION check: does the image-block translation actually work against
// a REAL provider? Sends an Anthropic-format /v1/messages request (like claude-code)
// carrying a base64 image to an OpenAI-format provider, so translate.js must convert
// the Anthropic image block -> OpenAI image_url. Asks the model the image's color;
// we generate a solid-color PNG so the answer is checkable.
//
// Runs in an isolated temp HOME copied from the real ~/.bobbytools, so the real
// config/router are never touched. Lives in scripts/ (needs network + keys).
//
//   node scripts/e2e-vision.mjs "<providerSlug>/<modelName>"
// e.g. node scripts/e2e-vision.mjs "tuyulan/genfity.com/genfity/gemini-3.5-flash"

import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { deflateSync } from 'zlib';

const modelArg = process.argv[2];
if (!modelArg) { console.error('usage: node scripts/e2e-vision.mjs "<providerSlug>/<model>"'); process.exit(2); }

// ── build a solid-color PNG (RGB) by hand, return base64 ──
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, color type 2 (RGB)
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) { const p = row + 1 + x * 3; raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const png = solidPng(64, 64, [220, 30, 30]); // solid red
const b64 = png.toString('base64');

// ── isolated temp HOME: copy the real config so we hit real providers/keys ──
const realCfg = join(homedir(), '.bobbytools', 'config.json');
if (!existsSync(realCfg)) { console.error('no real config found at ' + realCfg); process.exit(2); }
const home = mkdtempSync(join(tmpdir(), 'bobbyvis-'));
const dir = join(home, '.bobbytools');
mkdirSync(dir, { recursive: true });
copyFileSync(realCfg, join(dir, 'config.json'));

const PORT = 13366;
const serverUrl = pathToFileURL(join(process.cwd(), 'src/server.js')).href;
const boot = `const { startRouterServer } = await import(${JSON.stringify(serverUrl)}); await startRouterServer(${PORT}, true);`;
const child = spawn(process.execPath, ['-e', boot], {
  env: { ...process.env, USERPROFILE: home, HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`); if (r.ok) break; } catch {}
  await sleep(150);
}

console.log(`[vision] Anthropic /v1/messages (image) -> ${modelArg}`);
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✔' : '✘'} ${m}`); c ? pass++ : fail++; };

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-bobby' },
    body: JSON.stringify({
      model: modelArg,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What single color fills this image? Answer with just the color name.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        ],
      }],
    }),
  });
  const j = await res.json().catch(() => ({}));
  ok(res.status === 200, `status 200 (got ${res.status})`);
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').toLowerCase();
  ok(!!text, `model replied: ${JSON.stringify(text.slice(0, 120))}`);
  ok(/red|merah/.test(text), 'model correctly identified the image as RED (image survived translation)');
} catch (e) {
  ok(false, 'request threw: ' + e.message);
}

if (fail) console.log('\n--- router log tail ---\n' + log.slice(-1200));
console.log(`\n${fail === 0 ? '✔ VISION E2E PASSED' : '✘ VISION E2E FAILED'} — pass=${pass} fail=${fail}`);
// Detach then kill, and let the loop drain, so libuv doesn't assert on a handle
// still closing at exit (a Windows-only teardown noise that masked the real code).
child.unref();
child.kill('SIGTERM');
await sleep(300);
process.exitCode = fail === 0 ? 0 : 1;

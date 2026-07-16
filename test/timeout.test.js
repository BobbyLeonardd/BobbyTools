// Self-check for fetchWithConnectTimeout — connect-only timeout semantics.
// Run: node test/timeout.test.js
import assert from 'node:assert';
import { fetchWithConnectTimeout } from '../src/helpers.js';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    // Mimic fetch: reject with AbortError if the signal fires while "connecting".
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });

// (1) Headers arrive fast → the connect timer is cleared, so even a very long
//     body stream is never aborted. We prove it: connectMs is tiny (20ms) but the
//     fetch resolves at 5ms; then we wait past the old deadline and the signal is
//     still not aborted.
{
  const controller = new AbortController();
  const fakeFetch = async (url, opts) => {
    await sleep(5, opts.signal); // "connecting" — headers arrive at 5ms
    return { ok: true, signal: opts.signal };
  };
  const res = await fetchWithConnectTimeout('u', {}, controller, 20, fakeFetch);
  assert.strictEqual(res.ok, true, 'fast connect resolves');
  await sleep(40); // outlive the old 20ms connect window
  assert.strictEqual(controller.signal.aborted, false, 'timer cleared — long stream never aborted');
}

// (2) Connect is slower than connectMs → the timer aborts it.
{
  const controller = new AbortController();
  const fakeFetch = async (url, opts) => {
    await sleep(100, opts.signal); // headers never arrive in time
    return { ok: true };
  };
  await assert.rejects(
    () => fetchWithConnectTimeout('u', {}, controller, 20, fakeFetch),
    (e) => e.name === 'AbortError',
    'slow connect is aborted',
  );
  assert.strictEqual(controller.signal.aborted, true, 'signal marked aborted');
}

// (3) Caller aborts via the shared controller (e.g. client disconnect) → fetch rejects.
{
  const controller = new AbortController();
  const fakeFetch = async (url, opts) => {
    await sleep(100, opts.signal);
    return { ok: true };
  };
  const p = fetchWithConnectTimeout('u', {}, controller, 5000, fakeFetch);
  controller.abort(); // client hung up
  await assert.rejects(() => p, (e) => e.name === 'AbortError', 'external abort propagates');
}

console.log('✔ fetchWithConnectTimeout self-check passed');

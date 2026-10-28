// node --experimental-vm-modules tools/verify-session-integrity.mjs [project-root]
// Actual source modules; only transport, storage, timers, and PKCE randomness are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const token = name => ({ access_token: `${name}-access`, refresh_token: `${name}-refresh`, token_type: 'Bearer', access_expires_in: 3600, refresh_expires_in: 86400, server_time: '2026-10-24T00:00:00Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; ++i) await Promise.resolve(); };
const changed = e => e?.name === 'SessionChangedError';
const aborted = e => e?.constructor?.name === 'GoogleAbort';

async function fixture({ holdPkce = false } = {}) {
  const requests = [], timers = new Map(), storage = new Map(), published = [];
  const digest = deferred();
  let timerId = 0;
  const setTimer = (fn, ms) => { const id = timerId++; timers.set(id, { fn, ms }); return id; };
  const context = createContext({
    URL, URLSearchParams, TextEncoder, Uint8Array, Date,
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    window: { setTimeout: setTimer }, setTimeout: setTimer, clearTimeout: id => timers.delete(id),
    crypto: { getRandomValues: bytes => bytes.fill(7), subtle: { digest: () => holdPkce ? digest.promise : Promise.resolve(new Uint8Array(32).buffer) } },
  });
  const transport = new SyntheticModule(['transport', 'shellInvoke'], function () {
    this.setExport('transport', (method, url, headers, body) => {
      const d = deferred(); requests.push({ method, url, headers: { ...headers }, body, ...d }); return d.promise;
    });
    // pass #79: shellInvoke (lib/secure.ts's bridge probe) — null = no shell in the VM,
    // which keeps auth/profiles on the localStorage fallback these tests assert on.
    this.setExport('shellInvoke', async () => null);
  }, { context });
  const device = new SyntheticModule(['deviceId'], function () { this.setExport('deviceId', () => 'synthetic-device'); }, { context });
  // pass #79: auth.ts logs persistence failures to the diagnostics ring (lib/applog) and
  // persists through the DPAPI secure store (lib/secure). Both are stubbed: applog is a
  // memory-only module with no session semantics, and secure stubs to the no-shell path —
  // which drives exactly the localStorage fallback these storage assertions check.
  const applog = new SyntheticModule(['logError', 'logInfo'], function () {
    this.setExport('logError', () => {});
    this.setExport('logInfo', () => {});
  }, { context });
  const secure = new SyntheticModule(['secureGet', 'securePut', 'secureDel'], function () {
    this.setExport('secureGet', async () => null);
    this.setExport('securePut', async () => false);
    this.setExport('secureDel', async () => {});
  }, { context });
  const modules = new Map([['./transport', transport], ['./device', device], ['./applog', applog], ['./secure', secure]]);
  for (const name of ['api', 'auth', 'google']) {
    const file = path.join(root, 'src/lib', `${name}.ts`);
    modules.set(`./${name}`, new SourceTextModule(stripTypeScriptTypes(fs.readFileSync(file, 'utf8')), { context, identifier: file }));
  }
  const link = specifier => { const module = modules.get(specifier); assert.ok(module, specifier); return module; };
  const authModule = modules.get('./auth'), googleModule = modules.get('./google');
  await authModule.link(link); await authModule.evaluate();
  await googleModule.link(link); await googleModule.evaluate();
  const auth = authModule.namespace, api = modules.get('./api').namespace;
  auth.onTokenChange(t => published.push(t?.access_token ?? null));
  return {
    auth, api, google: googleModule.namespace, requests, timers, storage, published, digest,
    async count(n) { await flush(); assert.equal(requests.length, n); },
    respond(index, status, json = {}) { requests[index].resolve({ status, json, text: JSON.stringify(json) }); },
    async fireTimer() { assert.equal(timers.size, 1); const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await flush(); return timer.ms; },
  };
}

const tests = [
  ['F01: refresh success cannot overwrite a replacement session', async () => {
    const f = await fixture(); f.auth.seed(token('A'));
    const pending = assert.rejects(f.auth.silentRefresh(), changed); await f.count(1);
    f.auth.seed(token('B')); f.respond(0, 200, token('A2')); await pending;
    assert.equal(f.auth.accessToken(), 'B-access');
    assert.equal(JSON.parse(f.storage.get('delcc-auth')).access_token, 'B-access');
    assert.deepEqual(f.published, ['A-access', 'B-access']);
  }],
  ['F01: refresh completion cannot resurrect logout', async () => {
    const f = await fixture(); f.auth.seed(token('A'));
    const pending = assert.rejects(f.auth.silentRefresh(), changed); await f.count(1);
    const logout = f.auth.logout(); assert.equal(f.auth.accessToken(), null); await f.count(2);
    f.respond(0, 200, token('A2')); f.respond(1, 200); await Promise.all([pending, logout]);
    assert.equal(f.auth.accessToken(), null); assert.equal(f.storage.has('delcc-auth'), false); assert.equal(f.timers.size, 0);
    assert.equal(f.requests[1].headers.Authorization, 'Bearer A-access');
  }],
  ['F01: stale failure/finally cannot clear B or its coalesced refresh', async () => {
    const f = await fixture(); f.auth.seed(token('A'));
    const old = assert.rejects(f.auth.silentRefresh(), changed); await f.count(1);
    f.auth.seed(token('B')); const b1 = f.auth.silentRefresh(); await f.count(2);
    f.requests[0].reject(new Error('offline')); await old;
    const b2 = f.auth.silentRefresh(); await f.count(2);
    f.respond(1, 200, token('B2')); await Promise.all([b1, b2]);
    assert.equal(f.auth.accessToken(), 'B2-access'); assert.deepEqual(f.published, ['A-access', 'B-access', 'B2-access']);
  }],
  ['F01: newer login intent wins and routine refresh preserves its version', async () => {
    const f = await fixture(); f.auth.seed(token('old'));
    const a = assert.rejects(f.auth.login('A', 'synthetic'), changed);
    const b = f.auth.login('B', 'synthetic'); const version = f.auth.sessionVersion();
    await f.count(2); f.respond(1, 200, token('B')); await b; f.respond(0, 200, token('A')); await a;
    assert.equal(f.auth.accessToken(), 'B-access'); assert.equal(f.auth.sessionVersion(), version);
    const refresh = f.auth.silentRefresh(); f.respond(2, 200, token('B2')); await refresh;
    assert.equal(f.auth.sessionVersion(), version);
  }],
  ['F01: aborted password login cannot publish a token', async () => {
    const f = await fixture(); f.auth.seed(token('old')); const abort = new AbortController();
    const pending = assert.rejects(f.auth.login('A', 'synthetic', abort.signal), changed);
    await f.count(1); abort.abort(); f.respond(0, 200, token('A')); await pending;
    assert.equal(f.auth.accessToken(), 'old-access'); assert.deepEqual(f.published, ['old-access']);
    await assert.rejects(f.auth.login('A', 'synthetic', abort.signal), changed); await f.count(1);
  }],
  ['F01: logout invalidates an in-flight password login', async () => {
    const f = await fixture(); const pending = assert.rejects(f.auth.login('A', 'synthetic'), changed);
    await f.auth.logout(); f.respond(0, 200, token('A')); await pending;
    assert.equal(f.auth.accessToken(), null); assert.equal(f.timers.size, 0);
  }],
  ['F01: cancelling a stalled login restores refresh scheduling for the retained session', async () => {
    const f = await fixture(); f.auth.seed(token('old')); const ac = new AbortController();
    const pending = assert.rejects(f.auth.login('A', 'synthetic', ac.signal), changed);
    assert.equal(f.timers.size, 0); ac.abort(); assert.equal(f.timers.size, 1);
    const refresh = f.auth.silentRefresh(); await f.count(2); f.respond(1, 200, token('old2')); await refresh;
    f.respond(0, 200, token('A')); await pending; assert.equal(f.auth.accessToken(), 'old2-access');
  }],
  ['F01/F02: pending login cannot refresh the previous identity or accept its late response', async () => {
    const f = await fixture(); f.auth.seed(token('A'));
    const login = f.auth.login('B', 'synthetic');
    await assert.rejects(f.auth.silentRefresh(), changed); await f.count(1);
    const staleRead = assert.rejects(f.api.api.me('A-access'), changed); await f.count(2);
    f.respond(0, 200, token('B')); await login;
    f.respond(1, 200, { username: 'A' }); await staleRead;
    assert.equal(f.auth.accessToken(), 'B-access'); assert.deepEqual(f.published, ['A-access', 'B-access']);
  }],
  ['F02: delayed 401 cannot replay a mutation as B', async () => {
    const f = await fixture(); f.auth.seed(token('A'));
    const pending = assert.rejects(f.api.api.submitPublic('A-access', 'SYNTHETIC', 'CPP17', 'synthetic source'), changed);
    await f.count(1); f.auth.seed(token('B')); f.respond(0, 401); await pending; await f.count(1);
    assert.equal(f.requests[0].headers.Authorization, 'Bearer A-access'); assert.equal(f.auth.accessToken(), 'B-access');
  }],
  ['F02: switching during refresh prevents mutation replay', async () => {
    const f = await fixture(); f.auth.seed(token('A'));
    const pending = assert.rejects(f.api.api.submitPublic('A-access', 'SYNTHETIC', 'CPP17', 'synthetic source'), changed);
    f.respond(0, 401); await f.count(2); f.auth.seed(token('B')); f.respond(1, 200, token('A2')); await pending; await f.count(2);
  }],
  ['F02: switching during a 426 version lookup prevents replay', async () => {
    const f = await fixture(); f.auth.seed(token('A'));
    const pending = assert.rejects(f.api.api.submitPublic('A-access', 'SYNTHETIC', 'CPP17', 'synthetic source'), changed);
    f.respond(0, 426); await f.count(2); assert.match(f.requests[1].url, /client-releases/);
    f.auth.seed(token('B')); f.respond(1, 200, { required_version: '1.2.3' }); await pending; await f.count(2);
  }],
  ['F02: same-session 401 refresh replays exactly once with the original body', async () => {
    const f = await fixture(); f.auth.seed(token('A')); const version = f.auth.sessionVersion();
    const pending = f.api.api.submitPublic('A-access', 'SYNTHETIC', 'CPP17', 'synthetic source');
    f.respond(0, 401); await f.count(2); f.respond(1, 200, token('A2')); await f.count(3);
    assert.equal(f.requests[2].headers.Authorization, 'Bearer A2-access'); assert.equal(f.requests[2].body, f.requests[0].body);
    f.respond(2, 200, { submission_id: 1 }); assert.equal((await pending).submission_id, 1);
    assert.equal(f.auth.sessionVersion(), version);
    const oldSameSession = f.api.api.me('A-access'); await f.count(4); f.respond(3, 200, { username: 'A' }); await oldSameSession;
  }],
  ['F02: same-session 426 still retries and old captured tokens cannot start after a switch', async () => {
    const f = await fixture(); f.auth.seed(token('A')); const pending = f.api.api.me('A-access');
    f.respond(0, 426); await f.count(2); f.respond(1, 200, { required_version: '1.2.3' }); await f.count(3);
    assert.equal(f.requests[2].headers['X-Client-Version'], '1.2.3'); f.respond(2, 200, { username: 'A' }); await pending;
    f.auth.seed(token('B')); await assert.rejects(f.api.api.me('A-access'), changed); await f.count(3);
  }],
  ['F02: a successful stale response is not exposed to the new session', async () => {
    const f = await fixture(); f.auth.seed(token('A')); const pending = assert.rejects(f.api.api.me('A-access'), changed);
    f.auth.seed(token('B')); f.respond(0, 200, { username: 'A' }); await pending;
  }],
  ['F10: network and ambiguous HTTP failures preserve credentials and are reported', async () => {
    for (const status of [0, 401, 403, 429, 503]) {
      const f = await fixture(); f.auth.seed(token('A')); const pending = assert.rejects(f.auth.silentRefresh());
      if (status) f.respond(0, status, { detail: 'synthetic failure' }); else f.requests[0].reject(new Error('offline'));
      await pending; assert.equal(f.auth.accessToken(), 'A-access'); assert.deepEqual(f.published, ['A-access']);
      assert.equal(JSON.parse(f.storage.get('delcc-auth')).refresh_token, 'A-refresh');
      assert.equal([...f.timers.values()][0].ms, 5000);
    }
  }],
  ['F10: background retries are bounded and success restarts the normal schedule', async () => {
    const f = await fixture(); f.auth.seed(token('A')); const pending = assert.rejects(f.auth.silentRefresh());
    f.requests[0].reject(new Error('offline')); await pending;
    for (const [index, delay] of [5000, 15000, 30000].entries()) {
      assert.equal(await f.fireTimer(), delay); f.requests[index + 1].reject(new Error('offline')); await flush();
    }
    assert.equal(f.timers.size, 0); assert.equal(f.auth.accessToken(), 'A-access');
    const recover = f.auth.silentRefresh(); f.respond(4, 200, token('A2')); await recover;
    assert.ok([...f.timers.values()][0].ms > 30000);
    const again = assert.rejects(f.auth.silentRefresh()); f.requests[5].reject(new Error('offline')); await again;
    assert.equal([...f.timers.values()][0].ms, 5000);
    const logout = f.auth.logout(); f.respond(6, 200); await logout; assert.equal(f.timers.size, 0);
  }],
  ['F10: an authenticated retry propagates refresh failure without erasing the session', async () => {
    const f = await fixture(); f.auth.seed(token('A')); const pending = assert.rejects(f.api.api.me('A-access'), e => e.status === 503);
    f.respond(0, 401); await f.count(2); f.respond(1, 503); await pending; await f.count(2); assert.equal(f.auth.accessToken(), 'A-access');
  }],
  ['F11: cancellation before or during PKCE prevents the start request', async () => {
    const f = await fixture({ holdPkce: true }), ac = new AbortController(); let urls = 0;
    const options = { signal: ac.signal, onUrl: () => urls++, onStatus() {} };
    const pending = assert.rejects(f.google.googleLogin(options), aborted); ac.abort(); f.digest.resolve(new Uint8Array(32).buffer); await pending;
    await assert.rejects(f.google.googleLogin(options), aborted); await f.count(0); assert.equal(urls, 0);
  }],
  ['F11: cancellation during start prevents the browser callback', async () => {
    const f = await fixture(), ac = new AbortController(); let urls = 0;
    const pending = assert.rejects(f.google.googleLogin({ signal: ac.signal, onUrl: () => urls++, onStatus() {} }), aborted);
    await f.count(1); ac.abort(); f.respond(0, 200, { authorization_url: 'https://example.invalid', transaction_id: 'synthetic', expires_in: 300, interval: 1 }); await pending;
    assert.equal(urls, 0); assert.equal(f.timers.size, 0);
  }],
  ['F11: cancellation during sleep removes the timer and prevents exchange', async () => {
    const f = await fixture(), ac = new AbortController();
    const pending = assert.rejects(f.google.googleLogin({ signal: ac.signal, onUrl() {}, onStatus() {} }), aborted);
    await f.count(1); f.respond(0, 200, { authorization_url: 'https://example.invalid', transaction_id: 'synthetic', expires_in: 300, interval: 1 }); await flush();
    assert.equal(f.timers.size, 1); ac.abort(); await pending; assert.equal(f.timers.size, 0); await f.count(1);
  }],
  ['F11: cancellation during exchange suppresses tokens, pending callbacks, and rate-limit callbacks', async () => {
    for (const [status, body] of [[200, token('A')], [202, { interval: 1 }], [429, {}]]) {
      const f = await fixture(), ac = new AbortController(); let statuses = 0;
      const pending = assert.rejects(f.google.googleLogin({ signal: ac.signal, onUrl() {}, onStatus: () => statuses++ }), aborted);
      await f.count(1); f.respond(0, 200, { authorization_url: 'https://example.invalid', transaction_id: 'synthetic', expires_in: 300, interval: 1 }); await flush();
      await f.fireTimer(); await f.count(2); ac.abort(); f.respond(1, status, body); await pending;
      assert.equal(statuses, 0); assert.equal(f.timers.size, 0); assert.equal(f.auth.accessToken(), null);
    }
  }],
  ['F11: uncancelled PKCE/start/pending/exchange still returns tokens', async () => {
    const f = await fixture(), ac = new AbortController(); let urls = 0, statuses = 0;
    const pending = f.google.googleLogin({ signal: ac.signal, onUrl: () => urls++, onStatus: () => statuses++ });
    await f.count(1); f.respond(0, 200, { authorization_url: 'https://example.invalid', transaction_id: 'synthetic', expires_in: 300, interval: 1 }); await flush();
    await f.fireTimer(); f.respond(1, 202, { interval: 2 }); await flush(); assert.equal(await f.fireTimer(), 2000);
    f.respond(2, 200, token('A')); assert.equal((await pending).access_token, 'A-access'); assert.equal(urls, 1); assert.equal(statuses, 1);
  }],
];

let passed = 0;
for (const [name, run] of tests) {
  try { await run(); console.log(`PASS ${name}`); passed++; }
  catch (error) { console.error(`FAIL ${name}`); console.error(error); process.exitCode = 1; }
}
console.log(`Session integrity: ${passed}/${tests.length} passed`);

// Node >=22.13: node --experimental-strip-types --experimental-vm-modules tools/claude11/verify/transport-probe.test.ts [transport.ts]
// Plain assertions against the actual module. Fresh VM contexts replace a production reset hook.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

type Invoke = (command: string, args: any) => Promise<string>;
type Response = { status: number; json: any; text: string };
type Api = {
  getLayout(): Promise<string>;
  transport(method: string, url: string, headers: Record<string, string>, body?: string): Promise<Response>;
};
const root = fileURLToPath(new URL('../../../', import.meta.url));
const readonlySource = path.join(root, 'readonly/src/lib/transport.ts');
const sourcePath = process.argv[2] ? path.resolve(process.argv[2])
  : fs.existsSync(readonlySource) ? readonlySource : path.join(root, 'src/lib/transport.ts');
const javascript = stripTypeScriptTypes(fs.readFileSync(sourcePath, 'utf8'), { mode: 'strip' });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const url = 'https://example.invalid/api/v3/problems?page=2';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { bridge?: boolean; rejectImport?: boolean; exportValue?: unknown } = {}) {
  const imports: string[] = [];
  const invocations: { command: string; args: any }[] = [];
  const fetches: { url: string; init: any }[] = [];
  const started = deferred(), gate = deferred();
  const window: { __TAURI_INTERNALS__?: object } = options.bridge ? { __TAURI_INTERNALS__: {} } : {};
  let rejectImport = !!options.rejectImport;
  const invoke: Invoke = async (command, args) => {
    invocations.push({ command, args: plain(args) });
    return command === 'get_layout' ? 'tmath'
      : JSON.stringify({ status: 201, body: JSON.stringify({ via: 'bridge' }) });
  };
  const context = createContext({
    window, URL,
    fetch: async (requestUrl: string, init: any) => {
      fetches.push({ url: requestUrl, init: plain(init) });
      return { status: 202, text: async () => '{"via":"fetch"}' };
    },
  });
  const core = new SyntheticModule(['invoke'], function () {
    this.setExport('invoke', 'exportValue' in options ? options.exportValue : invoke);
  }, { context });
  await core.link(() => { throw new Error('The fake core must not import anything'); });
  await core.evaluate();
  const module = new SourceTextModule(javascript, {
    context, identifier: sourcePath,
    importModuleDynamically: async specifier => {
      // Each probeBridge invocation attempts this import; the gate keeps first callers concurrent.
      imports.push(specifier);
      started.resolve();
      assert.equal(specifier, '@tauri-apps/api/core');
      await gate.promise;
      if (rejectImport) throw new Error('Synthetic Tauri import failure');
      return core;
    },
  });
  await module.link(specifier => { throw new Error(`Unexpected static import: ${specifier}`); });
  await module.evaluate();
  return {
    api: module.namespace as unknown as Api, imports, invocations, fetches, window,
    started: started.promise, release: gate.resolve,
    allowImport: () => { rejectImport = false; },
    setInvoke: (value: unknown) => core.setExport('invoke', value),
  };
}

const scenarios: [string, () => Promise<void>][] = [
  ['concurrent first callers share one pending probe and never fetch early', async () => {
    const f = await fixture({ bridge: true });
    let settled = 0;
    const layouts = Array.from({ length: 12 }, () => f.api.getLayout());
    const requests = Array.from({ length: 4 }, () => f.api.transport('GET', url, {}));
    const all = Promise.all([...layouts, ...requests].map(async promise => {
      const value = await promise; settled++; return value;
    }));
    await f.started;
    try {
      assert.deepEqual(f.imports, ['@tauri-apps/api/core']);
      assert.equal(settled, 0);
      assert.equal(f.invocations.length, 0);
      assert.equal(f.fetches.length, 0);
    } finally { f.release(); }
    await all;
    assert.deepEqual(await Promise.all(layouts), Array(12).fill('tmath'));
    for (const response of await Promise.all(requests))
      assert.deepEqual(plain(response), { status: 201, json: { via: 'bridge' }, text: '{"via":"bridge"}' });
    assert.equal(f.invocations.length, 16);
    assert.equal(f.fetches.length, 0);
    assert.equal(f.imports.length, 1);
  }],
  ['missing bridge caches null even if the bridge appears later', async () => {
    const f = await fixture();
    const first = f.api.getLayout();
    await f.started; f.release();
    assert.equal(await first, 'baseplate');
    f.window.__TAURI_INTERNALS__ = {};
    assert.equal(await f.api.getLayout(), 'baseplate');
    assert.equal(await f.api.getLayout(), 'baseplate');
    assert.deepEqual(f.imports, ['@tauri-apps/api/core']);
    assert.equal(f.invocations.length, 0);
    assert.equal(f.fetches.length, 0);
  }],
  ['failed Tauri import is swallowed and its null result stays cached', async () => {
    const f = await fixture({ bridge: true, rejectImport: true });
    const first = f.api.getLayout();
    await f.started; f.release();
    assert.equal(await first, 'baseplate');
    f.allowImport();
    assert.equal(await f.api.getLayout(), 'baseplate');
    const response = await f.api.transport('GET', url, {});
    assert.deepEqual(plain(response), { status: 202, json: { via: 'fetch' }, text: '{"via":"fetch"}' });
    assert.deepEqual(f.imports, ['@tauri-apps/api/core']);
    assert.equal(f.invocations.length, 0);
    assert.equal(f.fetches.length, 1);
  }],
  ['non-callable invoke export also produces a persistent null result', async () => {
    const f = await fixture({ bridge: true, exportValue: undefined });
    const first = f.api.getLayout();
    await f.started; f.release();
    assert.equal(await first, 'baseplate');
    let replacements = 0;
    f.setInvoke(async () => { replacements++; return 'replacement'; });
    assert.equal(await f.api.getLayout(), 'baseplate');
    assert.equal(replacements, 0);
    assert.equal(f.invocations.length, 0);
    assert.deepEqual(f.imports, ['@tauri-apps/api/core']);
  }],
  ['successful probe retains the original invoke function for the session', async () => {
    const f = await fixture({ bridge: true });
    const first = f.api.getLayout();
    await f.started; f.release();
    assert.equal(await first, 'tmath');
    let replacements = 0;
    f.setInvoke(async () => { replacements++; return 'replacement'; });
    delete f.window.__TAURI_INTERNALS__;
    assert.equal(await f.api.getLayout(), 'tmath');
    const headers = { 'Content-Type': 'application/json', 'X-Test': 'synthetic' };
    const response = await f.api.transport('POST', url, headers, '{"answer":42}');
    assert.deepEqual(plain(response), { status: 201, json: { via: 'bridge' }, text: '{"via":"bridge"}' });
    assert.deepEqual(f.invocations[2], {
      command: 'api_fetch',
      args: { method: 'POST', path: '/problems?page=2', body: '{"answer":42}', headers },
    });
    assert.equal(f.invocations.length, 3);
    assert.equal(replacements, 0);
    assert.equal(f.fetches.length, 0);
    assert.deepEqual(f.imports, ['@tauri-apps/api/core']);
  }],
  ['transport forwards the complete request to fetch when the cached bridge is null', async () => {
    const f = await fixture();
    const headers = { 'Content-Type': 'application/json', 'X-Test': 'synthetic' };
    const body = '{"answer":42}';
    const first = f.api.transport('POST', url, headers, body);
    await f.started;
    assert.equal(f.fetches.length, 0);
    f.release();
    assert.deepEqual(plain(await first), { status: 202, json: { via: 'fetch' }, text: '{"via":"fetch"}' });
    assert.deepEqual(f.fetches[0], { url, init: { method: 'POST', headers, body } });
    f.window.__TAURI_INTERNALS__ = {};
    await f.api.transport('GET', url, {});
    assert.equal(f.fetches.length, 2);
    assert.equal(f.invocations.length, 0);
    assert.deepEqual(f.imports, ['@tauri-apps/api/core']);
  }],
];

console.log(`SOURCE ${sourcePath}`);
let failed = 0;
for (const [name, run] of scenarios) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Scenario did not settle within 5 seconds')), 5000);
    })]);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`, error);
  } finally { clearTimeout(timer); }
}
console.log(`${scenarios.length - failed}/${scenarios.length} passed`);
process.exitCode = failed ? 1 : 0;

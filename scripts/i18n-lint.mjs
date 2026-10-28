// delcc i18n drift lint — vendored from tools/claude11/verify (pass #75, claude11 lane payload removed).
// Default: src/i18n. Only literal string leaves are compared; no TS executes.
import fs from 'node:fs';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'src/i18n');
const files = ['en-US.ts', 'vi-VN.ts', 'zh-CN.ts'];
const identifier = /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u;
const quoted = t => t?.length >= 2 && /["']/.test(t[0]) && t.at(-1) === t[0];

function decodeKey(token) {
  if (!quoted(token)) {
    if (!identifier.test(token ?? '') && !/^\d+$/.test(token ?? ''))
      throw new Error(`Expected a literal property name, received ${token ?? 'EOF'}`);
    return token;
  }
  return token.slice(1, -1).replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g, (_, escape) => {
    if (/^[ux]/.test(escape)) {
      const digits = escape.slice(1).replace(/^\{|\}$/g, '');
      if (!digits) throw new Error('Invalid Unicode or hex escape in property name');
      return String.fromCodePoint(parseInt(digits, 16));
    }
    if (/^[\r\n]/.test(escape)) return '';
    if (/^[1-9]$/.test(escape)) throw new Error('Legacy numeric escapes are unsupported');
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[escape] ?? escape;
  });
}

function keysOf(source) {
  // Strings precede comment handling: URLs, braces and escaped quotes stay inside values.
  const pattern = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*"|'(?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*'|[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*|\d+|[\s\S]/gu;
  const tokens = [...source.matchAll(pattern)].map(m => m[0])
    .filter(t => !/^\s|^\/\/|^\/\*/.test(t));
  let at = tokens.findIndex((t, i) => t === 'export' && /^(const|let|var|default)$/.test(tokens[i + 1] ?? ''));
  if (at < 0) throw new Error('Expected an exported dictionary object');
  if (tokens[++at] === 'default') at++;
  else {
    while (at < tokens.length && tokens[at] !== '=') at++;
    at++;
  }
  const keys = new Set();
  const take = expected => {
    if (tokens[at] !== expected) throw new Error(`Expected ${expected}, received ${tokens[at] ?? 'EOF'}`);
    at++;
  };
  function object(prefix) {
    take('{');
    while (tokens[at] !== '}') {
      const key = decodeKey(tokens[at++]);
      take(':');
      const segments = [...prefix, key];
      if (tokens[at] === '{') object(segments);
      else {
        if (!quoted(tokens[at])) throw new Error(`Expected a string at ${segments.join('.')}`);
        at++;
        keys.add(segments.join('.'));
      }
      if (tokens[at] === '}') break;
      take(',');
    }
    take('}');
  }
  object([]);
  return keys;
}

try {
  const sets = files.map(file => {
    try { return keysOf(fs.readFileSync(path.join(directory, file), 'utf8')); }
    catch (error) { throw new Error(`${file}: ${error.message}`); }
  });
  const report = { missing_in: {}, extra_in: {} };
  let drift = false;
  files.forEach((file, i) => {
    const others = sets.filter((_, j) => j !== i);
    // Union of pairwise differences: a key can be extra in two files and missing in one.
    const missing = [...new Set(others.flatMap(set => [...set]))].filter(key => !sets[i].has(key)).sort();
    const extra = [...sets[i]].filter(key => others.some(set => !set.has(key))).sort();
    report.missing_in[file] = missing;
    report.extra_in[file] = extra;
    drift ||= missing.length > 0 || extra.length > 0;
  });
  if (drift) console.log(JSON.stringify(report, null, 2));
  process.exitCode = drift ? 1 : 0;
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 2;
}

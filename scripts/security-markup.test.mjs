import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';

function declaration(file,name) {
  const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  let found;
  function walk(n){ if(ts.isVariableDeclaration(n)&&n.name.getText(sf)===name)found=n; n.forEachChild(walk); }
  walk(sf);
  assert.ok(found,'Missing production declaration '+name);
  return 'const '+found.getText(sf)+';';
}
const source=declaration('src/tmath/ui.ts','esc')+'\n'+declaration('src/tmath/solve.ts','ioCell')+'\nglobalThis.render=ioCell;';
const javascript=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021}}).outputText;
let checked=0;
for(const method of ['file',undefined])for(const side of ['input','output'])for(const value of [
  'sample.in','<b id="marker">file</b>','"><img src=x onerror=alert(1)>',"a&b'\"<>",
]) {
  const context=vm.createContext({problem:{io_method:{method,[side]:value}},text:()=> 'not provided'});
  vm.runInContext(javascript,context);
  const actual=context.render(side);
  assert.ok(!/[<>]/.test(actual),'Unescaped markup: '+actual);
  assert.equal(actual,(method==='file'?'File: ':'')+value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));
  checked++;
}
for(const side of ['input','output']){
  const context=vm.createContext({problem:{io_method:{method:'standard',[side]:'<b>ignored</b>'}},text:()=> 'not provided'});
  vm.runInContext(javascript,context);
  assert.equal(context.render(side),side==='input'?'stdin':'stdout');
  checked++;
}
console.log('PASS F04 I/O metadata escaping: '+checked+' production-function cases');

// pass #78 (Sonnet S7): the About sanitizer fails CLOSED — a sanitizer crash renders
// the pane empty and logs, never returns unsanitized HTML. The real sanitizeAbout is
// extracted from src/tmath/app.ts; purify/logError are stubbed per case.
function makeAboutContext(purifyStub) {
  const src = 'const logError = (m) => { globalThis.__lastLog = String(m); };\n'
    + 'const purify = __purifyStub;\n'
    + declaration('src/tmath/app.ts','sanitizeAbout')
    + '\nglobalThis.sanitizeAbout = sanitizeAbout;';
  const context=vm.createContext({ __purifyStub: purifyStub });
  vm.runInContext(ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2021}}).outputText, context);
  return context;
}
let aboutChecked=0;
const throwing=makeAboutContext({ sanitize: () => { throw new Error('boom-injection'); } });
assert.equal(throwing.sanitizeAbout('<b>hi</b><script>alert(1)</script>'), '', 'fail-closed must render empty');
assert.ok(String(throwing.__lastLog).includes('boom-injection'), 'failure must reach the diagnostics log');
aboutChecked++;
const passing=makeAboutContext({ sanitize: (h) => 'clean:'+h });
assert.equal(passing.sanitizeAbout('<b>hi</b>'), 'clean:<b>hi</b>', 'healthy sanitizer passes through');
aboutChecked++;
const hooked=makeAboutContext({ hooks: 0, addHook() { this.hooks++; }, sanitize: (h) => h });
hooked.sanitizeAbout('a'); hooked.sanitizeAbout('b');
assert.equal(hooked.__purifyStub.hooks, 0, 'hook registration is module-scope — sanitizeAbout never re-registers');
aboutChecked++;
console.log('PASS S7 About-sanitizer fail-closed: '+aboutChecked+' production-function cases');

// pass #141 (wave-8 W8-L02): the judge/user-controlled interpolation sites that reach
// innerHTML carry esc() — source-shape tripwires (a dropped escape fails the suite).
// The sites: the submission detail button (data-sub + its aria-label, judge IDs), the
// contest tab label (server label verbatim), the AC-banner vars (server counts), and
// the two confirm dialogs whose interpolated names are judge data (submit) / user
// input (draft name).
const appSource = fs.readFileSync('src/tmath/app.ts','utf8');
const solveSource = fs.readFileSync('src/tmath/solve.ts','utf8');
let shapes=0;
for (const [name, src, re] of [
  ['submissions data-sub', appSource, /data-sub="\$\{esc\(s\.id\)\}"/],
  ['submissions showDetails aria', appSource, /subs\.showDetails", \{ n: esc\(String\(s\.id\)\) \}\)/],
  ['contest tab label', appSource, />\$\{esc\(this\.probLabel\(p, i\)\)\}</],
  ['AC banner vars', appSource, /contests\.acBanner", \{ n: esc\(String\(workspace\.accepted_problem_count \?\? 0\)\), r: esc\(String\(workspace\.next_problem_requirement\)\) \}\)/],
  ['submit confirm name', solveSource, /problem\.confirmBody", \{ name: esc\(String\(problem\.name \?\? args\.code\)\) \}\)/],
  ['draft delete confirm name', solveSource, /drafts\.deleteConfirm", \{ name: esc\(d\.name\) \}\)/],
]) {
  assert.ok(re.test(src), 'escaped shape missing: '+name);
  shapes++;
}
console.log('PASS W8-L02 innerHTML escape shapes: '+shapes+' sites');

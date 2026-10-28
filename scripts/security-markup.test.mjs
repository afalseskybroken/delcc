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

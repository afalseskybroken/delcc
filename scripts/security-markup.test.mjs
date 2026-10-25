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

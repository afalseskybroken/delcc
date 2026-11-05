// ONE owner of the monaco editor worker import. pass #129 (attack-surface P4): the audit
// read the dist's TWO `editor.worker-*.js` files as a duplicated worker emission (~3 MB
// "pure duplication") — it was not. The big one is the SHARED monaco editor kernel chunk
// that merely inherits the worker module's name (five chunks import it, exactly one copy),
// and the 210 KB one is the real worker kernel it spawns via
// `new Worker("/assets/editor.worker-*.js")` — Rollup had already deduped everything the
// two import sites shared. This module is therefore a hygiene fix, not a size win: the
// worker import now has exactly one owner, and the naming quirk is documented where the
// next audit will look.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
export default EditorWorker;

// delcc-app/src/lib/editor.ts
// Monaco bundled locally (no CDN: a contest client must not die because jsdelivr hiccuped).
// Loaded lazily via dynamic import from main.ts so first paint stays small.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution";
import "monaco-editor/esm/vs/basic-languages/pascal/pascal.contribution";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };

// OJ language key -> Monaco id: shared with lib/cph.ts, lives in lib/langmap.ts (no Monaco import there).
export { monacoLang } from "./langmap";

let ed: monaco.editor.IStandaloneCodeEditor | null = null;

export interface EditorPrefs { minimap: boolean; wordWrap: "on" | "off" }

export function mount(el: HTMLElement, language: string, onDirty: () => void, prefs?: EditorPrefs) {
  if (ed) { ed.dispose(); ed = null; }
  el.innerHTML = "";
  ed = monaco.editor.create(el, {
    value: "", language, theme: "vs-dark", automaticLayout: true,
    minimap: { enabled: prefs?.minimap ?? true }, wordWrap: prefs?.wordWrap ?? "on", tabSize: 4,
  });
  ed.onDidChangeModelContent(onDirty);
}
export function setLang(language: string) {
  const m = ed?.getModel();
  if (m) monaco.editor.setModelLanguage(m, language);
}
// lane 7: live-toggle without remounting (remounting would drop undo history mid-edit).
export function setPrefs(prefs: EditorPrefs) {
  ed?.updateOptions({ minimap: { enabled: prefs.minimap }, wordWrap: prefs.wordWrap });
}
export const getValue = () => ed?.getValue() ?? "";

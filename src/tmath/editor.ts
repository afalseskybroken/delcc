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
import { monacoLang } from "../lib/langmap";
import { resolveEditorFont, type Preferences } from "./preferences";

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };

// The view owns both editor and model; the legacy singleton is untouched.
export function createEditor(host: HTMLElement, value: string, language: string,
  preferences: Preferences, onChange: () => void) {
  const model = monaco.editor.createModel(value, monacoLang(language));
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let listener: monaco.IDisposable | undefined;
  let observer: MutationObserver | undefined;
  let disposed = false;
  let debugDecor: string[] = []; // pass #106: the debugger's current-line decoration ids
  try {
    editor = monaco.editor.create(host, {
    model, automaticLayout: true, theme: document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
    fontFamily: resolveEditorFont(preferences.editorFont), fontSize: preferences.editorSize,
    minimap: { enabled: preferences.minimap }, wordWrap: preferences.wordWrap ? "on" : "off",
    tabSize: 4, scrollBeyondLastLine: false, ariaLabel: host.getAttribute("aria-label") ?? "",
    });
    listener = editor.onDidChangeModelContent(onChange);
    observer = new MutationObserver(() => { if (!disposed) monaco.editor.setTheme(document.documentElement.classList.contains("dark") ? "vs-dark" : "vs"); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  } catch (error) {
    observer?.disconnect(); listener?.dispose();
    try { editor?.dispose(); } finally { model.dispose(); }
    throw error;
  }
  return {
    getValue: () => model.getValue(),
    runAction: (action: "undo" | "redo" | "findReplace") => {
      if (disposed || !editor) return;
      editor.focus();
      const command = action === "findReplace" ? "editor.action.startFindReplaceAction" : action;
      editor.trigger("tm-editor-toolbar",command,null);
    },
    setLanguage: (key: string, source: string) => {
      if (disposed) throw new Error("Editor is disposed");
      monaco.editor.setModelLanguage(model, monacoLang(key));
      if (disposed) throw new Error("Editor was disposed during language change");
      model.setValue(source);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true; observer?.disconnect(); listener?.dispose();
      try { editor?.dispose(); } finally { if (!model.isDisposed()) model.dispose(); }
    },
    // pass #106: the debugger's current-line highlight. No-op without Monaco (the fallback
    // textarea path): the panel itself carries the line number, so nothing is lost.
    debugLine: (line: number | null) => {
      if (disposed || !editor) return;
      const max = model.getLineCount();
      debugDecor = editor.deltaDecorations(debugDecor, line !== null && line >= 1 && line <= max ? [{
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: "tm-debug-line" },
      }] : []);
    },
  };
}

// delcc-app/src/lib/langmap.ts
// OJ language keys (CPP20, PY3, JAVA8, ...) -> internal lang_key buckets.
// Split out of lib/editor.ts (which eagerly bundles Monaco at module scope) so
// anything that just needs the bucket — lib/cph.ts included — doesn't pull the
// whole editor chunk in to get it.
export function monacoLang(key: string): string {
  const k = (key || "").toUpperCase();
  if (/^(CPP|C\d|C$|GCC|CLANG)/.test(k)) return "cpp";
  if (/^(PY|PYPY|PYTHON)/.test(k)) return "python";
  if (/^JAVA/.test(k)) return "java";
  if (/^(RUST|RS)/.test(k)) return "rust";
  if (/^GO/.test(k)) return "go";
  if (/^(JS|NODE)/.test(k)) return "javascript";
  if (/^(KOT)/.test(k)) return "kotlin";
  if (/^(PAS|FPC)/.test(k)) return "pascal";
  if (/^(CS|MONO|DOTNET)/.test(k)) return "csharp";
  return "plaintext";
}

// pass #103: the OJ language key -> display name map, stated ONCE here so Settings'
// default-language selector and the solve view's language pill agree verbatim (the
// carve's official c_ display-name mapping — the menu shows "C++20", the value stays
// the key).
export const LANG_DISPLAY: Record<string, string> = {
  C: "C", C11: "C11", CPP03: "C++03", CPP11: "C++11", CPP14: "C++14", CPP17: "C++17",
  CPP20: "C++20", JAVA8: "Java 8", MONOCS: "C#", PAS: "Pascal", PY2: "Python 2",
  PY3: "Python 3", PYPY3: "PyPy 3", TEXT: "Text",
};

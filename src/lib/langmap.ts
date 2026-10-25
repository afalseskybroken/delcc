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

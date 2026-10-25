import { applyScheme } from "../lib/scheme";
import { setLocale, type Locale, LOCALES } from "../i18n";

export interface Preferences {
  theme: "light" | "dark" | "system";
  locale: Locale;
  statementFont: string;
  statementSize: number;
  editorFont: string;
  editorSize: number;
  minimap: boolean;
  wordWrap: boolean;
}
export function read(key: string, fallback = ""): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Session still works without storage. */ }
}
export function loadPreferences(): Preferences {
  let p: Partial<Preferences> = {};
  try { p = JSON.parse(read("delcc-tmath-preferences", "{}")) ?? {}; } catch { /* defaults */ }
  const locale = read("delcc-locale", "en-US") as Locale;
  return {
    theme: p.theme === "system" || p.theme === "dark" ? p.theme : read("delcc-scheme") === "dark" && !p.theme ? "dark" : "light",
    locale: LOCALES.includes(locale) ? locale : "en-US",
    statementFont: typeof p.statementFont === "string" ? p.statementFont : "__system__",
    statementSize: clamp(p.statementSize, 12, 28, 16),
    editorFont: typeof p.editorFont === "string" ? p.editorFont : "__sysmono__",
    editorSize: clamp(p.editorSize, 10, 28, 14),
    minimap: p.minimap ?? false, wordWrap: p.wordWrap ?? true,
  };
}
export const clamp = (v: unknown, min: number, max: number, fallback: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
// the OS-default stacks behind the "System" font options (Windows is the shipped platform)
export const SYSTEM_UI_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';
export const SYSTEM_MONO_STACK = 'Consolas, "Cascadia Code", "Courier New", monospace';
export const resolveStatementFont = (f: string): string =>
  !f || f === "__system__" ? SYSTEM_UI_STACK : f.replace(/[;{}]/g, "");
export const resolveEditorFont = (f: string): string =>
  !f || f === "__default__" ? "Menlo, Consolas, \"Courier New\", monospace"
  : f === "__sysmono__" ? SYSTEM_MONO_STACK : f.replace(/[;{}]/g, "");
export function applyPreferences(p: Preferences): void {
  const dark = p.theme === "dark" || (p.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  applyScheme("tmath", dark ? "dark" : "light");
  setLocale(p.locale);
  document.documentElement.lang = p.locale;
  document.documentElement.style.setProperty("--tm-statement-font", resolveStatementFont(p.statementFont));
  document.documentElement.style.setProperty("--tm-statement-size", `${p.statementSize}px`);
  document.documentElement.style.setProperty("--tm-editor-font", resolveEditorFont(p.editorFont));
  // pass #22: UI and statement fonts are ONE choice — the shell rides the statement font
  document.documentElement.style.setProperty("--tm-ui-font", "var(--tm-statement-font)");
}
export function savePreferences(p: Preferences): void {
  write("delcc-tmath-preferences", JSON.stringify(p));
  write("delcc-locale", p.locale);
  write("delcc-scheme", p.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p.theme);
  applyPreferences(p);
}

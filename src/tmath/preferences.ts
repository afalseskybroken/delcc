import { applyScheme } from "../lib/scheme";
import { setLocale, type Locale, LOCALES } from "../i18n";
import { setTimeFormat } from "./ui";

export interface Preferences {
  theme: "light" | "dark" | "system";
  locale: Locale;
  timeFormat: "auto" | "12h" | "24h";
  statementFont: string;
  statementSize: number;
  editorFont: string;
  editorSize: number;
  minimap: boolean;
  wordWrap: boolean;
  uiScale: number;
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
    timeFormat: p.timeFormat === "12h" || p.timeFormat === "24h" ? p.timeFormat : "auto",
    statementFont: typeof p.statementFont === "string" ? p.statementFont : "__system__",
    statementSize: clamp(p.statementSize, 12, 28, 16),
    editorFont: typeof p.editorFont === "string" ? p.editorFont : "__sysmono__",
    editorSize: clamp(p.editorSize, 10, 28, 14),
    minimap: p.minimap ?? false, wordWrap: p.wordWrap ?? true,
    uiScale: clamp(p.uiScale, 80, 140, 100),
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
// pass #88: hour12 option for every locale-formatted clock (undefined = locale default)
export const hour12Opt = (tf: Preferences["timeFormat"]): { hour12?: boolean } =>
  tf === "12h" ? { hour12: true } : tf === "24h" ? { hour12: false } : {};
export function applyPreferences(p: Preferences): void {
  setTimeFormat(p.timeFormat);
  const dark = p.theme === "dark" || (p.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  applyScheme("tmath", dark ? "dark" : "light");
  setLocale(p.locale);
  document.documentElement.lang = p.locale;
  document.documentElement.style.setProperty("--tm-statement-font", resolveStatementFont(p.statementFont));
  document.documentElement.style.setProperty("--tm-statement-size", `${p.statementSize}px`);
  document.documentElement.style.setProperty("--tm-editor-font", resolveEditorFont(p.editorFont));
  // pass #22: UI and statement fonts are ONE choice — the shell rides the statement font
  document.documentElement.style.setProperty("--tm-ui-font", "var(--tm-statement-font)");
  void applyUiScale(p.uiScale);
}

// pass #58 shipped UI scale as CSS zoom on <body> — REVERTED in #62 (He: the tmath tree
// stopped drawing entirely; the zoomed body box shrank inside the window with the dark
// background showing around it — WebView2 + zoom-on-body is a surface-sizing hazard).
// The redo rides TAURI'S NATIVE WEBVIEW ZOOM: compositor-level (the Ctrl+scroll class),
// every layout box untouched, Monaco hit-testing and sticky positioning unaffected.
export async function applyUiScale(scale: number): Promise<void> {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const wv = getCurrentWebview();
    if (typeof wv.setZoom === "function") await wv.setZoom(scale / 100);
  } catch { /* plain-browser dev or missing permission — 100% stays */ }
}

// ---------- pass #106: window identity (title + icon) ----------
// They live in their OWN localStorage keys, not the preferences JSON: the icon is up to a
// few hundred KB of data URL and must not ride the object every save re-serializes.
export const WINDOW_TITLE_KEY = "delcc-window-title";
export const WINDOW_ICON_KEY = "delcc-window-icon";
const IDENTITY_TITLE_MAX = 120;
const IDENTITY_FILE_MAX = 512 * 1024;

// Any browser-decodable image (png/ico/jpeg/webp) → RGBA the Rust command accepts.
// Downscaled to ≤ 256 px on the long edge. Returns null when the browser can't decode it.
export async function iconToRgba(url: string): Promise<{ width: number; height: number; rgba: string } | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) return null;
    const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) {
      bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    }
    return { width: w, height: h, rgba: btoa(bin) };
  } catch {
    return null;
  }
}

const cleanTitle = (raw: string): string =>
  raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, IDENTITY_TITLE_MAX);

// Applies the persisted identity (boot) — a no-op when nothing was customized. An
// unparseable stored icon is dropped back to the bundle icon instead of erroring.
export async function applyIdentity(): Promise<void> {
  try {
    const title = cleanTitle(read(WINDOW_TITLE_KEY));
    const iconUrl = read(WINDOW_ICON_KEY);
    if (!title && !iconUrl) return;
    const icon = iconUrl.startsWith("data:image/") ? await iconToRgba(iconUrl) : null;
    const { applyIdentity: invokeIdentity } = await import("../lib/transport");
    await invokeIdentity(title, icon, !icon);
  } catch { /* plain-browser dev or a rejected payload — the default identity stays */ }
}

// Settings picker: validate a picked file's size, encode, persist, apply live.
export async function setWindowIcon(file: File): Promise<"applied" | "tooBig" | "badIcon" | "storage"> {
  if (file.size > IDENTITY_FILE_MAX) return "tooBig";
  const url: string = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => resolve("");
    fr.readAsDataURL(file);
  });
  if (!url.startsWith("data:image/")) return "badIcon";
  const rgba = await iconToRgba(url);
  if (!rgba) return "badIcon";
  try {
    write(WINDOW_ICON_KEY, url);
  } catch {
    return "storage"; // quota — the honest status line says so
  }
  const { applyIdentity: invokeIdentity } = await import("../lib/transport");
  await invokeIdentity(null, rgba, false);
  return "applied";
}

export function resetWindowIdentity(): void {
  write(WINDOW_TITLE_KEY, "");
  write(WINDOW_ICON_KEY, "");
  void (async () => {
    try {
      const { applyIdentity: invokeIdentity } = await import("../lib/transport");
      await invokeIdentity("", null, true);
    } catch { /* plain-browser dev */ }
  })();
}
export function savePreferences(p: Preferences): void {
  write("delcc-tmath-preferences", JSON.stringify(p));
  write("delcc-locale", p.locale);
  write("delcc-scheme", p.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p.theme);
  applyPreferences(p);
}

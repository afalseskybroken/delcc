import { ApiError, clientVersion } from "../lib/api";
import { getLocale, t, type DictKey } from "../i18n";

export const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const text = (key: DictKey, vars?: Record<string, string | number>) => esc(t(key, vars));
/** dict strings may carry \n break markers (esc-neutralized markup is never re-parsed) */
export const textBr = (key: DictKey) => esc(t(key)).replace(/\n/g, "<br>");
export const list = <T = any>(value: any): T[] => Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : Array.isArray(value?.items) ? value.items : [];
// pass #88: 12h/24h preference (Settings → Appearance) — undefined = locale default;
// preferences.applyPreferences pushes the value here at boot and on every change.
let hour12: boolean | undefined;
export const setTimeFormat = (tf: "auto" | "12h" | "24h"): void => {
  hour12 = tf === "12h" ? true : tf === "24h" ? false : undefined;
};
export const date = (value: unknown) => {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short", hour12 });
};
export const button = (key: DictKey, action: string, primary = false) => `<button type="button" class="tm-button${primary ? " primary" : ""}" data-action="${action}">${text(key)}</button>`;
export const empty = (key: DictKey = "common.empty") => `<div class="tm-empty">${text(key)}</div>`;
export const loading = () => `<div class="tm-empty" role="status">${text("common.loading")}</div>`;
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const keys: Record<number, DictKey> = {401:"errors.unauthorized",403:"errors.forbidden",404:"errors.notFound",409:"errors.conflict",410:"errors.expired",422:"errors.invalid",426:"errors.updateRequired",429:"errors.rateLimited",503:"errors.unavailable"};
    const key = keys[error.status];
    return `${error.status} · ${key ? t(key, {version:clientVersion()}) : t("common.error")}${error.message ? ` — ${error.message}` : ""}`;
  }
  return `${t("errors.network")}${error instanceof Error ? ` — ${error.message}` : ""}`;
}
export const errorBox = (error: unknown) => `<div class="tm-error" role="alert">${esc(errorText(error))}</div>`;
export const icons: Record<string, string> = {
  contests: '<path d="M8 3h8v4a4 4 0 0 1-8 0V3ZM8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 11v7m-4 3h8m-6-3h4v3"/>',
  problems: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4Zm9 3a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2"/>',
  submissions: '<path d="M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7m-7 4h5"/>',
  rankings: '<path d="M4 21V11h5v10m1 0V4h5v17m1 0v-7h5v7"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  settings: '<path d="m10 3-1 3-3 1-3 3 2 2-1 3 3 3 3-1 2 3 3-2 1-3 3-1 1-4-3-2V5l-4-2-2 2-3-2Z"/><circle cx="12" cy="12" r="3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M10 4H4v16h6m5-12 4 4-4 4m-7-4h11"/>',
};
export const icon = (name: string) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.problems}</svg>`;

export async function copyText(value: string, target: HTMLElement): Promise<void> {
  try { await navigator.clipboard.writeText(value); target.textContent = t("common.copied"); }
  catch { target.textContent = t("common.copyFailed"); }
}

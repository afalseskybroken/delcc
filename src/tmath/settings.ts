import { t, LOCALES } from "../i18n";
import { clientVersion } from "../lib/api";
import { cphDetect, systemFonts, openExternal } from "../lib/transport";
import { cphSupported, toolchainOverride, setToolchainOverride, CPH_LANGS, detectOnce, type CphToolchain } from "../lib/cph";
import { LANG_DISPLAY } from "../lib/langmap";
import { logSnapshot, clearLog, onLog, formatEntries } from "../lib/applog";
import { esc, text, button, errorBox, empty, copyText } from "./ui";
import { applyPreferences, read, write, savePreferences, type Preferences } from "./preferences";
import manifest from "../../package.json";

const REPO_URL = "https://github.com/afalseskybroken/delcc";

// pass #24 — outdo official's jailed curated lists (carve gg/_g): System stacks are the
// DEFAULTS for the shared UI/statement font and the editor font, and the whole OS font
// list enumerates on every Settings visit (leave/rejoin re-enumerates).
const IS_WIN = /win/i.test(navigator.userAgent);
const SYS_UI = IS_WIN ? "Segoe UI" : "System";
const SYS_MONO = IS_WIN ? "Consolas" : "Monospace";
const STATEMENT_FONTS: [string, string][] = [
  ["__system__", `System (${SYS_UI})`],
  ["Noto Sans Variable", "Noto Sans Variable"],
  ["Arial", "Arial"],
  ["Times New Roman", "Times New Roman"],
  ["Georgia", "Georgia"],
];
const EDITOR_FONTS: [string, string][] = [
  ["__sysmono__", `System Monospace (${SYS_MONO})`],
  ["__default__", "Menlo / Consolas"],
  ["Consolas", "Consolas"],
  ["Menlo", "Menlo"],
  ["Courier New", "Courier New"],
];

export function renderSettings(host: HTMLElement, prefs: Preferences, onChange: () => void): () => void {
  let disposed = false;
  // a saved off-list font survives remounts (audit F23) instead of silently resetting
  const withSaved = (list: [string, string][], saved: string): [string, string][] =>
    list.some(([k]) => k === saved) || !saved ? list : [...list, [saved, saved]];
  const select = (id: string, values: [string, string][], selected: string) => `<select id="${id}" name="${id}">${values.map(([value, label]) => `<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  host.innerHTML = `<div class="tm-settings-wrap"><div class="tm-page-title"><div><div class="tm-eyebrow">${esc(t("settings.eyebrow" as "settings.title"))}</div><h1>${text("settings.title" as "contests.title")}</h1><p class="tm-muted">${esc(t("settings.headerDesc" as "settings.title"))}</p></div></div><div class="tm-settings-grid">
    <section class="tm-card tm-settings-section"><h2>${text("settings.appearance")}</h2><div class="tm-field"><label for="tm-theme">${text("settings.theme")}</label>${select("tm-theme", ["light","dark","system"].map(v => [v, t(`settings.${v}` as "settings.light")]), prefs.theme)}</div><div class="tm-field"><label for="tm-locale">${text("settings.language")}</label>${select("tm-locale", LOCALES.map(v => [v, {"en-US":"English","vi-VN":"Tiếng Việt","zh-CN":"简体中文"}[v]]), prefs.locale)}</div><div class="tm-field"><label for="tm-timefmt">${text("settings.timeFormat")}</label>${select("tm-timefmt", [["auto", t("settings.timeAuto")], ["12h", t("settings.time12h")], ["24h", t("settings.time24h")]], prefs.timeFormat)}</div><div class="tm-field"><label for="tm-scale">${text("settings.uiScale")}</label>${select("tm-scale", [80,90,100,110,125,140].map(v => [String(v), `${v}%`]), String(prefs.uiScale))}</div><div class="tm-field"><label for="tm-default-lang">${text("settings.defaultLang")}</label>${select("tm-default-lang", [["", text("settings.defaultLangNone")], ...Object.entries(LANG_DISPLAY).map(([k, v]) => [k, v] as [string, string])], read("delcc-tmath-default-lang"))}<small class="tm-muted">${text("settings.defaultLangHint")}</small></div></section>
    <section class="tm-card tm-settings-section"><h2>${text("settings.typography")}</h2><div class="tm-field"><label for="tm-statement-font">${text("settings.statementFont")}</label>${select("tm-statement-font", withSaved(STATEMENT_FONTS, prefs.statementFont), prefs.statementFont)}<small class="tm-muted" data-font-row></small></div><div class="tm-field"><label for="tm-editor-font">${text("settings.editorFont")}</label>${select("tm-editor-font", withSaved(EDITOR_FONTS, prefs.editorFont), prefs.editorFont)}</div><div class="tm-field-row"><div class="tm-field"><label for="tm-statement-size">${text("settings.statementSize")}</label><input id="tm-statement-size" type="number" min="12" max="28" value="${prefs.statementSize}"></div><div class="tm-field"><label for="tm-editor-size">${text("settings.editorSize")}</label><input id="tm-editor-size" type="number" min="10" max="28" value="${prefs.editorSize}"></div></div><label class="tm-check"><input id="tm-wrap" type="checkbox"${prefs.wordWrap ? " checked" : ""}>${text("settings.wordWrap")}</label><label class="tm-check"><input id="tm-minimap" type="checkbox"${prefs.minimap ? " checked" : ""}>${text("settings.minimap")}</label><div class="tm-preview"><small>${text("settings.preview")}</small><p class="tm-statement">a + b = c · ∑ i² · 0123456789</p><pre style="font-family:var(--tm-editor-font);font-size:${prefs.editorSize}px">int main() { return 0; }</pre></div></section>
    <section class="tm-card tm-settings-section"><h2>${text("settings.tools")}</h2>${button("settings.detectTools", "tools")}<div id="tm-tools"></div><p class="tm-muted">${text("settings.tcOverride")}</p>${CPH_LANGS.filter(l => cphSupported(l.key)).map(l => `<div class="tm-field"><label for="tm-tc-${l.key}">${l.label}</label><input id="tm-tc-${l.key}" spellcheck="false" placeholder="${text("settings.tcAuto")}"><small class="tm-muted" data-tc-state="${l.key}"></small></div>`).join("")}</section>
    <section class="tm-card tm-settings-section"><h2>${text("settings.versions")}</h2><dl class="tm-versions"><div><dt>${text("app.clientVersion")}</dt><dd><button type="button" class="tm-button" data-action="open-releases" title="${text("app.releasesTap")}"><b>delcc</b> ${esc(manifest.version)}</button></dd></div><div><dt>${text("app.requiredVersion")}</dt><dd>${esc(clientVersion() || "—")}</dd></div><div><dt>${text("app.github")}</dt><dd>${button("app.github", "open-github")}</dd></div></dl><p class="tm-muted">${text("app.independent")}</p></section>
    <section class="tm-card tm-settings-section"><h2>${text("settings.logs")}</h2><pre class="tm-log-view" data-log-view>${esc(formatEntries(logSnapshot()))}</pre><div class="tm-toolbar">${button("settings.logsCopy", "log-copy")}${button("settings.logsClear", "log-clear")}</div><p class="tm-muted">${text("settings.logsHint")}</p></section></div></div>`;
  host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select").forEach(control => {
    if (control.id.startsWith("tm-tc-")) return; // toolchain overrides wire separately
    control.onchange = () => {
      const val = (id: string) => (host.querySelector(`#${id}`) as HTMLInputElement).value;
      prefs.theme = val("tm-theme") as Preferences["theme"];
      prefs.locale = val("tm-locale") as Preferences["locale"];
      prefs.statementFont = val("tm-statement-font"); prefs.editorFont = val("tm-editor-font");
      prefs.statementSize = Math.max(12, Math.min(28, Number(val("tm-statement-size")) || 16));
      prefs.editorSize = Math.max(10, Math.min(28, Number(val("tm-editor-size")) || 14));
      prefs.wordWrap = (host.querySelector("#tm-wrap") as HTMLInputElement).checked;
      prefs.minimap = (host.querySelector("#tm-minimap") as HTMLInputElement).checked;
      prefs.timeFormat = val("tm-timefmt") as Preferences["timeFormat"];
      prefs.uiScale = Math.max(80, Math.min(140, Number(val("tm-scale")) || 100));
      // applyPreferences HERE (audit BUG-033, the one real find): without it the
      // scheme/locale vars stayed stale until the next theme-menu action or restart
      applyPreferences(prefs);
      savePreferences(prefs); onChange();
    };
  });
  // enumerate the OS font list on every Settings visit (queryLocalFonts -> bridge
  // fallback); System entries stay first, the saved value always survives (F23)
  const fontRow = host.querySelector<HTMLElement>("[data-font-row]");
  if (fontRow) fontRow.textContent = t("settings.fontsScanning");
  void (async () => {
    if (disposed) return;
    let families: string[] = [];
    if ("queryLocalFonts" in window) {
      try {
        const fonts = await (window as unknown as { queryLocalFonts(): Promise<{ family: string }[]> }).queryLocalFonts();
        families = [...new Set(fonts.map(f => f.family))];
        if (families.length) write("delcc-font-sources", "browser");
      } catch { /* permission denied -> bridge */ }
    }
    if (!families.length) {
      try {
        families = await systemFonts();
        if (families.length) write("delcc-font-sources", "os");
      } catch { /* curated fallback stays */ }
    }
    if (disposed || !families.length) { if (fontRow && !disposed) fontRow.textContent = ""; return; }
    families = families.sort((x, y) => x.localeCompare(y));
    if (fontRow) fontRow.textContent = t("settings.fontsFound", { n: String(families.length) });
    const rebuild = (id: string, base: [string, string][], saved: string) => {
      const el = host.querySelector<HTMLSelectElement>(`#${id}`);
      if (!el) return;
      const opts = [...base];
      for (const fam of families) if (!opts.some(([k]) => k === fam)) opts.push([fam, fam]);
      if (!opts.some(([k]) => k === saved) && saved) opts.push([saved, saved]);
      el.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}"${saved === v ? " selected" : ""}>${esc(l)}</option>`).join("");
    };
    rebuild("tm-statement-font", STATEMENT_FONTS, host.querySelector<HTMLSelectElement>("#tm-statement-font")?.value ?? "");
    rebuild("tm-editor-font", EDITOR_FONTS, host.querySelector<HTMLSelectElement>("#tm-editor-font")?.value ?? "");
  })();
  // toolchain overrides (audit #48): saved on change, no full re-render; the state
  // line names the actual binary in auto mode — "<path> [auto-detected]" (pass #54)
  for (const l of CPH_LANGS) {
    if (!cphSupported(l.key)) continue;
    const input = host.querySelector<HTMLInputElement>(`#tm-tc-${l.key}`)!;
    input.value = toolchainOverride(l.key);
    const state = host.querySelector<HTMLElement>(`[data-tc-state="${l.key}"]`);
    let detected: CphToolchain | undefined;
    const paint = () => {
      if (toolchainOverride(l.key)) { if (state) state.textContent = text("settings.tcManual"); return; }
      if (detected) {
        if (state) state.textContent = text("settings.tcAutoDetected", { path: detected.binary });
        input.placeholder = detected.binary;
      } else if (state) state.textContent = text("settings.tcNoneDetected");
    };
    paint();
    input.onchange = () => { setToolchainOverride(l.key, input.value); paint(); };
    void detectOnce().then(tcs => {
      if (disposed) return;
      detected = tcs.find(t => t.lang_key === l.key);
      paint();
    }).catch(() => { /* detection unavailable — the [None detected] line stays */ });
  }
  // pass #103 (Official parity): the Settings-level default submission language —
  // applied by the solve view to problems with no language stored in the draft, when
  // the problem allows it. Blank = no default (the last-used follow stands alone).
  const defaultLang = host.querySelector<HTMLSelectElement>("#tm-default-lang");
  if (defaultLang) defaultLang.onchange = () => write("delcc-tmath-default-lang", defaultLang.value);
  // pass #103 (He's honesty): the auto-detect answer renders WITHOUT waiting for the
  // button — the exact binaries when found, [None detected] when the probe answers
  // empty. The button stays as the manual re-run.
  {
    const out = host.querySelector<HTMLElement>("#tm-tools");
    if (out) out.textContent = t("common.loading");
    void detectOnce().then(tcs => {
      if (disposed) return;
      if (out) out.innerHTML = tcs.length ? tcs.map(tool => `<p><b>${esc(tool.label)}</b> <code>${esc(tool.binary)}</code><br><span class="tm-muted">${esc(tool.version)}</span></p>`).join("") : empty("settings.noTools");
    }).catch(e => { if (!disposed && out) out.innerHTML = errorBox(e); });
  }
  // diagnostics log: live view while Settings is open; copy/clear are manual
  const logView = host.querySelector<HTMLElement>("[data-log-view]")!;
  const unlog = onLog(() => { logView.textContent = formatEntries(logSnapshot()); });
  const logCopy = host.querySelector<HTMLButtonElement>('[data-action="log-copy"]')!;
  logCopy.onclick = () => void copyText(formatEntries(logSnapshot()), logCopy);
  const logClear = host.querySelector<HTMLButtonElement>('[data-action="log-clear"]')!;
  logClear.onclick = () => { clearLog(); logView.textContent = formatEntries(logSnapshot()); };
  const ghBtn = host.querySelector<HTMLButtonElement>('[data-action="open-github"]')!;
  ghBtn.onclick = () => void openExternal(REPO_URL);
  // pass #105 (MID-2a): tapping the version opens the Releases page — zero network, no
  // polling; the page itself is the source of truth for new binaries (GG mandate).
  const relBtn = host.querySelector<HTMLButtonElement>('[data-action="open-releases"]')!;
  relBtn.onclick = () => void openExternal(`${REPO_URL}/releases`);
  const btn = host.querySelector<HTMLButtonElement>('[data-action="tools"]')!;
  btn.onclick = async () => {
    btn.disabled = true;
    const out = host.querySelector<HTMLElement>("#tm-tools")!;
    out.textContent = t("common.loading");
    try {
      const tools = await cphDetect(); if (disposed) return;
      out.innerHTML = tools.length ? tools.map(tool => `<p><b>${esc(tool.label)}</b> <code>${esc(tool.binary)}</code><br><span class="tm-muted">${esc(tool.version)}</span></p>`).join("") : empty("settings.noTools");
    } catch (e) { if (!disposed) out.innerHTML = errorBox(e); }
    finally { if (!disposed) btn.disabled = false; }
  };
  return () => { disposed = true; unlog(); };
}

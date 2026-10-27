// delcc-app/src/lib/cph.ts
// CPH state: toolchain cache, per-problem test cases in localStorage (never sent
// anywhere — there's no server endpoint to source real judge data from). The actual
// compile/run call lives in lib/transport.ts (cph_detect/cph_run invoke wrappers);
// this is the bit main.ts drives the panel with.
import { cphDetect, cphRun, cphCompile, cphStop, type CphToolchain, type CphCase, type CphCaseResult, type CphRunResponse, type CphCompileResponse } from "./transport";
import { monacoLang } from "./langmap";
import { logInfo } from "./applog";

export type { CphToolchain, CphCase, CphCaseResult, CphRunResponse, CphCompileResponse };
export { monacoLang as cphLangKey };

// java/rust/go/pascal/python/javascript/cpp have a real runner in src-tauri/src/cph.rs.
// kotlin/csharp/plaintext fall through here on purpose — half a runner is worse than none.
const SUPPORTED = new Set(["cpp", "python", "java", "rust", "go", "pascal", "javascript"]);
export const cphSupported = (langKey: string) => SUPPORTED.has(langKey);

// manual toolchain overrides (audit: multiple GCC installs, or picking g++ over
// gcc) — key delcc-toolchain-override:<lang>; blank/absent = auto-detected binary.
// The override alone enables a language: the runner executes the path as-is.
const OVERRIDE_KEY = (langKey: string) => `delcc-toolchain-override:${langKey}`;
export const toolchainOverride = (langKey: string): string => {
  try { return localStorage.getItem(OVERRIDE_KEY(langKey)) ?? ""; } catch { return ""; }
};
export const setToolchainOverride = (langKey: string, binary: string): void => {
  try {
    const v = binary.trim();
    if (v) localStorage.setItem(OVERRIDE_KEY(langKey), v);
    else localStorage.removeItem(OVERRIDE_KEY(langKey));
  } catch { /* private mode */ }
};
export const CPH_LANGS: { key: string; label: string }[] = [
  { key: "cpp", label: "C++" }, { key: "python", label: "Python" }, { key: "java", label: "Java" },
  { key: "rust", label: "Rust" }, { key: "go", label: "Go" }, { key: "pascal", label: "Pascal" },
  { key: "javascript", label: "JavaScript" },
];

let toolchains: CphToolchain[] | null = null;
let detectInFlight: Promise<CphToolchain[]> | null = null;
export function detectOnce(): Promise<CphToolchain[]> {
  if (toolchains) return Promise.resolve(toolchains);
  // pass #56: dedupe the IN-FLIGHT probe too — Settings calls this once per language
  // (7 concurrent calls raced the null cache and ran the whole probe set 7×)
  if (!detectInFlight) {
    detectInFlight = cphDetect().then(tcs => {
      toolchains = tcs;
      // QoL (pass #52): auto-detection prints the exact binary each language will run —
      // surfaces in Settings → Diagnostics, so "why is Run disabled" is answerable
      // without pressing Detect tools manually.
      for (const tc of tcs) logInfo(`toolchain ${tc.lang_key}: ${tc.binary} (${tc.version})`);
      if (!tcs.length) logInfo("toolchain detect: none found");
      return tcs;
    }).catch(e => { detectInFlight = null; throw e; });
  }
  return detectInFlight;
}
export const toolchainFor = (langKey: string): CphToolchain | undefined => {
  const override = toolchainOverride(langKey);
  if (override) {
    const detected = toolchains?.find((t) => t.lang_key === langKey);
    return { lang_key: langKey, label: `${detected?.label ?? langKey} (manual)`, binary: override, version: detected?.version ?? "manual path" };
  }
  return toolchains?.find((t) => t.lang_key === langKey);
};

const tcKey = (problemCode: string) => `cph-tc:${problemCode}`;
export function loadCases(problemCode: string): CphCase[] {
  try {
    const raw = localStorage.getItem(tcKey(problemCode));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveCases(problemCode: string, cases: CphCase[]) {
  try { localStorage.setItem(tcKey(problemCode), JSON.stringify(cases)); } catch { /* private mode — session only */ }
}
export const newCase = (): CphCase => ({ id: Math.random().toString(36).slice(2, 9), input: "", expected: "" });

export async function runAll(
  langKey: string, source: string, cases: CphCase[], timeLimitMs: number, memoryLimitMb?: number, std?: string,
): Promise<CphRunResponse> {
  const tc = toolchainFor(langKey);
  if (!tc) throw new Error(`no ${langKey} toolchain detected`);
  // enabled (mock-submit inclusion) is decided by the caller; Rust gets exactly what it's given.
  // memoryLimitMb is plumbing for lane 1 — no UI control yet (opt-in Rust feature, unverified).
  // std (pass #52): the selected judge language's C++ standard — c++03..c++20; absent =
  // compiler default (the old forced -std=c++17 restricted every compile).
  return cphRun(langKey, tc.binary, source, cases, timeLimitMs, memoryLimitMb, std);
}
// ---------- lane 2 (pass #10): case-pool import/export ----------
// Append-only: every export above this line keeps its exact signature and behavior —
// tmath's solve view imports this file live. No UI wiring here; the merge pass decides
// where the buttons go for each persona.
const CASE_POOL_FORMAT = "delcc-cases";
const CASE_POOL_VERSION = 1;
const MAX_CASES = 40; // mirrors main.ts's MOCK_CAP — project-wide doctrine, not CPH-only
const MAX_FIELD_LEN = 100_000; // chars, same threshold main.ts's harvester already uses per field

export function exportCasePool(code: string): string {
  const cases = loadCases(code);
  return JSON.stringify({
    format: CASE_POOL_FORMAT,
    version: CASE_POOL_VERSION,
    source: code,
    exportedAt: new Date().toISOString(),
    // ids, enabled, per-case time/memory overrides are local UI state, not portable data —
    // only input/expected round-trip.
    cases: cases.map((c) => ({ input: c.input, expected: c.expected ? c.expected : null })),
  });
}

export function importCasePool(code: string, json: string): { added: number; skipped: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("not valid JSON"); }
  const p = parsed as { format?: unknown; version?: unknown; cases?: unknown };
  if (!p || p.format !== CASE_POOL_FORMAT) throw new Error(`not a ${CASE_POOL_FORMAT} export`);
  if (p.version !== CASE_POOL_VERSION) throw new Error(`unsupported version ${String(p.version)} (expected ${CASE_POOL_VERSION})`);
  if (!Array.isArray(p.cases)) throw new Error("missing cases array");

  const existing = loadCases(code);
  const dedupeKey = (input: string, expected: string) => `${input}\u0000${expected}`;
  const seen = new Set(existing.map((c) => dedupeKey(c.input, c.expected ?? "")));
  let added = 0, skipped = 0;
  for (const raw of p.cases as unknown[]) {
    const r = raw as { input?: unknown; expected?: unknown };
    if (existing.length + added >= MAX_CASES) { skipped++; continue; }
    if (typeof r?.input !== "string" || r.input.length === 0 || r.input.length > MAX_FIELD_LEN) { skipped++; continue; }
    let expected = "";
    if (r?.expected != null) {
      if (typeof r.expected !== "string" || r.expected.length > MAX_FIELD_LEN) { skipped++; continue; }
      expected = r.expected;
    }
    const key = dedupeKey(r.input, expected);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    // imported ids are untrusted (could collide, could be absent, could be anything) — same
    // rule the paint path applies to any locally-loaded data: never trust a stored id, mint fresh.
    existing.push({ id: newCase().id, input: r.input, expected });
    added++;
  }
  saveCases(code, existing);
  return { added, skipped };
}

// ---------- pass #11: compile-only + stop ----------
// Append-only, same contract as above. compileOnly builds (or, for python/node, syntax-checks) the
// current source and caches the build in Rust, so a following runAll on unchanged source skips
// the compiler. stopRun cancels whatever local job is running (compile or run).
export async function compileOnly(langKey: string, source: string, std?: string): Promise<CphCompileResponse> {
  const tc = toolchainFor(langKey);
  if (!tc) throw new Error(`no ${langKey} toolchain detected`);
  return cphCompile(langKey, tc.binary, source, std);
}
export const stopRun = (): Promise<boolean> => cphStop();

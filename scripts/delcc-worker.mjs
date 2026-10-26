#!/usr/bin/env node
// scripts/delcc-worker.mjs — the distributed-compute runner (pass #48).
// delcc's doctrine, worker edition: pull-based, human-gated, locally-capped.
// You run this YOURSELF, on a job file YOU have read, against YOUR toolchain.
// Nothing phones home: input comes from a local file, output lands in a local
// file — the GitHub PR flow (docs/DISTRIBUTED.md) is how results travel.
//
// Usage:
//   node scripts/delcc-worker.mjs <job.json> [--out results.json]
//
// job.json shape:
// {
//   "problem": "A01A00001",            // label only — the worker never talks to the judge
//   "language": "cpp" | "python",
//   "source": "main.cpp",              // path to the source file
//   "cases": [{ "name": "1", "input": "3\n", "expected": "3\n" }],
//   "timeLimitMs": 1000,               // enforced per case by THIS worker, not the requester
//   "compare": "exact"                 // "exact" (line-trimmed) — the only mode for now
// }
//
// The job may contain code written by someone else. Running it is like running it
// in a terminal yourself: unsandboxed. Read the job before you run it. Exit code 0
// means every scored case passed; results.json carries the details for the PR.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const argFile = process.argv[2];
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : "results.json";
if (!argFile) { console.error("usage: node scripts/delcc-worker.mjs <job.json> [--out results.json]"); process.exit(2); }

const job = JSON.parse(fs.readFileSync(argFile, "utf8"));
const fail = (msg) => { console.error(`worker: ${msg}`); process.exit(2); };
if (!job || typeof job !== "object") fail("job.json is not an object");
if (job.language !== "cpp" && job.language !== "python") fail("language must be cpp or python (for now)");
if (!Array.isArray(job.cases) || !job.cases.length) fail("job.cases must be a non-empty array");
const srcFile = path.resolve(typeof job.source === "string" ? job.source : fail("job.source must be a path"));
if (!fs.existsSync(srcFile)) fail(`source not found: ${srcFile}`);
const tl = Math.max(100, Math.min(60_000, Number(job.timeLimitMs) || 5000));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "delcc-worker-"));

const run = (cmd, args, input, timeoutMs) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", done = false;
  const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); resolve({ kind: "timeout" }); } }, timeoutMs);
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ kind: "spawn-error", stderr: String(e) }); } });
  child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ kind: "exit", code, stdout, stderr }); } });
  child.stdin.on("error", () => { /* EPIPE when the program exits early — stdout already has the answer */ });
  child.stdin.end(input ?? "");
});

const normalize = (s) => String(s ?? "").split(/\r?\n/).map(l => l.replace(/\s+$/g, "")).join("\n").replace(/\n+$/g, "");

const results = { problem: String(job.problem ?? ""), language: job.language, timeLimitMs: tl, toolchain: null, cases: [], startedAt: new Date().toISOString() };

if (job.language === "cpp") {
  const compiler = process.env.CXX || "g++";
  // -static: the operator's machine must not need matching runtime DLLs — the
  // binary is self-contained (dynamic libstdc++ DLL mismatches crash at startup
  // on several MinGW distributions)
  const compile = await run(compiler, ["-O2", "-std=c++17", "-static", "-o", "job-bin", srcFile], "", 120_000);
  if (compile.kind !== "exit" || compile.code !== 0) {
    results.cases.push({ case: "compile", verdict: "CE", detail: (compile.stderr || compile.detail || "").slice(0, 4000) });
  } else {
    results.toolchain = `${compiler} (local)`;
    for (const [i, c] of job.cases.entries()) {
      const t0 = Date.now();
      const r = await run(path.join(workDir, process.platform === "win32" ? "job-bin.exe" : "job-bin"), [], String(c.input ?? ""), tl);
      const ms = Date.now() - t0;
      if (r.kind === "timeout") { results.cases.push({ case: c.name ?? String(i + 1), verdict: "TLE", timeMs: ms }); continue; }
      if (r.kind !== "exit") { results.cases.push({ case: c.name ?? String(i + 1), verdict: "RUNERR", detail: r.stderr }); continue; }
      const expected = c.expected == null ? null : normalize(c.expected);
      const got = normalize(r.stdout);
      const verdict = r.code !== 0 ? `RTE(${r.code})` : expected == null ? "RAN" : got === expected ? "AC" : "WA";
      results.cases.push({ case: c.name ?? String(i + 1), verdict, timeMs: ms, output: got.slice(0, 4000), stderr: r.stderr.slice(0, 2000) });
    }
  }
} else {
  const interpreter = process.env.PYTHON || "python";
  results.toolchain = `${interpreter} (local)`;
  for (const [i, c] of job.cases.entries()) {
    const t0 = Date.now();
    const r = await run(interpreter, [srcFile], String(c.input ?? ""), tl);
    const ms = Date.now() - t0;
    if (r.kind === "timeout") { results.cases.push({ case: c.name ?? String(i + 1), verdict: "TLE", timeMs: ms }); continue; }
    if (r.kind !== "exit") { results.cases.push({ case: c.name ?? String(i + 1), verdict: "RUNERR", detail: r.stderr }); continue; }
    const expected = c.expected == null ? null : normalize(c.expected);
    const got = normalize(r.stdout);
    const verdict = r.code !== 0 ? `RTE(${r.code})` : expected == null ? "RAN" : got === expected ? "AC" : "WA";
    results.cases.push({ case: c.name ?? String(i + 1), verdict, timeMs: ms, output: got.slice(0, 4000), stderr: r.stderr.slice(0, 2000) });
  }
}

const scored = results.cases.filter(c => c.verdict !== "compile" && c.verdict !== "RAN");
const passed = results.cases.filter(c => c.verdict === "AC").length;
results.summary = `${passed}/${scored.length || results.cases.length} passed`;
fs.writeFileSync(path.resolve(outFile), JSON.stringify(results, null, 2) + "\n");
fs.rmSync(workDir, { recursive: true, force: true });
console.log(`worker: ${results.summary} — wrote ${path.resolve(outFile)}`);
process.exit(passed === scored.length ? 0 : 1);

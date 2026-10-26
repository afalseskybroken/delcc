# DISTRIBUTED.md — helping delcc with compute, without it becoming a botnet

Two different activities share one rule: **everything rides normal Git PRs, and
everything runs only on a machine whose human chose to run it.** No coordinator
server, no always-on daemon, no silent background anything.

## 1. Distributed development (the normal kind)

Fork → branch → PR, same as any project:

1. Fork `afalseskybroken/delcc`, branch off `main`
   (`git checkout -b fix/<short-desc>`).
2. Keep changes scoped: one concern per PR. The repo's gates are
   `npx tsc --noEmit`, `node scripts/lint-i18n.mjs`, and the test suites in
   `docs/BUILDING.md` — run them before pushing.
3. Open the PR with: what you changed, why, and how you tested it. Screenshots
   for UI changes.
4. The maintainer (or any reviewer/agent they delegate to) audits the diff and
   merges. Nothing merges itself.

That's it — if your contribution is code or docs, this section is all of it.

## 2. Distributed compute (donating CPU cycles)

Use case: the maintainer wants many local runs of a job (stress-testing a
solution across machines, timing on different hardware, long batches) and
friends donate cycles. The flow is deliberately shaped like development so it
stays auditable:

```
maintainer                worker operator (you)           GitHub
    │ 1. push job branch        │                            │
    ├──────────────────────────>│ 2. git fetch + read job    │
    │                           │ 3. node scripts/delcc-worker.mjs job.json
    │                           │    (runs ON YOUR machine, YOUR toolchain)
    │                           │ 4. commit results.json ────> 5. open PR
    │                           │                            │ 6. review/audit
    │ <─────── 7. merge = result accepted ────────────────────┘
```

### The operator's side (the person donating compute)

1. `git fetch origin && git switch job/<name>` — read the job file FIRST:
   `job.json` names the source file it will compile/run. **The worker executes
   that code on your machine, unsandboxed — same as running it in a terminal
   yourself.** If you did not write the code and cannot read it, do not run the
   job. This is the whole security model; there is nothing else protecting you.
2. Run it:
   ```
   node scripts/delcc-worker.mjs job.json --out results-<yourname>.json
   ```
   Requirements: Node 18+, and your own toolchain (`g++` on PATH for cpp jobs,
   `python` for python jobs; override with `CXX` / `PYTHON` env vars).
3. Commit `results-<yourname>.json` on the job branch and open a PR titled
   `results: <job name> — <your handle>`. The results file records verdicts,
   timings, and your toolchain line — nothing else leaves your machine.

### What the worker enforces (on your behalf, not the requester's)

- **Time limit**: each case is killed at `timeLimitMs` (capped at 60 s) — the
  cap lives in YOUR worker, so a job asking for an hour still dies at 60 s.
- **Memory**: not enforced by the Node worker (unlike the desktop client's
  Windows Job Object). A runaway job is your Ctrl+C to stop, plus Task Manager.
- **No network**: the worker never talks to the judge, Gravatar, or anything
  else — input is the local job file, output is the local results file.
- **No persistence**: each run compiles into a temp dir that is deleted after.

### The requester's side (writing a job)

```json
{
  "problem": "B05 - Mật mã 30 (stress)",
  "language": "cpp",
  "source": "main.cpp",
  "cases": [{ "name": "1", "input": "3\n1 2 3\n", "expected": "2\n" }],
  "timeLimitMs": 1000
}
```

Commit `job.json` + `main.cpp` on a `job/<slug>` branch, push, and tell the
operators which branch to pull. When their PRs land, results accumulate on the
branch; audit them like any PR (the timings are machine-reported, not gospel —
treat cross-machine comparisons as directional).

### Anti-botnet checklist (why this stays honest)

- [x] Pull-based: workers fetch work; nobody connects into a worker machine.
- [x] Human-gated: a person types the command, every session, every machine.
- [x] Locally-capped: limits are enforced by the machine that runs the code.
- [x] Auditable: jobs and results are ordinary commits — `git log` is the ledger.
- [x] Inactive by default: nothing runs at boot, in the background, or on a schedule.

---
*[VI — Tiếng Việt] mirrors of the main docs live alongside them; this file's
Vietnamese translation is queued (see the repo's translation tracker).*

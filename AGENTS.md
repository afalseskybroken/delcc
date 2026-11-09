# AGENTS.md — standing instructions for coding agents

If you are an agent (human-supervised LLM or automation) working in this
repository, this file is your entry point. It compresses the rules that keep
agent work mergeable. Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md).

## Non-negotiables

1. **Read state before writing code.** `git log --oneline -5`, `git status`,
   and the latest ledger entries first — other agents and the maintainer
   commit between your sessions. Never edit from memory.
2. **Honest-client doctrine is the spine.** No fake features, no stubbed
   flows, no telemetry, no analytics, no forced updates, no undocumented
   endpoints. Violating it is the only mistake that gets a whole pass
   reverted. Full digest: [CONTRIBUTING.md](CONTRIBUTING.md §Doctrine digest).
3. **The API contract is read-only.** Never invent endpoints. The public canon
   is the live spec at `https://oj.tmathcoding.vn/api/v3/openapi.json`;
   `docs/api-docs.md` references in this repo point at the maintainer's
   private mirror. When code starts talking to anything new, update
   `docs/SECURITY.md` in the same pass — the network-surface list must stay
   complete and honest.
4. **Escape-first everywhere.** Interpolated values go through `esc()`, URLs
   through `safeUrl`, embeds are YouTube-only, DOMPurify is the final gate.
   Untrusted local data (localStorage) is validated with caps on load.
5. **Tokens never appear in logs, commits, or docs.** Diagnostics log message
   strings and status codes only.

## Build and gate discipline

- Gate battery (all of it, every pass): `npx tsc --noEmit`,
  `node scripts/lint-i18n.mjs`, `node scripts/lint-versions.mjs`,
  `node --experimental-vm-modules scripts/test-tmath-md.mjs`,
  `node --experimental-vm-modules tools/verify-session-integrity.mjs`,
  `node --test scripts/security-markup.test.mjs`, then `npx vite build`,
  then the browser suites (offline fixture, system Chrome):
  `node scripts/test-tmath-statement.mjs`, `node scripts/test-tmath-boot.mjs`,
  `node scripts/test-tmath-tools.mjs`, then `npm audit --omit=dev` (the
  documented advisory baseline must not grow), then `cargo test` and
  `cargo clippy -- -D warnings` (in `src-tauri/`) — the whole battery, frontend
  and Rust, on every pass that could touch it. This is also the CI matrix;
  a suite that is green locally but missing from `.github/workflows/ci.yml`
  is a regression lock that does not exist.
- **Never trust a piped exit code.** `cmd | tail; echo $?` yields tail's
  status. Redirect to a file and read it. This exact trap has produced a false
  BUILD_OK and a hidden type error before.
- **Build order: vite before cargo.** The Rust `generate_context!` macro
  embeds `../dist`; a missing or half-written dist fails cargo with a
  misleading proc-macro error.
- `lint-versions` guards the versioning law: SEVEN files carry the version —
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock`, `package-lock.json` (machine `X.Y.Z-tag`), plus both
  READMEs (the human release name, `v0.2.23a-alpha` spelling). Two spellings
  on purpose — never "fix" either into the other. Missing the lock files is
  the classic bump mistake (pass #151 hit it; lint-versions passing without
  them was the tell that the law had drifted).
- Layouts: `DELCC_LAYOUT` env at compile time (`baseplate` default, `wip`,
  `tmath`). i18n is shared: three locales (en-US, vi-VN, zh-CN) plus the
  `Dict` interface must all agree (`lint-i18n`).

## Repo conventions

- Commit prefixes `fix:` / `feat:` / `docs:` / `release:`, one concern per
  commit when practical.
- Docs have Vietnamese twins (`*.vi.md`) — mirror meaningful doc changes.
- `tools/verify-session-integrity.mjs` is a gate dependency; do not "clean it
  up". The unwrap gate (`tools/unwrap-bundle.mjs` +
  `scripts/test-unwrap-bundle.mjs`) is MAINTAINER-LOCAL: gitignored relay
  tooling that exists only in the maintainer's tree — it must never be
  referenced from CI or fresh-clone instructions (its path validator keeps a
  historical allowance for `tools/claude11/...` bundle paths — deliberate,
  for old relay chunks).
- Playwright-dependent suites run against an offline Vite fixture with
  system Chrome (`channel: "chrome"` — no browser downloads). The canonical
  three are CI gates since #102/#144: `test-tmath-statement.mjs`,
  `test-tmath-boot.mjs`, `test-tmath-tools.mjs`. The old solve-view suite was
  dropped in #102 (frozen at a UI long gone) — do not resurrect it blindly.
  The tools suite pre-warms its lazy chunk trees with EXPLICIT entry-file
  URLs (a browser-native extensionless import re-resolves the whole tree
  under unhashed URLs, and a cold dep-optimizer pass RELOADS the page —
  both learned the hard way in #145's CI duel).
- `todo.md`, `states.md` and the API-doc mirrors are maintainer-private; they
  are referenced, not shipped. Annotate, don't delete.

## Known platform quirks (documented, not yours to "fix")

- The dev box used for this project has chronic memory pressure: builds run in
  retry loops with `-j 1` and a redirected `CARGO_TARGET_DIR`. On normal
  machines none of that is needed; on that box it is mandatory.
- Rust-side behaviors verified against the live judge (e.g. literal query
  parameters like `scope=` on `/submissions`, the 504-hanging unscoped
  `/submissions`) are probe-verified facts — do not "simplify" them away.

## Cutting a release (the maintainer's word, then this)

- A tag `vX.Y.Za-alpha` targets the release commit by its FULL SHA — the
  short form is rejected by the API (`Release.target_commitish is invalid`).
- Three assets, the 45a pattern: `delcc.exe` (the release build),
  `delcc-vX.Y.Za-alpha.zip` (the same binary zipped — for hosts that block
  raw executables), `hash.txt` (`delcc.exe SHA256=<UPPERCASE HEX>`).
- The release build: `CARGO_TARGET_DIR='C:\rust-target' DELCC_LAYOUT=tmath
  cargo build --release` from `src-tauri/` (the dev box needs
  `RUST_MIN_STACK=16777216`; normal machines do not).
- **A post-release fix bumps the version.** The fix-forward precedent applies
  ONLY to unreleased versions (#143 inside 0.3.45, #145-#150 inside 0.3.46);
  once the tag is public, the next defect ships as the next version (#151 ->
  0.3.47, #152 -> 0.3.48).

## Changes that need the maintainer first

License or branding changes, anything touching the official-client parity
posture (window title, version header), new dependencies, and any change to
the shipped network surface wait for an explicit maintainer decision.

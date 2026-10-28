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
  then `cargo build` (in `src-tauri/`) for Rust-side changes.
- **Never trust a piped exit code.** `cmd | tail; echo $?` yields tail's
  status. Redirect to a file and read it. This exact trap has produced a false
  BUILD_OK and a hidden type error before.
- **Build order: vite before cargo.** The Rust `generate_context!` macro
  embeds `../dist`; a missing or half-written dist fails cargo with a
  misleading proc-macro error.
- `lint-versions` guards the versioning law: three machine fields carry
  `X.Y.Z-tag`; both READMEs carry the human release name (`v0.2.23a-alpha`
  spelling). Two spellings on purpose — never "fix" either into the other.
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
- Playwright-dependent suites (`scripts/test-tmath-solve.mjs`,
  `scripts/test-tmath-statement.mjs`) are optional lane checks, not part of
  the canonical gate battery.
- `todo.md`, `states.md` and the API-doc mirrors are maintainer-private; they
  are referenced, not shipped. Annotate, don't delete.

## Known platform quirks (documented, not yours to "fix")

- The dev box used for this project has chronic memory pressure: builds run in
  retry loops with `-j 1` and a redirected `CARGO_TARGET_DIR`. On normal
  machines none of that is needed; on that box it is mandatory.
- Rust-side behaviors verified against the live judge (e.g. literal query
  parameters like `scope=` on `/submissions`, the 504-hanging unscoped
  `/submissions`) are probe-verified facts — do not "simplify" them away.

## Changes that need the maintainer first

License or branding changes, anything touching the official-client parity
posture (window title, version header), new dependencies, and any change to
the shipped network surface wait for an explicit maintainer decision.

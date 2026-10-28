# Contributing to delcc

Read this before opening a PR. delcc is small, opinionated, and runs on a
strict gate discipline — a change that cannot pass the gates below will not be
merged, and a change that fakes its way past them gets reverted. The license is
**PolyForm Noncommercial 1.0.0**: by contributing you accept that your work is
distributed under it (see README §License).

## Prerequisites

- Node ≥ 22 (the VM-based test suites require `--experimental-vm-modules` on
  some Node versions — the commands below carry the flag; keep it)
- Rust stable + the Tauri v2 prerequisites for your OS (Windows: WebView2 +
  MSVC build tools — see [BUILDING.md](docs/BUILDING.md))
- `npm ci` (not `npm install`) for a reproducible tree

## Layouts

`DELCC_LAYOUT` selects the compile-time UI lane: `baseplate` (default, stable
tab UI), `wip` (reference iteration), `tmath` (the parity lane users actually
run — mirror of the official client's structure). All three must keep passing
gates; the i18n dictionaries are shared across lanes. Build order matters:
**frontend (`vite build`) before cargo** — the Rust `generate_context!` macro
embeds `../dist` and fails confusingly if it is absent or mid-write.

## The gate battery (all of it, real exit codes)

```
npx tsc --noEmit
node scripts/lint-i18n.mjs
node scripts/lint-versions.mjs
node --experimental-vm-modules scripts/test-tmath-md.mjs
node --experimental-vm-modules tools/verify-session-integrity.mjs
node --test scripts/security-markup.test.mjs
npx vite build
# then, for Rust changes:
cargo build -j 1        # in src-tauri/; release profile carries the ship flags
```

Never trust a piped exit code (`cmd | tail; echo $?` reports *tail's* status).
Redirect to a file and read it.

- `lint-i18n` — every UI string key must exist in **en-US, vi-VN and zh-CN**
  and in the `Dict` interface in `src/i18n/index.ts`. Three locales, not two.
- `lint-versions` — `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json` must carry the same `X.Y.Z-tag` machine version,
  and both README files' "What works" heading the matching human release name
  (`v0.2.23a-alpha` style). Update all five lines when bumping.
- `security-markup` — guards the escape-first doctrine. If your change touches
  HTML sinks, extend the suite in the same pass.

## Commit style

One concern per commit when practical. Prefixes:

- `fix:` — defect repair (cite the symptom and, if known, the cause)
- `feat:` — new behavior
- `docs:` — documentation only
- `release:` — version bumps + release artifacts

## Doctrine digest (the short version — see SUCCESSION.md for the full text)

1. **Honesty over polish**: no fake buttons, no stubbed flows, no silent
   truncation; a feature that cannot be finished honestly is left out and
   listed as a limitation.
2. **The user's machine is the user's**: local runs are unsandboxed and say so;
   nothing phones home except the judge API, the judge site's public profile
   pages, and gravatar.com (own avatar). Any new network call means updating
   SECURITY.md **in the same pass**.
3. **Escape-first everywhere**: interpolated values pass `esc()`; URLs pass
   `safeUrl`; embeds are YouTube-only; DOMPurify is the final gate, not the
   only one.
4. **Untrusted local data**: anything loaded from localStorage is validated and
   capped. Never trust a stored id.
5. **Tokens never appear in logs, commits, or docs.**
6. **The API contract is read-only**: never invent endpoints; verify against
   the live spec (`https://oj.tmathcoding.vn/api/v3/openapi.json`).

## What lives outside this repo (private by design)

The maintainer ledger (`todo.md`, `states.md`), the API-doc mirrors
(`../docs/api-docs.md`, `../tools/openapi-frontend.json`), and release
staging are workspace-private. If a doc here references them, treat the live
OpenAPI spec as the public canon. Do not "fix" such references by deleting
them — annotate instead (see README §Contract for the pattern).

## Pull requests

Small, single-concern PRs pass fastest. Include: what changed and why, which
gates you ran (with their real exit statuses), and a SECURITY.md diff if the
network surface moved. Non-commercial use only (license above) — PRs that add
telemetry, analytics, forced-update checks, or undocumented endpoints are
rejected on sight.

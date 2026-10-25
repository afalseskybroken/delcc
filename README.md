# delcc — an independent, inspectable client for TMATH

> *"and in that light, I find deliverance"*

Not TMATH's work. delcc is an independent desktop client for the TMATH
competitive programming judge (`oj.tmathcoding.vn`), built because the official
client is closed-source and some of its users wanted one they could read, audit,
and fix. It talks only to the judge's documented API — no telemetry, no
analytics, no undocumented behavior. Every network call it can make is listed
in [SECURITY.md](docs/SECURITY.md); that list is the contract.

*Người dùng Việt Nam? Xem [README.vi.md](README.vi.md).*

## Documentation map

| Doc | What it holds |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the pieces fit: transport, identity, the tmath shell, CPH runner, methodology |
| [BUILDING.md](docs/BUILDING.md) | toolchains, per-platform build notes, test suites, release ritual |
| [SECURITY.md](docs/SECURITY.md) | the complete network surface, data-at-rest inventory, known gaps |
| [SUCCESSION.md](docs/SUCCESSION.md) | the maintainer handoff: read order, non-negotiables, how to take over |
| `todo.md` / `states.md` | the ledger — every pass since the beginning, and current feature state |

## The trees (layouts)

delcc boots one of three layouts (`src/main.ts`):

- **tmath** (`src/tmath/`) — the parity lane, the one users run. Mirrors the
  official client's structure so switching between them costs nothing.
- **baseplate** (`src/main.ts`) — the original stable tab UI; the fallback.
- **wip** (`src/main.ts`) — early original-UI iteration, kept for reference.
  A fully original tree is anticipated; see SUCCESSION.md.

## Quick start

```
cd delcc-app
npm install
npm run dev          # frontend only, plain browser
npm run tauri dev    # full desktop shell (needs Rust — see BUILDING.md)
npm run tauri build  # release bundle (MSI/NSIS on Windows)
```

Frontend-only mode covers login and lists; the desktop shell adds custom
headers, submissions, and the local CPH runner. Per-platform details,
prerequisites, and caveats: [BUILDING.md](docs/BUILDING.md).

## what works (v0.2.1a-alpha)

login (+ Google flow) → contests → workspace → problem → submit → verdict
poll; rankings, submissions filters, account, settings; local CPH
compile/run with per-case limits; multi-profile quick-login with silent
refresh; i18n (EN / VI / ZH). Errors surface as human text per status —
never a bare code.

## contract (read-only, outside this folder)

- `../docs/api-docs.md` — endpoint checklist
- `../tools/openapi-frontend.json` — machine contract
- `../delcc/index.html` — PoC reference (kept, not imported)

## theming
Unthemed on purpose. `src/app.css` is the guest-themer lane
(Claude Sonnet 5.5) — structure stays, palette is theirs.

## license

**CC BY-NC-SA 4.0** (`SPDX: CC-BY-NC-SA-4.0`, full text in [LICENSE](LICENSE)) —
chosen deliberately, not by default:

- **You may**: use it, study it, modify it, redistribute it, run it anywhere —
  for any *non-commercial* purpose. School, club, personal, judge-community use:
  all fine, no permission needed.
- **You may not**: commercialize it (sell it, bundle it into a paid product,
  run it primarily for commercial advantage) — and any fork or adaptation must
  carry this same license (**ShareAlike**). Closed forks are excluded by design:
  if you build on delcc, your changes are readable too.
- **Honest framing**: this is *source-available*, not OSI open source — the OSI
  definition forbids field-of-use limits, and the no-commercialization limit is
  the point here. The FSF recommends against CC licenses for code; this project
  chose NC + SA anyway because those two constraints are its identity, and no
  software-native license encodes both. That trade is documented, not hidden.
- **Escape hatch**: copyright remains with the maintainer(s), who may relicense
  future versions; contributions are accepted under the same license.

## versioning (His scheme — LLMs, read this before touching versions)
`v[BREAKING].[NON_BREAKING].[TWEAK][MATURITY]`
- `BREAKING` stays **0 until the first Stable release** — do not bump it to 1 before then.
- `MATURITY`: `a` = alpha, `b` = beta, nothing = stable. Other suffixes come later.
- Example: `v0.2.1a` = still pre-stable, 2nd non-breaking wave, 1st tweak, alpha.
- **Two spellings on purpose** (LLMs: do not "fix" either into the other):
  - Human-facing release name carries the scheme verbatim: `delcc-v0.2.1a-alpha`
    (the trailing `-alpha` is the channel tag on the artifact folder/zip).
  - Machine fields (package.json / Cargo.toml / tauri.conf.json) require strict
    semver, so they carry `0.2.1-alpha` — same version, maturity spelled out.
    Cargo REJECTS `0.2.1a-alpha` outright; a build that "succeeds" with it is a
    false positive from a pipe-eaten exit code.
- Release ledger lives in `todo.md` (pass entries) and `../ship-staging/`.

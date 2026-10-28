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
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit: transport, identity, the tmath shell, CPH runner, methodology |
| [BUILDING.md](docs/BUILDING.md) | Toolchains, per-platform build notes, test suites, release ritual |
| [SECURITY.md](docs/SECURITY.md) | The complete network surface, data-at-rest inventory, known gaps |
| [SUCCESSION.md](docs/SUCCESSION.md) | The maintainer handoff: read order, non-negotiables, how to take over |
| [DISTRIBUTED.md](docs/DISTRIBUTED.md) | Helping with compute or code via PRs — the worker, the doctrine, the anti-botnet checklist |
| `todo.md` / `states.md` | The ledger — every pass since the beginning, and current feature state *(maintainer-private, deliberately not in the public repo — see [PUBLISH.md](docs/PUBLISH.md))* |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to build, gate, and land a change — commit prefixes, the test battery, doctrine digest |
| [AGENTS.md](AGENTS.md) | Standing instructions for coding agents working on delcc |

## The trees (layouts)

delcc boots one of three layouts (`src/main.ts`):

- **tmath** (`src/tmath/`) — the parity lane, the one users run. Mirrors the
  official client's structure so switching between them costs nothing.
- **baseplate** (`src/main.ts`) — the original stable tab UI; the fallback.
- **wip** (`src/main.ts`) — early original-UI iteration, kept for reference.
  A fully original tree is anticipated; see SUCCESSION.md.

## Quick start

```
cd delcc              # the clone directory is named after the repo
npm install
npm run dev          # frontend only, plain browser
npm run tauri dev    # full desktop shell (needs Rust — see BUILDING.md)
npm run tauri build  # release bundle (MSI/NSIS on Windows)
```

Frontend-only mode covers login and lists; the desktop shell adds custom
headers, submissions, and the local CPH runner. Per-platform details,
prerequisites, and caveats: [BUILDING.md](docs/BUILDING.md).

## What works (v0.2.27a-alpha)

Login (+ Google flow) → contests → workspace → problem → submit → verdict
poll; rankings, submissions filters, account, settings; local CPH
compile/run with per-case limits; multi-profile quick-login with silent
refresh; i18n (EN / VI / ZH). Errors surface as human text per status —
never a bare code.

## Contract (read-only)

The API surface is read-only from delcc's side — the app never invents
endpoints. The human checklist and its machine mirror live in the maintainer
workspace (private by design); the public canon is the judge's live spec:

- `https://oj.tmathcoding.vn/api/v3/openapi.json` — the judge's own OpenAPI document, public
- `../docs/api-docs.md`, `../tools/openapi-frontend.json` — private mirrors of it (maintainer workspace)
- `../delcc/index.html` — PoC reference (kept, not imported)

## Theming
Unthemed on purpose. `src/app.css` is the guest-themer lane
(Claude Sonnet 5.5) — structure stays, palette is theirs.

## Notices

- **Not TMATH's work.** delcc is an independent community client; "TMATH" and
  the official client belong to their respective owners. delcc ships no official
  code or assets (the API it calls is documented and public).
- **Contests and proctored exams**: do not use delcc in any graded, ranked, or
  proctored contest unless the contest operator explicitly allows third-party
  clients. The official client ships exam-proctoring machinery (clipboard,
  fullscreen, lock); delcc deliberately ships none — read that as a boundary,
  not an invitation.

## License

**PolyForm Noncommercial 1.0.0** (`SPDX: PolyForm-Noncommercial-1.0.0`, full
text in [LICENSE](LICENSE)) — chosen deliberately, not by default:

- **You may**: use it, study it, modify it, redistribute it, run it anywhere —
  for any *non-commercial* purpose. School, club, personal, judge-community
  use: all fine, no permission needed. PolyForm is written for software and
  includes an explicit **patent grant** (the CC license this replaced had none).
- **You may not**: commercialize it (sell it, bundle it into a paid product,
  run it primarily for commercial advantage).
- **Honest difference from the old CC BY-NC-SA 4.0**: PolyForm NC has **no
  ShareAlike clause** — a fork is not forced to publish its changes (it must
  stay non-commercial and carry this license's notices, but it may keep its
  code closed). The non-commercialization constraint — the project's actual
  identity — is unchanged; the forced-openness of forks is a trade documented
  here rather than hidden. If the project ever needs a free-for-noncommercial +
  closed-fork-excluding combination again, the planned revisit is the Fair Core
  License family.
- **Honest framing**: this is *source-available*, not OSI open source — the OSI
  definition forbids field-of-use limits, and the no-commercialization limit is
  the point here.
- **Escape hatch**: copyright remains with the maintainer(s), who may relicense
  future versions; contributions are accepted under the same license.

Required Notice: Copyright afalseskybroken and delcc contributors (https://github.com/afalseskybroken/delcc)

## Versioning (His scheme — LLMs, read this before touching versions)
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

# ARCHITECTURE.md — how delcc is put together, and why

*Người dùng Việt Nam? Xem [ARCHITECTURE.vi.md](ARCHITECTURE.vi.md).*

Read [README.md](../README.md) first (what this is, versioning law), then this,
then [SECURITY.md](SECURITY.md) (the network contract). File paths are relative
to this folder.

## Big picture

A Tauri v2 app: a Rust shell owning a system webview that runs a framework-free
TypeScript frontend. Two processes, one contract between them:

- **Rust side** (`src-tauri/src/`): HTTP proxy (`api_fetch`), the CPH local
  runner (`cph.rs`), font enumeration (`fonts.rs`), URL opening (`open_url`),
  layout selection (`get_layout`). The shell does the talking — see Transport.
- **Frontend** (`src/`): vanilla TS rendered as template strings into the DOM.
  No framework, no router library — hash-based routing in the shell classes.
  Dependencies are deliberately few: monaco (editor), katex (math), dompurify
  (sanitizer), the Tauri api.

Why no framework: the whole UI is a handful of views re-rendered wholesale on
navigation with an explicit dispose chain. That is visible, debuggable, and
relay-friendly (friends/agents can hold the entire file in their head). If you
introduce a framework, you are making a successor pay for your preference —
have a reason written down first.

## Boot modes and the trees

`src/main.ts` selects a layout at boot via `getLayout()`:

- `baseplate` — the original stable tab UI (Phase 0+1 flows).
- `wip` — early home-grid iteration, kept for reference.
- `tmath` — boots `src/tmath/index.ts` → the independent shell class in
  `src/tmath/app.ts`, the layout users run today (parity lane).

Plain-browser mode (`npm run dev`) works for login/lists; anything needing the
shell (headers, CPH, CORS-bypassed calls) requires Tauri. The transport layer
makes this distinction explicit — see below.

## Transport — `src/lib/transport.ts`

The single network choke point (see SECURITY.md for the full surface). Order of
preference:

1. **Rust `api_fetch`** — chosen when a module-level probe finds the Tauri
   bridge (`window.__TAURI_INTERNALS__` present). The probe is a shared
   promise: N concurrent first callers trigger exactly one probe, and its
   result (bridge found / null) is cached for the session. Test coverage:
   `tools/claude11/verify/transport-probe.test.ts`.
2. **WebView `fetch`** — plain-browser fallback.

Why Rust-first: the WebView fetch stack failed with `Failed to fetch` against
the check box while curl sailed through; the shell's reqwest stack does not.
Custom headers (`X-Client-Version`, `X-Device-Id`) ride on every call in the
Tauri build, matching the official client's posture.

## API layer — `src/lib/api.ts`

Typed wrappers over `transport()` for the documented contract
(`../docs/api-docs.md`, machine-readable at `../tools/openapi-frontend.json`).
Conventions:

- **Error model**: every server failure surfaces as human text per status
  (401/403/404/409/422/426/429), never a bare code. `ApiError` carries the code.
- **Client version honesty**: `X-Client-Version` is resolved at boot from the
  judge's own `client-releases/current` feed — delcc reports the newest official
  version so it is never gate-kept as "too old" (426). This is deliberate and
  documented, not a trick.
- The API is JWT bearer; tokens come from `src/lib/auth.ts` (silent refresh 60 s
  before expiry, boot-time refresh, token-change listeners).

## Identity — `src/lib/profiles.ts`, `src/lib/google.ts`

Multi-profile local model: each profile = username + optional stored token /
saved password (vault gap documented in SECURITY.md). Quick-login keeps a
refresh token per profile; a restored session that turns out to belong to a
different account is invalidated on boot (never resume someone else's token).
Google login is server-mediated PKCE: start → browser → poll → account.

**Session merge** (`tmath/app.ts identify()`): `/bootstrap` carries a user
summary; `/me` carries the full detail. They are merged, not replaced, and both
spellings (`gravatar_hash` / `gravatarHash`) are tolerated because the wire
uses snake_case while some surfaces carry camelCase.

**Gravatar rule** (verified live, 2026-10-25 — see
`../research/gravatar-investigation-2026-10-25.md`): the server delivers
`gravatar_hash` **only for the account owner's own self-view and only when that
account has a Gravatar-registered email**; other users' hashes are always null.
Avatars therefore render for *you*, letter-fallback for everyone else — same as
the official client. The avatar component validates `^[a-f0-9]{64}$` at render
time, requests `?s=size*2&d=404&r=g` with `no-referrer`, and hides the image on
error (`d=404` makes the letter fallback work).

## The tmath shell — `src/tmath/app.ts`

One class, hash-routed views (contests / problems / workspace / submissions /
rankings / account / settings), each view = template string + event wiring +
optional disposer:

- `render()` bumps a generation, disposes the previous view, dispatches. Views
  receive `alive()` and must bail if stale.
- `disposeView` is a **chain**: views that spawn sub-views (workspace → solve)
  compose disposers so nothing leaks (the F27 lesson: every interval/observer
  enters the chain the moment it is created).
- Statement rendering: markdown-ish → KaTeX, then DOMPurify; iframes survive
  only for YouTube embed origins. About text: markdown first, sanitize after.
- Editor: monaco, per-language draft autosave with revision gating.
- Submissions/verdict: poll-based (2 s) with a shared verdict mapper
  (`src/lib/verdict.ts`) and the official result-color mapping.
- i18n: three locales (`src/i18n/`, `en-US` / `vi-VN` / `zh-CN`), flat dot-key
  dicts typed by `Dict`; drift lint in `tools/claude11/verify/i18n-lint.mjs`
  (exit 1 + JSON report on key drift).
- Preferences/theme: `src/tmath/preferences.ts`, light/dark/system.

## CPH — the local runner (`src-tauri/src/cph.rs`, UI in `src/tmath/solve.ts`)

Compile-and-run against self-typed test cases, no network, no sandbox (it is
the user's own code at the user's own privilege — stated in the source, not
buried). Key structures:

- **Detect** (`cph_detect`): probes toolchains on PATH; a probe must succeed
  AND print a version (guards against the Windows Store app-execution-alias
  stubs that exit 9009 with a marketing line).
- **One job at a time**: a single `active` slot (`JobGuard`) is what Stop
  addresses; a second job while one runs is refused. `cph_stop` flags the job;
  the runner's poll loop kills the whole process tree within ~15 ms
  (`taskkill /T /F` on Windows, process-group kill on unix).
- **Build cache**: `hash(lang, binary, source)` — unchanged source skips the
  compiler; replaced/failed builds retire their temp dirs on every path.
- **Verdicts**: AC/WA (whitespace-normalized compare), RE, TLE (wall-clock
  poll + tree kill), RAN (no expected output), CANCELLED, MLE only with the
  opt-in `job-mem-cap` feature (Windows Job Object; UNVERIFIED FFI behind a
  feature flag on purpose — see the module comment).
- **Output caps**: 1 MiB/stream; exceeding is an explicit RE, never a clipped WA.

Tests: `tools/claude11/verify/cph_tests.rs` (`mod t` + `mod stop_semantics`,
run via the scratch-crate recipe in the file header) and
`tools/claude11/verify/cph_capture_tests.rs`.

## Data at rest

Everything user-facing is `localStorage` under `delcc-*` keys (profiles, auth,
drafts, preferences, sidebar, subs filters, sort orders). No files, no sqlite.
CPH uses per-run temp dirs. Full inventory and gaps: SECURITY.md.

## Verification gates (the house list)

Run before calling anything done (Pass #38's gate list is the precedent):

1. `npx tsc --noEmit` — 0 errors
2. `node tools/claude11/verify/i18n-lint.mjs src/i18n` — exit 0
3. `npm run build` — tsc + vite, clean (watch for the stale-dist pattern:
   confirm no dev vite running before cargo builds)
4. `cargo build` in `src-tauri/` — **verify the real exit code** (see the
   versioning section's pipe-eaten-exit warning; this cost a night once)
5. `cargo test` via the scratch crate for cph tests (recipe in the test header;
   note the box-environment caveat about g++/python3 documented in the queue)
6. `node tools/claude11/verify/transport-probe.test.ts src/lib/transport.ts`
7. Session integrity: `tools/verify-session-integrity.mjs`

## Methodology (the part worth inheriting)

1. **Contract-first**: the API surface is `../docs/api-docs.md` +
   `../tools/openapi-frontend.json`. delcc implements the contract; it does not
   redefine it. When the contract says a field is optional, the UI says so.
2. **Behavioral parity by observation**: where the official client's behavior
   matters, delcc matches observed behavior and writes the reasoning into the
   code as comments with evidence pointers (offsets, dates, test results), so
   the next person can re-derive it instead of re-litigating it.
3. **The ledger**: every pass logs what/why/hashes/gates in `todo.md`. Distributed
   and relay-driven work stayed coherent because of this. Keep it.
4. **Corrected theories are recorded as corrected** (see the gravatar note's
   "do not re-litigate" section) so successors do not rediscover dead ends.

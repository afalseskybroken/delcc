# SECURITY.md — the honest-client contract

*Người dùng Việt Nam? Xem [SECURITY.vi.md](SECURITY.vi.md).*

delcc's promise is simple: **you can read everything it does.** This file is the
auditable summary. If the code and this file disagree, one of them is a bug —
file it, and fix whichever is wrong.

## The complete network surface (as of 0.2.27-alpha)

| Destination | When | Why |
|---|---|---|
| `oj.tmathcoding.vn/api/v3/*` | all API traffic | the judge itself: auth, contests, problems, submissions, leaderboard, client-release manifest |
| `oj.tmathcoding.vn/<user profile pages>` | only when viewing another user's profile | reads the site's **public** profile page — the exact bytes any anonymous browser gets, CORS-open — to pick up the gravatar hash the site itself publishes there. Validated (the site's empty-string hash placeholder is rejected), cached locally (FIFO-capped); one *successful* GET per user, retried on the next view if it missed. Fetched by the Rust shell (`site_fetch`) — these pages carry no CORS header for the webview. See `src/tmath/avatars.ts` for the honesty notes. |
| `www.gravatar.com/avatar/<sha256>` | only when the server delivers your own gravatar hash (self-view, gravatar-registered account) | your avatar image, requested with `referrerpolicy="no-referrer"`, `d=404` so nothing else is fetched |

What requests themselves carry, disclosed: authenticated calls bear `Authorization: Bearer
<token>`; submit POSTs and problem-detail reads bear `X-Device-Id` (a fresh random identifier
`delcc-…` per app launch, memory-only, derived from nothing — not hardware, not account, never
persisted; the legacy stored key is deleted on load)
and `X-Client-Version`, which reports the newest version from the official release feed rather than
delcc's own — the judge 426-gates older strings, so this shim is load-bearing for any independent
client. Maintainer verdict 2026-10-29: the judge publishes no Terms of Service, and the shim is
disclosed openly (README §Notices, `src/lib/api.ts`) — concealment is what doctrine forbids, not
the shim.

That is all. Concretely absent:

- no analytics, metrics, or usage reporting
- no crash reporting or error upload
- no update auto-download (the release manifest is *read*; binaries are fetched
  by you, the human, from the release page)
- no third-party CDNs, fonts, or scripts — all assets ship in the bundle. About-pane
  markdown may contain remote **images** (profiles decorate their About with them; the
  official client renders them too). Since pass #83 they load through an ISOLATED shell
  fetch, never from the webview: the `asset_fetch` command is https-only, re-validates
  every redirect hop against public hosts, accepts `image/*` content types only, caps
  responses at 2 MiB with a 10 s timeout, and never attaches cookies or tokens — the
  image bytes enter the page as `data:` URLs, so the webview CSP (`img-src`/`connect-src`)
  stays pinned and no third party is contacted by the page itself. The image host sees
  the viewer's IP (identical to the official client). Disclosed limit: a profile author
  could point at a DNS name resolving into a private range (rebinding). Since pass #96
  the hostname is resolved once, every resolved address is verified public, and the client
  is pinned to that address — the connection can only hit the IP that was verified. The
  command carries no credentials and caps the response, so the exposure is one capped-size
  image fetch, never a token; a failed/refused fetch degrades to a plain **link**, and
  images beyond 8 per pane degrade to links too (capped, visibly, per the honesty doctrine). The only
  other image fetches the app makes are the gravatar avatars in the table above
- the CPH local runner (`src-tauri/src/cph.rs`) never touches the network — it
  compiles and runs *your* code on *your* machine, sandbox-free, exactly like
  running it in a terminal

Network code lives in three plainly named places. `src/lib/transport.ts` carries
all API traffic (Rust shell first, WebView `fetch` as fallback). Two deliberate
direct-`fetch` exceptions: `src/lib/verdict.ts` (the submission-result SSE stream)
and `src/tmath/avatars.ts` (the public profile page GET, which goes through the
shell's `site_fetch` command). Auditing the network surface means reading those
three files.

The one read-heavy path is the **problems index**. The Problems page has progress
filters (solved / attempted / untouched), and the public API exposes no per-user
solved state — so on first visit delcc reads the public problem list page by page
(five requests in flight, short-page detection, hard page cap), plus your own
`solved_problems` and your own submissions. That index lives in memory only, is
dropped when delcc closes, and enables the filters once it completes; until then
the filters are visibly disabled with a progress line. No storage key is written.

## Authentication data at rest — the honest picture (as of 0.2.26-alpha)

- Refresh tokens live in the **DPAPI-protected secure store** (pass #78): the Rust
  shell encrypts them with `CryptProtectData` and writes the blob to
  `%APPDATA%\vn.delcc.app\secure\*.bin`. The webview's `localStorage` no longer
  holds tokens; pre-#78 plaintext copies (`delcc-auth`, `delcc-profiles`) migrate
  on first boot and are deleted. Worst case of a failed migration is a one-time
  re-login (failures are logged in Settings → Diagnostics, never silent).
- **DPAPI is not a sandbox.** It is user-scope and machine-bound: malware already
  running as *your* Windows user can decrypt these blobs, exactly like it could
  steal the official client's Credential Manager entry. What the move buys: the
  threat shifts from "read a plaintext file" to "run code as the user" — the same
  boundary every local client (ours and the official one) sits behind. While in
  use, tokens still cross the webview IPC and ride memory as Bearer headers —
  inherent to a webview client, stated here rather than hidden.
- Plain-browser dev (no Tauri shell) keeps plaintext localStorage — that is the
  dev lane, not a shipped posture.
- Optional quick-login may store a password per profile: the vault lane
  (`src/lib/vault.ts`, AES-GCM behind a PBKDF2 lock hash) is unchanged by #78;
  wiring it into the tmath layout stays queued.
- For comparison: the official client persists its refresh token in Windows
  Credential Manager (DPAPI, user scope) and has been observed carrying
  credentials across its IPC surface in plaintext. delcc now matches the at-rest
  posture and discloses the IPC path.

Mitigations available today: profiles can be tokenless (`needsReauth`), the
lock feature gates profile use behind a hash, and signing out deletes the
stored session (secure-store blob and localStorage keys).

## Other data at rest

- drafts/filters/preferences: `localStorage` keys, all prefixed `delcc-`
  (drafts, preferences, sidebar, sort orders, subs filters, the active-profile
  pointer)
- tokens + saved profiles: DPAPI-protected blobs at
  `%APPDATA%\vn.delcc.app\secure\*.bin` (see above)
- CPH build dirs: per-run temp dirs (`delcc-cph-*`), removed on every path;
  cache dir removed on app exit via `cleanup()`
- window identity (pass #106): the custom title and icon data URL live in
  `delcc-window-title` / `delcc-window-icon` in localStorage; the icon never
  leaves the device (canvas → RGBA → the window manager, no network)

## Local process surface (as of 0.3.8-alpha)

Everything that executes a program stays behind the pass-#78 binary allowlist
(`validate_binary`): detector candidates ∪ live-detected toolchains ∪
Settings-registered overrides, per language. Pass #106 adds one new face on
that same posture — the **step-by-step debugger** (`debug_start`/`debug_step`/
`debug_stop`, Shift+Run):

- it compiles your draft with the SAME allowlisted compiler, only with
  `-g -O0`, into a per-session temp dir that dies with the session;
- the debugger binary (gdb) is chosen Rust-side — the compiler's sibling
  directory, then PATH — and gated at gdb ≥ 8 (7.6.1 probed broken on file
  redirection); the webview cannot nominate a debugger path;
- gdb executes only the binary delcc just compiled (same blast radius as a
  normal run); the whole gdb+inferior tree runs under a KILL_ON_JOB_CLOSE Job
  Object and `taskkill /T /F` on stop;
- a debug session holds the single Job slot, so no second compile/run can
  start under it; session stdin/stdout are files in the session temp dir;
- the version-tap and window-identity features open only the GitHub Releases
  page through `open_url` (github.com was already on the allowlist).

CSP note discovered by the boot-gate pass (#106): DOMPurify's DOMParser
fallback parses hostile HTML via `innerHTML` on an inert implementation
document, which Chromium reports as `script-src-attr` violations — the CSP
BLOCKS those never-executed attributes (parse-only; sanitization completes
and the execute-vectors stay dead). The statement browser test tolerates
exactly that fingerprint and fails on anything else.

## Reporting

Report at **https://github.com/afalseskybroken/delcc/issues** — for anything
sensitive, mark it private via the issue form or open a minimal public issue
first and ask for a private channel. The fastest self-audit remains
`git grep fetch` plus reading `src/lib/transport.ts`.

## Non-negotiables (repeated from SUCCESSION.md because they belong here too)

1. The network surface above is closed. Any change adding a call updates this
   file in the same commit.
2. No undocumented behavior: nothing ships that a source reader cannot see.
3. Gaps are documented, never hidden.

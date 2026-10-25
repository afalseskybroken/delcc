# SECURITY.md — the honest-client contract

*Người dùng Việt Nam? Xem [SECURITY.vi.md](SECURITY.vi.md).*

delcc's promise is simple: **you can read everything it does.** This file is the
auditable summary. If the code and this file disagree, one of them is a bug —
file it, and fix whichever is wrong.

## The complete network surface (as of 0.2.1-alpha)

| Destination | When | Why |
|---|---|---|
| `oj.tmathcoding.vn/api/v3/*` | all API traffic | the judge itself: auth, contests, problems, submissions, leaderboard, client-release manifest |
| `www.gravatar.com/avatar/<sha256>` | only when the server delivers your own gravatar hash (self-view, gravatar-registered account) | your avatar image, requested with `referrerpolicy="no-referrer"`, `d=404` so nothing else is fetched |

That is all. Concretely absent:

- no analytics, metrics, or usage reporting
- no crash reporting or error upload
- no update auto-download (the release manifest is *read*; binaries are fetched
  by you, the human, from the release page)
- no third-party CDNs, fonts, or scripts — all assets ship in the bundle
- the CPH local runner (`src-tauri/src/cph.rs`) never touches the network — it
  compiles and runs *your* code on *your* machine, sandbox-free, exactly like
  running it in a terminal

Single choke point: `src/lib/transport.ts`. Every HTTP request goes through
`transport()` (Rust shell first, WebView `fetch` as fallback). Auditing the
network surface means reading one file.

## Authentication data at rest — known gaps, stated plainly

- Refresh tokens live in the webview's `localStorage` (`delcc-profiles`,
  `delcc-auth`). On Windows the WebView profile is at
  `%LOCALAPPDATA%\vn.delcc.app\`. That is **plaintext at rest** on the host.
- Optional quick-login may store a password per profile. There is a vault lane
  (`src/lib/vault.ts`, design staged in `docs/passkeys-design.md`) intended to
  replace plaintext storage; until it ships, the gap is real.
- For comparison: the official client persists its refresh token in Windows
  Credential Manager (DPAPI, user scope) and has been observed carrying
  credentials across its IPC surface in plaintext. delcc's stance: document what
  we store, ship the vault lane before claiming otherwise, never pretend the
  gap does not exist.

Mitigations available today: profiles can be tokenless (`needsReauth`), the
lock feature gates profile use behind a hash, and signing out deletes the
stored session. Machine-level encryption (DPAPI) for the token store is the
next planned step — see the vault lane.

## Other data at rest

- drafts/filters/preferences: `localStorage` keys, all prefixed `delcc-`
  (profiles, auth, drafts, preferences, sidebar, sort orders, subs filters)
- CPH build dirs: per-run temp dirs (`delcc-cph-*`), removed on every path;
  cache dir removed on app exit via `cleanup()`

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

# SECURITY.md — the honest-client contract

*Người dùng Việt Nam? Xem [SECURITY.vi.md](SECURITY.vi.md).*

delcc's promise is simple: **you can read everything it does.** This file is the
auditable summary. If the code and this file disagree, one of them is a bug —
file it, and fix whichever is wrong.

## The complete network surface (as of 0.3.49-alpha)

| Destination | When | Why |
|---|---|---|
| `oj.tmathcoding.vn/api/v3/*` | all API traffic | the judge itself: auth, contests, problems, submissions, leaderboard, client-release manifest |
| `oj.tmathcoding.vn/api/v3/submissions/stream` and `oj.tmathcoding.vn/api/v3/participations/<id>/submissions/stream` (SSE) | while the Submissions view is open — the public feed, or a contest you participate in | a long-lived authenticated Server-Sent Events connection used as a **bell**: any non-ready event triggers a refresh through the documented REST list call, and the stream payload itself is never trusted as data (pass #164). Opened by the Rust shell commands `submission_stream_start` / `submission_stream_stop` (EventSource cannot carry a Bearer header and `api_fetch` buffers whole bodies); a browser-dev fallback reads the same wire via `fetch` + ReadableStream (`src/lib/substream.ts`). Carries `Authorization: Bearer <token>`. The path is pinned to exactly these two shapes with a non-empty digit-only id and a 256-byte cap. Bounded: at most **4 concurrent streams** (a slot is reserved atomically under the registry lock before the connect), 64 KiB lines / 256 KiB frames / 64 lines per frame, a 90 s idle watchdog, and the pump ends when the page drops the channel (pass #168, wave-11 N1–N4). |
| `oj.tmathcoding.vn/api/v3/client-releases/downloads` POST | only when you click the update banner's "open official installer" button | the official feed's own download counter — the same call the official client makes; carries the channel, platform and release id, nothing about you |
| `oj.tmathcoding.vn/<user profile pages>` | only when viewing another user's profile | reads the site's **public** profile page — the exact bytes any anonymous browser gets, CORS-open — to pick up the gravatar hash the site itself publishes there. Validated (the site's empty-string hash placeholder is rejected), cached locally (FIFO-capped); one *successful* GET per user, retried on the next view if it missed. Fetched by the Rust shell (`site_fetch`) — these pages carry no CORS header for the webview. See `src/tmath/avatars.ts` for the honesty notes. |
| `api.github.com/repos/afalseskybroken/delcc/releases?per_page=1` | once per boot (pass #134, the footnote update dot) | a READ-ONLY check whether a newer delcc release exists — the dot in the sidebar footnote (green [Up to date] / red [Update available], click opens the releases page). The judge's client-releases feed cannot answer this (delcc adopts whatever client version that feed demands, by the shim above, so it is always "in sync" by construction). Carries no tokens or cookies; `Accept: application/vnd.github+json` + the delcc user agent; 10 s timeout; the same 8 MiB body cap as every other byte path; the URL is pinned to exactly one host:path inside the `update_check` command — webview content cannot aim it elsewhere; a failure leaves a neutral grey dot (no evidence, no claim) |
| `www.gravatar.com/avatar/<sha256>` | whenever a gravatar hash is in play: your own (the server delivers it on self-view) AND other users' — hashes harvested from their public profile pages via the `site_fetch` row above, and from public list responses | avatar images, requested with `referrerpolicy="no-referrer"`, `d=404` so nothing else is fetched |
| `www.youtube-nocookie.com/embed/<id>` (+ `www.youtube.com/embed/<id>`) | only when a profile's About markdown embeds a YouTube video (the official client renders the same embeds) | an iframe the sanitizer keeps ONLY for these two origins (scheme+host+path shape-checked); the shipped CSP `frame-src` pins the same two hosts — the page cannot frame anything else |

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

- no analytics, metrics, or usage reporting — with the single exception in the table
  above: the release feed's own download counter, fired only by your click on the
  banner's installer button (added to this table in pass #123; before that the call
  existed in code without a row here, which was exactly the disagreement this file's
  opening rule exists to catch)
- no crash reporting or error upload
- no update auto-download (the release manifest is *read*; binaries are fetched
  by you, the human, from the release page)
- no third-party CDNs, fonts, or scripts — all assets ship in the bundle. About-pane
  markdown may contain remote **images** (profiles decorate their About with them; the
  official client renders them too). Since pass #83 they load through an ISOLATED shell
  fetch, never from the webview: the `asset_fetch` command is https-only, validates the
  ORIGINAL host by resolution (every resolved address public, the client pinned to it),
  and drives every redirect hop through the exact same resolve → verify-all-addresses
  → pin procedure as the original host (automatic redirect-following is OFF; the fetch
  loop re-validates EACH hop since pass #142 — the old string-check-only residual is
  closed). It
  accepts `image/*` content types only, caps responses at 2 MiB — enforced while
  STREAMING since pass #141 (the body is rejected at the cap instead of being fully
  buffered first) — with a 10 s timeout, and never attaches cookies or tokens — the
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
  compiles and runs *your* code on *your* machine. pass #144 (W8-L18) states a
  platform boundary plainly: the native confirm-once dialogs (planted toolchains,
  PATH debuggers) are a WINDOWS mechanism — on a non-Windows development build
  there is no dialog to host, both gates answer true, and the consent records
  never engage. The shipped and documented target is Windows (DPAPI, Job Objects,
  the native MessageBoxW); a non-Windows build's consent boundaries are exactly
  the ones the page could have anyway
- **Pass #159/#160 — the run-path sandbox (amended pass #163, wave-12 W12-01/02/08)**:
  the RUN of untrusted contest code executes under a RESTRICTED token via delcc's
  own launcher — the intermediate lowers its OWN token (every privilege disabled,
  the Administrators group deny-only, the NETWORK group deny-only best-effort, the
  integrity level LOW) and the session temp directory is labeled LOW (the sandboxed
  child's only writable corner). It is FAIL-CLOSED: a self-restriction failure
  refuses the run (the launcher exits 3 with the reason on stderr) — there is NO
  plain-spawn fallback. The COMPILE step (trusted, allowlisted toolchains) and the
  debug lane are NOT launcher-wrapped; they run at the caller's medium integrity,
  the historical posture. Pass #166 (wave-10 S1) states the consequence plainly: the
  debug lane (`debug_start`) is an **unsandboxed execution path reachable by the page
  at the user's full rights** — it compiles and runs the debuggee unwrapped. The
  restricted-token sandbox is therefore **Run-only defense-in-depth, NOT a
  page-compromise boundary**: a compromised page does not need to defeat it, because
  it can simply ask for the debug lane instead. The page boundary (CSP, the
  sanitizers, the boot gate) remains the real wall. Pass #163 restored this
  boundary: #159–#161 had
  inadvertently wrapped the compile step too, which broke C++/Rust compilation — a
  LOW-integrity compiler cannot write its intermediate temp files to the user's
  MEDIUM-integrity `%TEMP%` (Windows MIC no-write-up). Residuals, disclosed: the
  NETWORK group deny is best-effort (an interactive logon token usually does not
  carry S-1-5-2) and covers authenticated connections only — LOW integrity does NOT
  block outbound calls at the user's rights; the run response carries a `sandboxed`
  flag (true when every case ran wrapped with its temp corner labeled) for
  diagnostics, but the current UI does not surface it as a visible badge.

Network code lives in four plainly named places. `src/lib/transport.ts` carries
all API traffic (Rust shell first, WebView `fetch` as fallback). Two deliberate
direct-`fetch` exceptions: `src/lib/verdict.ts` (the single-submission verdict SSE
stream) and `src/tmath/avatars.ts` (the public profile page GET, which goes through
the shell's `site_fetch` command). The fourth is `src/lib/substream.ts` (pass #164):
the submission-LIST SSE streams, opened by the Rust shell commands
`submission_stream_start` / `submission_stream_stop` (browser-dev `fetch` fallback),
disclosed in the table above. Auditing the network surface means reading those four
files plus the two stream commands in `src-tauri/src/main.rs`.

Path guards (pass #163, wave-12 W12-24/25): `api_fetch`/`site_fetch` reject a path that
is not leading-`/`, contains a literal `..`, or whose canonicalized form
(`reqwest::Url::parse`, which normalizes single-encoded `%2e%2e` dot-segments) leaves
`/api/v3`. Redirects are re-checked for scheme+host every hop (the pinned judge), so a
same-host redirect stays inside the trusted origin — the path is not re-scoped per hop,
but the judge redirecting itself is within the trust boundary, not a cross-origin escape.
Residual (W12-25, hypothesis): a DOUBLE-encoded `%252e%252e` survives canonicalization (the
parser decodes `%25`→`%` once and does not re-scan) and passes the client guards; escaping
`/api/v3` would then require the SERVER to double-decode the path. The judge (Django/DRF
over WSGI) decodes once, so this is not reachable against it — disclosed, not a live hole.

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

## Local process surface (as of 0.3.49-alpha)

Everything that executes a program stays behind the pass-#78 binary allowlist
(`validate_binary`): detector candidates ∪ live-detected toolchains ∪
Settings-registered overrides, per language. Pass #106 adds one new face on
that same posture — the **step-by-step debugger** (`debug_start`/`debug_step`/
`debug_stop`, Shift+Run — pass #124 adds Ctrl+Run with the Run label mutating
while Ctrl is held):

- the compiled family (C/C++, Rust, Go, Pascal) compiles your draft with the
  SAME allowlisted compiler, only with debug info (`-g -O0`, `-g`,
  `-gcflags=all=-N -l`, `-g` respectively), into a per-session temp dir that
  dies with the session;
- the debugger binary (gdb) is chosen Rust-side — the compiler's sibling
  directory, then PATH — and gated at gdb ≥ 8 (7.6.1 probed broken on file
  redirection); the webview cannot nominate a debugger path; since #123 the
  session spawns gdb with `-nx` (no init-file injection path);
- gdb executes only the binary delcc just compiled — but that debuggee runs at the
  user's FULL rights (unsandboxed), UNLIKE the sandboxed Run, so its blast radius is
  LARGER than a sandboxed run, not equal to it (pass #166, wave-10 S1: the old "same
  blast radius as a normal run" wording predated the #159 Run sandbox and is no longer
  true); the whole gdb+inferior tree runs under a KILL_ON_JOB_CLOSE Job
  Object and `taskkill /T /F` on stop;
- **Python (pass #124)** runs on its own lane: delcc generates a wrapper script
  in the session temp dir that runs the draft under `pdb` with three separated
  streams — the debuggee's stdin is swapped to the case file (`input()` reads
  the case, never the command pipe), the program's stdout goes to the session
  output file, and pdb's protocol stream rides stderr where it is parsed
  Rust-side. The fixed command set is n/s/r/c plus one locals query per stop —
  no raw passthrough, the same promise the gdb lane makes. The only binary
  executed is the allowlisted Python itself; the wrapper is data, not code we
  ship;
- **Java and JavaScript are NOT wired yet** (pass #124): the honest error names
  the queue (jdb lane / inspector CDP lane). Nothing pretends.
- a debug session holds the single Job slot, so no second compile/run can
  start under it; session stdin/stdout are files in the session temp dir;
- process-tree kills spawn the SYSTEM `taskkill.exe` by absolute path (pass
  #154): Rust's Windows executable lookup starts in the app's own directory, so
  a planted `taskkill.exe` beside `delcc.exe` could otherwise win. System32 is
  resolved from `SystemRoot`; the bare name is only a fallback.
- the version-tap and window-identity features open only the GitHub Releases
  page through `open_url` (github.com was already on the allowlist).

### Toolchain & debugger consent — disclosed residuals (pass #163, wave-12)

The confirm-once consent model (planted toolchains, PATH debuggers, Settings
overrides) is a **trust-on-first-use, path-string** model. Its limits, stated plainly:

- **Consent rides the path, not the file (W12-15).** Acceptances and refusals are
  recorded by path string in the shared `confirmed_fixed` / `refused_fixed` sets, used
  for BOTH the compiler and the debugger (`consent_debugger`). No file identity (hash,
  size+mtime, or signer) is pinned. Two consequences: a confirmed file can be **swapped**
  (same path, new bytes) and run without re-asking; and a path confirmed as a *compiler*
  is auto-accepted as a *debugger*. The boundary this sits behind: a local attacker who
  can rewrite a confirmed toolchain already has write access to your toolchain directory
  — the same boundary every local client (ours and the official one) sits behind.
  Content pinning is queued.
- **Symlink following in the user-trusted class (W12-13).** The C5 reparse-point refusal
  (`symlink_metadata`, never follow a symlink) covers the attacker-plantable discovery
  roots: the fixed-root glob, the VS Code extension scan, `walk_find`, the Java sibling
  *detection*, and fpc. It deliberately does NOT cover `resolve_in_path` (PATH
  resolution), the Settings-override `is_file` check, the run-lane Java sibling, or
  `find_gdb` — those follow symlinks because legitimate PATH entries (`python3` →
  `python3.12`) and user-registered overrides ARE symlinks; refusing them would break
  detection and the #163 execution pinning. A symlink planted in a PATH directory or
  registered as an override can therefore redirect to another executable; both are
  user-controlled inputs, not attacker-plantable fixed roots.
- **Dialog coalescing and cooldown (W12-14).** Detection serializes on one async gate
  (`detect_gate`) held across the planted-candidate dialog — deliberate coalescing so
  concurrent detections never double-ask or spawn-storm; a slow answer blocks other
  detections until it lands. The page-driven Settings-override dialog (`cph_set_override`)
  is rate-bounded by an in-memory cooldown (2 s global, 5 s per-path, at most 128 tracked
  paths, oldest evicted) so the page cannot open one modal per call. The cooldown is
  forgotten on restart; the consent is not. Override refusal is intentionally NOT sticky
  — re-registering the override is the user's change-of-mind escape (a planted-candidate
  refusal IS sticky).
- **Debugger event queue (W12-19).** The per-session gdb event queue is bounded at 512
  records, drop-oldest — a COUNT cap (each record ≤ the 256 KiB line cap, so ~128 MiB
  worst case under a malfunctioning approved debugger). Pass #163 fixed the desync:
  `wait_stopped` now drains to the next `*stopped`, skipping the `=thread-*` /
  `=library-loaded` / `*running` notifications `transact` queues, instead of handing
  `snapshot` the first record of any kind. Residual: a >512-event flood inside one
  transaction could still evict the `*stopped` before it is consumed; the wait then times
  out honestly (a failed step, not a desync). A byte-budget queue is queued. The threat
  model throughout is an already-approved debugger — trusted to run your code.

CSP note discovered by the boot-gate pass (#106): DOMPurify's DOMParser
fallback parses hostile HTML via `innerHTML` on an inert implementation
document, which Chromium reports as `script-src-attr` violations — the CSP
BLOCKS those never-executed attributes (parse-only; sanitization completes
and the execute-vectors stay dead). The statement browser test tolerates
exactly that fingerprint and fails on anything else.

Third-party graph stack (#109, reworked by #111): the tools panel’s graph tab runs
[Another Graph Editor](https://github.com/anAcc22/another_graph_editor) (MIT) — the same
app the official client’s graph tool loads — vendored as REACT SOURCE under
`src/vendor/age/` (the original #109 shape was an offline iframe over a built artifact
under `public/age/`; #111 retired the iframe and the standalone app shell and the tools
panel now lazily imports the vendored source, mounted client-side — no cross-origin
frame). Its only runtime fetches are the canvas fonts served same-origin from
`public/age/`; nothing else leaves the machine. The remaining `frame-src 'self' …`
grants in the CSP serve the statement pane’s YouTube embeds, not the graph stack.
Licenses and the vendoring recipe are recorded in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Sketch tab (#112): Excalidraw 0.18.1 (MIT) renders as a lazy React component in the
tools panel, and the scene persists locally in the delcc-sketch-scene localStorage key.
Fonts, precisely (reconciled in pass #164, wave-11 W11-L18): the app points
`EXCALIDRAW_ASSET_PATH` at its own same-origin copy — the five core families the
canvas uses (Excalifont, Nunito, Liberation, Cascadia, ComicShanns; 0.3 MB under
`public/excalidraw/fonts/`), served from `self` under the CSP's `font-src 'self' data:`.
Excalidraw's loader keeps a hard-coded esm.sh CDN fallback AFTER the configured paths;
the shipped CSP refuses that origin, so a skipped family's subsets (Xiaolai CJK,
Virgil, Lilita — 13+ MB, deliberately not shipped) fall to SYSTEM fonts, honestly.
Disclosed dev-only leak: plain-browser development has no CSP, so those skipped
families may fetch from esm.sh during sketch use in `vite dev` — never in the shipped
app. The claim "no CDN in the shipped app" holds; "no CDN anywhere" did not, and this
paragraph is the correction. License hygiene (pass #170): the five shipped families
carry their authoritative license texts IN the bundle — `public/excalidraw/fonts/LICENSE-*.txt`
(OFL-1.1 for Excalifont/Cascadia/Liberation/Nunito with the copyright lines extracted from
the font files' own name tables; MIT for ComicShanns with the complete embedded copyright
set, including Excalidraw's modifier chain). See also docs/THIRD-PARTY-NOTICES.md.

## Dependency advisories (as of 0.3.20-alpha)

Pass #117 closes the first RustSec sweep the tree has ever had (cargo-audit 0.22.2,
1,395 advisories, run 2026-11-01): `rustls-webpki` 0.103.15 → 0.103.16
(RUSTSEC-2026-0382 — certificate verification could accept distrusted intermediates)
and `webpki-root-certs` 1.0.9 → 1.0.11 (RUSTSEC-2026-0383 — bundled roots trusted
distrusted emSign intermediates). Both sit on delcc's TLS verification path for every
HTTPS call the shell makes (`reqwest` → `rustls`), so the fix ships in the binary,
not just the lockfile — verified with `cargo tree`. The npm dev-chain advisory found
in the same sweep (vite `server.fs.deny` bypass, GHSA-8g5g-mxqh-grgj, moderate) is
dev-server-only and was bumped in the same pass (6.4.5). The sweep tooling is kept
for reuse so future passes can re-run it; production npm gates remain the CI audit.

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

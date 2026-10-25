# delcc-app — tree bug audit

Audit completed: **2026-10-24, Asia/Bangkok**. Review began on 2026-10-23 and resumed against the current working files.

**42 findings, plus one security follow-up requiring runtime confirmation. No fixes applied.** This Markdown report is the only file created by the audit. Source, configuration, tests, return bundles, and build artifacts were not edited.

## Scope and evidence

“Whole tree” means the maintained delcc-app project root: all application personas, shared libraries, native backend, localization, styles, build configuration, and project tools/tests. The parent directory's checked-in OpenAPI contract was read only to resolve endpoint questions. No credentials, user profiles, or live account data were used.

This is a source audit with selected offline reproductions, not a claim that every possible defect has been found. Generated dist files, Rust targets, dependency implementations, font/image binaries, and archived payloads were not treated as maintained application source. Relevant dependency behavior and historical tool payloads were inspected where needed. Historical patch scripts received targeted replay review, not exhaustive execution.

Evidence labels:

- **R — reproduced offline:** current source functions/modules were transpiled or extracted in memory and exercised with synthetic dependencies. Filesystem and HTTP effects were mocked. These are not full browser/native integration tests.
- **S — source-confirmed:** the faulty branch, ownership, selector, or contract is visible in current code; the described full runtime scenario was not executed.
- **H — follow-up:** a risky behavior is established, but its practical security impact needs additional evidence.

Priorities:

- **P1:** address first: session/account integrity, wrong-context operations, injection, native resource exhaustion, or destructive tooling.
- **P2:** functional correctness, persistence, lifecycle, or verification defects.
- **P3:** narrower display or round-trip defects.

P1 does not imply that exploitation against a deployed system was demonstrated.

## Finding index

| ID | Priority | Evidence | Finding |
|---|---|---|---|
| F01 | P1 | R | Refresh completion overwrites a newer session or resurrects logout |
| F02 | P1 | R | A 401 retry can replay a mutation under another account |
| F03 | P1 | S | WIP login UI removes a profile lock without verification |
| F04 | P1 | R | Problem I/O metadata enters HTML unescaped |
| F05 | P1 | S | Surviving descendants can wedge CPH after the parent exits |
| F06 | P1 | S | CPH captures unbounded output in the desktop process |
| F07 | P1 | R | Bundle extraction can delete outside its return directory |
| F08 | P1 | R | Bundle paths escape extraction and bypass zone checks |
| F09 | P1 | R/S | Baseplate/WIP problem and contest operations lose context ownership |
| F10 | P2 | S | Temporary refresh failures erase valid session credentials |
| F11 | P2 | R | Google cancellation is ignored across request awaits |
| F12 | P2 | R | TMATH boot refresh leaves the saved profile token stale |
| F13 | P2 | R | Public search changes are dropped while a request is pending |
| F14 | P2 | R/S | Old list responses overwrite newer pages and filters |
| F15 | P2 | R | Baseplate/WIP CPH completions attach to a different problem |
| F16 | P2 | R | Case imports double-count additions against capacity |
| F17 | P2 | R | Case import dereferences a cleared event target |
| F18 | P2 | R/S | Pending case imports commit after disposal without revision tracking |
| F19 | P2 | R | Unchecked expected output becomes editable and scored |
| F20 | P2 | R | Switching the case picker loses detailed run results |
| F21 | P2 | S | Monaco toolbar stays disabled after successful mounting |
| F22 | P2 | S | Compile completion erases the stale-result indication |
| F23 | P2 | R/S | Installed font selections are overwritten on subsequent changes |
| F24 | P2 | R | Malformed math can block the UI before limits are checked |
| F25 | P2 | S | TMATH page-title refresh buttons have no handler |
| F26 | P2 | R/S | Contest deduplication prematurely disables pagination |
| F27 | P2 | S | Workspace countdown intervals are never disposed |
| F28 | P2 | R | Baseplate/WIP misses inline math preceding display math |
| F29 | P2 | R | Explicit iframe Markdown embeds never match after escaping |
| F30 | P2 | R/S | Output clipping changes correct CPH verdicts into WA |
| F31 | P2 | R/S | Expected-output normalization strips leading spaces asymmetrically |
| F32 | P2 | S | Toolchain detection has no deadline or cancellation |
| F33 | P2 | R/S | Exporter duplicates single-file basenames into directories |
| F34 | P2 | R | Bundle parser truncates nested fenced Markdown |
| F35 | P2 | R | E2E reports success without a terminal verdict |
| F36 | P2 | S | Contest E2E polls a source endpoint for verdicts |
| F37 | P2 | S | Solve browser tests no longer match tabs and confirmation flow |
| F38 | P2 | S | Statement browser fixture is installed behind Vite fallback |
| F39 | P2 | R | Replaying fixpass-n16 duplicates the hover overlay |
| F40 | P3 | R | Export/import drops valid empty-stdin cases |
| F41 | P3 | S | Workspace countdown label always remains “unknown” |
| F42 | P2 | S | Baseplate/WIP update banner ignores hidden/dismissed state |

## Session and account integrity

### F01 — Refresh completion crosses session boundaries

**Location:** [auth.ts:53](../src/lib/auth.ts#L53), with session replacement at [auth.ts:48](../src/lib/auth.ts#L48) and logout at [auth.ts:66](../src/lib/auth.ts#L66).

Start a refresh for account A, then log out or seed account B before the response completes. The old promise unconditionally saves its result; its catch unconditionally saves null. The global pending-refresh promise also allows B to join A's refresh.

**Observed:** late success restored A after logout and replaced B with A; late failure cleared B. All tokens were synthetic.

**Bugfix path:** introduce a session generation; bind refresh/login commits and refresh deduplication to it. Invalidate it on replacement/logout. An old promise's cleanup must not clear a newer pending refresh.

**Regression:** deferred success/failure after logout and account switch; assert no stale token is published to storage or listeners and B starts its own refresh.

### F02 — A 401 retry can submit as a different account

**Location:** [api.ts:148](../src/lib/api.ts#L148), [auth.ts:64](../src/lib/auth.ts#L64).

An A-authenticated request returns 401 after the user has switched to B. The parameterless refresh hook refreshes the current session, then replays the original method/body using that token.

**Observed:** the actual submit wrapper sent the same synthetic body first with Bearer A-access and then Bearer B-access. Fixing F01 alone does not prevent this independent replay path.

**Bugfix path:** associate authenticated requests with the originating session generation and refuse refresh/replay after an account change. Allow legitimate same-session token rotation.

**Regression:** delayed 401 after switching accounts must not produce a second POST; same-session expiry should refresh/retry exactly once.

### F03 — WIP profile lock can be removed from the login screen

**Location:** [main.ts:802](../src/main.ts#L802), especially [main.ts:823](../src/main.ts#L823); resume paths at [main.ts:785](../src/main.ts#L785) and [main.ts:798](../src/main.ts#L798).

For an existing locked profile, the lock button clears locked, lockHash, and savedPwEnc without verifying the lock password. It retains the stored token. Selecting the now-unlocked profile again or reopening the application can resume that token.

**Impact:** bypasses the project's stated local UI lock without editing localStorage. This is separate from the deliberate decision to store tokens locally; no claim of OS-level protection is implied.

**Bugfix path:** verify the existing lock password before clearing it. A lost-password reset should require account authentication and discard the old stored session.

**Regression:** a locked profile with a valid token cannot be resumed by toggling its lock, switching profiles, or restarting without verification.

### F10 — Temporary refresh failures erase credentials

**Location:** [auth.ts:58](../src/lib/auth.ts#L58).

The refresh catch deletes the session for every error, including offline transport, timeout, rate limiting, or server failure. A boot restore or scheduled refresh can therefore force reauthentication even though the refresh credential has not been rejected.

**Bugfix path:** distinguish definitive invalid-refresh responses from transient failures using the documented contract. Retain credentials on temporary errors and use bounded retry/backoff, together with F01's generation guard.

**Regression:** network rejection, 429, and 503 retain the originating session; an explicit invalid-refresh response clears it; logout cancels retries.

### F11 — Google cancellation is ignored after awaited requests

**Location:** [google.ts:35](../src/lib/google.ts#L35), [google.ts:48](../src/lib/google.ts#L48), [main.ts:588](../src/main.ts#L588).

Cancelling during googleStart still permits its later response to call onUrl. Cancelling during googleExchange still permits a returned token. Baseplate/WIP seeds that token and finishes login without a final abort check. TMATH already checks before seeding, but its URL callback remains exposed to the first race.

**Observed:** cancellation during start produced one URL callback; cancellation during exchange returned a token.

**Bugfix path:** check cancellation before work and after every await, before callbacks or token publication; retain caller-side checks before seeding.

**Regression:** abort at PKCE/start/sleep/exchange boundaries; no post-cancel browser opening or session mutation.

### F12 — Boot rotation misses the saved profile

**Location:** [app.ts:85](../src/tmath/app.ts#L85), [app.ts:111](../src/tmath/app.ts#L111).

The token listener persists rotation only when this.user.username matches the active profile. Boot refresh happens while this.user is null; identify follows it. The current auth token rotates, but the saved profile retains its old token.

**Observed:** exercising the actual start method with synthetic dependencies produced zero profile writes and retained the old refresh token.

**Impact:** returning to a profile-resume path can seed a stale refresh token. Forced reauthentication depends on server rotation invalidating the old token, as documented in auth.ts; live rotation was not tested.

**Bugfix path:** establish and validate the session's profile ownership before refresh, or persist the rotated token after identity is verified.

**Regression:** boot with a saved profile, rotate once, reopen through WIP, and verify the new token is used without assigning tokens to another profile.

## Native runner and input boundaries

### F04 — Problem I/O metadata is interpolated as markup

**Location:** [solve.ts:337](../src/tmath/solve.ts#L337), consumed at [solve.ts:359](../src/tmath/solve.ts#L359).

ioCell returns API-provided input/output strings unescaped in both file-method and methodless branches. They are inserted into host.innerHTML outside the sanitized statement renderer.

**Observed:** a harmless marker was returned as File: <b id="audit-marker">file.in</b>, without escaping. This confirms markup injection. Script execution and an attacker's ability to author this API metadata were not exercised. [tauri.conf.json:22](../src-tauri/tauri.conf.json#L22) supplies no CSP mitigation.

**Bugfix path:** escape every metadata value at the HTML boundary, or create text nodes.

**Regression:** filenames containing angle brackets, quotes, ampersands, and harmless markup remain literal text; no injected elements or event attributes.

### F05 — CPH can hang after a parent process exits

**Location:** [cph.rs:442](../src-tauri/src/cph.rs#L442), especially PID reset and joins at [cph.rs:462](../src-tauri/src/cph.rs#L462).

Direct-child exit ends the deadline/cancel loop. The code clears the PID and joins stdin/stdout/stderr threads without a deadline. A surviving descendant holding inherited pipes prevents EOF. Stop no longer has a polled cancellation path. The optional Windows Job handle is dropped only after those joins, too late to terminate the descendant.

**Bugfix path:** coordinate process-tree and pipe lifetime; enforce bounded drain/cancellation after direct-child exit and terminate remaining descendants before blocking joins.

**Regression:** a controlled child spawns a bounded descendant holding output pipes, then exits. Completion and Stop must remain bounded and release the active-job slot, with and without job-mem-cap.

**Limit:** native process scenario reviewed statically, not executed.

### F06 — LOG_CAP does not bound host memory

**Location:** [cph.rs:428](../src-tauri/src/cph.rs#L428), [cph.rs:386](../src-tauri/src/cph.rs#L386).

Both output-reader threads use read_to_end into growing vectors. Clipping occurs only after capture finishes. A program or compiler emitting output quickly can exhaust the desktop process's memory before timeout. A child-process memory cap does not bound these host allocations.

**Bugfix path:** continuously drain output with a bounded retained buffer or enforce an explicit output limit and cancel the process tree. Keep verdict data separate from display clipping.

**Regression:** large stdout and stderr must not cause unbounded retained memory or blocked pipes; preserve cancellation and a truthful output-limit result.

**Limit:** no noisy native process was launched.

### F30 — Presentation clipping corrupts verdict comparison

**Location:** [cph.rs:494](../src-tauri/src/cph.rs#L494), [cph.rs:719](../src-tauri/src/cph.rs#L719).

run_one clips stdout to LOG_CAP and adds a truncation annotation before the judge compares it with expected output. Identical output beyond 65,536 bytes therefore becomes WA.

**Observed:** pure evaluation with identical 65,537-byte expected/actual strings produced unequal normalized comparison inputs.

**Bugfix path:** compare bounded complete or streamed output before presentation clipping, or explicitly return an output-limit result. Coordinate with F06 rather than retaining unlimited output.

**Regression:** exact matches and differences before/after the clipping boundary; include a multibyte UTF-8 boundary.

### F31 — Leading whitespace is normalized inconsistently

**Location:** [cph.rs:717](../src-tauri/src/cph.rs#L717), [cph.rs:631](../src-tauri/src/cph.rs#L631).

Expected output passes through str::trim before normalize, while stdout only gets trailing-whitespace normalization. Identical values beginning with spaces can be judged WA.

**Observed:** identical “  answer” expected/actual strings compare differently.

**Bugfix path:** use trim only to detect the existing blank/unscored convention; compare original expected text and stdout with the same normalization.

**Regression:** leading spaces/tabs, trailing spaces, CRLF/LF, and the documented blank-expected behavior.

### F32 — Toolchain detection can wait forever

**Location:** [cph.rs:256](../src-tauri/src/cph.rs#L256).

Version probes call Command.output without timeout, capture bound, or cancellation. Probes are sequential, so one hanging executable prevents later toolchains from being reported. The active-run Stop mechanism does not own these probes.

**Bugfix path:** apply bounded capture and termination per probe; continue to other candidates after a timeout/failure.

**Regression:** a controlled hanging version probe followed by a working candidate; detection returns within its budget and reports the working toolchain.

**Limit:** native probe fixture not executed.

## Baseplate/WIP state ownership

### F09 — Old problem/contest operations overwrite the current context

**Location:** [main.ts:1118](../src/main.ts#L1118), [main.ts:616](../src/main.ts#L616), [main.ts:1183](../src/main.ts#L1183), [main.ts:1230](../src/main.ts#L1230).

openProblem assigns S.problem before awaiting detail, then commits statement/editor/CPH state without checking whether another problem was selected. openContest similarly commits participation and problem rows after newer selections. Submit uses the current global S.problem/S.contest, not the context that produced the displayed statement.

**Observed:** resolve B then A after opening A then B: selected problem B, statement A, CPH pool A. This creates a concrete wrong-problem submission risk. The analogous contest race is source-confirmed.

An old verdict watcher is also not cancelled when opening a new problem without a previous submission; it can repaint the shared verdict area.

**Bugfix path:** assign a view/session generation to opening, initialization, and verdict ownership. Snapshot contest/problem identifiers, reject stale continuations, and enable submit only for the fully committed context. Cancel the old watcher at the start of navigation.

**Regression:** reverse-order problem/contest responses, logout during load, delayed editor mounting, and a new problem with no submission while the old verdict is pending.

### F13 — A search change is dropped during public loading

**Location:** [main.ts:1081](../src/main.ts#L1081), [main.ts:1113](../src/main.ts#L1113).

relaunchPublic resets the list/page but leaves pstate.loading true. loadProblemsPage then refuses the new search request. The old request subsequently appends its rows into the reset state; later pages may use the new filter.

**Observed:** changing old → new during a pending request sent only one request and displayed old-result under the visible new search value.

**Bugfix path:** version or cancel list requests, queue/restart the latest query after an in-flight request, and keep pagination/exhaustion attached to that query.

**Regression:** change search/topic/group during a slow load; only the latest query populates the list and its next page.

### F14 — Old list responses repaint newer pages

**Location:** [main.ts:480](../src/main.ts#L480), with the same unguarded pattern at [main.ts:951](../src/main.ts#L951).

Concurrent submissions loads have no request generation. Their completions paint whichever response arrives last, while the page label and saved filters are read from current mutable UI state. Contest list loading has the same late-response ownership problem.

**Observed:** page 2 resolved before page 1; the final rows were page1 while the label said p2.

**Bugfix path:** capture the page/filter/session snapshot per request, accept only the latest result, and save the accepted snapshot rather than rereading controls. Apply equivalent guards to errors so an old 401 does not clear newer state.

**Regression:** reverse response order for pages and filters, including an old failure after a newer success.

### F15 — CPH work can commit into another problem's state

**Location:** [main.ts:1330](../src/main.ts#L1330), [main.ts:1449](../src/main.ts#L1449), [main.ts:1600](../src/main.ts#L1600), [main.ts:1648](../src/main.ts#L1648).

Opening another problem resets the global CPH state and running flag while old runs/imports remain pending. Their continuations mutate current cphUi and save through its current problemCode.

**Observed:** an A run completed while B was current and installed A's result ID into B's results. An A submission harvest resolving after switching to B persisted “from A” under B's storage key.

**Bugfix path:** capture problem identity, case/source revision, and an operation generation. Reject stale completion; save imports only to their validated destination snapshot. Preserve actual runner ownership until cancellation/completion instead of resetting the busy flag on navigation.

**Regression:** switch problems during runs and both import paths; edit cases/source during runs; ensure no cross-problem persistence or current-looking stale verdict.

### F28 — Mixed math is processed in the wrong order

**Location:** [main.ts:1719](../src/main.ts#L1719).

collectMath scans all display formulas before inline formulas while sharing a single last position. Inline formulas earlier than a later display formula are then skipped.

**Observed:** “inline \(a\) before $$b$$” collected only b; the earlier inline formula remained raw.

**Bugfix path:** collect all delimiter matches and process them in source order, or use a single ordered tokenizer that preserves overlap rules and code exclusions.

**Regression:** inline-before-display, display-before-inline, multiple alternating formulas, escaped delimiters, and code blocks.

## TMATH solve, drafts, and settings

### F16 — Import capacity counts each addition twice

**Location:** [cph.ts:83](../src/lib/cph.ts#L83), [cph.ts:95](../src/lib/cph.ts#L95).

The cap checks existing.length + added, but existing grows on every accepted case and added also increments.

**Observed:** importing 40 distinct valid cases into an empty store accepted 20 and skipped 20.

**Bugfix path:** compare the growing existing.length directly with MAX_CASES, or use an immutable initial length plus added.

**Regression:** empty → 40, existing 30 → 10, existing 39 → 1; duplicates/invalid entries must not consume capacity.

### F17 — Async import uses event.currentTarget after dispatch

**Location:** [solve.ts:429](../src/tmath/solve.ts#L429), [solve.ts:442](../src/tmath/solve.ts#L442).

The handler awaits file.text and later reads e.currentTarget again. Browser dispatch clears currentTarget once the synchronous handler returns.

**Observed:** a fixture simulating that lifetime imported successfully, then threw “Cannot set properties of null (setting 'value')”. The file input remained uncleared, so reselecting the same file need not trigger change.

**Bugfix path:** capture the input element before awaiting and clear that captured element in finally.

**Regression:** successful/failed reads, invalid JSON, and selecting the same file twice; no unhandled rejection.

### F18 — Pending imports ignore disposal and revision changes

**Location:** [solve.ts:431](../src/tmath/solve.ts#L431).

Disposal is checked before file reading but not after it. The continuation imports into shared storage, reloads cases, and repaints even after disposal. It also does not increment revision, allowing a run started during the file read to finish without acknowledging the replaced cases.

**Observed:** resolving a pending file read after disposal still invoked import and repaint. The missing revision guard is source-confirmed.

**Bugfix path:** await text separately, then validate disposal and operation generation before committing. Coordinate imports with running state and increment revision for accepted case changes.

**Regression:** complete reads after navigation/remount and during a pending run; no disposed repaint, stale overwrite, or falsely fresh result.

### F19 — Unscored cases become editable and scoreable

**Location:** [solve.ts:101](../src/tmath/solve.ts#L101), [solve.ts:124](../src/tmath/solve.ts#L124), [solve.ts:136](../src/tmath/solve.ts#L136).

controls re-enables all case textareas when idle. Its corrective loop searches for data-case rows, but the current picker never renders that attribute. A null-expected textarea becomes enabled while its scoring checkbox remains unchecked; typing changes expected into a string.

**Observed:** the actual controls function changed an unscored field's disabled state from true to false.

**Bugfix path:** set the active expected field's disabled state from running or activeCase.expected == null using the real picker DOM.

**Regression:** adding unscored cases, toggling scoring off, detection completion, run/stop, and picker switching must preserve the unchecked/unscored state.

### F20 — Picker navigation discards detailed results

**Location:** [solve.ts:122](../src/tmath/solve.ts#L122), [solve.ts:247](../src/tmath/solve.ts#L247).

Run completion paints details only for the currently active case. Picker changes replace that container with an empty element. runMarks stores verdict strings, not stdout/stderr/results.

**Observed:** after stdout-A was shown, selecting B yielded empty result HTML; switching back also loses A's details.

**Bugfix path:** retain full local results by case ID and render the selected result from paintCases. Invalidate or mark results stale when their input/source revision changes.

**Regression:** run A and B with distinct stdout/stderr, switch A → B → A, then edit and rerun.

### F21 — Monaco readiness does not refresh toolbar controls

**Location:** [solve.ts:99](../src/tmath/solve.ts#L99), [solve.ts:288](../src/tmath/solve.ts#L288), [solve.ts:462](../src/tmath/solve.ts#L462).

Detection can finish while Monaco is still importing, causing controls to disable undo/redo/find. Successful mountEditor assigns editor but never reruns controls. A successful retry from fallback has the same issue.

**Bugfix path:** refresh controls when editor readiness/fallback state changes, guarded against disposal.

**Regression:** delay detection and editor import independently in both completion orders; fail the first mount then retry. Toolbar state must reflect the mounted editor immediately.

### F22 — Old compile completion looks current after edits

**Location:** [solve.ts:170](../src/tmath/solve.ts#L170), compared with run revision tracking at [solve.ts:226](../src/tmath/solve.ts#L226).

Editing/switching language is possible while compiling. Those changes mark the status stale, but compileSource captures no revision and overwrites the status when the old compilation finishes.

**Bugfix path:** capture source/language/revision for compilation and preserve an explicit stale indication if they change before completion.

**Regression:** delay compile completion, edit source or switch language, then resolve success/failure; the old result must remain identifiable as stale.

### F23 — Non-curated fonts are lost on settings remount

**Location:** [settings.ts:10](../src/tmath/settings.ts#L10), [settings.ts:19](../src/tmath/settings.ts#L19), [app.ts:154](../src/tmath/app.ts#L154).

Choosing an enumerated font saves preferences and remounts settings. Initial selects contain only curated defaults, so a saved external font has no matching option. The select chooses its first option; later enumeration preserves that wrong value, and the next unrelated change saves it over the chosen font.

**Observed:** the actual select generator omitted a saved JetBrains Mono value and emitted no selected option.

**Bugfix path:** include the current saved font in initial options and preserve that preference when adding enumerated families.

**Regression:** choose non-curated statement/editor fonts, change size/theme, revisit settings, and reload; selected and saved values remain unchanged.

### F24 — Math work limits are applied after expensive scanning

**Location:** [statement.ts:67](../src/tmath/statement.ts#L67), [statement.ts:123](../src/tmath/statement.ts#L123), [statement.ts:205](../src/tmath/statement.ts#L205).

Each unmatched math opener scans up to another 32,000 characters. The overall size/count limit is checked only after protection and Markdown parsing.

**Observed:** source-extracted protectMath on repeated unmatched “\(x” took approximately 33 ms at 3,000 characters, 236 ms at 12,000, and 2,624 ms at 48,000, producing zero formulas. These are illustrative local measurements, not a cross-device benchmark. The function runs synchronously in the UI path.

**Bugfix path:** impose a total scan/work budget or use a linear delimiter parser; propagate a raw/limited outcome before expensive parsing.

**Regression:** repeated unmatched openers, long delimiters, normal math, escapes, HTML attributes, and code fences. Prefer a bounded-work assertion over a hardware-specific duration.

### F40 — Valid empty-stdin tests do not round-trip

**Location:** [cph.ts:84](../src/lib/cph.ts#L84).

The exporter and runner support an empty stdin string, but import rejects every input of length zero.

**Observed:** exporting a case with empty input and expected “42\n”, then importing into an empty destination, added zero and skipped one.

**Bugfix path:** permit empty strings while retaining type and maximum-length checks.

**Regression:** a no-input/output-producing program's case round-trips alongside ordinary cases.

## TMATH shell and profile presentation

### F25 — Page-title refresh buttons are never bound

**Location:** [app.ts:150](../src/tmath/app.ts#L150), [app.ts:194](../src/tmath/app.ts#L194), [app.ts:207](../src/tmath/app.ts#L207).

shell calls bindBanner while tm-content is empty. The refresh query finds nothing. Contests, problems, rankings, and account insert their page-title refresh buttons only afterward, with no subsequent binding.

**Bugfix path:** bind after each view is inserted, or delegate the action from a stable host. Keep the existing workspace refresh-problems action distinct.

**Regression:** on every affected page, refresh issues exactly one new load, including when the initial API response is delayed.

### F26 — Deduplication incorrectly controls server pagination

**Location:** [app.ts:290](../src/tmath/app.ts#L290), [app.ts:319](../src/tmath/app.ts#L319), [app.ts:278](../src/tmath/app.ts#L278).

The recent-contest list removes contests also shown in active groups, then passes the reduced count to the pager. A full server page with any overlap looks like a short final page.

**Observed:** 20 server rows with one active overlap become 19 visible rows and disable Next.

**Bugfix path:** derive pagination from the original page count or supported pagination metadata; deduplicate only presentation.

**Regression:** full pages with one/all active overlaps still allow the next server page; genuine short final pages do not.

### F27 — Workspace countdown leaks after every navigation

**Location:** [app.ts:390](../src/tmath/app.ts#L390), [app.ts:405](../src/tmath/app.ts#L405).

workspace creates a one-second interval but never registers clearInterval in the view disposer. Problem-tab changes and workspace refreshes create more intervals, retaining old host elements and executing indefinitely. App destruction also leaves them running.

**Bugfix path:** compose the timer cleanup into disposeView immediately after creation, including workspaces with no solve view.

**Regression:** repeatedly enter, refresh, switch problems, leave, and destroy; at most one active countdown belongs to the live workspace and none remain afterward.

### F29 — Authored iframe embeds remain escaped text

**Location:** [app.ts:576](../src/tmath/app.ts#L576).

mdInline first converts quotes into &quot;, then its iframe regex looks for literal quotes around src. A normal authored iframe therefore never matches the documented explicit-embed rule.

**Observed:** a synthetic YouTube embed remained fully escaped instead of producing the intended iframe.

**Bugfix path:** tokenize explicit embeds safely before generic escaping, or parse a constrained structure after decoding with a strict origin/path allowlist. Avoid broadly unescaping arbitrary HTML.

**Regression:** permitted YouTube/no-cookie embed forms render; disallowed origins/attributes stay inert; ordinary watch links remain ordinary links.

### F41 — Countdown label queries a nonexistent child

**Location:** [app.ts:376](../src/tmath/app.ts#L376), [app.ts:386](../src/tmath/app.ts#L386).

The data-clock-label element is already the span containing the label. tick searches for another span inside it and therefore never updates “unknown”, although the numeric clock changes.

**Bugfix path:** update the selected label element's textContent directly.

**Regression:** future, expired, and missing deadlines display the matching label and numeric state.

### F42 — Update banner CSS defeats hidden state

**Location:** [app.css:85](../src/app.css#L85), [index.html:13](../index.html#L13), [main.ts:1313](../src/main.ts#L1313).

The author rule sets .update-banner to display:flex without a hidden override. That overrides the native hidden display behavior, while initialization and dismissal rely on the hidden attribute. Baseplate/WIP can show the initial checking banner and keep it visible after dismissal. TMATH explicitly hides this outer banner separately.

**Bugfix path:** add an explicit .update-banner[hidden] display:none rule, or an appropriately scoped shared hidden rule.

**Regression:** computed display is none initially and after dismissal, and visible only when a notice is painted. Browser CSS execution was not performed in this audit.

## Delivery and verification tools

### F07 — Unvalidated chunk IDs control recursive deletion

**Location:** [unwrap-bundle.mjs:19](tools/unwrap-bundle.mjs#L19).

chunkId is interpolated into the output path before recursive removal. A value such as “..” resolves outside the intended return directory. Even an ordinary invalid bundle deletes the previous chunk return before validation rejects it.

**Observed:** executing the actual script against a fake filesystem recorded a deletion targeting the workspace for “..”; invalid bundle content removed the previous return before exit 2. No real deletion was performed.

**Bugfix path:** validate a single chunk identifier, resolve and prove strict containment, parse/validate the complete input, then stage and replace only the verified target.

**Regression:** dot segments, separators, absolute paths, and invalid bundles cause no deletion.

### F08 — File destinations escape the extraction boundary

**Location:** [unwrap-bundle.mjs:29](tools/unwrap-bundle.mjs#L29).

Zone validation tests the raw string prefix, while path.join later normalizes traversal. Disallowed paths are still written after merely incrementing a violation counter.

**Observed:** a path beginning tools/claude11/ and containing parent traversals wrote outside the chunk root with zero violations in a fake-filesystem execution.

**Bugfix path:** validate canonical relative paths and allowed destinations before any write. Enforce containment and reject traversal, drive/UNC paths, duplicate destinations, and forbidden zones.

**Regression:** prefixed traversal and explicit forbidden-zone files yield zero writes. No live filesystem escape was attempted.

### F33 — Exported single files become nested directories

**Location:** [export-agent-tree.mjs:58](tools/export-agent-tree.mjs#L58).

For file entries, set.to already contains the filename, but the code appends its basename again. Cargo.toml becomes Cargo.toml/Cargo.toml; API context and other single files are similarly malformed. With frontend export enabled, a later copy can collide with the directory created where api.ts should be.

**Observed:** destination calculation produced src-tauri/Cargo.toml/Cargo.toml.

**Bugfix path:** use the declared destination directly for single files; append relative paths only for directory walks.

**Regression:** validate the whole exported layout with and without frontend context using a fake filesystem or isolated fixture.

### F34 — Nested Markdown fences truncate returned files

**Location:** [unwrap-bundle.mjs:22](tools/unwrap-bundle.mjs#L22), [unwrap-bundle.mjs:31](tools/unwrap-bundle.mjs#L31).

The parser splits every FILE header regardless of fence state and captures only the first triple-backtick-delimited block. Valid Markdown containing a longer outer fence and inner code fences is truncated; literal FILE lines inside content can become false sections.

**Observed:** a four-backtick Markdown block containing a Rust fence extracted only its initial heading.

**Bugfix path:** parse section headers outside content fences, honor fence character/length, preserve complete content, and reject malformed framing rather than silently accepting a partial file.

**Regression:** byte-preserving round-trips of nested fences, literal FILE headers, CRLF, and empty files.

### F35 — E2E success does not require a terminal verdict

**Location:** [delcc-e2e.py:234](tools/delcc-e2e.py#L234), pending statuses at [delcc-e2e.py:52](tools/delcc-e2e.py#L52).

The polling loop does not validate HTTP status, omits compact pending codes such as QU, ignores is_terminal, and returns True even after all polls are exhausted.

**Observed:** the actual phase with stubbed HTTP/time returned success for thirty 503 responses, thirty pending responses, and QU with is_terminal:false after one poll.

**Bugfix path:** validate response status/shape and authoritative terminal state; handle pending statuses consistently; fail when no terminal result arrives. Preserve the existing explicit submission gate.

**Regression:** offline fixtures for transient errors, exhaustion, compact pending statuses, and real terminal responses. No live submission was made.

### F36 — Contest E2E polls source data as a verdict

**Location:** [delcc-e2e.py:231](tools/delcc-e2e.py#L231), [api.ts:208](../src/lib/api.ts#L208). Contract: [openapi-frontend.json](../tools/openapi-frontend.json).

The problem-scoped singular submission endpoint used by the tool does exist, but the checked-in contract identifies it as a submission-source read. Its response contains source/language/IDs and no status or is_terminal. The contest-scoped plural submissions/{submission_id} endpoint supplies submission details.

**Impact:** polling source responses cannot establish a verdict, and F35 masks that failure as success. The two endpoint ID domains also must not be assumed interchangeable.

**Bugfix path:** use the documented detail endpoint and returned submission ID; reject source-only response shapes and encode path identifiers.

**Regression:** fake HTTP asserts the exact contest-detail path and required response shape. Live endpoint behavior was not probed.

### F37 — Solve browser tests contain stale expectations

**Location:** [test-tmath-solve.mjs:132](../scripts/test-tmath-solve.mjs#L132), [test-tmath-solve.mjs:155](../scripts/test-tmath-solve.mjs#L155).

The test expects two tabs globally, but the fixture now has two sample tabs plus Input/Output tabs. It also clicks Submit twice and expects one request without accepting the new confirmation dialog; the current flow sends no request until confirmation.

**Bugfix path:** scope tab assertions to the intended tablist and explicitly exercise confirmation/cancellation at every submission step.

**Regression:** the updated offline browser suite must cover confirmed submission, cancellation, double clicks, and pending requests with external requests blocked.

**Limit:** inspected statically; not reported as an executed browser failure.

### F38 — Statement fixture is behind Vite's page fallback

**Location:** [test-tmath-statement.mjs:10](../scripts/test-tmath-statement.mjs#L10).

The test appends fixture middleware after createServer returns. The installed Vite implementation already installed SPA fallback and index-HTML middleware before returning, so the fixture request can be served as the application page first, without the expected host.

**Bugfix path:** install the fixture through configureServer before fallback, as the solve test already does; assert the fixture identity before imports.

**Regression:** request the fixture and verify its expected root, then run statement checks with external requests blocked.

**Limit:** Vite middleware ordering was inspected locally; no server/browser was launched.

### F39 — Historical patch replay is not idempotent

**Location:** [fixpass-n16.mjs:9](tools/fixpass-n16.mjs#L9).

The edit helper tests oldStr before newStr, while the new overlay markup still contains the old anchor. Replaying the patch inserts another overlay instead of skipping an already-applied change.

**Observed:** actual script execution against fake filesystem copies of current source increased overlay count from one to two, with one simulated write.

**Bugfix path:** recognize the applied form first, require an unambiguous anchor, and preflight the complete patch before writing.

**Regression:** applying to original and already-patched fixtures yields exactly one overlay. This is a historical-tool replay hazard, not a claim that normal application startup reruns it.

## Security follow-up requiring runtime confirmation

### Q01 — Profile Markdown accepts unrestricted URL schemes

**Priority:** P2 follow-up; **evidence:** H for practical execution impact, R for emitted markup.

**Location:** [app.ts:581](../src/tmath/app.ts#L581).

Escaping characters does not validate URL schemes. The Markdown renderer emits arbitrary link/image URL values directly. An offline probe produced a link with href="javascript:void%200". The renderer also performs subsequent regex replacements over generated markup, so nested Markdown needs structural validation.

**Potential impact:** dangerous or unexpected navigation from another user's About content. Script execution was not demonstrated; target=_blank, browser/WebView behavior, and navigation policy affect the result. No remote payload was loaded.

**Bugfix path:** use a constrained parser/DOM construction, explicitly allow intended URL protocols, and sanitize the final allowed structure. Preserve the narrow explicit-embed policy.

**Verification needed:** isolated browser/WebView fixtures for javascript/data/file schemes, encoded schemes, nested Markdown, and allowed HTTPS links/images; assert prohibited navigation/attributes never appear.

## Checks actually executed

All checks below completed without production builds or source edits.

### TypeScript

Command:

~~~text
npx --no-install tsc --noEmit
~~~

Result: **exit 0; no stdout/stderr diagnostics**.

### Dictionary parity and structure

Command:

~~~text
node tools/claude11/verify/i18n-lint.mjs src/i18n
~~~

Result: **exit 0; no stdout/stderr diagnostics**.

Additional in-memory inspection:

~~~text
en-US: 353 keys
vi-VN: 353 keys
zh-CN: 353 keys
placeholder mismatches: []
duplicate keys in all three dictionaries and Dict interface: []
~~~

### Transport regression suite

Command:

~~~text
node --experimental-strip-types --experimental-vm-modules tools/claude11/verify/transport-probe.test.ts
~~~

Output:

~~~text
SOURCE src/lib/transport.ts
PASS concurrent first callers share one pending probe and never fetch early
PASS missing bridge caches null even if the bridge appears later
PASS failed Tauri import is swallowed and its null result stays cached
PASS non-callable invoke export also produces a persistent null result
PASS successful probe retains the original invoke function for the session
PASS transport forwards the complete request to fetch when the cached bridge is null
6/6 passed
~~~

Exit 0. Node also emitted its experimental-feature notices for type stripping and VM modules.

### Selected offline reproduction outputs

~~~text
auth logout final= A-rotated
auth switch-success final= A-rotated
auth switch-failure final= null
same synthetic submission body: Bearer A-access -> Bearer B-access
abort during start: onUrl calls=1
abort during exchange: returned token=true
boot refresh persistence: saved-profile refresh=old, profile writes=0
public search changed in flight: requests=1, displayed=old-result, visible search=new
problem A resolves after B: selected=B, statement=Statement A, CPH=A
submission responses reversed: rows=page1, label=p2
late local run: current problem=B, result IDs=a
late harvest persisted: {"code":"B","inputs":["from A"]}
case import: {"added":20,"skipped":20}, stored=20
empty-stdin round-trip: {"added":0,"skipped":1}, targetCases=0
mixed inline then display formulas collected: b
full contest page after one active overlap: visible=19, nextDisabled=true
~~~

These outputs demonstrate the specified branches with synthetic dependencies. They do not establish live service behavior or complete UI integration. Additional reproduction details appear with their findings; no fixture files were retained.

## Coverage and limits

| Area | Review performed | Remaining limit |
|---|---|---|
| Baseplate/WIP | main.ts flows, auth/profile gates, lists, solve/submit/poll, CPH, math, app.css | No interactive persona session |
| TMATH | app, solve, editor, statement, settings, preferences, ui, index, relevant CSS/icon usage | No pixel/layout comparison or full browser run |
| Shared libraries | api, auth, google, profiles, vault, updater, transport, device, scheme, cph, langmap, verdict, editor | No real credentials, OAuth, API, storage-quota or OS execution |
| Native backend | active main.rs, cph.rs, fonts.rs; Cargo/build/Tauri/capabilities | No Cargo/Tauri build, compiler process, Job Object, or font-registry experiment |
| Localization | All three dicts and interface; key/placeholder/duplicate checks | No exhaustive linguistic review |
| Tools/tests | Export/unwrap, E2E, B1/C2 verification, browser harnesses, selected historical patch/replay helpers | Historical tools not all executed; fake filesystem/HTTP only |
| Root/build/docs | package/lock context, Vite, tsconfig, index, README, todo tail, audit notes, chunk/task context | No dependency-vulnerability feed lookup or generated-artifact audit |

- No Vite build was run because it writes dist; the current request was audit-only. No Cargo/Tauri builds were attempted.
- Browser regression suites were not run: Playwright/jsdom are not resolvable as project dependencies in this environment, and the solve browser script writes test-output. No package installation or workaround dependency download occurred.
- The legacy solve-jsdom harness also retains historical absolute imports and expects a generated bundle; its presence is not evidence of a passing portable gate.
- The directory is not a Git working tree, so no commit-based diff or clean-tree claim is available. Findings reference the files and line numbers inspected during this audit.
- Checked-in API schema was used for F36. No external network inspection, live submissions, or active security testing occurred.
- No new synchronous switchingLanguage/disposal draft-clobber defect was confirmed in the current guarded solve/editor path. That earlier issue was not re-reported merely because it existed in prior passes.
- Statement sanitization/copy cleanup, intentional lack of copy/context-menu blocking, and local “mock / not judged” disclosures were not treated as defects. The current local file-I/O limitation is explicitly disclosed in the code/UI.
- No general security approval, absence-of-bugs guarantee, or performance guarantee follows from these passing checks.

## Suggested repair order

1. Bind session and request ownership before changing refresh/replay behavior: F01–F03, F09, F12.
2. Close destructive/injection/resource boundaries: F04–F08.
3. Repair local-run/import ownership and verdict correctness: F15–F22, F30–F32, F40.
4. Fix persistence and navigation behavior: F10–F14, F23–F29, F41–F42.
5. Repair delivery/test tools before relying on their results: F33–F39; verify Q01 in an isolated browser fixture.

This is a bugfix path only. None of these repairs has been applied.

# api.ts ↔ contract audit sheet (pass #10)

Built from `openapi-frontend.json` + `docs/api-docs.md` (read-only — never copied, only
referenced by endpoint/field name) cross-referenced against `src/lib/api.ts` and every
caller in `src/**` except `src/tmath/`, which is listed as "tmath persona" per the pass
brief — its calls are named, not quoted.

49 operations in the contract, across 45 distinct paths. Covered below in six groups.

## Auth

| Endpoint | Wrapper | Callers | Notes |
|---|---|---|---|
| `POST /auth/login` | `api.login` | `lib/auth.ts:login` | — |
| `POST /auth/refresh` | `api.refresh` | `lib/auth.ts:silentRefresh` | — |
| `POST /auth/logout` | `api.logout` | `lib/auth.ts:logout` | best-effort — called after the local token is already cleared, failure ignored |
| `POST /auth/google/start` | `api.googleStart` | `lib/google.ts` | — |
| `POST /auth/google/exchange` | `api.googleExchange` | `lib/google.ts` | — |

## Identity / home

| Endpoint | Wrapper | Callers | Notes |
|---|---|---|---|
| `GET /me` | `api.me` | main.ts (resumeProfile-adjacent), tmath persona | two independent callers, same wrapper — no divergence |
| `GET /home` | `api.home` | main.ts (wip home grid), tmath persona | — |
| `GET /current-contest` | `api.currentContest` | **none** | wrapper exists, never called anywhere, including tmath. `home`'s own payload (`current_contests`/`future_contests`) apparently covers what main.ts needed instead — feature-shaped gap, not a bug, but dead code worth noting |
| `GET /bootstrap` | **none** | — | never called. Unknown what it returns without reading the contract's schema for it in detail — flagged for a future lane to check whether it would replace several of the calls below |
| `GET /organizations` | **none** | — | never called |
| `GET /organizations/{organization_id}` | **none** | — | never called |
| `GET /years` | **none** | — | never called |

## Contests

| Endpoint | Wrapper | Callers | Notes |
|---|---|---|---|
| `GET /contests` | `api.contests` | main.ts, tmath persona | per the wrapper's own comment, this feed is **joined-only** — a probe found it returns exactly one row (the joined contest), not a public catalog. Both personas rely on `/home` for current/upcoming instead |
| `GET /contests/{key}` | **none** | — | no wrapper, no caller. Single-contest detail by key is never fetched directly; both personas apparently get what they need from the list/join flow |
| `POST /contests/{key}/join` | `api.join` | main.ts, tmath persona | — |
| `POST /contests/{key}/leave` | `api.leave` | main.ts, tmath persona | — |
| `GET /contests/{key}/workspace` | `api.workspace` | main.ts, tmath persona | return shape is `unknown`-typed in `ContestListItem`'s neighbors; nothing in either persona narrows it further |
| `GET /contests/{key}/leaderboard` | **none** | — | never called — no leaderboard view in either persona yet |
| `GET/PUT/DELETE /contests/{key}/code-share/me` | **none** | — | never called, all three methods |
| `GET /contests/{key}/code-shares` | **none** | — | never called |
| `GET /contests/{key}/code-shares/{student_id}` | **none** | — | never called |
| `GET /contests/{key}/code-shares/{student_id}/status` | **none** | — | never called |

## Problems

| Endpoint | Wrapper | Callers | Notes |
|---|---|---|---|
| `GET /problems` | `api.problems` | main.ts, tmath persona | `search`/`type`/`group` params wired per the wrapper's own comment ("real server-side params per openapi contract") |
| `GET /problems/{code}` | `api.problem` | main.ts, tmath persona | `submitHeaders` flag forces `X-Client-Version`/`X-Device-Id` — `raw()`'s own comment says these are demanded on detail reads "undocumented — proven by tools/delcc-e2e.py", i.e. found by running the script, not by reading the contract |
| `POST /problems/{code}/submit` | `api.submitPublic` | main.ts, tmath persona | — |
| `GET /contests/{key}/problems` | `api.contestProblems` | main.ts, tmath persona | — |
| `GET /contests/{key}/problems/{code}` | `api.contestProblem` | main.ts, tmath persona | — |
| `POST /contests/{key}/problems/{code}/submit` | `api.submitContest` | main.ts, tmath persona | — |
| `GET /contests/{key}/problems/{code}/submissions` | `api.contestProblemSubmissions` | main.ts (409-recovery path) | see "Top 5" below — this is the plural list, used as the recovery mechanism; the *singular* endpoint one row down is not |
| `GET /contests/{key}/problems/{code}/submission/{contest_submission_id}` | **none** | — | **never called, by either persona.** Needs a submission id as a path param, so it isn't itself a "find my current submission" shortcut — main.ts's 409-recovery already gets what it needs from the plural list above. Possibly redundant with `GET /submissions/{id}`/`GET /contests/{key}/submissions/{id}` for a contest-scoped id; not confirmed either way without reading its schema closely |
| `GET /problem-topics` | `api.topics` | main.ts, tmath persona | hardcoded `?scope=public` in the wrapper — if a non-public scope value ever matters, the wrapper would need a param added |
| `GET /problem-classes` | **none** | — | never called |
| `POST/GET /problem-class-requests` | **none** | — | never called, either method |
| `POST /problem-class-requests/{request_id}/votes` | **none** | — | never called |
| `POST /problem-class-revocations` | **none** | — | never called |

## Submissions

| Endpoint | Wrapper | Callers | Notes |
|---|---|---|---|
| `GET /submissions` | `api.submissions` | main.ts (subs tab, CPH harvester), tmath persona | — |
| `GET /submissions/{id}` | `api.submission` | main.ts, `lib/verdict.ts`, tmath persona | optional `scope` param wired |
| `GET /submissions/{id}/source` | **no wrapper** — `raw()` called directly | tmath persona only (`app.ts:307`) | real endpoint, real caller, just no named wrapper in `api.ts` — main.ts has no source-view feature at all |
| `GET /contests/{key}/submissions` | **none** | — | never called — main.ts uses the problem-scoped plural (`contestProblemSubmissions`) instead, never the contest-wide one |
| `GET /contests/{key}/submissions/{id}` | `api.submissionContest` | `lib/verdict.ts` | — |
| `GET /contests/{key}/submissions/{id}/source` | **none** | — | never called by either persona — the only source-view caller (tmath) uses the *public* source endpoint even from a contest context; contest-scoped source is a real, unused gap |
| `GET /submissions/stream` | **none** | — | never called. `GET /participations/{id}/submissions/stream` (below) is what `lib/verdict.ts` actually streams from — this is a *different* path, unclear from the contract alone whether it's a global feed or an alias; not confirmed |
| `GET /participations/{id}/submissions/stream` | `api.streamUrl` (URL builder, not a `raw()` call) | `lib/verdict.ts` | EventSource can't carry `Authorization`, so this is fetched manually with a header + streamed, per the wrapper's comment — browser (non-Tauri) path falls back to polling |

## Releases, admin, achievements, users

| Endpoint | Wrapper | Callers | Notes |
|---|---|---|---|
| `GET /client-releases/current` | `api.release` *and* a second inline call in `syncClientVersion` | `lib/updater.ts` (via `api.release`), `lib/api.ts` itself (`syncClientVersion`, bypasses the `api` object and calls `raw()` directly with the same path) | same endpoint, two independent call sites for two different purposes (spoofing the version header vs. telling the user about a new official build) — documented as intentional in both places, not a duplication bug |
| `GET/POST /client-releases/downloads` | `api.recordDownload` (POST only) | `lib/updater.ts` | contract lists `GET` too; nothing calls it — presumably a stats-read endpoint with no UI for it yet |
| `POST /admin/contests/{key}/submissions/upload` | **none** | — | admin-only surface, correctly never touched by a client persona |
| `GET /achievements` | **none** | — | never called |
| `GET /achievements/featured` | **none** | — | never called |
| `GET /users` | **no wrapper** — `raw()` direct | tmath persona only (`app.ts:325-326`) | — |
| `GET /users/{username}` | **no wrapper** — `raw()` direct | tmath persona only (`app.ts:325`, `app.ts:360`) | — |

## Error-shape / behavior notes (not tied to one endpoint)

- `raw()`'s 401 handling retries once via `refreshHook`, but **never** for any `/auth/*`
  path — correct, avoids a refresh-on-refresh-failure loop, but worth stating since it's
  implicit in a regex (`!/^\/auth\//.test(path)`) rather than a named exception list.
- 426 retry (`bumpVersion` then replay) is skipped specifically for `/client-releases/*`
  paths, to avoid the version-check call re-triggering itself.
- `humanError()` maps 400/401/403/404/409/422/410/503/426/429 to persona-neutral English
  strings. `src/tmath/ui.ts` has its **own**, separate 401/403/404/409/410/422/426/429/503
  status→dict-key map for i18n — same status set, intentionally duplicated (one persona
  can't own English strings the other needs translated), not a bug, but a second place that
  needs updating if the server ever adds a new status code either persona should handle.
- No wrapper anywhere distinguishes a network failure (no response at all) from a 4xx/5xx
  with a body — `ApiError` is only constructed from an HTTP response; a thrown
  `TypeError`/`fetch` rejection propagates as a plain `Error`, not an `ApiError`, so
  `e instanceof ApiError` checks (used for the 409-recovery branch, the 401-retry
  suppression, etc.) silently fall through to the generic path for those. Not observed to
  cause a visible bug, since `humanError()`'s final fallback (`String(e?.message || e)`)
  still produces readable text — just means "is this a real server error vs. offline" isn't
  distinguishable anywhere downstream.

## Top 5 actionable follow-ups

1. **Contest-scoped submission source is a real, unused gap.** `GET
   /contests/{key}/submissions/{id}/source` has no wrapper and no caller; the only
   source-view feature (tmath) always uses the public source endpoint, even when looking at
   a contest submission. Unclear whether the public endpoint actually works for a
   contest-scoped id (same id-space, or not?) — worth a one-line check against the live
   contract before assuming either endpoint is interchangeable with the other.
2. **`GET /bootstrap` is completely unexplored.** Never called by either persona. Given the
   name, it may bundle several of the always-fetched-together calls (`/me` + `/home` +
   maybe `/current-contest`) into one round trip — worth reading its response schema
   specifically; could be a real latency win on cold boot for both personas.
3. **No wrapper for `/submissions/{id}/source` or `/users`/`/users/{username}`** even though
   all three are real, working, called-by-tmath endpoints. Low-risk, mechanical addition to
   `api.ts` (append-only, matches lane 2's CPH precedent) — would let main.ts build the same
   source-view/user-profile features tmath already has, and gives both personas one source
   of truth for those three endpoints instead of tmath's ad-hoc `raw()` calls.
4. **`GET /contests/{key}/submissions` (contest-wide, not problem-scoped) is unused** — both
   personas only ever fetch the narrower problem-scoped plural. If a future "all my
   submissions in this contest" view is wanted, the endpoint's already there and contracted;
   right now it's just dead weight in the audit, not in the app.
5. **The i18n status-code map in `src/tmath/ui.ts` and `humanError()` in `lib/api.ts` are two
   separate lists of the same status codes.** Not a bug today — they're read by different
   personas with different output needs (English prose vs. dict keys) — but if the server
   ever adds a new status either persona should special-case, both lists need the same edit
   and nothing enforces that. Worth a shared status-code constant (just the list of known
   codes, not the strings) the next time either file is touched, so a missed update shows up
   as a type error instead of silently falling through to the generic case.

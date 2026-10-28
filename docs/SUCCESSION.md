# SUCCESSION.md — if you are reading this after the maintainer left

*Người dùng Việt Nam? Xem [SUCCESSION.vi.md](SUCCESSION.vi.md).*

This file exists for the day the person who built delcc graduates and moves on.
Projects like this die when the story lives only in one head. Everything that
matters is written down here and in the files it points to. If something is not
written down, treat it as not existing — and fix that by writing it down.

## What delcc is, in one paragraph

delcc is an independent, inspectable desktop client for the TMATH competitive
programming judge (`oj.tmathcoding.vn`). It talks only to the judge's documented
public API. It has no telemetry, no analytics, no crash reporting, and no
undocumented behavior: every network call it can make is listed in
[SECURITY.md](SECURITY.md), and that list is the contract. It exists because the
official client is closed-source, and some of its users wanted one they could
read, audit, and fix. It started as a small mitigation experiment and snowballed.
That is the whole story — you lose nothing by starting here.

## Read order for a new maintainer

1. [README.md](../README.md) — what this is, how to run it, the versioning law.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit and why they are that way.
3. [BUILDING.md](BUILDING.md) — toolchains, per-platform notes, release gates.
4. [SECURITY.md](SECURITY.md) — the honest-client contract and the current threat model.
5. `todo.md` — the ledger. Every pass since the beginning is logged there, with
   the reasoning. It is the closest thing to history this project has.
6. `states.md` — current feature state, what is done, what is staged.
7. `../docs/api-docs.md` + `../tools/openapi-frontend.json` — the API contract
   delcc is written against. Read-only references; delcc never redefines them.

## The trees (layouts)

- **tmath** (`src/tmath/`) — the parity lane, the one users run today. It mirrors
  the official client's information architecture and visual language so a switch
  between the two costs nothing. Where official behavior matters (avatars,
  contest flow, deadlines), delcc matches observed behavior; the reasoning for
  each behavior is carved into comments in the code.
- **baseplate** (`src/main.ts`, layout `baseplate`) — the original stable tab UI.
  Keep it working; it is the fallback when the parity lane drifts.
- **wip** (`src/main.ts`, layout `wip`) — early iteration of an original home
  grid. Kept for reference.
- A future fully original UI is anticipated: a tree where the maintainer is free
  of parity constraints. Nothing is staged yet; when it exists, document it here.

## The non-negotiables

These are the identity of the project. A successor who breaks these has forked
it in spirit, whatever the repo says:

1. **No telemetry. Ever.** The network surface in SECURITY.md is closed. Any
   change that adds a network call must update that file in the same commit.
2. **No undocumented behavior.** delcc does only what its user can read in its
   source and in the API contract. No hidden endpoints, no stealth features.
3. **Honesty about its own gaps.** Known weaknesses are documented (see
   SECURITY.md — e.g. tokens at rest), not hidden. A user-first client tells the
   user where the bodies are buried.
4. **The versioning law** in README.md, including the two-spellings rule and the
   pipe-eaten-exit warning. It exists because it was violated once and cost a
   night.
5. **The license**: PolyForm Noncommercial 1.0.0 (pass #75, was CC BY-NC-SA
   4.0) — non-commercial only, written for software, explicit patent grant.
   Honest note: PolyForm has no ShareAlike clause, so a fork may keep its
   changes closed (it stays non-commercial); the forced-open-fork property of
   the old CC SA is gone. If that property is ever needed again, the planned
   revisit is the Fair Core License family.
6. **The ledger.** Every pass gets a `todo.md` entry: what, why, hashes, gates.
   This is how a distributed, relay-driven workflow stayed coherent — keep it.

## Release ritual (as practiced)

1. Pass entry in `todo.md` describing the change.
2. Gates: `tsc --noEmit` clean, i18n lint clean, `vite build` clean,
   `cargo build`/`cargo test` real-exit verified (see the pipe-eaten-exit warning).
3. Version bumped per the two-spellings rule (human release name vs machine semver).
4. Artifact into `../ship-staging/delcc-v<version>/` with a README (EN+VI), the
   exe, and `hash.txt` (SHA256 of exe and zip). Zip it.
5. `states.md` updated if feature state moved.

## On the origin (for context, not for mileage)

The official client's users were tired; nobody was willing to write an
alternative. delcc's author was one of those users, started with a mitigation
experiment, got the OpenAPI spec, and built outward. Along the way the project
accumulated a methodology: observe real behavior, document it, implement it
cleanly against the public contract, write the reasoning into the code where the
next person can find it. That methodology — not any particular feature — is the
thing worth inheriting.

## If the maintainer disappears tomorrow

Fork it — that is what the license is for. delcc is **PolyForm Noncommercial
1.0.0** ([LICENSE](../LICENSE)): any fork inherits the non-commercial
constraint, so a commercial takeover is legally excluded from the start, not
just frowned upon. A fork may keep its changes closed (PolyForm has no
ShareAlike) — the inspectability of THIS repo is what the license protects. The repo
stands on its own. The docs in this set plus the ledger contain the operating
knowledge. Start a `todo.md` pass entry with your name on it — that is how
every maintainer here signed their work, and how you sign yours.

A note on the epigraph in the README — *"and in that light, I find
deliverance"*: it was the founder's, borrowed from something they loved, kept
because it fit. You are allowed to keep it, or to add your own line beneath it.
Succession is also that.

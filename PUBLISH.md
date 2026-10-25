# PUBLISH.md — from this workspace to a public repo, in order

The one-time path for putting delcc on GitHub under the burner identity. Written
so it can be executed by the maintainer or by any successor holding the
workspace. Nothing here has been executed yet — this is the runbook.

## 1. The GitHub account (human step, ~5 minutes)

Automated account creation is prohibited by GitHub's ToS and gated by a
human-verification puzzle + email confirmation — so this part is yours:

1. `github.com/signup` with a **dedicated email** (not your personal one) — a
   burner inbox you control.
2. Handle: **`afalseskybroken`** — verified available as of 2026-10-25
   (`github.com/afalseskybroken` → 404). Claim it in the signup flow.
3. After signup: Settings → Emails → enable **"Keep my email addresses
   private"** and note the offered noreply address
   (`<id>+afalseskybroken@users.noreply.github.com`) — commit attribution uses
   it, never a real inbox.
4. Settings → Password authentication / **enable 2FA** (TOTP; store the
   recovery codes with the burner inbox credentials).
5. Profile: name/bio may reference the TMATH alt (`afalseskybroken · delcc`)
   — nothing personal. No real name, no avatar that identifies you.

## 2. Scrub status (already handled via .gitignore)

The repo ships **without** the private workspace layer. `.gitignore` excludes:

| Excluded | Why |
|---|---|
| `todo.md`, `states.md` | the ledger — friend-lane names, workflow history, He's working notes; private by design (successors start their own ledger) |
| `chunks/`, `BUNDLE.md` | lane bookkeeping and relay contracts |
| `tools/carve-account.txt` | **dump of the official client's minified code — third-party proprietary, never publish** |
| `tools/fixpass-*.mjs`, `export-agent-tree.mjs`, `count10.mjs`, `dedupe-strip.mjs`, `unwrap-bundle.mjs`, `audit-b1.mjs`, `peek-*.mjs` | workspace lane tooling with hardcoded absolute workspace paths and lane context |

Everything else — `src/`, `src-tauri/`, `tools/claude11/**`, the e2e harness,
all docs (`README*`, `ARCHITECTURE*`, `BUILDING*`, `SECURITY*`, `SUCCESSION*`,
`PUBLISH.md` itself, `LICENSE`) — is intended for the public repo.

Before the first commit, one manual sweep is still required (the scan that
informed this list is dated 2026-10-25):

```
git add -A && git status                 # eyeball what is staged
git grep --cached -n -i -E "<your handles>|[A-Za-z]:\/|D:/|lane aliases|password\s*[:=]" 
```

`savedPw`/`savedPwEnc` as code identifiers are fine (that is the vault feature);
literal credential VALUES are not — there should be none, verify anyway.

Sweep log (2026-10-25, first pass executed): found and fixed a whole leak class
the name-scan missed — absolute workspace paths. The audit doc's ~55 location
links were rewritten to repo-relative paths; the lane-tool test
`scripts/test-unwrap-bundle.mjs` (subject excluded from the repo) moved to the
ignore list; this runbook's own references were sanitized. Known false positive:
`Cargo.lock` matches the "Astra" pattern via `fastrand` — leave it. `src/lib/api.ts`
login call and `tools/delcc-e2e.example.toml` empty `password = ""` are code
identifiers, fine. Final state: zero workspace-name occurrences in the
publishable tree.

## 3. Git identity (attribution to the TMATH alt)

After the account exists, inside `delcc-app/`:

```
git init
git config user.name  "afalseskybroken"
git config user.email "<id>+afalseskybroken@users.noreply.github.com"   # from Settings → Emails
```

Config is repo-local (`--local` is implied) — the global identity stays yours.
All commits are then attributed to the burner; the TMATH alt connection lives in
the handle and the profile bio, deliberately nowhere else.

## 4. First commit and push

```
git checkout -b main
git add -A
git commit -m "delcc 0.2.1a-alpha — initial public source"
gh auth login            # as the burner, in this terminal session
gh repo create <repo-name> --public --source=. --push
```

Repo-name candidates: `delcc` (taken-or-not: check), `delcc-app`, `tmath-delcc`.
License is CC BY-NC-SA-4.0 — GitHub's license picker does not know it; the
LICENSE file in-repo is the authority (that is normal for CC-licensed code).

## 5. Post-publish repo settings (once)

- About: "Independent, inspectable TMATH client. No telemetry. CC BY-NC-SA-4.0"
  + topics: `tauri`, `competitive-programming`, `judge-client`
- Default branch `main`; disable Wiki and Projects (docs live in-repo).
- SECURITY.md will surface automatically in the Security tab; fill the reporting
  placeholder in it when issues are enabled.

## 6. What stays behind

The workspace root (outside this repo) remains the private layer: ledger, lanes, staging,
archives, research. The public repo is the product; the workspace is the studio.
PUBLISH.md itself is safe to publish (it contains no secrets — it describes the
process), but excluding it is equally fine if you prefer the runbook private;
it is NOT in .gitignore, so remove it explicitly if you want it out.

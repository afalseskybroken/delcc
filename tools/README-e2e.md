# delcc-e2e.py

Phase-based live IPC trace against the real server, plain HTTPS, no browser, no CORS,
no injection — the same honest-client posture as the app itself (`User-Agent: delcc/0.1.0`,
no forced headers).

## Setup

```
cp tools/delcc-e2e.example.toml tools/delcc-e2e.local.toml
# edit tools/delcc-e2e.local.toml — [auth] username/password, burner creds only
python tools/delcc-e2e.py
```

`delcc-e2e.local.toml` is gitignored (`tools/.gitignore`). The script refuses to run
without it rather than silently falling back to empty creds.

## Phases

| Phase | What it does | Writes anything? |
|---|---|---|
| `login` | `POST /auth/login`, keeps the token for later phases | no |
| `contests-list` | `GET /contests` | no |
| `problem-open` | resolves a target problem (config, or first one found); joins a contest if `[run].contest` is set | joins a contest, if configured |
| `statement-fetch` | `GET` the resolved problem's detail, reports statement length / allowed languages / io_method | no |
| `harvest` | lists past submissions for the resolved problem, pulls detail on up to 6, reports `can_view_detail`/case counts — the same read path CPH's harvester uses in the app | no |
| `submit-mock` | **submits real source to the live tenant** and polls the verdict | **yes — a real submission** |

Default (`python tools/delcc-e2e.py`, no `--phases`) runs every phase above the table's
`submit-mock` row, in order. `submit-mock` is never included by default.

## Running submit-mock

Needs **both**, not either:

1. `allow_live_submit = true` in `delcc-e2e.local.toml`'s `[danger]` section, and
2. `--allow-live-submit` passed on the command line.

```
python tools/delcc-e2e.py --phases login,problem-open,submit-mock --allow-live-submit
```

Leaving either gate off makes the phase refuse and explain why, not silently skip.

## What this can't verify from a Linux box

- The actual Tauri shell (`src-tauri`) — this script talks straight to the API over
  `urllib`, it never touches `main.rs`/`cph.rs`/the WebView. A green run here says the
  **contract and endpoints** work; it says nothing about the desktop app's own code paths
  (token refresh timing, the lock-password flow, CPH's local compile/run, the updater).
- Anything Windows-only: CPH's actual compiler detection and sandboxed run (`cph.rs`),
  the Job Object memory cap (`job-mem-cap` feature, unverified even by `cargo check` from
  here — see `todo.md`), console-window suppression, the installer/MSI.
- SSE streaming (`/submissions/stream`, `/participations/{id}/submissions/stream`) — this
  script polls `GET /submissions/{id}` the same way the app's non-stream fallback does;
  it doesn't open an event stream, so it can't confirm the stream path specifically.
- Anything that only shows up in the WebView's own rendering: Monaco, KaTeX, DOMPurify
  output, the actual click-through UX.

## What remains on the Windows checklist

- `cargo build` for real (last attempted from Linux — blocked on toolchain age, see
  `todo.md` "Pass #9").
- `cargo build --features job-mem-cap` in isolation (lane 1 from pass #9 — still
  completely unbuilt).
- A real `submit-mock` run against a disposable/burner-owned problem, to confirm the
  verdict-poll shape this script assumes still matches the live contract.

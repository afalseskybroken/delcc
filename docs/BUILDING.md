# BUILDING.md — toolchains, platforms, release gates

*Người dùng Việt Nam? Xem [BUILDING.vi.md](BUILDING.vi.md).*

delcc builds on any platform Tauri v2 supports. The fully proven path is
Windows x64 (it is the platform the maintainer runs); macOS/Linux paths are
written to work and flagged where they are untested — see honest caveats below.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 (built with 22/24) | Vite 6 |
| npm | bundled with Node | |
| Rust | stable ≥ 1.80 | `rustup` recommended |
| Platform webview | see below | Tauri uses the system webview |
| C/C++ compiler | only for CPH *usage*, not for building delcc itself | picked up from PATH at runtime |

Platform webview notes:

- **Windows**: WebView2 Runtime (preinstalled on Win11; the Tauri bundler can
  download it). Rust toolchain: `x86_64-pc-windows-msvc` is the proven host
  (VS Build Tools with C++ workload). A GNU host may link but is untested.
- **macOS**: WKWebView, ships with the OS. Xcode CLT for the linker.
- **Linux**: `webkit2gtk-4.1` + dev packages (`libgtk-3-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`, patchelf) — standard Tauri v2 prerequisites.

## Frontend only (no Rust needed)

```
cd delcc   # the clone directory is named after the repo
npm install
npm run dev      # vite dev server — login/lists work in a plain browser
npm run build    # tsc + vite → dist/
```

Plain-browser mode cannot carry custom headers or talk to the shell; detail
views, submit, and CPH need the full Tauri build.

## Full build (Tauri)

```
cd delcc   # the clone directory is named after the repo
npm run tauri dev     # dev shell with hot reload
npm run tauri build   # release bundle; targets: "all" (see src-tauri/tauri.conf.json)
```

Windows cache note: this workspace keeps cargo's cache outside the tree — set
`CARGO_TARGET_DIR=C:\rust-target` (PowerShell: `$env:CARGO_TARGET_DIR='C:\rust-target'`)
before building. The checkout stays small and rebuilds reuse the same artifacts.

Bundle outputs per platform: Windows → MSI (WiX) + NSIS installer;
macOS → .app/.dmg; Linux → .deb/.appimage. `productName: delcc`,
identifier `vn.delcc.app` — changing the identifier changes the WebView data
directory (`%LOCALAPPDATA%/<identifier>` on Windows), i.e. where profiles and
tokens live. Do not change it casually.

### Windows specifics (proven path)

1. Install VS Build Tools (C++ workload) + Rust MSVC + Node.
2. `npm install`, then `npm run tauri build`.
3. First cargo build pulls ~400 crates; expect minutes, and **verify the real
   exit code** — see the pipe-eaten-exit warning in README's versioning
   section. A build that "succeeds" with an invalid version string is a false
   positive from a pipe-eaten exit. This happened once; it is documented so it
   does not happen twice.

### macOS / Linux caveats (honest, untested)

- The Rust CPH runner has unix code paths (`process_group(0)`,
  `poll(2)` readiness, process-group `kill -KILL`) written to be correct, but
  they have **never run on a real unix box**. Treat first-run CPH on
  macOS/Linux as the test. The Windows Job Object memory cap is
  Windows-only by design (`--features job-mem-cap`), a no-op elsewhere.
- Bundle signing/notarization (macOS) is unconfigured; unsigned binaries will
  need Gatekeeper exceptions.

## Choosing a layout (compile-time)

The layout is baked into the binary at build time — it is **not** a runtime
setting. The Rust shell reads the `DELCC_LAYOUT` environment variable when
`cargo` compiles (`src-tauri/src/main.rs`, `option_env!`), and `src/main.ts`
boots whichever layout the shell reports:

```
DELCC_LAYOUT=tmath npm run tauri dev      # parity lane (the one users run)
DELCC_LAYOUT=baseplate npm run tauri dev  # original stable tab UI (default)
DELCC_LAYOUT=wip npm run tauri dev        # early original-UI iteration
```

Same for release builds: `DELCC_LAYOUT=tmath npm run tauri build`. Omitting the
variable builds **baseplate**. PowerShell form: `$env:DELCC_LAYOUT="tmath"` before
the build. Note the window title also switches with the layout (`tmath` presents
as "TMATH Code Client", matching the official client's title for seamless use).

## Test suites

| Suite | Command |
|---|---|
| Type check | `npx tsc --noEmit` |
| i18n key drift (3 locales + Dict interface) | `node scripts/lint-i18n.mjs` |
| Version consistency (manifests + README release names) | `node scripts/lint-versions.mjs` |
| Markdown statement rendering | `node --experimental-vm-modules scripts/test-tmath-md.mjs` |
| Unwrap bundle security | `node --experimental-vm-modules scripts/test-unwrap-bundle.mjs` |
| Session integrity | `node --experimental-vm-modules tools/verify-session-integrity.mjs` |
| Security markup | `node --test scripts/security-markup.test.mjs` |

Pass #75 note: the former auxiliary rows (transport-probe, CPH stop-semantics
scratch recipe, solve-jsdom) lived under `tools/claude11/verify/` — that lane
payload was removed; the i18n linter was vendored to `scripts/i18n-lint.mjs`
(wrapped by `scripts/lint-i18n.mjs`). The transport-probe harness was already
rotted (0/6 — its VM fixture rejected transport.ts's `import "./applog"`).

Environment caveat (documented 2026-10-25): on the current dev box, spawned
MinGW-g++ binaries segfault and PATH `python3` is a Store stub, so cph tests
needing a real g++/python fail here. The stop-semantics suite is immune
(rustc-built fixture). A red result is not a code regression until you have
ruled out the box.

## Release ritual

1. Pass entry in `todo.md` (what / why / gates / hashes).
2. All gates above green; `vite build` output fresh (watch stale-dist).
3. Version bump per the two-spellings rule: release name `delcc-v0.2.1a-alpha`,
   machine fields `0.2.1-alpha` (package.json, Cargo.toml, tauri.conf.json — all
   three must agree).
4. Stage `../ship-staging/delcc-v<name>/`: binary, README.txt (EN+VI, what's-new,
   honest network use, limitations), `hash.txt` (SHA256 of exe + zip).
5. Zip, record both hashes in the pass entry.

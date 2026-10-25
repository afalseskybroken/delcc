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
cd delcc-app
npm install
npm run dev      # vite dev server — login/lists work in a plain browser
npm run build    # tsc + vite → dist/
```

Plain-browser mode cannot carry custom headers or talk to the shell; detail
views, submit, and CPH need the full Tauri build.

## Full build (Tauri)

```
cd delcc-app
npm run tauri dev     # dev shell with hot reload
npm run tauri build   # release bundle; targets: "all" (see src-tauri/tauri.conf.json)
```

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

## Test suites

| Suite | Command |
|---|---|
| Type check | `npx tsc --noEmit` |
| i18n key drift | `node tools/claude11/verify/i18n-lint.mjs src/i18n` |
| Transport probe cache | `node --experimental-strip-types --experimental-vm-modules tools/claude11/verify/transport-probe.test.ts src/lib/transport.ts` |
| CPH stop semantics | scratch-crate recipe in `tools/claude11/verify/cph_tests.rs` header (`cargo test stop_semantics`) |
| Solve view (jsdom) | `node tools/claude11/verify/solve-jsdom.test.cjs` |
| Session integrity | `node tools/verify-session-integrity.mjs` |

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

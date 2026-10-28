# BUILDING.vi.md — công cụ, nền tảng, gate phát hành

delcc build được trên mọi nền tảng mà Tauri v2 hỗ trợ. Đường chạy đã kiểm chứng
đầy đủ là Windows x64 (nền tảng maintainer dùng); đường macOS/Linux được viết để
hoạt động và được gắn cờ ở những chỗ CHƯA kiểm thử — xem các caveat trung thực
bên dưới. Bản gốc tiếng Anh: [BUILDING.md](BUILDING.md).

## Yêu cầu

| Công cụ | Phiên bản | Ghi chú |
|---|---|---|
| Node.js | ≥ 20 (đã build với 22/24) | Vite 6 |
| npm | đi kèm Node | |
| Rust | stable ≥ 1.80 | khuyến nghị `rustup` |
| Webview nền tảng | xem dưới | Tauri dùng webview hệ thống |
| Compiler C/C++ | chỉ để *sử dụng* CPH, không cần để build delcc | được dò từ PATH lúc chạy |

Ghi chú webview theo nền tảng:

- **Windows**: WebView2 Runtime (có sẵn trên Win11; bundler Tauri có thể tự tải).
  Rust toolchain: `x86_64-pc-windows-msvc` là host đã kiểm chứng (VS Build Tools
  với workload C++). Host GNU có thể link nhưng chưa thử.
- **macOS**: WKWebView, có sẵn theo OS. Xcode CLT cho linker.
- **Linux**: `webkit2gtk-4.1` + các gói dev (`libgtk-3-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, patchelf) — bộ prerequisite
  chuẩn của Tauri v2.

## Chỉ frontend (không cần Rust)

```
cd delcc   # the clone directory is named after the repo
npm install
npm run dev      # vite dev server — login/danh sách chạy trên trình duyệt thuần
npm run build    # tsc + vite → dist/
```

Chế độ trình duyệt thuần không mang được custom header cũng như nói chuyện với
shell; view chi tiết, nộp bài và CPH cần build Tauri đầy đủ.

## Build đầy đủ (Tauri)

```
cd delcc   # the clone directory is named after the repo
npm run tauri dev     # shell dev với hot reload
npm run tauri build   # bundle release; targets: "all" (xem src-tauri/tauri.conf.json)
```

Ghi chú cache trên Windows: workspace này để cache của cargo ngoài cây mã nguồn —
đặt `CARGO_TARGET_DIR=C:\rust-target` (PowerShell: `$env:CARGO_TARGET_DIR='C:\rust-target'`)
trước khi build. Cây mã nguồn gọn, và các lần build lại dùng chung artifact.

Bundle theo nền tảng: Windows → MSI (WiX) + installer NSIS; macOS → .app/.dmg;
Linux → .deb/.appimage. `productName: delcc`, identifier `vn.delcc.app` — đổi
identifier tức là đổi thư mục dữ liệu WebView (`%LOCALAPPDATA%/<identifier>` trên
Windows), tức là nơi profile và token sống. Đừng đổi tùy tiện.

### Windows (đường đã kiểm chứng)

1. Cài VS Build Tools (workload C++) + Rust MSVC + Node.
2. `npm install`, rồi `npm run tauri build`.
3. Cargo build đầu tiên kéo ~400 crate; tính bằng phút, và **xác minh exit code
   thật** — xem cảnh báo pipe-eaten-exit ở mục versioning trong README. Một build
   "thành công" với chuỗi version sai là false positive do exit code bị pipe nuốt.
   Chuyện này từng xảy ra; được ghi lại để không lặp lại.

### macOS / Linux — caveat trung thực (chưa kiểm thử)

- Rust CPH runner có đường unix (`process_group(0)`, readiness `poll(2)`, kill
  theo process-group `kill -KILL`) được viết để đúng, nhưng **chưa từng chạy trên
  máy unix thật**. Coi lần chạy CPH đầu tiên trên macOS/Linux là bài test. Cap
  bộ nhớ Windows Job Object là Windows-only by design (`--features job-mem-cap`),
  no-op ở nơi khác.
- Ký/notarize bundle (macOS) chưa cấu hình; binary unsigned sẽ cần Gatekeeper
  exception.

## Chọn layout (thời điểm build)

Layout được nướng vào binary lúc build — **không phải** thiết lập runtime. Shell
Rust đọc biến môi trường `DELCC_LAYOUT` khi `cargo` biên dịch
(`src-tauri/src/main.rs`, `option_env!`), và `src/main.ts` boot đúng layout mà
shell báo:

```
DELCC_LAYOUT=tmath npm run tauri dev      # nhánh parity (bản người dùng đang chạy)
DELCC_LAYOUT=baseplate npm run tauri dev  # UI tab gốc ổn định (mặc định)
DELCC_LAYOUT=wip npm run tauri dev        # bản thử nghiệm UI gốc sớm
```

Build release cũng vậy: `DELCC_LAYOUT=tmath npm run tauri build`. Bỏ qua biến thì
ra **baseplate**. PowerShell: `$env:DELCC_LAYOUT="tmath"` trước khi build. Lưu ý
tiêu đề cửa sổ cũng đổi theo layout (`tmath` hiện as "TMATH Code Client", khớp
tiêu đề client chính thức để dùng liền mạch).

## Bộ test

| Bộ | Lệnh |
|---|---|
| Type check | `npx tsc --noEmit` |
| Lệch khoá i18n (3 locale + interface Dict) | `node scripts/lint-i18n.mjs` |
| Nhất quán phiên bản (manifests + tên release README) | `node scripts/lint-versions.mjs` |
| Render markdown của đề bài | `node --experimental-vm-modules scripts/test-tmath-md.mjs` |
| Bảo mật unwrap bundle | chỉ ở máy maintainer — công cụ relay bị gitignore, không chạy được trên CI/clone mới |
| Toàn vẹn phiên đăng nhập | `node --experimental-vm-modules tools/verify-session-integrity.mjs` |
| Security markup | `node --test scripts/security-markup.test.mjs` |

Ghi chú pass #75: các dòng phụ trước đây (transport-probe, công thức
stop-semantics CPH, solve-jsdom) nằm dưới `tools/claude11/verify/` — payload
lane đó đã bị xoá; bộ i18n lint được vendor về `scripts/i18n-lint.mjs`
(`scripts/lint-i18n.mjs` là wrapper). Harness transport-probe vốn đã mục ruỗng
(0/6 — fixture VM của nó từ chối `import "./applog"` của transport.ts).

Caveat môi trường (ghi ngày 2026-10-25): trên máy dev hiện tại, binary g++ (MinGW)
khi bị spawn thì segfault và `python3` trên PATH là Store stub, nên các cph test
cần g++/python thật sẽ đỏ ở đây. Bộ stop-semantics miễn nhiễm (fixture build bằng
rustc). Kết quả đỏ chưa phải là regression của code cho đến khi bạn loại trừ
yếu tố máy.

## Nghi thức phát hành

1. Pass entry vào `todo.md` (what / why / gates / hashes).
2. Toàn bộ gate trên xanh; output `vite build` mới (co chừng stale-dist).
3. Bump version theo luật hai cách viết: tên release `delcc-v0.2.1a-alpha`,
   trường máy `0.2.1-alpha` (package.json, Cargo.toml, tauri.conf.json — cả ba
   phải khớp nhau).
4. Stage `../ship-staging/delcc-v<name>/`: binary, README.txt (EN+VI, what's-new,
   network use trung thực, limitations), `hash.txt` (SHA256 của exe + zip).
5. Zip, ghi cả hai hash vào pass entry.

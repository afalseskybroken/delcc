# ARCHITECTURE.vi.md — delcc được lắp ráp thế nào, và vì sao

Đọc [README.vi.md](README.vi.md) trước (đây là gì, luật versioning), rồi tới
tài liệu này, rồi [SECURITY.vi.md](SECURITY.vi.md) (hợp đồng mạng). Bản gốc
tiếng Anh: [ARCHITECTURE.md](ARCHITECTURE.md). Đường dẫn file tính từ thư mục
này. Thuật ngữ kỹ thuật giữ nguyên tiếng Anh cho khớp với codebase.

## Bức tranh lớn

Một app Tauri v2: shell Rust sở hữu webview hệ thống, chạy frontend TypeScript
không framework. Hai tiến trình, một hợp đồng giữa chúng:

- **Phía Rust** (`src-tauri/src/`): proxy HTTP (`api_fetch`), trình chạy CPH
  cục bộ (`cph.rs`), liệt kê font (`fonts.rs`), mở URL (`open_url`), chọn layout
  (`get_layout`). Shell là bên nói chuyện — xem mục Transport.
- **Frontend** (`src/`): TS thuần, render bằng template string vào DOM. Không
  framework, không router library — routing dựa trên hash ngay trong class shell.
  Dependencies cố tình ít: monaco (editor), katex (công thức), dompurify
  (sanitizer), Tauri api.

Vì sao không framework: toàn bộ UI chỉ là một nắm view được render lại toàn phần
mỗi lần điều hướng, với chuỗi dispose tường minh. Thứ đó nhìn thấy được, debug
được, và thân thiện với relay (friend/agent có thể nắm trọn một file trong đầu).
Nếu bạn đưa framework vào, bạn đang bắt successor trả tiền cho sở thích của bạn —
hãy viết lý do ra giấy trước.

## Boot mode và các tree

`src/main.ts` chọn layout khi boot qua `getLayout()`:

- `baseplate` — UI tab gốc ổn định (luồng Phase 0+1).
- `wip` — bản thử nghiệm home-grid sớm, giữ để tham chiếu.
- `tmath` — boot `src/tmath/index.ts` → class shell độc lập trong
  `src/tmath/app.ts`, layout người dùng đang chạy (nhánh parity).

Chế độ trình duyệt thuần (`npm run dev`) đủ cho login/danh sách; mọi thứ cần
shell (custom headers, CPH, lượt gọi bỏ qua CORS) cần build Tauri đầy đủ. Lớp
transport làm ranh giới này tường minh — xem bên dưới.

## Transport — `src/lib/transport.ts`

Điểm nghẽn mạng duy nhất (xem SECURITY.vi.md cho toàn bộ bề mặt). Thứ tự ưu tiên:

1. **Rust `api_fetch`** — được chọn khi một probe module-level tìm thấy bridge
   Tauri (`window.__TAURI_INTERNALS__` tồn tại). Probe là một promise dùng chung:
   N caller đầu chạy đồng thời chỉ tạo đúng MỘT probe, và kết quả của nó (có
   bridge / null) được cache cho cả session. Test:
   `tools/claude11/verify/transport-probe.test.ts`.
2. **`fetch` của WebView** — phương án dự phòng cho trình duyệt thuần.

Vì sao Rust-first: fetch stack của WebView từng chết với `Failed to fetch` ở ô
check box trong khi curl đi xuyên suốt; reqwest của shell thì không. Custom
headers (`X-Client-Version`, `X-Device-Id`) đi trên mọi lượt gọi trong build
Tauri, đúng tư thế của client chính thức.

## Lớp API — `src/lib/api.ts`

Wrapper có kiểu trên `transport()` cho hợp đồng đã tài liệu hoá
(`../docs/api-docs.md`, bản máy đọc ở `../tools/openapi-frontend.json`).
Quy ước:

- **Error model**: mọi lỗi server hiện dưới dạng câu chữ dễ hiểu theo từng mã
  (401/403/404/409/422/426/429), không bao giờ là mã trần. `ApiError` mang theo
  mã gốc.
- **Client version trung thực**: `X-Client-Version` được giải tại boot từ
  chính feed `client-releases/current` của sàn — delcc báo phiên bản chính thức
  mới nhất để không bị chặn as "quá cũ" (426). Đây là chủ đích, đã tài liệu
  hoá, không phải mẹo.
- API dùng JWT bearer; token đến từ `src/lib/auth.ts` (silent refresh trước hạn
  60 giây, refresh lúc boot, listener thay đổi token).

## Định danh — `src/lib/profiles.ts`, `src/lib/google.ts`

Mô hình multi-profile cục bộ: mỗi profile = username + token / mật khẩu lưu
(optional) (khoảng trống vault được ghi thẳng trong SECURITY.vi.md). Quick-login
giữ refresh token theo profile; một session khôi phục mà hoá ra thuộc tài khoản
khác sẽ bị vô hiệu lúc boot (không bao giờ dùng token của người khác). Đăng nhập
Google là PKCE qua máy chủ: start → browser → poll → account.

**Trộn session** (`tmath/app.ts identify()`): `/bootstrap` mang tóm tắt user;
`/me` mang chi tiết đầy đủ. Chúng được trộn, không thay thế, và cả hai cách viết
(`gravatar_hash` / `gravatarHash`) đều được chấp nhận vì wire dùng snake_case
trong khi vài bề mặt mang camelCase.

**Luật Gravatar** (kiểm chứng live 2026-10-25 — xem
`../research/gravatar-investigation-2026-10-25.md`): server chỉ giao
`gravatar_hash` cho **chính chủ, và chỉ khi tài khoản đó có email đăng ký
Gravatar**; hash của người khác luôn null. Avatar vì thế chỉ render cho *bạn*,
người khác là letter-fallback — giống hệt client chính thức. Component avatar
validate `^[a-f0-9]{64}$` lúc render, gọi `?s=size*2&d=404&r=g` với
`no-referrer`, và ẩn ảnh khi lỗi (`d=404` khiến letter-fallback hoạt động).

## Shell tmath — `src/tmath/app.ts`

Một class, view định tuyến bằng hash (contests / problems / workspace /
submissions / rankings / account / settings), mỗi view = template string + wiring
event + disposer (tuỳ chọn):

- `render()` tăng generation, dispose view trước, dispatch. View nhận `alive()`
  và phải bail nếu đã stale.
- `disposeView` là một **chuỗi**: view sinh sub-view (workspace → solve) sẽ
  compose disposer để không gì leak (bài học F27: mọi interval/observer vào
  chuỗi ngay tại lúc được tạo).
- Render đề bài: markdown-ish → KaTeX, rồi DOMPurify; iframe chỉ sống với origin
  embed YouTube. Văn bản Giới thiệu: markdown trước, sanitize sau.
- Editor: monaco, autosave draft theo ngôn ngữ với revision gating.
- Bài nộp/verdict: poll (2 giây) với verdict mapper dùng chung
  (`src/lib/verdict.ts`) và bảng màu kết quả chính thức.
- i18n: ba locale (`src/i18n/`, `en-US` / `vi-VN` / `zh-CN`), dict phẳng theo
  khoá chấm, kiểu qua `Dict`; lint drift ở
  `tools/claude11/verify/i18n-lint.mjs` (exit 1 + báo cáo JSON khi lệch khoá).
- Preferences/theme: `src/tmath/preferences.ts`, light/dark/system.

## CPH — trình chạy cục bộ (`src-tauri/src/cph.rs`, UI ở `src/tmath/solve.ts`)

Biên dịch và chạy against test case tự nhập, không mạng, không sandbox (đó là
code của người dùng chạy với quyền của người dùng — ghi thẳng trong source,
không chôn ở đâu cả). Cấu trúc then chốt:

- **Detect** (`cph_detect`): dò toolchain trên PATH; một probe phải THÀNH CÔNG
  và tự in phiên bản (chặn app-execution-alias stub của Windows Store — thứ exit
  9009 kèm câu marketing).
- **Một job tại một thời điểm**: slot `active` duy nhất (`JobGuard`) là cái mà
  Stop nhắm vào; job thứ hai khi đang có job bị từ chối. `cph_stop` đặt cờ;
  vòng poll của runner kill cả cây tiến trình trong ~15 ms (`taskkill /T /F` trên
  Windows, kill theo process-group trên unix).
- **Build cache**: `hash(lang, binary, source)` — source không đổi thì bỏ qua
  compiler; build bị thay thế/thất bại đều dọn temp dir trên mọi đường chạy.
- **Verdict**: AC/WA (so sánh đã chuẩn hoá khoảng trắng), RE, TLE (wall-clock
  poll + tree kill), RAN (không có expected output), CANCELLED, MLE chỉ khi bật
  feature `job-mem-cap` (Windows Job Object; FFI CHƯA KIỂM CHỨNG, cố tình nằm
  sau feature flag — xem comment module).
- **Giới hạn output**: 1 MiB/stream; vượt là RE tường minh, không bao giờ là WA
  bị cắt cụt.

Test: `tools/claude11/verify/cph_tests.rs` (`mod t` + `mod stop_semantics`, chạy
qua công thức scratch-crate ở header file) và
`tools/claude11/verify/cph_capture_tests.rs`.

## Dữ liệu tại máy

Mọi thứ người dùng thấy là `localStorage` với khoá tiền tố `delcc-` (profiles,
auth, drafts, preferences, sidebar, subs filters, sort order). Không file, không
sqlite. CPH dùng temp dir cho từng lần chạy. Danh mục đầy đủ và các khoảng trống:
SECURITY.vi.md.

## Verification gates (danh sách chuẩn của nhà)

Chạy trước khi gọi là xong (Pass #38 là tiền lệ):

1. `npx tsc --noEmit` — 0 lỗi
2. `node tools/claude11/verify/i18n-lint.mjs src/i18n` — exit 0
3. `npm run build` — tsc + vite, sạch (co chừng stale-dist: xác nhận không có
   vite dev đang chạy trước khi cargo build)
4. `cargo build` trong `src-tauri/` — **xác minh exit code thật** (xem cảnh báo
   pipe-eaten-exit ở mục versioning; nó từng phí mất một đêm)
5. `cargo test` qua scratch crate cho cph test (công thức ở header test; lưu ý
   caveat môi trường về g++/python3 đã ghi trong queue)
6. `node tools/claude11/verify/transport-probe.test.ts src/lib/transport.ts`
7. Session integrity: `tools/verify-session-integrity.mjs`

## Phương pháp luận (phần đáng được kế thừa)

1. **Contract-first**: bề mặt API là `../docs/api-docs.md` +
   `../tools/openapi-frontend.json`. delcc hiện thực hợp đồng; không định nghĩa
   lại. Hợp đồng nói field là optional thì UI phải nói vậy.
2. **Parity hành vi bằng quan sát**: nơi hành vi client chính thức quan trọng,
   delcc khớp hành vi quan sát được và viết lý do vào code dưới dạng comment có
   con trỏ bằng chứng (offset, ngày, kết quả test), để người sau tái suy ra thay
   vì tái tranh cãi.
3. **Sổ cái**: mỗi pass log what/why/hashes/gates vào `todo.md`. Công việc phân
   tán, chạy bằng relay vẫn giữ được tính nhất quán là nhờ cái này. Giữ nó.
   (Lưu ý: `todo.md`/`states.md` là file làm việc riêng của maintainer — đi theo
   workspace, không đi theo repo công khai; fork repo thì mở sổ cái của riêng bạn.)
4. **Lý thuyết bị sửa thì ghi là đã sửa** (xem mục "do not re-litigate" trong
   note gravatar) để successor không đào lại đáy chết.

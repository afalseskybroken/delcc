# SECURITY.vi.md — hợp đồng client trung thực

Lời hứa của delcc đơn giản: **bạn đọc được mọi thứ nó làm.** File này là bản tóm
tắt có thể kiểm toán. Nếu code và file này mâu thuẫn thì một trong hai là bug —
report, và sửa cái sai. Bản gốc tiếng Anh: [SECURITY.md](SECURITY.md).

## Toàn bộ bề mặt mạng (tính từ 0.3.37-alpha)

| Điểm đến | Khi nào | Vì sao |
|---|---|---|
| `oj.tmathcoding.vn/api/v3/*` | toàn bộ traffic API | sàn thi đấu: auth, contests, problems, submissions, leaderboard, manifest client-release |
| `oj.tmathcoding.vn/api/v3/client-releases/downloads` POST | chỉ khi bạn bấm nút "open official installer" trên banner cập nhật | bộ đếm tải của chính feed release — cùng lệnh gọi mà client chính thức thực hiện; chỉ mang channel, platform và release id, không có gì về bạn |
| `oj.tmathcoding.vn/<trang profile người dùng>` | chỉ khi xem profile của người dùng khác | đọc trang profile **công khai** của site — đúng những byte mà bất kỳ browser ẩn danh nào cũng nhận được, CORS mở — để lấy hash gravatar mà chính site công bố ở đó. Được validate, cache tại máy (giới hạn FIFO); một GET *thành công* mỗi người dùng, trượt thì thử lại ở lần xem sau. Do shell Rust (`site_fetch`) thực hiện — các trang này không có header CORS cho webview. Xem `src/tmath/avatars.ts`. |
| `api.github.com/repos/afalseskybroken/delcc/releases?per_page=1` | một lần mỗi lần khởi động (pass #134, chấm trạng thái update ở footnote) | kiểm tra READ-ONLY xem có bản delcc mới hơn không — chấm màu ở footnote của sidebar (xanh [Đã mới nhất] / đỏ [Có bản cập nhật], bấm mở trang phát hành). Feed client-releases của sàn không thể trả lời câu này (delcc nhận phiên bản client mà feed đó yêu cầu, qua shim ở trên, nên luôn "đồng bộ" với sàn một cách hiển nhiên). Không mang token hay cookie; `Accept: application/vnd.github+json` + user agent delcc; timeout 10 s; cùng giới hạn 8 MiB như mọi đường byte khác; URL được ghim vào đúng một host:path bên trong lệnh `update_check` — nội dung webview không thể nhắm nó đi đâu khác; lỗi thì chấm chuyển xám trung tính (không bằng chứng, không khẳng định) |
| `www.gravatar.com/avatar/<sha256>` | mỗi khi có hash gravatar: của chính bạn VÀ của người dùng khác — hash lấy từ trang profile công khai qua `site_fetch` và từ các danh sách công khai | ảnh avatar, gợi với `referrerpolicy="no-referrer"`, `d=404` nên không thứ gì khác được fetch |
| `www.youtube-nocookie.com/embed/<id>` (+ `www.youtube.com/embed/<id>`) | chỉ khi About của một profile nhúng video YouTube (client chính thức render cùng kiểu embed) | iframe sanitizer CHỈ giữ cho hai origin này (kiểm tra scheme+host+path); CSP `frame-src` của app đóng khung đúng hai host đó |

Các request tự mang theo gì, công khai: call có xác thực mang `Authorization: Bearer <token>`;
POST nộp bài và đọc chi tiết bài mang `X-Device-Id` (một định danh ngẫu nhiên `delcc-…`
mới theo mỗi lần khởi app, chỉ nằm trong bộ nhớ, không suy ra từ gì cả — không phải phần cứng,
không phải tài khoản, không bao giờ lưu; key cũ đã lưu bị xoá khi tải) và `X-Client-Version`, báo phiên bản mới nhất từ feed release chính thức thay vì phiên bản
của delcc — sàn 426-chặn chuỗi cũ hơn, nên shim này chịu tải cho bất kỳ client độc lập nào. Phán
quyết của maintainer 2026-10-29: sàn không công bố ToS nào, và shim được công khai rõ ràng
(README §thông báo, `src/lib/api.ts`) — che giấu mới là điều doctrine cấm, không phải shim.

Hết. Cụ thể là KHÔNG có:

- không analytics, metrics hay usage reporting — với đúng một ngoại lệ trong bảng
  phía trên: bộ đếm tải của feed release, chỉ chạy khi bạn bấm nút installer trên
  banner (được thêm vào bảng này ở pass #123; trước đó lệnh gọi đã tồn tại trong mã
  mà không có hàng nào ở đây — đúng kiểu mâu thuẫn mà quy tắc mở đầu của file này
  sinh ra để bắt)
- không crash reporting hay upload lỗi
- không tự động tải update (manifest release chỉ được *đọc*; binary là bạn —
  con người — tự tải từ trang release)
- không CDN/font/script bên thứ ba — mọi asset đi kèm bundle. Markdown trong ô
  Giới thiệu có thể chứa ảnh **remote** (pass #83 khôi phục theo pass #78 — He: cô
  lập, đỡ cụt tính năng): ảnh tải qua lệnh `asset_fetch` của shell, KHÔNG qua webview
  — https-only, chỉ nhận `image/*`, giới hạn 2 MiB (stream-enforced từ #141), không
  bao giờ đính kèm cookie/token, và host được resolve-một-lần + verify-mọi-địa-chỉ +
  pin từ pass #96; từ pass #142 MỖI hop redirect đi qua đúng quy trình resolve →
  verify → pin đó (redirect tự động bị TẮT). Ảnh fail/lớn quá → render thành link
  thường (tối đa 8 ảnh/pane, phần thừa thành link). Cả hai luồng ảnh (asset_fetch và
  gravatar) nằm trong bảng trên
- trình chạy CPH cục bộ (`src-tauri/src/cph.rs`) không bao giờ chạm mạng — nó
  biên dịch và chạy *code của bạn* trên *máy của bạn*. Từ pass #159 bước RUN được
  sandbox (xem khối Pass #159 bên dưới); bước compile và debug lane giữ tư thế
  lịch sử (không bọc launcher, chạy ở medium integrity của người gọi). Pass #166
  (wave-10 S1) nói rõ hệ quả: debug lane (`debug_start`) là **đường thực thi KHÔNG
  sandbox mà page chạm tới được với toàn quyền của user**; sandbox restricted-token
  chỉ là **defense-in-depth riêng cho Run, KHÔNG phải ranh giới chống page bị chiếm**
  — page bị chiếm không cần đánh bại sandbox, nó chỉ cần gọi debug lane. Ranh giới
  page (CSP, các sanitizer, boot gate) mới là bức tường thật

Mã mạng nằm ở ba nơi có tên rõ ràng. `src/lib/transport.ts` chở toàn bộ lưu lượng
API (shell Rust trước, `fetch` WebView dự phòng). Hai ngoại lệ `fetch` trực tiếp có
chủ đích: `src/lib/verdict.ts` (stream SSE kết quả chấm) và `src/tmath/avatars.ts`
(GET trang profile công khai, đi qua lệnh `site_fetch` của shell). Kiểm toán bề mặt
mạng = đọc ba file đó.

Bảo vệ đường dẫn (pass #163, wave-12 W12-24/25): `api_fetch`/`site_fetch` từ chối path
không bắt đầu bằng `/`, chứa `..` literal, hoặc dạng canonical của nó
(`reqwest::Url::parse`, chuẩn hoá các dot-segment mã hoá đơn `%2e%2e`) rời khỏi
`/api/v3`. Redirect được kiểm tra lại scheme+host mỗi hop (judge đã ghim), nên redirect
cùng host vẫn nằm trong origin tin cậy — path không được re-scope mỗi hop, nhưng judge
tự redirect chính nó là trong ranh giới tin cậy, không phải escape cross-origin. Phần
còn lại (W12-25, giả thuyết): `%252e%252e` mã hoá KÉP sống sót qua canonicalization
(parser giải `%25`→`%` một lần và không quét lại) và lọt qua bảo vệ phía client; để thoát
`/api/v3` khi đó cần SERVER giải mã kép path. Judge (Django/DRF trên WSGI) giải mã một
lần, nên không thể chạm tới với nó — công khai, không phải lỗ hổng sống.

Đường đọc nặng duy nhất là **chỉ mục bài tập**. Trang Bài tập có bộ lọc tiến độ
(đã giải / đã thử / chưa đụng tới), mà API công khai không cho biết trạng thái
giải của từng người — nên lần đầu mở, delcc đọc danh sách bài công khai theo
từng trang (năm request song song, nhận biết trang ngắn, có chặn trên), cộng
`solved_problems` của chính bạn và các bài nộp của chính bạn. Chỉ mục đó chỉ nằm
trong bộ nhớ, mất khi đóng delcc, và bật bộ lọc khi quét xong; trước đó bộ lọc
hiện rõ là bị tắt kèm dòng tiến độ. Không ghi key lưu trữ nào.

## Dữ liệu xác thực tại máy — bức tranh trung thực (tính từ 0.2.26-alpha)

- Refresh token nằm trong **secure store mã hoá DPAPI** (pass #78): shell Rust
  mã hoá bằng `CryptProtectData` và ghi blob vào
  `%APPDATA%\vn.delcc.app\secure\*.bin`. `localStorage` của webview không còn
  giữ token; các bản plaintext trước #78 (`delcc-auth`, `delcc-profiles`) được
  migrate ở lần boot đầu rồi bị xoá. Trường hợp xấu nhất của migration thất bại
  là đăng nhập lại một lần (lỗi được log trong Settings → Diagnostics, không
  bao giờ im lặng).
- **DPAPI không phải sandbox.** Nó ở scope user và gắn vào máy: malware đã
  chạy bằng user Windows *của bạn* giải mã được các blob này, y như nó có thể
  đánh cắp entry Credential Manager của client chính thức. Điều migrate này
  mua được: mối đe doạ dịch từ "đọc được file plaintext" thành "chạy code bằng
  user" — đúng ranh giới mà mọi client local (cả của mình lẫn chính thức) đang
  đứng sau. Khi đang dùng, token vẫn đi qua IPC của webview và nằm trong bộ
  nhớ dưới dạng Bearer header — điều vốn có của một webview client, nói rõ ở
  đây thay vì giấu.
- Dev bằng browser thường (không có shell Tauri) vẫn dùng localStorage
  plaintext — đó là lane dev, không phải tư thế ship.
- Quick-login (tuỳ chọn) có thể lưu mật khẩu theo profile: lane vault
  (`src/lib/vault.ts`, AES-GCM sau hash PBKDF2) không đổi bởi #78; việc nối nó
  vào layout tmath vẫn nằm trong hàng đợi.
- Để so sánh: client chính thức lưu refresh token trong Windows Credential
  Manager (DPAPI, scope user) và đã bị quan sát thấy mang credential qua bề mặt
  IPC dạng plaintext. delcc giờ đạt tư thế at-rest tương đương và công khai
  đường IPC của mình.

Giảm thiểu khả dụng hiện tại: profile có thể không token (`needsReauth`), tính
năng khoá chặn việc dùng profile sau một hash, và đăng xuất xoá session đã lưu
(blob secure store cùng các key localStorage).

## Dữ liệu khác tại máy

- drafts/filters/preferences: khoá `localStorage`, toàn bộ tiền tố `delcc-`
  (drafts, preferences, sidebar, sort orders, subs filters, con trỏ profile
  đang hoạt động)
- token + profile đã lưu: blob mã hoá DPAPI tại
  `%APPDATA%\vn.delcc.app\secure\*.bin` (như trên)
- build dir CPH: temp dir mỗi lần chạy (`delcc-cph-*`), bị xoá trên mọi đường
  chạy; cache dir bị xoá khi app thoát qua `cleanup()`. Dừng chạy gọi `taskkill.exe` bằng đường dẫn tuyệt đối từ
  `%SystemRoot%\System32` (chỉ dùng tên trần khi không lấy được biến môi trường),
  nên một `taskkill.exe` đặt cạnh app không thể che khuất nó (#154)

## Cảnh báo phụ thuộc (tính tới 0.3.20-alpha)

Pass #117 xử lý đợt quét RustSec đầu tiên mà cây mã này từng có (cargo-audit 0.22.2,
1.395 advisory, chạy ngày 2026-11-01): `rustls-webpki` 0.103.15 → 0.103.16
(RUSTSEC-2026-0382 — việc xác minh chứng chỉ có thể chấp nhận intermediate bị thu hồi
niềm tin) và `webpki-root-certs` 1.0.9 → 1.0.11 (RUSTSEC-2026-0383 — bộ root đóng gói
sẵn tin các intermediate emSign đã bị thu hồi niềm tin). Cả hai nằm trên đường xác
minh TLS của mọi lệnh gọi HTTPS mà shell thực hiện (`reqwest` → `rustls`), nên bản
vá chạy trong binary, không chỉ trong lockfile — đã xác minh bằng `cargo tree`.
Advisory npm chuỗi dev tìm thấy trong cùng đợt quét (lỗi `server.fs.deny` của vite,
GHSA-8g5g-mxqh-grgj, mức moderate) chỉ ảnh hưởng dev-server và cũng được nâng trong
cùng pass (6.4.5). Công cụ quét được giữ lại để các pass sau chạy lại; gate npm production
vẫn là audit của CI.

## Reporting

Báo cáo tại **https://github.com/afalseskybroken/delcc/issues** — với nội dung
nhạy cảm, đánh dấu riêng tư qua form issue hoặc mở một issue công khai tối thiểu
trước và hỏi kênh riêng tư. Cách kiểm toán nhanh nhất vẫn là `git grep fetch`
cộng với đọc `src/lib/transport.ts`.

## Bất di bất dịch (lặp lại từ SUCCESSION.vi.md vì nó thuộc về đây)

1. Bề mặt mạng ở trên là đóng. Mọi thay đổi thêm lượt gọi phải cập nhật file
   này trong cùng commit.
2. Không hành vi ẩn: không thứ gì ship mà người đọc source không thấy được.
3. Khoảng trống được ghi lại, không bao giờ bị che giấu.


## Pass #159/#160 — sandbox làm run-path (sửa đổi pass #163, wave-12 W12-01/02/08)

Bước RUN của code contest không tin cậy thực thi dưới RESTRICTED token qua
launcher của delcc: intermediate tự hạ token CỦA CHÍNH NÓ (mọi privilege bị
disable, group Administrators bị deny-only, group NETWORK bị deny-only
best-effort, integrity level là LOW), và thư mục temp của phiên chạy mang LOW
mandatory label (góc ghi duy nhất của tiến trình sandbox). Nó là FAIL-CLOSED:
self-restriction lỗi thì run bị từ chối (launcher exit 3 kèm lý do trên stderr)
— KHÔNG có fallback về spawn thường. Bước COMPILE (toolchain tin cậy, đã
allowlist) và debug lane KHÔNG được bọc launcher; chúng chạy ở medium integrity
của người gọi, đúng tư thế lịch sử. Pass #166 (wave-10 S1) nói rõ hệ quả: debug lane
(`debug_start`) là **đường thực thi KHÔNG sandbox mà page chạm tới được với toàn quyền
của user** — debuggee chạy ở TOÀN quyền user (không sandbox), KHÁC với Run đã sandbox,
nên bán kính ảnh hưởng của nó LỚN HƠN một run đã sandbox chứ không bằng nhau (lối viết
"cùng bán kính ảnh hưởng như một run thường" đã lạc hậu từ khi có sandbox Run #159).
Sandbox restricted-token vì thế là **defense-in-depth riêng cho Run, KHÔNG phải ranh
giới chống page bị chiếm**: page bị chiếm không cần đánh bại nó, chỉ cần gọi debug lane.
Ranh giới page (CSP, các sanitizer, boot gate) mới là bức tường thật. Pass #163
khôi phục ranh giới này: #159–#161
đã vô tình bọc cả bước compile, làm hỏng biên dịch C++/Rust — compiler
low-integrity không ghi được file temp trung gian vào `%TEMP%` medium-integrity
của user (Windows MIC no-write-up). Công bố còn lại: deny group NETWORK là
best-effort (token logon interactive thường không mang S-1-5-2) và chỉ chặn kết
nối có xác thực — LOW integrity KHÔNG chặn lượt gọi ra ngoài với quyền của user;
response của run mang cờ `sandboxed` (true khi mọi case chạy được bọc với góc
temp đã label) để chẩn đoán, nhưng UI hiện tại không hiển thị nó như một badge.

## Consent toolchain & debugger — phần còn lại công khai (pass #163, wave-12)

Mô hình consent confirm-once (toolchain đặt sẵn, debugger PATH, override Settings) là
mô hình **trust-on-first-use, theo chuỗi đường dẫn**. Giới hạn của nó, nói rõ:

- **Consent đi theo đường dẫn, không theo file (W12-15).** Chấp nhận và từ chối được ghi
  theo chuỗi đường dẫn trong các set `confirmed_fixed` / `refused_fixed` dùng chung, cho
  CẢ compiler lẫn debugger (`consent_debugger`). Không ghim danh tính file (hash,
  size+mtime, hay signer). Hai hệ quả: một file đã confirm có thể bị **tráo** (cùng đường
  dẫn, byte mới) và chạy mà không hỏi lại; và một đường dẫn đã confirm là *compiler* được
  tự động chấp nhận là *debugger*. Ranh giới nó đứng sau: kẻ tấn công local ghi đè được
  toolchain đã confirm thì đã có quyền ghi vào thư mục toolchain của bạn — đúng ranh giới
  mọi client local (cả của mình lẫn chính thức) đang đứng sau. Việc ghim nội dung nằm
  trong hàng đợi.
- **Follow symlink trong lớp user-tin-cậy (W12-13).** Từ chối reparse-point C5
  (`symlink_metadata`, không bao giờ follow symlink) phủ các gốc discovery kẻ tấn công
  đặt được: glob fixed-root, quét extension VS Code, `walk_find`, *detection* Java
  sibling, và fpc. Nó cố ý KHÔNG phủ `resolve_in_path` (phân giải PATH), kiểm tra
  `is_file` của override Settings, Java sibling lane run, hay `find_gdb` — các chỗ đó
  follow symlink vì entry PATH hợp lệ (`python3` → `python3.12`) và override user đăng ký
  VỐN là symlink; từ chối chúng sẽ hỏng detection và việc ghim thực thi #163. Một symlink
  đặt trong thư mục PATH hoặc đăng ký làm override do đó có thể chuyển hướng sang
  executable khác; cả hai là input user kiểm soát, không phải fixed-root kẻ tấn công đặt được.
- **Coalescing dialog và cooldown (W12-14).** Detection tuần tự hoá trên một async gate
  (`detect_gate`) giữ xuyên suốt dialog planted-candidate — coalescing có chủ đích để các
  detection đồng thời không hỏi trùng hay spawn-storm; một câu trả lời chậm chặn các
  detection khác tới khi nó xong. Dialog override Settings do page điều khiển
  (`cph_set_override`) bị chặn nhịp bằng cooldown trong bộ nhớ (2 s toàn cục, 5 s mỗi
  đường dẫn, tối đa 128 đường dẫn được theo dõi, cũ nhất bị loại) để page không thể mở mỗi
  lệnh gọi một modal. Cooldown bị quên khi restart; consent thì không. Từ chối override cố
  ý KHÔNG sticky — đăng ký lại override là lối thoát đổi ý của user (từ chối
  planted-candidate THÌ sticky).
- **Hàng đợi event debugger (W12-19).** Hàng đợi event gdb mỗi phiên bị chặn ở 512 record,
  drop-oldest — chặn theo SỐ LƯỢNG (mỗi record ≤ line cap 256 KiB, nên ~128 MiB trường hợp
  xấu nhất dưới một debugger đã approve bị hỏng). Pass #163 sửa desync: `wait_stopped` giờ
  drain tới `*stopped` kế tiếp, bỏ qua các notification `=thread-*` / `=library-loaded` /
  `*running` mà `transact` xếp hàng, thay vì đưa `snapshot` record đầu tiên bất kỳ loại
  nào. Phần còn lại: một trận lụt >512 event trong một transaction vẫn có thể loại
  `*stopped` trước khi nó được tiêu thụ; wait khi đó timeout trung thực (một step lỗi,
  không phải desync). Hàng đợi theo byte-budget nằm trong hàng đợi. Mô hình đe doạ xuyên
  suốt là một debugger đã được approve — tin cậy để chạy code của bạn.

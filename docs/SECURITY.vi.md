# SECURITY.vi.md — hợp đồng client trung thực

Lời hứa của delcc đơn giản: **bạn đọc được mọi thứ nó làm.** File này là bản tóm
tắt có thể kiểm toán. Nếu code và file này mâu thuẫn thì một trong hai là bug —
report, và sửa cái sai. Bản gốc tiếng Anh: [SECURITY.md](SECURITY.md).

## Toàn bộ bề mặt mạng (tính từ 0.2.26-alpha)

| Điểm đến | Khi nào | Vì sao |
|---|---|---|
| `oj.tmathcoding.vn/api/v3/*` | toàn bộ traffic API | sàn thi đấu: auth, contests, problems, submissions, leaderboard, manifest client-release |
| `oj.tmathcoding.vn/<trang profile người dùng>` | chỉ khi xem profile của người dùng khác | đọc trang profile **công khai** của site — đúng những byte mà bất kỳ browser ẩn danh nào cũng nhận được, CORS mở — để lấy hash gravatar mà chính site công bố ở đó. Được validate, cache tại máy (giới hạn FIFO); một GET *thành công* mỗi người dùng, trượt thì thử lại ở lần xem sau. Do shell Rust (`site_fetch`) thực hiện — các trang này không có header CORS cho webview. Xem `src/tmath/avatars.ts`. |
| `www.gravatar.com/avatar/<sha256>` | chỉ khi server giao hash gravatar của chính bạn (self-view, tài khoản có email đăng ký Gravatar) | ảnh avatar của bạn, gọi với `referrerpolicy="no-referrer"`, `d=404` nên không thứ gì khác được fetch |

Hết. Cụ thể là KHÔNG có:

- không analytics, metrics hay usage reporting
- không crash reporting hay upload lỗi
- không tự động tải update (manifest release chỉ được *đọc*; binary là bạn —
  con người — tự tải từ trang release)
- không CDN/font/script bên thứ ba — mọi asset đi kèm bundle. Markdown trong ô
  Giới thiệu cũng không thể trỏ `<img>` tới host tùy ý: từ pass #78, ảnh remote
  trong About của người khác render thành **link** thường (client chính thức cắt
  hẳn ảnh remote; link là điểm trung gian trung thực của mình), nên lần fetch ảnh
  duy nhất của app là avatar gravatar trong bảng trên
- trình chạy CPH cục bộ (`src-tauri/src/cph.rs`) không bao giờ chạm mạng — nó
  biên dịch và chạy *code của bạn* trên *máy của bạn*, không sandbox, y như tự
  bạn chạy nó trong terminal

Mã mạng nằm ở ba nơi có tên rõ ràng. `src/lib/transport.ts` chở toàn bộ lưu lượng
API (shell Rust trước, `fetch` WebView dự phòng). Hai ngoại lệ `fetch` trực tiếp có
chủ đích: `src/lib/verdict.ts` (stream SSE kết quả chấm) và `src/tmath/avatars.ts`
(GET trang profile công khai, đi qua lệnh `site_fetch` của shell). Kiểm toán bề mặt
mạng = đọc ba file đó.

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
  chạy; cache dir bị xoá khi app thoát qua `cleanup()`

## Reporting

Chưa có tracker công khai — mục này là placeholder cho maintainer điền (issue
tracker / liên hệ) tại lần publish đầu. Trong lúc đó: cách kiểm toán nhanh nhất
là `git grep fetch` cộng với đọc `src/lib/transport.ts`.

## Bất di bất dịch (lặp lại từ SUCCESSION.vi.md vì nó thuộc về đây)

1. Bề mặt mạng ở trên là đóng. Mọi thay đổi thêm lượt gọi phải cập nhật file
   này trong cùng commit.
2. Không hành vi ẩn: không thứ gì ship mà người đọc source không thấy được.
3. Khoảng trống được ghi lại, không bao giờ bị che giấu.

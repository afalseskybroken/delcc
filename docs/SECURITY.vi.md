# SECURITY.vi.md — hợp đồng client trung thực

Lời hứa của delcc đơn giản: **bạn đọc được mọi thứ nó làm.** File này là bản tóm
tắt có thể kiểm toán. Nếu code và file này mâu thuẫn thì một trong hai là bug —
report, và sửa cái sai. Bản gốc tiếng Anh: [SECURITY.md](SECURITY.md).

## Toàn bộ bề mặt mạng (tính từ 0.2.1-alpha)

| Điểm đến | Khi nào | Vì sao |
|---|---|---|
| `oj.tmathcoding.vn/api/v3/*` | toàn bộ traffic API | sàn thi đấu: auth, contests, problems, submissions, leaderboard, manifest client-release |
| `oj.tmathcoding.vn/<trang profile người dùng>` | chỉ khi xem profile của người dùng khác | đọc trang profile **công khai** của site — đúng những byte mà bất kỳ browser ẩn danh nào cũng nhận được, CORS mở — để lấy hash gravatar mà chính site công bố ở đó. Được validate, cache tại máy (giới hạn FIFO); một GET mỗi người dùng, không hơn. Xem `src/tmath/avatars.ts`. |
| `www.gravatar.com/avatar/<sha256>` | chỉ khi server giao hash gravatar của chính bạn (self-view, tài khoản có email đăng ký Gravatar) | ảnh avatar của bạn, gọi với `referrerpolicy="no-referrer"`, `d=404` nên không thứ gì khác được fetch |

Hết. Cụ thể là KHÔNG có:

- không analytics, metrics hay usage reporting
- không crash reporting hay upload lỗi
- không tự động tải update (manifest release chỉ được *đọc*; binary là bạn —
  con người — tự tải từ trang release)
- không CDN/font/script bên thứ ba — mọi asset đi kèm bundle
- trình chạy CPH cục bộ (`src-tauri/src/cph.rs`) không bao giờ chạm mạng — nó
  biên dịch và chạy *code của bạn* trên *máy của bạn*, không sandbox, y như tự
  bạn chạy nó trong terminal

Điểm nghẽn duy nhất: `src/lib/transport.ts`. Mọi HTTP request đi qua
`transport()` (shell Rust trước, `fetch` WebView dự phòng). Kiểm toán bề mặt
mạng = đọc một file.

## Dữ liệu xác thực tại máy — khoảng trống đã biết, nói thẳng

- Refresh token nằm trong `localStorage` của webview (`delcc-profiles`,
  `delcc-auth`). Trên Windows, profile WebView ở
  `%LOCALAPPDATA%\vn.delcc.app\`. Đó là **plaintext tại máy** trên host.
- Quick-login (tuỳ chọn) có thể lưu mật khẩu theo profile. Đã có lane vault
  (`src/lib/vault.ts`, thiết kế stage ở `docs/passkeys-design.md`) nhằm thay thế
  việc lưu plaintext; cho tới khi nó ship, khoảng trống là thật.
- Để so sánh: client chính thức lưu refresh token trong Windows Credential
  Manager (DPAPI, scope user) và đã bị quan sát thấy mang credential qua bề mặt
  IPC dạng plaintext. Thái độ của delcc: ghi rõ mình lưu gì, ship lane vault
  trước khi tuyên bố điều ngược lại, không bao giờ giả vờ khoảng trống không
  tồn tại.

Giảm thiểu khả dụng hiện tại: profile có thể không token (`needsReauth`), tính
năng khoá chặn việc dùng profile sau một hash, và đăng xuất xoá session đã lưu.
Mã hoá cấp máy (DPAPI) cho token store là bước kế tiếp trong kế hoạch — xem
lane vault.

## Dữ liệu khác tại máy

- drafts/filters/preferences: khoá `localStorage`, toàn bộ tiền tố `delcc-`
  (profiles, auth, drafts, preferences, sidebar, sort orders, subs filters)
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

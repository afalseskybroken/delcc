# Đóng góp vào delcc

Đọc file này trước khi mở PR. delcc nhỏ, có cá tính rõ, và chạy trên kỷ luật
gate nghiêm ngặt — thay đổi không qua được các gate dưới đây sẽ không được
merge, và thay đổi "lách" gate sẽ bị revert. Giấy phép là **PolyForm
Noncommercial 1.0.0**: khi đóng góp, bạn chấp nhận công việc của mình được phân
phối dưới giấy phép đó (xem README §giấy phép).

## Chuẩn bị

- Node ≥ 22 (các bộ test dựa trên VM cần `--experimental-vm-modules` trên một
  số bản Node — lệnh dưới đây đã kèm flag; giữ nguyên)
- Rust stable + điều kiện tiên quyết của Tauri v2 cho hệ điều hành của bạn
  (Windows: WebView2 + MSVC — xem [BUILDING.vi.md](docs/BUILDING.vi.md))
- `npm ci` (không phải `npm install`) để cây thư mục tái lập được

## Các layout

`DELCC_LAYOUT` chọn lane UI lúc biên dịch: `baseplate` (mặc định, UI tab ổn
định), `wip` (bản thử nghiệm tham chiếu), `tmath` (nhánh đồng bộ chính thức —
nhánh người dùng đang chạy). Cả ba phải qua gate; từ điển i18n dùng chung cho
mọi lane. Thứ tự build quan trọng: **frontend (`vite build`) trước cargo** —
macro Rust `generate_context!` nhúng `../dist`, và sẽ lỗi khó hiểu nếu thư mục
đó vắng mặt hoặc đang ghi dở.

## Bộ gate (chạy hết, lấy exit code thật)

```
npx tsc --noEmit
node scripts/lint-i18n.mjs
node scripts/lint-versions.mjs
node --experimental-vm-modules scripts/test-tmath-md.mjs
node --experimental-vm-modules scripts/test-unwrap-bundle.mjs
node --experimental-vm-modules tools/verify-session-integrity.mjs
node --test scripts/security-markup.test.mjs
npx vite build
# với thay đổi Rust:
cargo build -j 1        # trong src-tauri/; profile release mang các flag đóng gói
```

Tuyệt đối đừng tin exit code sau đường ống (`cmd | tail; echo $?` trả về exit
của *tail*). Redirect vào file rồi đọc file.

- `lint-i18n` — mỗi khoá chuỗi UI phải tồn tại ở **cả en-US, vi-VN và zh-CN**
  lẫn interface `Dict` trong `src/i18n/index.ts`. Ba locale, không phải hai.
- `lint-versions` — `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json` phải cùng mang phiên bản máy `X.Y.Z-tag`, và
  heading "Tính năng hiện có" ở cả hai file README phải mang đúng tên release
  dạng người-đọc tương ứng (kiểu `v0.2.23a-alpha`). Bump phiên bản = cập nhật
  đủ 5 chỗ.
- `security-markup` — canh doctrine escape-first. Nếu thay đổi đụng vào các
  điểm chèn HTML, mở rộng bộ test trong cùng pass.

## Kiểu commit

Một vấn đề mỗi commit khi có thể. Prefix:

- `fix:` — sửa lỗi (ghi triệu chứng, và nguyên nhân nếu biết)
- `feat:` — hành vi mới
- `docs:` — chỉ tài liệu
- `release:` — bump phiên bản + artifact phát hành

## Tóm tắt doctrine (bản ngắn — toàn văn trong SUCCESSION.md)

1. **Thẳng thắn hơn bóng bẩy**: không nút giả, không luồng dựng phông, không
   cắt ngắn im lặng; tính năng không hoàn thành nổi một cách trung thực thì
   để ngoài và ghi vào phần hạn chế.
2. **Máy của người dùng là của người dùng**: chạy cục bộ không sandbox và nói
   rõ như vậy; không thứ gì gọi về nhà ngoài API của sàn, các trang profile
   công khai của sàn, và gravatar.com (avatar của chính mình). Mọi lượt gọi
   mạng mới đồng nghĩa cập nhật SECURITY.md **trong cùng pass**.
3. **Escape-first ở mọi nơi**: giá trị nội suy đi qua `esc()`; URL đi qua
   `safeUrl`; embed chỉ YouTube; DOMPurify là cổng cuối, không phải cổng duy nhất.
4. **Dữ liệu cục bộ là dữ liệu không tin**: mọi thứ nạp từ localStorage đều
   được kiểm chứng hình dạng và giới hạn. Đừng tin một id đã lưu.
5. **Token không bao giờ xuất hiện trong log, commit, hay tài liệu.**
6. **Hợp đồng API là chỉ-đọc**: không bịa endpoint; đối chiếu với spec sống
   (`https://oj.tmathcoding.vn/api/v3/openapi.json`).

## Những gì nằm ngoài repo này (private có chủ đích)

Sổ cái của maintainer (`todo.md`, `states.md`), bản mirror tài liệu API
(`../docs/api-docs.md`, `../tools/openapi-frontend.json`), và khu staging phát
hành là workspace riêng. Nếu tài liệu ở đây nhắc tới chúng, coi spec OpenAPI
sống là chuẩn công khai. Đừng "sửa" kiểu tham chiếu đó bằng cách xoá đi —
chú thích thay thế (xem README §Hợp đồng API để tham khảo cách làm).

## Pull request

PR nhỏ, một vấn đề mỗi PR, được duyệt nhanh nhất. Kèm theo: đã đổi gì và vì
sao, bạn đã chạy những gate nào (với exit code thật), và diff SECURITY.md nếu
bề mặt mạng dịch chuyển. Chỉ dùng phi thương mại (giấy phép trên) — PR thêm
telemetry, analytics, kiểm tra cập nhật ép buộc, hay endpoint không tài liệu
sẽ bị từ chối ngay tại chỗ.

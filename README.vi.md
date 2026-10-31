# delcc — client độc lập, minh bạch cho TMATH

> *"and in that light, I find deliverance"*
>
> *— và trong ánh sáng ấy, tôi tìm thấy sự giải thoát*

Đây **không phải** sản phẩm của TMATH. delcc là một client desktop độc lập cho
sàn lập trình thi đấu TMATH (`oj.tmathcoding.vn`), ra đời vì client chính thức
là closed-source và một bộ phận người dùng muốn có thứ gì đó họ đọc được, kiểm
toán được, tự sửa được. delcc chỉ nói chuyện với API công khai đã được tài liệu
hoá của sàn — không telemetry, không analytics, không hành vi ẩn. Toàn bộ các
lượt gọi mạng mà delcc có thể thực hiện được liệt kê trong
[SECURITY.md](docs/SECURITY.md); danh sách đó chính là lời cam kết.

Bộ tài liệu kỹ thuật có bản tiếng Việt đầy đủ: [ARCHITECTURE.vi.md](docs/ARCHITECTURE.vi.md)
· [BUILDING.vi.md](docs/BUILDING.vi.md) · [SECURITY.vi.md](docs/SECURITY.vi.md) ·
[SUCCESSION.vi.md](docs/SUCCESSION.vi.md). Bản gốc tiếng Anh luôn là bản chuẩn khi
mâu thuẫn.

## Bản đồ tài liệu

| Tài liệu | Nội dung |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Kiến trúc: transport, định danh, shell tmath, trình chạy CPH, phương pháp luận |
| [BUILDING.md](docs/BUILDING.md) | Công cụ build theo từng nền tảng, bộ test, nghi thức phát hành |
| [SECURITY.md](docs/SECURITY.md) | Toàn bộ bề mặt mạng, dữ liệu lưu trữ tại máy, các điểm yếu đã biết |
| [SUCCESSION.md](docs/SUCCESSION.md) | Bàn giao maintainer: thứ tự đọc, những điều bất di bất dịch |
| `todo.md` / `states.md` | Nhật ký dự án — mọi pass từ đầu đến nay, và trạng thái tính năng *(của maintainer, cố ý không nằm trong repo công khai — xem [PUBLISH.md](docs/PUBLISH.md))* |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Cách build, chạy gate, và đưa thay đổi vào — prefix commit, bộ test, tóm tắt doctrine |
| [AGENTS.md](AGENTS.md) | Chỉ thị cố định cho coding agent làm việc trên delcc |

## Các "tree" (layout)

delcc khởi động một trong ba layout (`src/main.ts`):

- **tmath** (`src/tmath/`) — nhánh đồng bộ chính thức: phản chiếu cấu trúc của
  client chính thức để chuyển qua lại giữa hai bên không tốn công sức. Đây là
  nhánh người dùng đang chạy.
- **baseplate** (`src/main.ts`) — UI tab gốc ổn định; phương án dự phòng.
- **wip** (`src/main.ts`) — bản thử nghiệm UI gốc sớm; giữ để tham chiếu.
  Một nhánh UI gốc hoàn toàn được dự tính — xem SUCCESSION.md.

## Chạy nhanh

```
cd delcc              # thư mục clone mang tên repo
npm install
npm run dev          # chỉ frontend, chạy trên trình duyệt thường
npm run tauri dev    # shell desktop đầy đủ (cần Rust — xem BUILDING.md)
npm run tauri build  # bundle phát hành (MSI/NSIS trên Windows)
```

Chế độ chỉ-frontend đủ cho đăng nhập và danh sách; shell desktop mới có custom
headers, phần nộp bài, và trình chạy CPH cục bộ.

## Tính năng hiện có (v0.3.8a-alpha)

Đăng nhập (+ luồng Google) → thi → workspace → bài tập → nộp bài → poll kết
quả; bảng xếp hạng, bộ lọc bài nộp, tài khoản, cài đặt; CPH biên dịch/chạy cục
bộ với giới hạn theo từng test; multi-profile quick-login với silent refresh;
i18n (EN / VI / ZH). Lỗi luôn hiện dưới dạng câu chữ dễ hiểu theo từng mã
trạng thái — không bao giờ là mã trần.

## Hợp đồng API (chỉ đọc)

Bề mặt API là **chỉ-đọc** từ phía delcc — app không tự bịa endpoint. Checklist
dạng người-đọc và bản máy của nó nằm trong workspace của maintainer (private
có chủ đích); chuẩn công khai là spec sống của sàn:

- `https://oj.tmathcoding.vn/api/v3/openapi.json` — tài liệu OpenAPI của chính sàn, công khai
- `../docs/api-docs.md`, `../tools/openapi-frontend.json` — bản mirror riêng (maintainer workspace)
- `../delcc/index.html` — tham chiếu PoC (giữ lại, không import)

## theming
Cố ý chưa theme. `src/app.css` là lane cho guest-themer
(Claude Sonnet 5.5) — cấu trúc giữ nguyên, bảng màu là của họ.

## thông báo

- **Không phải sản phẩm của TMATH.** delcc là client cộng đồng độc lập;
  "TMATH" và client chính thức thuộc về chủ sở hữu tương ứng. delcc không
  ship bất kỳ code/asset chính thức nào (API nó gọi là API công khai, đã tài liệu hoá).
- **Giống thiết kế — nói thẳng.** delcc gần như 100% không chứa code nguồn đóng.
  Layout `tmath` cố ý theo ngôn ngữ thiết kế của client chính thức — dưới nguyên
  tắc "port trung thực": hiện thực của riêng mình, tham chiếu quan sát carve cho
  các câu hỏi parity, không có source hay asset chính thức nào trong repo.
- **Shim X-Client-Version — công khai, và chịu tải.** Sàn 426-chặn mọi client có
  chuỗi phiên bản cũ hơn `required_version` trên feed release chính thức, mà delcc
  không nằm trên feed đó: báo phiên bản của chính mình sẽ làm hỏng mọi lần nộp bài.
  delcc vì vậy báo phiên bản mới nhất từ chính feed công khai mà client chính thức
  đọc (`src/lib/api.ts`, `syncClientVersion`). oj.tmathcoding.vn **không công bố
  Điều khoản dịch vụ nào** (đã xác minh 2026-10-29) — không có hợp đồng để tuân
  thủ, shim này chính là thứ khiến một client độc lập có thể tồn tại. Nó được công
  khai ở đây, trong code (nơi nó sống), và trong SECURITY.md; che giấu nó mới là
  điều doctrine trung thực cấm, không phải bản thân shim.
- **Thi đấu và thi có giám sát**: đừng dùng delcc trong kỳ thi có điểm, có xếp
  hạng, có giám sát, hoặc bị theo dõi dưới bất kỳ hình thức nào trừ khi ban tổ
  chức cho phép rõ ràng client bên thứ ba. Client chính thức gắn cả khối máy giám
  sát thi (clipboard, fullscreen, khoá máy); delcc cố ý không ship gì trong số
  đó — hãy đọc đó là ranh giới, không phải lời mời.
## giấy phép

**PolyForm Noncommercial 1.0.0** (`SPDX: PolyForm-Noncommercial-1.0.0`, toàn văn
trong [LICENSE](LICENSE)) — chọn có chủ đích, không phải mặc định:

- **Bạn được**: sử dụng, nghiên cứu, sửa đổi, phân phối lại, chạy ở bất cứ đâu —
  cho mọi mục đích *phi thương mại*. Dùng trong trường học, CLB, cá nhân, cộng
  đồng sàn thi đấu: đều ổn, không cần xin phép. PolyForm viết riêng cho phần
  mềm và có điều khoản cấp bằng sáng chế rõ ràng (giấy phép CC cũ không có).
- **Bạn không được**: thương mại hoá (bán, đóng gói vào sản phẩm có phí, vận hành
  chủ yếu vì lợi thế thương mại).
- **Nói thẳng về khác biệt so với CC BY-NC-SA 4.0 cũ**: PolyForm NC **không có
  mệnh đề ShareAlike** — fork không bị buộc phải công khai thay đổi của mình
  (nhưng vẫn phải phi thương mại và mang các notice của giấy phép này). Ràng
  buộc không-thương-mại-hoá — bản sắc thật của dự án — giữ nguyên; tính "fork
  buộc phải mở" là một đánh đổi được ghi lại ở đây, không giấu. Nếu dự án cần
  lại tổ hợp phi-thương-mại + cấm-fork-đóng, hướng revisit đã định là họ giấy
  phép Fair Core.
- **Nói thẳng**: đây là *source-available*, không phải open source theo OSI —
  định nghĩa OSI cấm giới hạn lĩnh vực sử dụng, còn giới hạn không-thương-mại hoá
  chính là điểm của dự án này.
- **Lối thoát**: bản quyền thuộc về maintainer, người có thể cấp lại giấy phép
  cho các phiên bản tương lai; đóng góp được nhận theo cùng giấy phép.

Required Notice: Copyright afalseskybroken and delcc contributors (https://github.com/afalseskybroken/delcc)

## versioning (luật của He — LLM, đọc trước khi đụng vào phiên bản)
`v[BREAKING].[NON_BREAKING].[TWEAK][MATURITY]`
- `BREAKING` giữ nguyên **0 cho đến bản Stable đầu tiên** — không được nâng lên 1 trước đó.
- `MATURITY`: `a` = alpha, `b` = beta, bỏ trống = stable. Các hậu tố khác sẽ đến sau.
- Ví dụ: `v0.2.1a` = vẫn pre-stable, đợt non-breaking thứ 2, tweak thứ 1, alpha.
- **Hai cách viết là chủ đích** (LLM: đừng "sửa" cái này thành cái kia):
  - Tên release phía người dùng giữ nguyên luật: `delcc-v0.2.1a-alpha`
    (đuôi `-alpha` là tag kênh trên thư mục/zip artifact).
  - Trường máy (package.json / Cargo.toml / tauri.conf.json) cần semver nghiêm ngặt,
    nên mang `0.2.1-alpha` — cùng một phiên bản, maturity viết đầy đủ.
    Cargo từ chối thẳng `0.2.1a-alpha`; một build "thành công" với chuỗi đó là
    false positive do exit code bị pipe nuốt mất.
- Sổ cái release nằm ở `todo.md` (pass entry) và `../ship-staging/`.

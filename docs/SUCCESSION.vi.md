# SUCCESSION.vi.md — nếu bạn đọc dòng này sau khi maintainer rời đi

File này tồn tại cho ngày người xây nên delcc tốt nghiệp và đi tiếp. Một dự án
như thế này chết khi câu chuyện chỉ sống trong một cái đầu. Mọi thứ quan trọng
đã được viết ra tại đây và tại các file mà nó trỏ tới. Nếu có thứ gì chưa được
viết ra, hãy coi nó như chưa tồn tại — và sửa bằng cách viết nó ra. Bản gốc
tiếng Anh: [SUCCESSION.md](SUCCESSION.md).

## delcc là gì, trong một đoạn

delcc là một client desktop độc lập, có thể kiểm toán, cho sàn lập trình thi
đấu TMATH (`oj.tmathcoding.vn`). Nó chỉ nói chuyện với API công khai đã được
tài liệu hoá của sàn. Không telemetry, không analytics, không crash reporting,
không hành vi ẩn: mọi lượt gọi mạng nó có thể thực hiện được liệt kê trong
[SECURITY.vi.md](SECURITY.vi.md), và danh sách đó là hợp đồng. Nó ra đời vì
client chính thức là closed-source, và một bộ phận người dùng muốn có thứ gì đó
họ đọc được, kiểm toán được, tự sửa được. Nó bắt đầu như một thí nghiệm giảm
thiểu nhỏ rồi muốn tuyết lở. Đó là toàn bộ câu chuyện — bạn không mất gì khi
bắt đầu từ đây.

## Thứ tự đọc cho maintainer mới

1. [README.vi.md](../README.vi.md) — đây là gì, chạy thế nào, luật versioning.
2. [ARCHITECTURE.vi.md](ARCHITECTURE.vi.md) — các mảnh ghép và lý do chúng vậy.
3. [BUILDING.vi.md](BUILDING.vi.md) — toolchain, ghi chú theo nền tảng, gate phát hành.
4. [SECURITY.vi.md](SECURITY.vi.md) — hợp đồng client trung thực và threat model hiện tại.
5. `todo.md` — sổ cái. Mọi pass từ đầu dự án đều được log tại đó, kèm lý do.
   Nó là thứ gần nhất với lịch sử mà dự án này có. (Lưu ý: sổ cái là file làm
   việc riêng của maintainer — đi theo workspace, không đi theo repo công khai.)
6. `states.md` — trạng thái tính năng hiện tại, cái gì xong, cái gì đang stage.
7. `../docs/api-docs.md` + `../tools/openapi-frontend.json` — hợp đồng API mà
   delcc viết against. Tham chiếu chỉ đọc; delcc không bao giờ định nghĩa lại.

## Các tree (layout)

- **tmath** (`src/tmath/`) — nhánh parity, nhánh người dùng đang chạy. Phản
  chiếu kiến trúc thông tin và ngôn ngữ thị giác của client chính thức để việc
  chuyển qua lại giữa hai bên không tốn công sức. Nơi hành vi chính thức quan
  trọng (avatar, luồng contest, deadline), delcc khớp hành vi quan sát được;
  lý do của từng hành vi được khắc vào comment trong code.
- **baseplate** (`src/main.ts`, layout `baseplate`) — UI tab gốc ổn định. Giữ
  nó sống; đó là phương án dự phòng khi nhánh parity trôi.
- **wip** (`src/main.ts`, layout `wip`) — bản thử nghiệm sớm của home grid gốc.
  Giữ để tham chiếu.
- Một UI gốc hoàn toàn được dự tính: một tree nơi maintainer thoát khỏi ràng
  buộc parity. Chưa có gì stage; khi nó tồn tại, hãy tài liệu hoá tại đây.

## Bất di bất dịch

Đây là bản sắc của dự án. Một successor phá những điều này đã fork nó về mặt
tinh thần, bất kể repo ghi gì:

1. **Không telemetry. Mãi mãi.** Bề mặt mạng trong SECURITY.vi.md là đóng. Mọi
   thay đổi thêm lượt gọi mạng phải cập nhật file đó trong cùng commit.
2. **Không hành vi ẩn.** delcc chỉ làm những gì người dùng đọc được trong source
   và trong hợp đồng API. Không endpoint chui, không tính năng stealth.
3. **Trung thực về khoảng trống của chính mình.** Điểm yếu đã biết được tài liệu
   hoá (xem SECURITY.vi.md — ví dụ token tại máy), không bị che. Một client
   user-first phải chỉ cho người dùng biết xác chết chôn ở đâu.
4. **Luật versioning** trong README.md, gồm luật hai cách viết và cảnh báo
   pipe-eaten-exit. Nó tồn tại vì từng bị vi phạm và phí mất một đêm.
5. **Giấy phép**: PolyForm Noncommercial 1.0.0 (pass #75, trước đây là
   CC BY-NC-SA 4.0) — chỉ phi thương mại, viết riêng cho phần mềm, có điều khoản
   sáng chế rõ ràng. Nói thẳng: PolyForm không có ShareAlike, nên fork được phép
   đóng thay đổi của mình (vẫn phải phi thương mại); tính "fork buộc mở" của CC
   SA cũ không còn. Nếu cần lại tính đó, hướng revisit đã định là họ Fair Core.
6. **Sổ cái.** Mọi pass được ghi một entry vào `todo.md`: what, why, hashes,
   gates. Công việc phân tán, relay-driven vẫn giữ tính nhất quán là nhờ nó. Giữ.

## Nghi thức phát hành (như đã thực hành)

1. Pass entry vào `todo.md` mô tả thay đổi.
2. Gate: `tsc --noEmit` sạch, i18n lint sạch, `vite build` sạch, `cargo build`/
   `cargo test` xác minh exit-code thật (xem cảnh báo pipe-eaten-exit).
3. Bump version theo luật hai cách viết (tên release người dùng vs semver máy).
4. Artifact vào `../ship-staging/delcc-v<version>/` kèm README (EN+VI), exe, và
   `hash.txt` (SHA256 của exe và zip). Zip nó.
5. `states.md` cập nhật nếu trạng thái tính năng dịch chuyển.

## Về nguồn gốc (để có bối cảnh, không để khoe)

Người dùng client chính thức mệt mỏi; không ai chịu viết phương án thay thế.
Tác giả delcc là một trong những người dùng đó, bắt đầu bằng một thí nghiệm giảm
thiểu, có được OpenAPI spec, và build ra ngoài. Dọc đường dự án tích luỹ một
phương pháp: quan sát hành vi thật, tài liệu hoá nó, hiện thực nó một cách sạch
sẽ against hợp đồng công khai, viết lý do vào code nơi người sau tìm thấy được.
Phương pháp đó — không phải tính năng nào cả — mới là thứ đáng được kế thừa.

## Nếu maintainer biến mất ngày mai

Fork nó — đó chính là lý do giấy phép tồn tại. delcc là **PolyForm
Noncommercial 1.0.0** ([LICENSE](../LICENSE)): mọi fork kế thừa ràng buộc
phi-thương-mại, nên chiếm dụng thương mại bị loại trừ về pháp lý ngay từ đầu,
không chỉ bị nhíu mày. Fork có thể giữ thay đổi của mình ở chế độ đóng
(PolyForm không có ShareAlike) — giấy phép bảo vệ tính kiểm-toán-được của CHÍNH
repo này. Repo tự đứng
được. Các doc trong bộ này cộng sổ cái chứa toàn bộ tri thức vận hành. Mở một
pass entry `todo.md` với tên của bạn — mọi maintainer ở đây ký công việc của họ
như vậy, và bạn cũng ký vậy.

Về dòng epigraph trong README — *"and in that light, I find deliverance"*: đó
của người sáng lập, mượn từ một thứ họ từng yêu, được giữ lại vì nó hợp. Bạn
được phép giữ nó, hay thêm dòng của riêng bạn bên dưới. Sự kế thừa cũng là cái
đó.

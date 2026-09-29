# Hướng dẫn cài đặt và sử dụng

Công cụ này tự động kiếm điểm **Microsoft Rewards** mỗi ngày: tìm kiếm trên máy tính và điện thoại, làm nhiệm vụ hằng ngày, điểm danh và đọc bài trong app Bing.

Công cụ gồm hai phần:

| Phần | Làm gì | Chạy ở đâu |
|---|---|---|
| **Bot** ([Microsoft Rewards Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)) | Đăng nhập tài khoản và kiếm điểm | Trong Docker, chạy ngầm trên máy của bạn |
| **Extension Bing Auto Search** | Bảng điều khiển: xem điểm, bấm chạy/dừng, thêm tài khoản, hẹn giờ | Trình duyệt Microsoft Edge (hoặc Chrome) |

```
Edge (extension) ──► bot trong Docker (127.0.0.1:3010) ──► Microsoft Rewards
```

Bot chỉ nghe trên chính máy của bạn và mọi yêu cầu phải kèm token, nên máy khác không điều khiển được.

---

## 1. Chuẩn bị

- **Docker**
  - Windows, macOS: cài [Docker Desktop](https://www.docker.com/products/docker-desktop/) và mở nó lên.
  - Linux: cài [Docker Engine](https://docs.docker.com/engine/install/) cùng plugin `docker compose`.
- **Git**
  - Windows: cài [Git for Windows](https://git-scm.com/download/win). Bộ này có sẵn **Git Bash**, dùng để gõ lệnh ở các bước dưới.
- **Microsoft Edge** (Chrome cũng được).
- Một **tài khoản Microsoft** đã tham gia Rewards, cùng cách đăng nhập tài khoản đó (xem [mục 4](#4-thêm-tài-khoản-microsoft)).

---

## 2. Cài bot (làm một lần, khoảng 10 phút)

Mở Terminal (Windows: mở **Git Bash**) rồi chạy:

```bash
git clone https://github.com/anhlehong/Bing-auto-search-on-PC.git
cd Bing-auto-search-on-PC
bash netsky/setup.sh
```

Script sẽ tự làm các việc sau:

1. Tải bot về thư mục `Microsoft-Rewards-Script/`, đúng phiên bản đã kiểm thử.
2. Thêm phần quản lý tài khoản để extension dùng được.
3. Tạo **token API** và file tài khoản trống.
4. Build và bật bot trong Docker. Lần đầu mất vài phút.

Chạy xong, màn hình in ra dạng:

```
Xong. Bot đang chạy ở http://127.0.0.1:3010
Token API (dán vào popup của extension):

    3f9c...e21a
```

**Chép lại token này** để dùng ở bước 3. Nếu quên, token nằm ở dòng `API_TOKEN=` trong file `Microsoft-Rewards-Script/.env`.

> Bot tự khởi động lại cùng Docker. Trên Windows/macOS, bật tuỳ chọn cho Docker Desktop tự mở khi đăng nhập máy.

---

## 3. Cài extension vào Edge (làm một lần)

1. Mở `edge://extensions` (Chrome: `chrome://extensions`).
2. Bật **Chế độ dành cho nhà phát triển** (Developer mode).
3. Bấm **Tải tiện ích đã giải nén** (Load unpacked) và chọn thư mục `Bing-auto-search-on-PC`.
4. Ghim icon extension lên thanh công cụ cho dễ bấm.
5. Bấm icon. Ô **Bot farm điểm** có chỗ nhập **Token API**: dán token từ bước 2 vào rồi bấm **Kết nối**.

Khi dòng chữ đổi thành *"Chưa có tài khoản…"* là đã kết nối xong.

Để popup hiện **điểm và nhiệm vụ**, Edge cần đăng nhập Bing bằng đúng tài khoản Rewards của bạn. Mở [bing.com](https://www.bing.com) và xem góc trên bên phải: nếu thấy nút **Đăng nhập** thì bấm vào để đăng nhập. Nếu bạn đã đăng nhập Edge bằng tài khoản Microsoft thì thường Bing đã tự đăng nhập sẵn. Phần này chỉ để *xem*; việc kiếm điểm do bot làm, không cần Edge.

---

## 4. Thêm tài khoản Microsoft

> **Đăng nhập ở đâu?** Bạn không cần đăng nhập trên trang web nào cả. Chỉ cần nhập email và mật khẩu vào form bên dưới. Ở lần chạy đầu, bot tự mở một trình duyệt ẩn trong Docker và đăng nhập thay bạn, rồi lưu phiên lại, nên các lần sau không phải đăng nhập nữa. Muốn bot đăng nhập lại từ đầu, bấm **Đăng nhập lại** ở dòng tài khoản đó.

1. Trong popup, bấm **Quản lý bot** để mở trang quản lý.
2. Ở mục **Tài khoản**, bấm **Thêm tài khoản** và điền:

| Ô | Điền gì |
|---|---|
| Email | Email tài khoản Rewards |
| Mật khẩu | Mật khẩu tài khoản. **Để trống** nếu bạn đăng nhập bằng app Microsoft Authenticator (không dùng mật khẩu). |
| Mã bí mật 2FA (TOTP) | Chỉ điền nếu tài khoản bật xác minh 2 bước bằng ứng dụng xác thực. Đây là chuỗi ký tự hiện ra lúc thiết lập ứng dụng xác thực. |
| Email khôi phục | Không bắt buộc |
| Quốc gia | `VN`, hoặc `auto` |
| Ngôn ngữ | **Giữ `en`** (lý do ở ghi chú bên dưới) |

Bot đăng nhập được theo 3 cách:

| Tài khoản của bạn | Bot đăng nhập thế nào |
|---|---|
| Mật khẩu + mã TOTP | **Tự động hoàn toàn. Nên dùng cách này.** |
| Chỉ mật khẩu | Tự động, trừ khi Microsoft đòi xác minh thêm |
| Không mật khẩu (Authenticator) | Popup hiện **một con số**; bạn mở app Authenticator trên điện thoại và chọn đúng số đó |

> ⚠️ **Ngôn ngữ phải là `en`.** Nếu để tiếng Việt (`vi`), Bing ẩn bộ đếm tìm kiếm. Bot sẽ tưởng đã tìm đủ và **bỏ qua toàn bộ phần tìm kiếm PC/Mobile**; dấu hiệu là log ghi `skip (complete, 0/0)`. Quốc gia vẫn để `VN` bình thường.
>
> Đăng nhập kiểu "gửi mã về email" **không dùng được**, vì bot chạy ngầm nên không có chỗ gõ mã.

---

## 5. Chạy

- Bấm **Bắt đầu farm** trong popup, hoặc **Chạy tất cả tài khoản** trong trang quản lý.
- Mỗi lượt mất khoảng 10–30 phút. Popup hiện tài khoản đang chạy, số điểm kiếm được và các dòng log mới nhất.
- **Lần chạy đầu tiên**, bot đăng nhập mất khoảng 2–4 phút. Log trong popup sẽ hiện *Entering email… Password submitted… Successfully logged in*.
- Nếu popup hiện **ô màu cam có con số**, Microsoft đang hỏi xác nhận đăng nhập: mở app Authenticator và chọn đúng số đó.
- Nếu đăng nhập thất bại (badge hiện `!`), vào trang quản lý, mục **Nhật ký**, để xem lý do; xem thêm [mục 7](#7-lỗi-thường-gặp).

**Tự chạy mỗi ngày:** mặc định bot tự chạy lúc **07:00** mỗi ngày; đổi giờ ở mục **Lịch chạy** trong trang quản lý. Lịch chạy nằm trong Docker nên **không cần mở Edge**, chỉ cần máy đang bật và Docker đang chạy.

---

## 6. Đọc popup

| Phần | Ý nghĩa |
|---|---|
| **Hôm nay** | Điểm kiếm được hôm nay, tính theo số dư nên có cả điểm từ app. Từ ngày thứ hai trở đi mới chính xác hoàn toàn. |
| **Số dư** | Tổng điểm hiện có |
| **PC / Mobile** | Điểm tìm kiếm hôm nay trên máy tính / điện thoại, trên tổng tối đa |
| **Nhiệm vụ** | Nhiệm vụ trên trang Rewards. Bấm vào một dòng để mở nhiệm vụ đó. |
| **Bot farm điểm** | Trạng thái bot, điểm từng tài khoản, log mới nhất |

Phần Hôm nay, Số dư, PC/Mobile và Nhiệm vụ là của tài khoản **đang đăng nhập Bing trên Edge**.

Chữ trên icon extension (badge):

| Badge | Nghĩa |
|---|---|
| `ON` | Bot đang chạy |
| Một con số | Cần duyệt đăng nhập trong Authenticator: chọn đúng số này |
| `!` | Lượt chạy trước bị lỗi; mở trang quản lý, mục **Nhật ký**, để xem |
| (trống) | Bot đang nghỉ |

Trang quản lý còn có: sửa mật khẩu/TOTP, **Đăng nhập lại** (xoá phiên đã lưu), bật/tắt từng việc ở mục **Việc cần làm**, nhật ký trực tiếp và **Lượt chạy gần đây**.

---

## 7. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| Popup báo *"TheNetsky chưa chạy"* | Mở Docker Desktop (Linux: `sudo systemctl start docker`), rồi trong thư mục `Microsoft-Rewards-Script` chạy `docker compose up -d` |
| *"Token bị từ chối"* | Dán lại token từ dòng `API_TOKEN=` trong `Microsoft-Rewards-Script/.env` |
| Log ghi `skip (complete, 0/0)`, PC/Mobile không tăng | Ngôn ngữ tài khoản đang là `vi`: vào **Sửa** và đổi thành `en` |
| Bot đăng nhập thất bại | Thêm mã TOTP cho tài khoản, hoặc bấm **Đăng nhập lại** rồi chạy lại. Xem chi tiết ở mục **Nhật ký**. |
| *"Hãy dừng lượt chạy trước"* | Không sửa được tài khoản trong lúc bot đang chạy: bấm **Dừng** trước |
| Bấm Start mà xong ngay, +0 điểm | Bình thường: hôm nay đã kiếm hết điểm, bot không còn việc gì để làm |
| Dòng *"Run finished (code 0)"* | Không phải lỗi: lượt chạy đã xong và thành công. Có mã khác 0 mới là lỗi. |
| Popup hiện *"Tiện ích đã được cập nhật"* | Bấm **Tải lại**, hoặc vào `edge://extensions` bấm Reload |

---

## 8. Cập nhật, tạm dừng, gỡ bỏ

**Cập nhật extension:**

```bash
cd Bing-auto-search-on-PC
git pull
```

Sau đó bấm Reload extension trong `edge://extensions`. Nếu bản mới có thay đổi phần bot, chạy lại `bash netsky/setup.sh`: token và tài khoản được giữ nguyên.

**Tạm dừng bot hẳn** (không chạy theo lịch nữa):

```bash
cd Bing-auto-search-on-PC/Microsoft-Rewards-Script
docker compose down
```

Bật lại bằng `docker compose up -d`.

**Gỡ bỏ:**
1. Chạy `docker compose down` như trên.
2. Gỡ extension trong `edge://extensions`.
3. Xoá thư mục `Bing-auto-search-on-PC`. Trên Linux, hai thư mục `config/` và `sessions/` do Docker tạo nên cần `sudo rm -rf`.

---

## 9. Lưu ý an toàn

- `Microsoft-Rewards-Script/.env` (token) và `Microsoft-Rewards-Script/accounts.env` (mật khẩu, mã 2FA) chứa **thông tin bí mật**. Đừng gửi, đừng nén thư mục này để chia sẻ, đừng đưa lên GitHub. Repo đã chặn sẵn bằng `.gitignore`.
- Mật khẩu chỉ nằm trên máy bạn và chỉ được bot dùng để đăng nhập Microsoft.
- Tự động hoá Microsoft Rewards **vi phạm điều khoản sử dụng** của Microsoft. Tài khoản có thể bị giới hạn điểm hoặc bị khoá. Chỉ dùng cho tài khoản của chính bạn và tự chịu rủi ro.

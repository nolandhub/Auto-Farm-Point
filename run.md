# Cài đặt Bing Auto Search

Công cụ tự kiếm điểm **Microsoft Rewards** mỗi ngày cho bạn. Nó gồm hai phần:

- **Bot**: chạy ngầm trong Docker trên máy bạn, tự đăng nhập và làm nhiệm vụ.
- **Extension**: nằm trong Edge, dùng để thêm tài khoản, bấm chạy và xem điểm.

Làm lần lượt 5 bước dưới đây, mất khoảng 20 phút. Chỉ cần làm một lần.

---

## Cần chuẩn bị

| | Windows / macOS | Linux |
|---|---|---|
| **Docker** | Cài [Docker Desktop](https://www.docker.com/products/docker-desktop/) và **mở nó lên** | Cài [Docker Engine](https://docs.docker.com/engine/install/) |
| **Git** | Windows: cài [Git for Windows](https://git-scm.com/download/win), dùng kèm **Git Bash** | Thường có sẵn |
| **Trình duyệt** | Microsoft Edge (hoặc Chrome) | Microsoft Edge (hoặc Chrome) |

Máy cần trống khoảng **6 GB** ổ cứng.

---

## Bước 1: Tải project

Mở **Git Bash** (Windows) hoặc **Terminal** (macOS/Linux), rồi chạy:

```bash
git clone https://github.com/nolandhub/Auto-Farm-Point.git
cd Auto-Farm-Point
```

Nếu bạn được gửi file ZIP thì giải nén ra. Mở Git Bash/Terminal **ngay trong thư mục vừa giải nén**, là thư mục có file `manifest.json`.

## Bước 2: Cài bot

Trong thư mục project, chạy:

```bash
bash netsky/setup.sh
```

Lần đầu mất khoảng **5–15 phút**. Chạy xong, màn hình hiện:

```
Xong. Bot đang chạy ở http://127.0.0.1:3010
Token API (dán vào popup của extension):

    3f9c...e21a
```

**Chép lại dãy token đó** để dùng ở bước 3.

## Bước 3: Cài extension

1. Mở `edge://extensions` (Chrome: `chrome://extensions`).
2. Bật **Chế độ dành cho nhà phát triển** (Developer mode).
3. Bấm **Tải tiện ích đã giải nén** (Load unpacked), rồi chọn **thư mục project**, tức thư mục có file `manifest.json`.
4. Ghim icon **Bing Auto Search** lên thanh công cụ.
5. Bấm icon, dán token vào ô **Token API**, rồi bấm **Kết nối**.

## Bước 4: Thêm tài khoản

Trong popup, bấm **Quản lý bot**, rồi bấm **Thêm tài khoản**:

| Ô | Điền |
|---|---|
| Email | Email tài khoản Microsoft Rewards |
| Mật khẩu | Mật khẩu tài khoản. Để trống nếu tài khoản không có mật khẩu. |
| Mã bí mật 2FA (TOTP) | Chỉ điền nếu tài khoản có bật ứng dụng xác thực |
| Quốc gia | `VN` hoặc `auto` |
| Ngôn ngữ | **`en`**. Bắt buộc: nếu để `vi`, bot sẽ bỏ qua phần tìm kiếm. |

Bạn không cần tự đăng nhập ở đâu cả. Bot tự đăng nhập ở lần chạy đầu, rồi nhớ luôn cho những lần sau.

## Bước 5: Chạy

Bấm **Bắt đầu farm** trong popup. Mỗi lượt mất khoảng 10–30 phút.

Từ nay bot **tự chạy lúc 07:00 mỗi ngày**. Muốn đổi giờ thì vào mục **Lịch chạy** trong trang quản lý. Bot vẫn tự chạy dù Edge đóng, miễn là máy đang bật và Docker đang chạy.

> Windows/macOS: trong cài đặt của Docker Desktop, bật **Start Docker Desktop when you sign in** để bot luôn sẵn sàng.

---

## Khi bot cần bạn

- **Popup hiện một con số màu cam:** Microsoft đang hỏi xác nhận. Mở app **Microsoft Authenticator** trên điện thoại và chọn đúng số đó.
- **Tự mở một tab có trình duyệt bên trong:** tài khoản đòi mã gửi qua email, hoặc cần một bước bot không tự làm được. Trong tab đó, bấm **Send code** **một lần**, rồi dán mã từ email vào. Đăng nhập xong, tab tự đóng và bot tự chạy tiếp. Muốn tự mở trang này, bấm **Đăng nhập thủ công** ở dòng tài khoản trong trang quản lý.

Tab chỉ tự mở khi Edge đang mở. Bot không bao giờ tự gửi mã, nên không lo bị gửi dồn mã làm khoá tài khoản.

---

## Gặp lỗi?

| Hiện tượng | Cách xử lý |
|---|---|
| `LỖI: Docker chưa chạy` | Mở Docker Desktop, chờ nó báo *running*, rồi chạy lại `bash netsky/setup.sh` |
| `LỖI: tài khoản này chưa được dùng Docker` (Linux) | Chạy `sudo usermod -aG docker $USER`, đăng xuất, đăng nhập lại, rồi chạy lại setup |
| `$'\r': command not found` (Windows) | Tải lại project bằng `git clone` như ở bước 1, đừng sao chép file qua Windows Explorer |
| `port is already allocated` | Một chương trình khác đang dùng cổng 3010 hoặc 6080. Tắt chương trình đó rồi chạy lại setup |
| Popup báo bot chưa chạy | Mở Docker Desktop. Nếu vẫn vậy, chạy lại `bash netsky/setup.sh` |
| Popup báo token sai | Chạy lại `bash netsky/setup.sh`: nó in lại đúng token. Token cũng nằm trong file `Microsoft-Rewards-Script/.env` |
| Điểm tìm kiếm PC/Mobile không tăng | Ngôn ngữ tài khoản đang là `vi`: bấm **Sửa**, đổi thành `en` |
| Popup báo *"Đã cập nhật. Tải lại để chạy bản mới."* | Bấm **Tải lại** |

Chi tiết từng lượt chạy xem ở mục **Nhật ký** trong trang quản lý.

---

## Cập nhật, tạm dừng, gỡ bỏ

**Cập nhật:** trong thư mục project, chạy

```bash
git pull
bash netsky/setup.sh
```

rồi bấm **Reload** extension trong `edge://extensions`. Token và tài khoản được giữ nguyên.

**Tạm dừng:** chạy `cd Microsoft-Rewards-Script && docker compose down`. Bật lại bằng `docker compose up -d`.

**Gỡ bỏ:** tạm dừng như trên, gỡ extension, rồi xoá thư mục project. Trên Linux, hai thư mục `config/` và `sessions/` cần xoá bằng `sudo rm -rf`.

---

## Lưu ý

- Hai file `Microsoft-Rewards-Script/.env` và `Microsoft-Rewards-Script/accounts.env` chứa token và mật khẩu. **Không gửi cho ai, không đưa lên GitHub.** Git đã được cài để tự bỏ qua hai file này.
- Bot chỉ nhận lệnh từ chính máy của bạn, và mọi lệnh đều phải kèm token.
- Tự động hoá Microsoft Rewards **vi phạm điều khoản** của Microsoft. Tài khoản có thể bị giới hạn điểm hoặc bị khoá. Hãy tự cân nhắc trước khi dùng.

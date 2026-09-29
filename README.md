# Bing Auto Search

Tự động kiếm điểm **Microsoft Rewards** mỗi ngày, điều khiển ngay trên trình duyệt Edge.

- **Tự động hoàn toàn:** tìm kiếm trên PC và điện thoại, bộ nhiệm vụ hằng ngày, nhiệm vụ (quest), điểm danh, đọc bài nhận điểm và khuyến mãi trong app Bing.
- **Hẹn giờ:** chạy mỗi ngày vào giờ bạn chọn, không cần mở trình duyệt.
- **Nhiều tài khoản:** thêm, sửa, đăng nhập lại ngay trong extension.
- **Xem điểm trực tiếp:** điểm hôm nay, số dư, tiến độ PC/Mobile, nhiệm vụ còn thiếu, nhật ký của bot.

Việc kiếm điểm do bot [Microsoft Rewards Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) (chạy trong Docker) đảm nhận. Extension là bảng điều khiển của bot.

## Cài nhanh

Cần có Docker, Git và Microsoft Edge.

```bash
git clone https://github.com/anhlehong/Bing-auto-search-on-PC.git
cd Bing-auto-search-on-PC
bash netsky/setup.sh
```

Sau đó nạp thư mục này vào `edge://extensions` (**Load unpacked**) và dán token mà script in ra vào popup.

**Hướng dẫn đầy đủ, từng bước cho người mới: [run.md](run.md)**

## Lưu ý

Tự động hoá Microsoft Rewards vi phạm điều khoản của Microsoft. Tài khoản có thể bị giới hạn hoặc bị khoá. Chỉ dùng cho tài khoản của chính bạn và tự chịu rủi ro.

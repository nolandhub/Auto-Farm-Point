# Bing Auto Search Setup

Earns **Microsoft Rewards** points for you every day. It has two parts:

- **Bot**: runs in the background in Docker, signs in and completes tasks.
- **Extension** (Edge): add accounts, start runs, see points.

One-time setup, about 20 minutes.

> ⚠️ Automating Microsoft Rewards **violates Microsoft's terms**. Accounts may have points limited or be banned.

---

## Requirements

- **Docker**: on Windows/macOS install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and **open it**. On Linux install [Docker Engine](https://docs.docker.com/engine/install/).
- **Git**: on Windows install [Git for Windows](https://git-scm.com/download/win) and use **Git Bash** for every command below. Usually preinstalled on macOS/Linux.
- **Microsoft Edge** (or Chrome), and about **6 GB** of free disk space.

---

## 1. Download and install the bot

Open **Git Bash** (Windows) or **Terminal** (macOS/Linux) and run:

```bash
git clone https://github.com/nolandhub/Auto-Farm-Point.git
cd Auto-Farm-Point
bash netsky/setup.sh
```

The first run takes 5–15 minutes. When done it prints the token (also copied to your clipboard), opens `edge://extensions`, and shows the next steps:

```
Done. The bot is running at http://127.0.0.1:3010
Token (copied to clipboard):

    3f9c...e21a

Next, in Microsoft Edge:
  1. Open edge://extensions and turn on Developer mode
  2. Load unpacked -> choose: /path/to/Auto-Farm-Point
  ...
```

## 2. Install the extension

1. Open `edge://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the folder the script printed (`Auto-Farm-Point`).
3. Pin the **Bing Auto Search** icon to the toolbar.
4. Click the icon, paste the token, then click **Kết nối** (Connect).

## 3. Add accounts

In the popup: **Quản lý bot** (Manage bot) → **Thêm tài khoản** (Add account).

- **Email / Password**: your Microsoft account (leave the password empty if the account has none).
- **2FA (TOTP)**: only if the account uses an authenticator app.
- **Country**: `VN` or `auto`.
- **Language**: **must be `en`**. With `vi` the bot skips searches.

No manual sign-in needed: the bot signs in on the first run and remembers it.

## 4. Run

Click **Bắt đầu farm** (Start farming). Each run takes 10–30 minutes.

After that the bot **runs automatically at 07:00 every day**, even with Edge closed, as long as the computer is on and Docker is running. Change the time under **Lịch chạy** (Schedule) on the manage page.

> Windows/macOS: in Docker Desktop settings, turn on **Start Docker Desktop when you sign in**.

---

## When the bot needs you

- **Popup shows an orange number**: open **Microsoft Authenticator** on your phone and pick that number.
- **A tab opens with a browser inside it**: click **Send code** **once**, then paste the code from your email. The tab closes by itself and the bot continues. (This tab only opens while Edge is open.)

## Troubleshooting

| Problem | Fix |
|---|---|
| `Docker is not running` / popup says the bot isn't running | Open Docker Desktop, wait for *running*, rerun `bash netsky/setup.sh` |
| `this user can't use Docker` (Linux) | `sudo usermod -aG docker $USER`, log out and back in, rerun setup |
| `$'\r': command not found` (Windows) | Re-download with `git clone`; don't copy files through Explorer |
| `port is already allocated` | Close whatever uses port 3010 or 6080, rerun setup |
| Popup says the token is wrong | Rerun `bash netsky/setup.sh` to print the token again |
| Moved the project folder | Rerun setup, remove the extension and **Load unpacked** from the new folder, paste the token again. The extension ID stays the same, so the bot keeps accepting it |
| Search points don't increase | Edit the account language to `en` |

Per-run details are under **Nhật ký** (Logs) on the manage page.

## Update / pause / uninstall

- **Update**: `git pull && bash netsky/setup.sh`, then click **Reload** on the extension. Token and accounts are kept.
- **Pause**: `cd Microsoft-Rewards-Script && docker compose down`. Resume: `docker compose up -d`.
- **Uninstall**: pause, remove the extension, delete the project folder. On Linux, `config/` and `sessions/` need `sudo rm -rf`.

> 🔒 `Microsoft-Rewards-Script/.env` and `accounts.env` hold your token and passwords. **Never share them.** Git already ignores both files.

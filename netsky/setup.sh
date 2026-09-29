#!/usr/bin/env bash
# Sets up the bundled farming bot (TheNetsky's Microsoft Rewards Script) and
# starts it in Docker. Safe to run again: it keeps the token and accounts, and
# only rebuilds and restarts.
#
# Linux and macOS: bash netsky/setup.sh
# Windows: run the same command in Git Bash, with Docker Desktop running.
set -euo pipefail

DIR="Microsoft-Rewards-Script"

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."

fail() { echo "LỖI: $*" >&2; exit 1; }

command -v docker >/dev/null || fail "chưa cài Docker (https://docs.docker.com/get-docker/)."
docker compose version >/dev/null 2>&1 || fail "cần Docker Compose v2 (lệnh 'docker compose')."
if ! docker_info="$(docker info 2>&1)"; then
  case "$docker_info" in
    *"permission denied"*)
      fail "tài khoản này chưa được dùng Docker. Chạy: sudo usermod -aG docker \$USER, đăng xuất, đăng nhập lại rồi chạy lại." ;;
    *)
      fail "Docker chưa chạy. Mở Docker Desktop (hoặc 'sudo systemctl start docker') rồi chạy lại." ;;
  esac
fi

[ -d "$DIR" ] || fail "Không tìm thấy thư mục $DIR. Source bot phải được đóng gói sẵn cùng extension."
[ -f "$DIR/Dockerfile" ] || fail "$DIR không chứa source bot hợp lệ (thiếu Dockerfile)."

cd "$DIR"

cp "$here/compose.override.yaml" compose.override.yaml

# Both files hold secrets: readable by this user only.
umask 077
if [ ! -f .env ]; then
  token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '# Control API token. The Bing Auto Search extension asks for it once.\nAPI_TOKEN=%s\n' "$token" > .env
  echo "==> Đã tạo token API mới trong $DIR/.env"
fi
if [ ! -f accounts.env ]; then
  printf '# Accounts, managed from the Bing Auto Search manager page.\n' > accounts.env
fi

echo "==> Build và bật bot (lần đầu mất vài phút)"
docker compose up -d --build

token="$(sed -n 's/^API_TOKEN=//p' .env)"
echo
echo "Xong. Bot đang chạy ở http://127.0.0.1:3010"
echo "Token API (dán vào popup của extension):"
echo
echo "    $token"
echo

#!/usr/bin/env bash
# Sets up the farming bot (TheNetsky's Microsoft Rewards Script) inside this
# extension's folder and starts it in Docker. Safe to run again: it keeps an
# existing checkout, token and accounts, and only rebuilds and restarts.
#
# Linux and macOS: bash netsky/setup.sh
# Windows: run the same command in Git Bash, with Docker Desktop running.
set -euo pipefail

REPO="https://github.com/TheNetsky/Microsoft-Rewards-Script.git"
# The version the account endpoints in accounts-api.patch were written against.
COMMIT="d0f07d74a0ed4dda127855d6e3dde98bf4c89d6e"
DIR="Microsoft-Rewards-Script"

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."

fail() { echo "LỖI: $*" >&2; exit 1; }

command -v git >/dev/null || fail "chưa cài git (https://git-scm.com/downloads)."
command -v docker >/dev/null || fail "chưa cài Docker (https://docs.docker.com/get-docker/)."
docker compose version >/dev/null 2>&1 || fail "cần Docker Compose v2 (lệnh 'docker compose')."
docker info >/dev/null 2>&1 || fail "Docker chưa chạy. Mở Docker Desktop (hoặc 'sudo systemctl start docker') rồi chạy lại."

if [ ! -d "$DIR/.git" ]; then
  echo "==> Tải bot về $DIR"
  git clone --quiet "$REPO" "$DIR"
  git -C "$DIR" checkout --quiet "$COMMIT"
fi

cd "$DIR"

if git apply --reverse --check "$here/accounts-api.patch" 2>/dev/null; then
  echo "==> Bản vá quản lý tài khoản đã có sẵn"
else
  echo "==> Thêm bản vá quản lý tài khoản"
  git apply "$here/accounts-api.patch" ||
    fail "không vá được. Thư mục $DIR đã bị sửa hoặc khác phiên bản $COMMIT."
fi

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

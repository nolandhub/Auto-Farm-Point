#!/usr/bin/env bash
# ABOUTME: One-command install/run of the farming bot on Linux, macOS or Windows (Git Bash),
# ABOUTME: then prints the token and the steps to load the extension in Edge.
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
project="$(pwd)"

fail() { echo "ERROR: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=mac ;;
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  *) os=linux ;;
esac

command -v docker >/dev/null || fail "Docker is not installed (https://docs.docker.com/get-docker/)."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the 'docker compose' command)."
if ! docker_info="$(docker info 2>&1)"; then
  case "$docker_info" in
    *"permission denied"*)
      fail "this user can't use Docker. Run: sudo usermod -aG docker \$USER, log out and back in, then run this again." ;;
    *)
      fail "Docker is not running. Open Docker Desktop (or 'sudo systemctl start docker') and run this again." ;;
  esac
fi

[ -d "$DIR" ] || fail "Folder $DIR not found. The bot source must ship with the extension."
[ -f "$DIR/Dockerfile" ] || fail "$DIR is not a valid bot source (no Dockerfile)."

cd "$DIR"

cp "$here/compose.override.yaml" compose.override.yaml

# Both files hold secrets: readable by this user only.
umask 077
if [ ! -f .env ]; then
  token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '# Control API token. The Bing Auto Search extension asks for it once.\nAPI_TOKEN=%s\n' "$token" > .env
  echo "==> Created a new API token in $DIR/.env"
fi
if [ ! -f accounts.env ]; then
  printf '# Accounts, managed from the Bing Auto Search manager page.\n' > accounts.env
fi

echo "==> Building and starting the bot (the first time takes a few minutes)"
docker compose up -d --build

token="$(sed -n 's/^API_TOKEN=//p' .env)"

# Best effort: a missing clipboard tool or browser only skips that convenience.
copy_token() {
  case "$os" in
    mac) printf '%s' "$token" | pbcopy ;;
    windows) printf '%s' "$token" | clip.exe ;;
    linux)
      if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null; then
        printf '%s' "$token" | wl-copy
      elif [ -n "${DISPLAY:-}" ] && command -v xclip >/dev/null; then
        printf '%s' "$token" | xclip -selection clipboard
      else
        return 1
      fi ;;
  esac
}

open_extensions_page() {
  case "$os" in
    mac) open -a "Microsoft Edge" "edge://extensions" ;;
    windows) cmd.exe //c start "" msedge "edge://extensions" ;;
    linux)
      [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || return 1
      command -v microsoft-edge >/dev/null || return 1
      nohup microsoft-edge "edge://extensions" >/dev/null 2>&1 &
      ;;
  esac
}

folder="$project"
[ "$os" = windows ] && folder="$(cd "$project" && pwd -W)"

if copy_token >/dev/null 2>&1; then copied=" (copied to clipboard)"; else copied=""; fi
open_extensions_page >/dev/null 2>&1 || true

cat <<EOF

Done. The bot is running at http://127.0.0.1:3010
Token$copied:

    $token

Next, in Microsoft Edge:
  1. Open edge://extensions and turn on Developer mode
  2. Load unpacked -> choose: $folder
  3. Click the Bing Auto Search icon -> paste the token -> Connect
  4. Manage bot -> Add account (language: en) -> Start farming

Already set up? Just click Reload on the extension in edge://extensions.
EOF

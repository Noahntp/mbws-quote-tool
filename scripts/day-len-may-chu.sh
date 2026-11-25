#!/usr/bin/env bash
# Đẩy bản ĐÃ COMMIT mới nhất lên VPS riêng và cài / cập nhật công cụ báo giá. Chạy trên máy văn phòng
# (Git Bash trên Windows cũng được), máy này phải SSH được vào VPS bằng khóa:
#
#   bash scripts/day-len-may-chu.sh root@IP baogia.ten-mien.vn      # lần đầu (cài) và mỗi lần cập nhật
#
# Lần đầu, cấu hình trên VPS (/etc/mbws-quote-tool.env) được tạo từ:
#   DATABASE_URL  biến môi trường, hoặc dòng DATABASE_URL trong .env.worker (CÙNG CSDL với bản Vercel → giữ nguyên hồ sơ cũ);
#                 đặt DATABASE_URL=none để dùng CSDL SQLite riêng trên VPS (bắt đầu trống)
#   APP_PASSWORD  biến môi trường (mật khẩu nhóm); không đặt → VPS tự tạo và in ra
# Các lần sau giữ nguyên cấu hình trên VPS.
set -euo pipefail

TARGET="${1:-}"; DOMAIN="${2:-${DOMAIN:-}}"
[ -n "$TARGET" ] || { echo "Cách dùng: bash scripts/day-len-may-chu.sh root@IP [ten-mien]" >&2; exit 1; }
cd "$(dirname "$0")/.."
SSH=(ssh -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new ${SSH_OPTS:-} "$TARGET")

[ -z "$(git status --porcelain --untracked-files=no)" ] || echo "⚠ Có thay đổi chưa commit — chỉ bản đã commit được đẩy lên." >&2
SHA="$(git rev-parse --short HEAD)"
REL="/opt/mbws-quote-tool/releases/$(date +%Y%m%d-%H%M%S)-$SHA"

echo "==> Kiểm tra kết nối $TARGET"
"${SSH[@]}" 'test "$(id -u)" -eq 0 || command -v sudo >/dev/null' || { echo "Cần đăng nhập root (hoặc user có sudo)." >&2; exit 1; }
SUDO=""; [ "$("${SSH[@]}" 'id -u')" = 0 ] || SUDO="sudo"

echo "==> Đẩy mã nguồn bản $SHA lên $REL"
# chỉ gồm file đã commit: không mang .env, CSDL, ảnh quét, node_modules
git archive --format=tar HEAD | "${SSH[@]}" "$SUDO mkdir -p '$REL' && $SUDO tar -x -C '$REL'"

if ! "${SSH[@]}" "$SUDO test -f /etc/mbws-quote-tool.env"; then
  echo "==> Lần đầu: tạo cấu hình trên VPS"
  DB="${DATABASE_URL:-}"
  if [ -z "$DB" ] && [ -f .env.worker ]; then DB="$(grep -m1 '^DATABASE_URL=' .env.worker | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"; fi
  [ "$DB" = none ] && DB=""
  if [ -n "$DB" ]; then echo "   CSDL: dùng chung Postgres với bản đang chạy (giữ nguyên hồ sơ cũ)"; else echo "   CSDL: SQLite riêng trên VPS (bắt đầu trống)"; fi
  # gửi qua kết nối SSH (stdin), không để mật khẩu nằm trên dòng lệnh
  { [ -n "$DB" ] && printf 'DATABASE_URL=%s\n' "$DB"; [ -n "${APP_PASSWORD:-}" ] && printf 'APP_PASSWORD=%s\n' "$APP_PASSWORD"; true; } \
    | "${SSH[@]}" "umask 077; $SUDO tee /etc/mbws-quote-tool.env >/dev/null"
fi

echo "==> Cài đặt trên VPS"
"${SSH[@]}" "$SUDO env DOMAIN='$DOMAIN' bash '$REL/scripts/cai-may-chu-ubuntu.sh'"

#!/usr/bin/env bash
# Cài bộ quét Việt Nam chạy 24/7 trên VPS Ubuntu 22.04/24.04 (systemd). Chạy trong thư mục mã nguồn đã clone:
#   sudo DATABASE_URL='postgres://...' bash scripts/cai-bo-quet-ubuntu.sh
# Không cần mở cổng nào; máy chỉ cần ra được Internet.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"
SERVICE=/etc/systemd/system/mbws-scan.service

if [ "$(id -u)" -ne 0 ]; then echo "Chạy bằng sudo." >&2; exit 1; fi

if [ -n "${DATABASE_URL:-}" ]; then
  umask 077
  printf 'DATABASE_URL=%s\n' "$DATABASE_URL" > "$APP_DIR/.env.worker"
  chown "$RUN_USER" "$APP_DIR/.env.worker"
elif [ ! -f "$APP_DIR/.env.worker" ]; then
  echo "Thiếu DATABASE_URL (đặt biến môi trường hoặc tạo file .env.worker)." >&2; exit 1
fi

# Node.js 22
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

cd "$APP_DIR"
sudo -u "$RUN_USER" npm ci
npx -y playwright@1.56.1 install-deps chromium
sudo -u "$RUN_USER" npx -y playwright@1.56.1 install chromium

cat > "$SERVICE" <<EOF
[Unit]
Description=MBWS - bo quet web mau tai Viet Nam
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v npm) run scan-worker
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mbws-scan
sleep 5
systemctl --no-pager --lines=5 status mbws-scan || true
echo
echo "Xong. Xem log: journalctl -u mbws-scan -f"

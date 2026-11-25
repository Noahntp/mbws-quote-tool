#!/usr/bin/env bash
# Cài / cập nhật CÔNG CỤ BÁO GIÁ (web + bộ quét + đếm chính xác) trên VPS Ubuntu 22.04/24.04 riêng.
# Thường được gọi tự động bởi scripts/day-len-may-chu.sh (chạy trên máy văn phòng). Chạy tay trên VPS:
#   sudo DOMAIN=baogia.ten-mien.vn bash /opt/mbws-quote-tool/releases/<bản>/scripts/cai-may-chu-ubuntu.sh
#
# Bố trí trên máy:
#   /opt/mbws-quote-tool/releases/<bản>   mã nguồn từng lần đẩy lên (giữ 3 bản gần nhất để quay lại khi lỗi)
#   /opt/mbws-quote-tool/current          → bản đang chạy
#   /opt/mbws-quote-tool/browsers         Chromium cho bộ quét
#   /var/lib/mbws-quote-tool              dữ liệu (CSDL SQLite nếu không dùng DATABASE_URL, ảnh tạm khi quét)
#   /etc/mbws-quote-tool.env              mật khẩu nhóm, khóa phiên, DATABASE_URL — chỉ root đọc được
# Chạy lại script nhiều lần không sao: lần sau chỉ cập nhật, giữ nguyên cấu hình và dữ liệu.
set -euo pipefail

APP_HOME=/opt/mbws-quote-tool
DATA_DIR=/var/lib/mbws-quote-tool
ENV_FILE=/etc/mbws-quote-tool.env
SERVICE=mbws-quote-tool
RUN_USER=mbws
PORT="${PORT:-3100}"
DOMAIN="${DOMAIN:-}"
RELEASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\n==> %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Chạy bằng root (sudo)."
[ -d /run/systemd/system ] || die "Máy không chạy systemd — cần VPS Ubuntu thông thường."
. /etc/os-release
[ "${ID:-}" = ubuntu ] || warn "Script viết cho Ubuntu; máy này là ${PRETTY_NAME:-không rõ}."
case "$RELEASE_DIR" in "$APP_HOME"/releases/*) ;; *) die "Mã nguồn phải nằm trong $APP_HOME/releases/ (dùng scripts/day-len-may-chu.sh để đẩy lên).";; esac
export DEBIAN_FRONTEND=noninteractive
for bin in curl openssl gpg; do command -v "$bin" >/dev/null || { apt-get update -y -q && apt-get install -y -q curl openssl gnupg ca-certificates; break; }; done

# ---------- 1. Người dùng chạy dịch vụ & thư mục ----------
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 750 "$DATA_DIR"
install -d -m 755 "$APP_HOME" "$APP_HOME/releases"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 755 "$APP_HOME/browsers"

# ---------- 2. Bộ nhớ ảo: Chromium + Node cần ~1,5 GB; máy ít RAM thì thêm 2 GB swap ----------
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 3500000 ] && [ -z "$(swapon --show --noheadings)" ] && [ ! -f /swapfile ]; then
  log "RAM $((mem_kb / 1024)) MB — thêm 2 GB swap"
  if fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    rm -f /swapfile; warn "VPS không cho tạo swap — bỏ qua (nên chọn VPS từ 4 GB RAM)."
  fi
fi

# ---------- 3. Node.js 22 ----------
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]; then
  log "Cài Node.js 22"
  apt-get update -y -q
  apt-get install -y -q ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs
fi
NODE_BIN="$(command -v node)"
echo "Node $(node -v)"

# ---------- 4. Thư viện npm & Chromium cho bộ quét ----------
log "Cài thư viện npm cho bản $(basename "$RELEASE_DIR")"
chown -R "$RUN_USER:$RUN_USER" "$RELEASE_DIR"
( cd "$RELEASE_DIR" && runuser -u "$RUN_USER" -- env HOME="$DATA_DIR" npm ci --omit=dev --no-audit --no-fund --loglevel=error )
PW_CLI="$RELEASE_DIR/node_modules/playwright-core/cli.js"
log "Cài Chromium cho bộ quét (Playwright $(node -p "require('$RELEASE_DIR/node_modules/playwright-core/package.json').version"))"
node "$PW_CLI" install-deps chromium >/dev/null
runuser -u "$RUN_USER" -- env HOME="$DATA_DIR" PLAYWRIGHT_BROWSERS_PATH="$APP_HOME/browsers" node "$PW_CLI" install chromium

# ---------- 5. Cấu hình (lần đầu tạo; lần sau chỉ bổ sung khóa còn thiếu, không ghi đè) ----------
touch "$ENV_FILE"; chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
has() { grep -q "^$1=" "$ENV_FILE"; }
set_default() { has "$1" || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; }
set_default PORT "$PORT"
set_default HOST 127.0.0.1
set_default DATA_DIR "$DATA_DIR"
set_default PLAYWRIGHT_BROWSERS_PATH "$APP_HOME/browsers"
set_default SESSION_SECRET "$(openssl rand -hex 32)"
NEW_PW=""
if ! has APP_PASSWORD; then NEW_PW="mbws-$(openssl rand -hex 3)-$(openssl rand -hex 3)"; set_default APP_PASSWORD "$NEW_PW"; fi
PORT="$(grep -m1 '^PORT=' "$ENV_FILE" | cut -d= -f2-)"
if has DATABASE_URL; then echo "CSDL: Postgres (DATABASE_URL trong $ENV_FILE)"; else echo "CSDL: SQLite tại $DATA_DIR/quote.db"; fi

# ---------- 6. Dịch vụ systemd (tự chạy khi khởi động máy, tự bật lại khi lỗi) ----------
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=MBWS - cong cu bao gia website
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_HOME/current
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

# ---------- 7. Chuyển sang bản mới; khởi động không lên thì quay lại bản cũ ----------
PREV="$(readlink -f "$APP_HOME/current" 2>/dev/null || true)"
switch_to() { ln -sfn "$1" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"; }
healthy() {
  for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/meta" || true)
    case "$code" in 200|401) return 0;; esac
    sleep 1
  done
  return 1
}
log "Khởi động dịch vụ $SERVICE"
switch_to "$RELEASE_DIR"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
if ! healthy; then
  journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true
  if [ -n "$PREV" ] && [ "$PREV" != "$RELEASE_DIR" ] && [ -d "$PREV" ]; then
    warn "Bản mới không khởi động được — quay lại bản trước: $(basename "$PREV")"
    switch_to "$PREV"; systemctl restart "$SERVICE"
  fi
  die "Dịch vụ không trả lời ở cổng $PORT (xem log ở trên: journalctl -u $SERVICE -n 100)."
fi
echo "Dịch vụ chạy ở http://127.0.0.1:$PORT (chỉ trong máy; truy cập từ ngoài qua Caddy)"

# ---------- 8. Caddy: tên miền + HTTPS tự động (Let's Encrypt) ----------
if [ -n "$DOMAIN" ]; then
  if ss -ltnpH 2>/dev/null | grep -E '[:.](80|443)[[:space:]]' | grep -vq '"caddy"'; then
    warn "Cổng 80/443 đang do chương trình khác dùng — không cài Caddy. Tự trỏ $DOMAIN về http://127.0.0.1:$PORT trong web server hiện có."
  else
    if ! command -v caddy >/dev/null; then
      log "Cài Caddy (web server có HTTPS tự động)"
      apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -y -q && apt-get install -y -q caddy
    fi
    cat > /etc/caddy/Caddyfile <<EOF
# Công cụ báo giá MBWS — HTTPS tự động cho $DOMAIN
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
    systemctl enable caddy >/dev/null 2>&1
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    # nhắc trỏ tên miền: Caddy chỉ lấy được chứng chỉ khi bản ghi A trỏ đúng về máy này
    dns_ip="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')"
    my_ips="$(hostname -I 2>/dev/null || true)"
    if [ -z "$dns_ip" ]; then warn "$DOMAIN chưa có bản ghi A — trỏ về IP máy này ($my_ips), Caddy sẽ tự lấy chứng chỉ HTTPS sau đó."
    elif ! printf ' %s ' $my_ips | grep -q " $dns_ip "; then warn "$DOMAIN đang trỏ về $dns_ip, IP máy này là: $my_ips (bỏ qua nếu máy ở sau NAT/IP công cộng khác)."
    fi
  fi
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
fi

# ---------- 9. Sao lưu hằng ngày (khi dùng SQLite trên máy; Postgres/Neon tự có sao lưu riêng) ----------
if ! has DATABASE_URL; then
  command -v sqlite3 >/dev/null || apt-get install -y -q sqlite3 >/dev/null
  install -d -m 700 /var/backups/mbws-quote-tool
  cat > /etc/cron.daily/mbws-quote-tool-backup <<EOF
#!/bin/sh
# Sao lưu CSDL công cụ báo giá, giữ 14 ngày
[ -f $DATA_DIR/quote.db ] || exit 0
sqlite3 $DATA_DIR/quote.db ".backup '/var/backups/mbws-quote-tool/quote-\$(date +%F).db'"
find /var/backups/mbws-quote-tool -name 'quote-*.db' -mtime +14 -delete
EOF
  chmod 755 /etc/cron.daily/mbws-quote-tool-backup
fi

# ---------- 10. Dọn bản cũ (giữ 3 bản gần nhất + bản đang chạy) ----------
CUR="$(readlink -f "$APP_HOME/current")"
ls -1dt "$APP_HOME"/releases/*/ 2>/dev/null | sed 's:/$::' | tail -n +4 | while read -r old; do
  [ "$old" = "$CUR" ] || rm -rf "$old"
done

log "XONG — bản $(basename "$RELEASE_DIR")"
if [ -n "$DOMAIN" ]; then echo "Địa chỉ: https://$DOMAIN"; else echo "Chưa gắn tên miền: chạy lại với DOMAIN=ten-mien để bật HTTPS."; fi
[ -n "$NEW_PW" ] && echo "Mật khẩu nhóm (tạo mới, lưu lại và gửi nhóm qua kênh nội bộ): $NEW_PW"
echo "Xem log: journalctl -u $SERVICE -f    ·    Sửa cấu hình: $ENV_FILE rồi systemctl restart $SERVICE"

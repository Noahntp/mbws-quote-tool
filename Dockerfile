FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
# Chromium đúng phiên bản playwright-core trong package.json (kèm thư viện hệ thống cần thiết)
RUN npx -y playwright@1.56.1 install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY . .

VOLUME ["/app/storage"]

ENV PORT=3100
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/storage

EXPOSE 3100

# Mặc định chạy cả công cụ báo giá. Chỉ chạy bộ quét (máy tại Việt Nam, nối CSDL chung):
#   docker run -d --restart unless-stopped -e DATABASE_URL=... <image> node server/scan-worker.js
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

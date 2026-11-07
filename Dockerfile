FROM node:22-bookworm-slim

# Cài đặt thư viện hệ thống cần thiết cho Chromium Playwright
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install chromium

COPY . .

VOLUME ["/app/storage"]

ENV PORT=3100
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/storage

EXPOSE 3100

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

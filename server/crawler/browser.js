// Khởi chạy Chromium dùng chung (quét web mẫu, in PDF, đồng bộ giá gói).
//  - Máy local / Docker: trình duyệt do `npx playwright install chromium` cài.
//  - Vercel / AWS Lambda: Chromium bản serverless (@sparticuz/chromium 141 khớp Playwright 1.56 → Chromium 141).
export const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

export async function launchChromium() {
  const { chromium } = await import('playwright-core');
  if (IS_SERVERLESS) {
    const Chromium = (await import('@sparticuz/chromium')).default;
    Chromium.setGraphicsMode = false;
    return chromium.launch({ executablePath: await Chromium.executablePath(), args: Chromium.args, headless: true });
  }
  return chromium.launch({ args: ['--disable-dev-shm-usage', '--no-first-run'] });
}

export async function devicesPreset(name) {
  const { devices } = await import('playwright-core');
  return devices[name];
}

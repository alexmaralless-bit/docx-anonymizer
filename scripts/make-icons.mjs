// Иконки расширения из знака Sitimlab: assets/sitimlab-icon.svg → icons/icon-{16,32,48,128}.png.
// Источник — иконка сайта студии (знак «Связка» на тёмной плитке); запуск: npm run icons.
// Рисует Chromium из Playwright; сети не требует. PNG лежат в репозитории, при сборке просто копируются.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const svg = await readFile(join(root, 'assets/sitimlab-icon.svg'), 'utf8');

await mkdir(join(root, 'icons'), { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(join(root, `icons/icon-${size}.png`), png);
    await page.close();
    console.log(`icons/icon-${size}.png`);
  }
} finally {
  await browser.close();
}

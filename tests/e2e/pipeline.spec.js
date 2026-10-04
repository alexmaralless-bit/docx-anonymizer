// Конвейер фундамента: popup → background → offscreen → Web Worker (ядро) → обратно.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from './fixtures.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';

test('popup отправляет .docx в ядро и получает результат', async ({ context, extensionId }) => {
  const dir = resolve('test-output');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e2e-sample.docx');
  writeFileSync(file, buildSampleDocx().bytes);

  const external = [];
  context.on('request', (r) => {
    if (!/^(chrome-extension|data|blob):/.test(r.url())) external.push(r.url());
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.setInputFiles('#dev-file', file);
  await expect(page.getByTestId('dev-status')).toContainText('Готово', { timeout: 30000 });

  const vt = Number(await page.getByTestId('vt-length').textContent());
  const count = Number(await page.getByTestId('entity-count').textContent());
  const size = Number(await page.getByTestId('result-size').textContent());
  expect(vt).toBeGreaterThan(2000);
  expect(count).toBeGreaterThanOrEqual(4); // 4 e-mail (временный детектор) + авторы правок
  expect(size).toBeGreaterThan(1000);
  await expect(page.locator('#dev-download')).toHaveAttribute('download', 'e2e-sample.anon.docx');
  expect(external, 'NFR-01: сетевые запросы из расширения').toEqual([]);
});

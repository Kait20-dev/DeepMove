import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from '@playwright/test';

const port = 4174, base = `http://127.0.0.1:${port}/DeepMove/`;
const server = spawn(process.execPath, ['scripts/preview-pages.mjs'], { windowsHide: true, env: { ...process.env, PAGES_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, log = '';
server.stdout.on('data', chunk => { log += chunk; });
server.stderr.on('data', chunk => { log += chunk; });
await mkdir('test-results', { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 150)); }
  assert.ok(ready, log);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), errors = [], failed = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().startsWith(base) && response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  await page.goto(base, { waitUntil: 'networkidle' });
  const canvas = page.locator('#hero-canvas');
  assert.ok(await canvas.evaluate(c => c.width > 0 && c.height > 0));
  assert.equal(await page.locator('#scene-toggle').getAttribute('aria-pressed'), 'false');
  const still = await canvas.evaluate(c => c.toDataURL());
  await page.waitForTimeout(220);
  assert.equal(await canvas.evaluate(c => c.toDataURL()), still, 'reduced motion must render a stable scene');
  await page.getByRole('button', { name: 'Включить фоновую анимацию', exact: true }).click();
  const before = await canvas.evaluate(c => c.toDataURL());
  await page.waitForTimeout(350);
  assert.notEqual(await canvas.evaluate(c => c.toDataURL()), before, 'pieces must visibly move');
  await page.getByRole('button', { name: 'Приостановить фоновую анимацию', exact: true }).click();
  const paused = await canvas.evaluate(c => c.toDataURL());
  await page.waitForTimeout(220);
  assert.equal(await canvas.evaluate(c => c.toDataURL()), paused, 'pause must stop the scene');
  await page.locator('#faq summary').first().click();
  assert.equal(await page.locator('#faq details').first().getAttribute('open'), '');
  console.log('PASS: original-site canvas scene, visible smooth motion, pause, reduced motion and FAQ');

  await page.goto(base + 'docs/getting-started/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1, name: 'Быстрый старт' }).waitFor();
  await page.getByRole('button', { name: /Поиск по документации/ }).click();
  await page.getByRole('searchbox', { name: 'Поиск', exact: true }).fill('HardBullet');
  await page.locator('#search-results a').first().waitFor();
  assert.ok(await page.locator('#search-results a').count() > 0);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.closest('#search-results') !== null), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#search-dialog').isVisible(), false);
  await page.keyboard.press('Control+k');
  await page.locator('#docs-search').fill('нет_такого_раздела_123456');
  await page.getByText('Ничего не найдено. Попробуй другое слово.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Скопировать код', exact: true }).first().click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /git clone/);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); }; });
  await page.getByRole('button', { name: 'Скопировать код', exact: true }).first().click();
  assert.match(await page.evaluate(() => getSelection().toString()), /git clone/);
  console.log('PASS: generated Markdown, local search, keyboard navigation, focus handling, clipboard and manual fallback');

  for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const [name, path] of [['landing', ''], ['docs', 'docs/getting-started/'], ['api', 'docs/bot-api/']]) {
      await page.goto(base + path, { waitUntil: 'networkidle' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} horizontal overflow at ${width}`);
      assert.equal(await page.locator('img').evaluateAll(images => images.some(image => !image.complete || !image.naturalWidth)), false, `${name} broken image at ${width}`);
      await page.screenshot({ path: `test-results/pages-${name}-${width}.png`, fullPage: true });
    }
  }
  await page.goto(base);
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  assert.equal(await page.locator('#mobile-nav').isVisible(), true);
  await page.locator('#mobile-nav').getByRole('link', { name: 'О проекте', exact: true }).click();
  assert.equal(await page.locator('#mobile-nav').isVisible(), false);
  await page.goto(base + 'docs/');
  await page.getByRole('button', { name: 'Открыть меню документации', exact: true }).click();
  assert.equal(await page.locator('#docs-sidebar').isVisible(), true);
  await page.locator('#docs-sidebar').getByRole('link', { name: 'Профили и два кубка', exact: true }).click();
  await page.waitForURL(base + 'docs/cups/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  const nojs = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await nojs.newPage();
  await staticPage.goto(base + 'docs/bot-api/');
  assert.equal(await staticPage.locator('.prose h1').count(), 1);
  assert.ok(await staticPage.locator('.docs-pagination a').count() > 0);
  assert.deepEqual(errors, []); assert.deepEqual(failed, []);
  console.log('PASS: landing/docs/API at three viewports, working images, mobile menus, no horizontal overflow, no JS errors/404s and readable docs without JavaScript');
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
}

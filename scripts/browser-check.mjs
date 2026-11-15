import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('test-results', { recursive: true });
try {
  for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: `test-results/home-${width}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    assert.equal(await page.locator('h1').count(), 1);
    assert.ok(await page.locator('h1').innerText().then(text => text.includes('DeepMove')));
    assert.equal(await page.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
    await page.locator('summary').filter({ hasText: 'Можно ли использовать нейросети?' }).click();
    assert.equal(await page.locator('details[open]').count(), 1);
    if (width === 390) {
      await page.getByRole('button', { name: 'Открыть меню' }).click();
      await page.locator('#mobile-navigation').getByRole('link', { name: 'Правила', exact: true }).click();
      assert.equal(await page.locator('#mobile-navigation').count(), 0);
      assert.equal(new URL(page.url()).hash, '#rules');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    const before = await page.locator('canvas').evaluate(canvas => canvas.toDataURL());
    await page.waitForTimeout(150);
    const after = await page.locator('canvas').evaluate(canvas => canvas.toDataURL());
    assert.equal(before, after, 'reduced motion must stop animation');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}×${height}: images, layout, FAQ, reduced motion, console${width === 390 ? ', mobile navigation' : ''}`);
    await page.close();
  }
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = new URL(process.env.FIELDNOTE_URL ?? 'http://127.0.0.1:4173');
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Browser checks must use the local preview.');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('../.makefun-local/browsers');
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const errors = [], blocked = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) { blocked.push(url.origin); await route.abort(); }
    else await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
  async function visit(hash = 'radar') {
    await page.goto(new URL(`/#${hash}`, base).href, { waitUntil: 'networkidle' });
    await page.locator('#board-body tr').first().waitFor();
    assert.equal(await page.locator('#fatal').isVisible(), false);
  }
  await visit();
  assert.match(page.url(), /\/dashboard\/index\.html/);
  assert.equal(await page.locator('#board-body tr').count(), 9);
  assert.notEqual(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('#market-map circle').count(), 192);
  const expected = JSON.parse(await readFile('out/board.json', 'utf8'));
  const actual = await page.evaluate(async () => {
    const { buildRadar, validateSnapshot } = await import('./engine.js');
    return buildRadar(validateSnapshot(window.FIELDNOTE_SNAPSHOT)).rows.map(p => [p.slug, p.implied_value_usd, p.farm_steps]);
  });
  assert.deepEqual(actual, expected.rows.map(p => [p.slug, p.implied_value_usd, p.farm_steps]));

  await page.getByRole('button', { name: 'Documented routes', exact: true }).click();
  assert.equal(await page.locator('#board-body tr').count(), 4);
  await page.getByRole('button', { name: 'House watchlist', exact: true }).click();
  assert.equal(await page.locator('#result-count').innerText(), '40 of 192 protocols');
  await page.locator('#search').fill('nonexistent-protocol-zz');
  assert.equal(await page.locator('#empty').isVisible(), true);
  await page.locator('#empty-reset').click();
  assert.equal(await page.locator('#result-count').innerText(), '192 of 192 protocols');
  await page.locator('#next').click();
  assert.match(await page.locator('#page-info').innerText(), /^10–18/);
  await visit('detail=steakhouse-financial');
  await page.locator('#detail[open]').waitFor();
  assert.equal(await page.locator('.peer-wrap tbody tr').count(), 5);
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  assert.match(await page.locator('.source-card code').innerText(), /steakhouse\.financial/);
  await page.getByRole('button', { name: 'Farm & exit plan', exact: true }).click();
  await page.locator('#pilot-budget').selectOption('500');
  assert.match(await page.locator('.cost-grid').innerText(), /\$500/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#detail').evaluate(node => node.open), false);
  await visit('detail=bittensor-dtao&tab=farm');
  assert.match(await page.locator('.detail-panel').innerText(), /\$0/);
  assert.equal(await page.locator('#pilot-budget').isDisabled(), true);

  await mkdir('test-results', { recursive: true });
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport);
    await visit();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `Body overflow at ${viewport.width}px`);
    await page.screenshot({ path: `test-results/mobile-${viewport.width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await mkdir('screenshots', { recursive: true });
  const captures = [
    ['1-board.png', 'radar'],
    ['2-detail.png', 'detail=steakhouse-financial'],
    ['3-filtered.png', 'radar'],
    ['4-plan.png', 'detail=veda&tab=farm'],
  ];
  for (const [name, hash] of captures) {
    await visit(hash);
    if (name === '3-filtered.png') await page.getByRole('button', { name: 'Documented routes', exact: true }).click();
    if (hash.startsWith('detail=')) await page.locator('#detail[open]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.screenshot({ type: 'png', animations: 'disabled' });
    assert.ok(bytes.length <= 524288, `${name} exceeds screenshot cap.`);
    assert.equal(bytes.readUInt32BE(16), 1440); assert.equal(bytes.readUInt32BE(20), 900);
    await writeFile(`screenshots/${name}`, bytes, { mode: 0o644 });
    console.log(`${name}: real Chromium capture, 1440×900, ${bytes.length} bytes`);
  }
  assert.deepEqual(blocked, [], 'Dashboard attempted external network access.');
  assert.deepEqual(errors, [], 'Browser or asset errors occurred.');
  console.log('Browser checks passed: assets, data agreement, filters, detail, sources, budget, keyboard exit, mobile, offline behavior.');
} finally {
  await browser.close();
}

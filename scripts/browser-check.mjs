/** Real-browser checks and the entry's screenshots. Not the house's sealed scorer. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = new URL(process.env.FIELDNOTE_URL ?? 'http://127.0.0.1:4173');
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Browser checks must use the local preview.');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('../.makefun-local/browsers');
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const errors = [], external = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) { external.push(url.origin); await route.abort(); } else await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  const visit = async (hash = 'radar') => {
    await page.goto(new URL(`/#${hash}`, base).href, { waitUntil: 'networkidle' });
    await page.locator('#crumb').waitFor();
    assert.equal(await page.locator('#fatal').isVisible(), false);
  };
  const visitBoard = async (hash = 'radar') => { await visit(hash); await page.locator('#body tr').first().waitFor(); };
  const settled = async () => { await page.waitForFunction(() => document.getElementById('strip').textContent.includes('this table = board.json'), null, { timeout: 15000 }); };

  await visitBoard();
  await settled();
  assert.match(page.url(), /\/dashboard\/index\.html/);
  assert.equal(await page.locator('.kpi').count(), 6);
  assert.equal(await page.locator('#body tr').count(), 8);
  assert.equal(await page.locator('#ledger-bar i').count(), (await page.locator('#ledger-legend span').count()));
  assert.match(await page.locator('#strip').innerText(), /ranks 1 to N in order/);
  assert.match(await page.locator('#strip').innerText(), /watchlist 40 of 40 ranked/);
  assert.notEqual(await page.locator('body').evaluate(n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.ok(await page.locator('#chart svg circle').count() > 50, 'the comps chart draws the traded tokens');
  assert.equal(await page.locator('#chart svg polyline').count(), 1, 'the fitted size curve is drawn once');
  assert.equal(await page.locator('#csv').isVisible(), true);

  // The page's own model must equal the submitted board row for row.
  const board = JSON.parse(await readFile('out/board.json', 'utf8'));
  const mine = await page.evaluate(async () => {
    const { buildRadar, validateSnapshot } = await import('./engine.js');
    return buildRadar(validateSnapshot(window.FIELDNOTE_SNAPSHOT), window.FIELDNOTE_PLANS ?? {}).rows
      .map(r => [r.slug, r.implied_value_usd, r.launch_odds, r.economics.verdict, r.farm_steps]);
  });
  const expect = board.rows.map(r => [r.slug, r.implied_value_usd, r.launch_odds, r.economics.verdict, r.farm_steps]);
  assert.equal(mine.length, expect.length);
  for (const [i, row] of expect.entries()) {
    assert.equal(mine[i][0], row[0]);
    assert.equal(mine[i][1], row[1], 'implied value must match exactly');
    assert.ok(Math.abs(mine[i][2] - row[2]) < 1e-9, `odds differ at ${row[0]}`);   // Math.log/exp can drift one ulp across engines
    assert.equal(mine[i][3], row[3]);
    assert.deepEqual(mine[i][4], row[4]);
  }

  const farm = await page.locator('#n-farm').innerText();
  await page.getByRole('button', { name: /^Farm/ }).click();
  assert.ok(await page.locator('#body tr').count() > 0);
  assert.equal(await page.locator('#body tr').count(), Math.min(8, Number(farm)));
  await page.getByRole('button', { name: 'Skip' }).click();
  assert.equal(await page.locator('#body tr').count(), Math.min(8, Number(await page.locator('#n-skip').innerText())));
  await page.getByRole('button', { name: 'All', exact: true }).click();

  const first = await page.locator('#body tr').first().innerText();
  await page.locator('#deposit').selectOption('1000');
  assert.notEqual(await page.locator('#body tr').first().innerText(), first, 'a smaller deposit must change the verdict line');
  await page.locator('#deposit').selectOption('10000');

  await page.locator('#search').fill('no-such-protocol-zz');
  assert.equal(await page.locator('#empty').isVisible(), true);
  await page.locator('#empty-reset').click();
  assert.match(await page.locator('#count').innerText(), /of 192 shown/);
  await page.locator('#next').click();
  await page.locator('#prev').click();

  await visit('detail=steakhouse-financial');
  await page.locator('#detail[open]').waitFor();
  assert.equal(await page.locator('.peer tbody tr').count(), 5);
  assert.match(await page.locator('.side-note2').innerText(), /Steakhouse/);
  assert.match(await page.locator('.side-note2 code').first().innerText(), /steakhouse\.financial/);
  await page.getByRole('button', { name: 'Farm and exit' }).click();
  assert.match(await page.locator('.econ').innerText(), /NET/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#detail').evaluate(n => n.open), false);
  await visit('detail=bittensor-dtao&tab=farm');
  assert.match(await page.locator('.econ').innerText(), /\$0\.00|—/);
  assert.match(await page.locator('#dlg .side-note2').innerText(), /TAO|alpha|token/i);
  assert.match(await page.locator('#dlg').innerText(), /Research only|no funded route/);

  await visit('model');
  assert.match(await page.locator('#model-content').innerText(), /called right/i);
  assert.match(await page.locator('#model-content').innerText(), /walk-forward/);
  await visit('ledger');
  assert.equal(await page.locator('#ledger-body tr').count(), 25);
  assert.match(await page.locator('#ledger-chips').innerText(), /Ranked here/);

  await mkdir('test-results', { recursive: true });
  for (const v of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(v);
    await visitBoard();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow at ${v.width}`);
    await page.screenshot({ path: `test-results/mobile-${v.width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await mkdir('screenshots', { recursive: true });
  for (const [name, hash, act] of [
    ['1-board.png', 'radar', null],
    ['2-detail.png', 'detail=steakhouse-financial', null],
    ['3-filtered.png', 'radar', async () => page.getByRole('button', { name: 'Watchlist', exact: true }).click()],
    ['4-plan.png', 'detail=veda&tab=farm', null],
  ]) {
    await visitBoard(hash);
    if (act) await act();
    if (hash.startsWith('detail=')) await page.locator('#detail[open]').waitFor();
    await settled().catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.screenshot({ type: 'png', animations: 'disabled' });
    assert.ok(bytes.length <= 524288, `${name} is ${bytes.length} bytes`);
    assert.equal(bytes.readUInt32BE(16), 1440);
    assert.equal(bytes.readUInt32BE(20), 900);
    await writeFile(`screenshots/${name}`, bytes, { mode: 0o644 });
    console.log(`${name}: real Chromium capture, 1440x900, ${bytes.length} bytes`);
  }
  assert.deepEqual(external, [], 'the dashboard tried to reach the network');
  assert.deepEqual(errors, [], 'browser or asset errors');
  console.log('Browser checks passed: assets, board agreement, filters, deposit scenario, detail, sources, ledger, model, keyboard exit, mobile, offline.');
} finally {
  await browser.close();
}

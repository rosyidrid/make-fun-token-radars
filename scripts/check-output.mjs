/** Local interpretation of the published artifact gate; not the house's sealed scorer. */
import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildDossier } from '../vendor/makefun-board.ts';

const root = resolve(process.argv[2] ?? 'out-final');
const snapshot = JSON.parse(await readFile(process.argv[3]
  ?? '../.makefun-local/kit/token-radar-01-kit/input/snapshot.json', 'utf8'));
const checks = [];
const plainName = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
async function check(name, run) {
  try { const detail = await run(); checks.push({ check: name, status: 'pass', detail }); }
  catch (error) { checks.push({ check: name, status: 'fail', detail: error.message }); }
}
async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(plainName.test(entry.name), `Invalid asset name: ${entry.name}`);
    const path = join(directory, entry.name);
    const info = await lstat(path);
    assert.ok((info.mode & 0o004) !== 0, `Unreadable output: ${path}`);
    if (info.isDirectory()) files.push(...await filesIn(path, prefix + entry.name + '/'));
    else {
      assert.ok(info.isFile(), `Non-regular asset: ${path}`);
      files.push({ path: prefix + entry.name, bytes: await readFile(path) });
    }
  }
  return files;
}

await check('dashboard_files', async () => {
  const files = await filesIn(join(root, 'dashboard'));
  assert.ok(files.length <= 400);
  assert.ok(files.some(f => f.path === 'index.html'));
  assert.ok(files.some(f => extname(f.path) === '.css') && files.some(f => extname(f.path) === '.js'));
  const size = files.reduce((n, f) => n + f.bytes.length, 0);
  assert.ok(size <= 4194304);
  for (const f of files) {
    const text = f.bytes.toString('utf8');
    if (f.path.endsWith('.css')) assert.doesNotMatch(text, /https?:\/\//i, f.path);
    if (f.path.endsWith('.html')) {
      assert.doesNotMatch(text, /\b[\w:-]+\s*=\s*["'][^"']*https?:\/\//i, f.path);
      for (const style of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) assert.doesNotMatch(style[1], /https?:\/\//i);
    }
    if (f.path.endsWith('.js')) assert.doesNotMatch(text, /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']https?:\/\//, f.path);
  }
  return `${files.length} files, ${size} bytes; no remote asset/import URLs`;
});
let rows;
await check('board_file', async () => {
  const bytes = await readFile(join(root, 'board.json'));
  assert.ok(bytes.length <= 8388608);
  const raw = JSON.parse(bytes);
  rows = Array.isArray(raw) ? raw : raw.rows;
  assert.ok(Array.isArray(rows) && rows.length >= 100 && rows.length <= 4000);
  const slugs = new Set(snapshot.protocols.map(p => p.slug));
  assert.equal(new Set(rows.map(p => p.slug)).size, rows.length);
  for (const row of rows) {
    assert.ok(slugs.has(row.slug) && !/\s/.test(row.slug) && row.slug.length <= 128);
    assert.ok(typeof row.name === 'string' && row.name.trim());
    assert.ok(Number.isSafeInteger(row.rank) && row.rank > 0);
    assert.ok(Number.isSafeInteger(row.implied_value_usd) && row.implied_value_usd > 0 && row.implied_value_usd <= 100000000000000);
  }
  return `${rows.length} real protocol rows, ${bytes.length} bytes`;
});
await check('sorted_by_value', async () => {
  assert.ok(rows);
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  for (const [i, row] of sorted.entries()) {
    assert.equal(row.rank, i + 1);
    if (i) assert.ok(sorted[i - 1].implied_value_usd >= row.implied_value_usd);
  }
  assert.ok(new Set(rows.map(row => row.implied_value_usd)).size > 1);
  return 'Contiguous ranks, descending nonconstant values';
});
await check('coverage', async () => {
  assert.ok(rows);
  const covered = new Set(rows.map(row => row.slug));
  for (const slug of snapshot.watchlist) assert.ok(covered.has(slug), slug);
  return `${snapshot.watchlist.length}/${snapshot.watchlist.length} watchlist`;
});
await check('farm_steps', async () => {
  assert.ok(rows);
  for (const row of rows) {
    assert.ok(Array.isArray(row.farm_steps) && row.farm_steps.length >= 3 && row.farm_steps.length <= 12);
    for (const step of row.farm_steps) assert.ok(typeof step === 'string' && step.trim().length >= 20 && step.trim().length <= 600, row.slug);
  }
  return 'Every row has 3–12 steps, each 20–600 characters';
});

function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let at = 8, ended = false, width, height, bitDepth, colorType;
  const chunks = [];
  while (at < bytes.length) {
    assert.ok(at + 12 <= bytes.length, 'Truncated PNG chunk');
    const length = bytes.readUInt32BE(at);
    assert.ok(at + 12 + length <= bytes.length, 'Truncated PNG data');
    const type = bytes.toString('ascii', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      assert.equal(length, 13); width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9];
      assert.equal(body[12], 0, 'Local checker supports non-interlaced PNG captures.');
    }
    if (type === 'IDAT') chunks.push(body);
    at += length + 12;
    if (type === 'IEND') { assert.equal(length, 0); ended = true; break; }
  }
  assert.ok(ended && at === bytes.length && chunks.length);
  assert.equal(bitDepth, 8);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(channels, 'Unsupported PNG color type');
  const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: 10000000 });
  assert.equal(pixels.length, height * (1 + width * channels), 'PNG pixel data is incomplete');
  return [width, height];
}
await check('screenshots', async () => {
  const files = await filesIn(join(root, 'screenshots'));
  assert.ok(files.length >= 3 && files.length <= 4);
  for (const f of files) {
    assert.ok(f.bytes.length <= 524288);
    assert.ok(f.path.endsWith('.png'), 'This local checker expects the project’s PNG browser captures.');
    const [width, height] = pngSize(f.bytes);
    assert.ok(Math.max(width, height) <= 1440 && Math.min(width, height) >= 800);
  }
  return `${files.length} complete, bounded PNG captures`;
});
await check('dossier_matches', async () => {
  const actual = await readFile(join(root, 'dossier.json'));
  const expected = buildDossier(root, { text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } });
  assert.ok(actual.length <= 1572864);
  assert.deepEqual(actual, Buffer.from(expected));
  const dossier = JSON.parse(actual);
  return `${actual.length} bytes; exact official buildDossier output; source ${/\[Cut at/.test(dossier.text) ? 'partially shown' : 'uncut'}`;
});
console.log(JSON.stringify({ local_only: true, output: root, checks }, null, 2));
if (checks.some(row => row.status === 'fail')) process.exitCode = 1;

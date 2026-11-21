import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSnapshot, buildRadar, predict, trainModel, farmPlan, exclusionReason, tokenRecorded, comparablePeers } from '../dashboard/engine.js';
import { RESEARCH, RESEARCH_DATE } from '../research-data.js';

const fixturePath = process.env.FIELDNOTE_SNAPSHOT ?? '../.makefun-local/kit/token-radar-01-kit/input/snapshot.json';
const snapshot = validateSnapshot(JSON.parse(await readFile(fixturePath, 'utf8')));
const radar = buildRadar(snapshot);

test('sealed snapshot is fully classified, watchlist covered once', () => {
  assert.equal(radar.ledger.length, snapshot.protocols.length);
  assert.equal(new Set(radar.ledger.map(p => p.slug)).size, snapshot.protocols.length);
  assert.ok(radar.rows.length >= 100 && radar.rows.length <= 4000);
  assert.equal(new Set(radar.rows.map(p => p.slug)).size, radar.rows.length);
  assert.deepEqual(radar.rows.filter(p => p.watchlist).map(p => p.slug).sort(), [...snapshot.watchlist].sort());
  assert.equal(radar.ledger.filter(p => p.status === 'candidate').length, radar.rows.length);
});

test('board ranks are contiguous and values descend, with deterministic output', () => {
  assert.deepEqual(radar.rows.map(p => p.rank), radar.rows.map((_, i) => i + 1));
  assert.ok(radar.rows[0].implied_value_usd > radar.rows.at(-1).implied_value_usd);
  for (const [i, p] of radar.rows.entries()) {
    assert.ok(Number.isSafeInteger(p.implied_value_usd) && p.implied_value_usd > 0);
    if (i) assert.ok(radar.rows[i - 1].implied_value_usd >= p.implied_value_usd);
    assert.ok(p.low_value_usd <= p.implied_value_usd && p.high_value_usd >= p.implied_value_usd);
    assert.ok(!tokenRecorded(p));
  }
  assert.equal(JSON.stringify(radar), JSON.stringify(buildRadar(structuredClone(snapshot))));
});

test('every concrete plan fits the gate and research-only routes use no live capital', () => {
  for (const row of radar.rows) {
    assert.ok(row.farm_steps.length >= 3 && row.farm_steps.length <= 12);
    for (const text of row.farm_steps) {
      assert.ok(text.length >= 20 && text.length <= 600, `${row.slug}: ${text.length}`);
      assert.match(text, /Cost:|budget/);
      assert.match(text, /Time:/);
    }
    if (row.plan.label === 'Research only') assert.equal(row.plan.capital_usd, 0);
    assert.deepEqual(row.farm_steps, farmPlan(row, row.age_days).steps);
  }
});

test('browser-recomputed values equal board values and factor breakdown', () => {
  for (const p of radar.rows) {
    assert.equal(p.implied_value_usd, predict(p, snapshot.as_of, radar.model).implied_value_usd);
    const f = p.factors;
    const product = f.intercept_usd * f.tvl * f.growth * f.age * f.category;
    assert.ok(Math.abs(product - p.implied_value_usd) <= 0.501);
  }
});

test('names do not alter valuations and missing age/growth are explicit assumptions', () => {
  const p = radar.rows[0];
  assert.deepEqual(predict(p, snapshot.as_of, radar.model), predict({ ...p, name: 'Different name', slug: 'different-name' }, snapshot.as_of, radar.model));
  const unknown = predict({ ...p, listed_at: null, change_7d: null }, snapshot.as_of, radar.model);
  assert.equal(unknown.age_days, null);
  assert.ok(Number.isSafeInteger(unknown.implied_value_usd));
  assert.equal(unknown.factors.growth, 1);
});

test('five-fold diagnostics are finite and input ordering does not change the fit', () => {
  const m = radar.model;
  assert.equal(m.validation.folds, 5);
  assert.ok(m.peer_count >= 15);
  assert.ok(Number.isFinite(m.validation.typical_factor) && m.validation.typical_factor >= 1);
  assert.ok(Number.isFinite(m.validation.baseline_factor) && m.validation.baseline_factor >= 1);
  assert.deepEqual(trainModel([...snapshot.protocols].reverse(), snapshot.as_of), m);
});

test('token-bearing and wrapped records are separated rather than mislabeled pre-token', () => {
  const p = radar.rows[0];
  assert.ok(exclusionReason({ ...p, gecko_id: 'a-token' }));
  assert.ok(exclusionReason({ ...p, name: 'Wrapped Coin' }));
  assert.ok(exclusionReason({ ...p, name: 'Protocol V2' }));
  assert.ok(exclusionReason({ ...p, category: 'CEX' }));
  for (const row of radar.rows) {
    if (exclusionReason(row)) assert.ok(row.watchlist && row.review_required);
  }
});

test('reject malformed, duplicate, unsafe or future-dated external input', () => {
  assert.throws(() => validateSnapshot(null), /object/);
  const corrupt = mutate => { const raw = structuredClone(snapshot); mutate(raw); return raw; };
  for (const raw of [
    corrupt(s => { s.as_of = '2026-02-30'; }),
    corrupt(s => { s.protocols[0].tvl_usd = -1; }),
    corrupt(s => { s.protocols[0].change_7d = Infinity; }),
    corrupt(s => { s.protocols[0].mcap_usd = -5; }),
    corrupt(s => { s.protocols[0].listed_at = '2099-01-01'; }),
    corrupt(s => { s.protocols[0].slug = '../escape'; }),
    corrupt(s => { s.protocols.push(s.protocols[0]); }),
    corrupt(s => { s.watchlist.push('invented-protocol'); }),
    corrupt(s => { s.watchlist.push(s.watchlist[0]); }),
  ]) assert.throws(() => validateSnapshot(raw));
});

test('unavailable market-cap sentinel is kept out of training, without erasing token identity', () => {
  for (const p of snapshot.protocols.filter(p => p.mcap_usd === -1)) {
    assert.ok(!radar.model.peer_slugs.includes(p.slug));
    assert.equal(radar.ledger.find(row => row.slug === p.slug).status, 'recorded');
  }
});

test('HTML-like external names remain data, never alter model behavior', () => {
  const raw = structuredClone(snapshot);
  raw.protocols.find(p => p.slug === radar.rows[0].slug).name = '<img src=x onerror=alert(1)>';
  const result = buildRadar(validateSnapshot(raw));
  assert.equal(result.rows[0].implied_value_usd, radar.rows[0].implied_value_usd);
  assert.ok(result.rows[0].name.startsWith('<img'));
});

test('explanatory peers come from training data, prefer categories/families and retain actual market caps', () => {
  const index = new Map(snapshot.protocols.map(p => [p.slug, p]));
  for (const p of radar.rows) {
    const peers = comparablePeers(p, snapshot.protocols, radar.model);
    assert.equal(peers.length, 5);
    assert.equal(new Set(peers.map(row => row.slug)).size, 5);
    for (const [i, peer] of peers.entries()) {
      assert.ok(radar.model.peer_slugs.includes(peer.slug));
      assert.notEqual(peer.slug, p.slug);
      assert.equal(peer.mcap_usd, index.get(peer.slug).mcap_usd);
      assert.equal(peer.multiple, peer.mcap_usd / peer.tvl_usd);
      if (i && peer.same_category) assert.ok(peers[i - 1].same_category);
      if (i && peer.same_family && !peer.same_category) assert.ok(peers[i - 1].same_family);
    }
  }
});

test('known token/product and access cautions stay in watchlist but never receive funded plans', () => {
  for (const slug of ['bittensor-dtao', 'usdd', 'onre', 'sentora-curator', 'symbiotic']) {
    const row = radar.rows.find(p => p.slug === slug);
    assert.ok(row && row.review_required);
    const plan = farmPlan(row, row.age_days, 500);
    assert.equal(plan.capital_usd, 0);
    assert.equal(plan.gas_low, 0);
    assert.equal(plan.opportunity_usd, 0);
    assert.ok(row.review_reasons.length);
  }
});

test('source review coverage is explicit, primary URLs are static text and dates do not leak into model', () => {
  assert.equal(Object.keys(RESEARCH).length, 9);
  assert.equal(RESEARCH_DATE, '2026-11-21');
  assert.equal(radar.rows.filter(p => p.research?.status === 'route').length, 4);
  for (const note of Object.values(RESEARCH)) {
    assert.equal(note.actions.length, 3);
    assert.ok(note.stop.length > 20);
    for (const [title, url] of note.sources) {
      assert.ok(title.length > 5);
      assert.equal(new URL(url).protocol, 'https:');
    }
  }
  assert.equal(radar.model.peer_count, 116);
  assert.equal(radar.model.validation.typical_factor, 4.280955682758762);
});

test('pilot scenarios separate principal from costs and never alter valuation', () => {
  const p = radar.rows.find(p => p.slug === 'steakhouse-financial');
  const small = farmPlan(p, p.age_days, 50), large = farmPlan(p, p.age_days, 500);
  assert.equal(small.capital_usd, 50); assert.equal(large.capital_usd, 500);
  assert.equal(small.gas_high, large.gas_high);
  assert.ok(large.opportunity_usd > small.opportunity_usd);
  assert.match(large.steps[2], /\$500/);
  for (const budget of [-1, Infinity, NaN, 10001]) assert.throws(() => farmPlan(p, p.age_days, budget));
  for (const row of radar.rows) for (const text of farmPlan(row, row.age_days, 500).steps) {
    assert.ok(text.length >= 20 && text.length <= 600, row.slug);
  }
});

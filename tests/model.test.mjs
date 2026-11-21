import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSnapshot, buildRadar, predict, predict as predictValue, validateValue, valuePeers, fitOdds, validateOdds,
  oddsPopulation, oddsOf, exclusionReason, tokenRecorded, comparablePeers, economics, gasPerTx, family,
  percentile, ECONOMICS } from '../dashboard/engine.js';
import { planFor, plansFor } from '../lib/plans.js';
import { RESEARCH, RESEARCH_DATE } from '../research-data.js';

const fixture = process.env.FIELDNOTE_SNAPSHOT ?? '../.makefun-local/new-kit/token-radar-01-kit/input/snapshot.json';
const snapshot = validateSnapshot(JSON.parse(await readFile(fixture, 'utf8')));
const plans = plansFor(snapshot);
const radar = buildRadar(snapshot, plans);

test('the sealed snapshot is fully classified and the board covers the watchlist once', () => {
  assert.equal(radar.ledger.length, snapshot.protocols.length);
  assert.equal(radar.ledger_total, snapshot.protocols.length);
  assert.equal(Object.values(radar.ledger_groups).reduce((a, b) => a + b, 0), snapshot.protocols.length);
  assert.equal(new Set(radar.ledger.map(l => l.slug)).size, snapshot.protocols.length);
  assert.ok(radar.rows.length >= 100 && radar.rows.length <= 4000);
  assert.equal(new Set(radar.rows.map(r => r.slug)).size, radar.rows.length);
  assert.deepEqual(radar.rows.filter(r => r.watchlist).map(r => r.slug).sort(), [...snapshot.watchlist].sort());
});

test('ranks are contiguous, values descend and the build is deterministic', () => {
  assert.deepEqual(radar.rows.map(r => r.rank), radar.rows.map((_, i) => i + 1));
  for (const [i, r] of radar.rows.entries()) {
    assert.ok(Number.isSafeInteger(r.implied_value_usd) && r.implied_value_usd > 0);
    if (i) assert.ok(radar.rows[i - 1].implied_value_usd >= r.implied_value_usd);
    assert.ok(r.p25_usd <= r.implied_value_usd && r.p75_usd >= r.implied_value_usd);
    assert.ok(r.launch_odds > 0 && r.launch_odds < 1);
    assert.ok(r.rank_low <= r.rank && r.rank <= r.rank_high);
    assert.ok(!tokenRecorded(r));
  }
  assert.equal(JSON.stringify(radar), JSON.stringify(buildRadar(structuredClone(snapshot), plansFor(snapshot))));
});

test('every plan fits the gate and a research-only route commits no capital', () => {
  for (const r of radar.rows) {
    assert.ok(r.farm_steps.length >= 3 && r.farm_steps.length <= 12);
    for (const s of r.farm_steps) {
      assert.ok(s.length >= 20 && s.length <= 600, `${r.slug}: ${s.length}`);
      assert.match(s, /Cost|cost|budget/);
      assert.match(s, /Time:/);
    }
    assert.deepEqual(r.farm_steps, plans[r.slug].steps);
    if (r.plan.capital_usd === 0) assert.equal(economics(r).verdict, 'skip');
  }
});

test('the browser recomputation equals the board and the factors multiply back', () => {
  for (const p of radar.rows) {
    assert.equal(p.implied_value_usd, predictValue(p, snapshot.as_of, radar.model, radar.model.validation).implied_value_usd);
    const f = p.factors;
    assert.ok(Math.abs(f.intercept_usd * f.tvl * f.growth * f.age * f.category - p.implied_value_usd) <= 0.501);
  }
});

test('names never move a valuation and missing inputs are explicit assumptions', () => {
  const p = radar.rows[0];
  assert.deepEqual(predict(p, snapshot.as_of, radar.model, radar.model.validation),
    predict({ ...p, name: 'Other', slug: 'other' }, snapshot.as_of, radar.model, radar.model.validation));
  const unknown = predict({ ...p, listed_at: null, change_7d: null }, snapshot.as_of, radar.model, radar.model.validation);
  assert.equal(unknown.age_days, null);
  assert.equal(unknown.factors.growth, 1);
});

test('the value model is judged three ways and beats the flat TVL multiple', () => {
  const v = radar.model.validation;
  assert.equal(v.folds, 5);
  for (const k of ['five_fold', 'leave_one_out', 'walk_forward', 'typical_factor', 'flat_factor']) assert.ok(v[k] >= 1);
  assert.ok(v.typical_factor < v.flat_factor, 'fitted terms must beat the flat multiple');
  assert.ok(v.ablation.size_curve < v.ablation.base_flat);
  assert.ok(v.range_holds.p10_p90 > v.range_holds.p25_p75);
  assert.deepEqual(validateValue(valuePeers([...snapshot.protocols].reverse()), snapshot.as_of), v);
});

test('the odds model is scored held-out on the population the board reads', () => {
  const o = radar.odds_check, pop = oddsPopulation(snapshot.protocols, new Set(snapshot.watchlist));
  assert.equal(o.n, pop.length);
  assert.equal(o.n, radar.odds.population);
  assert.ok(o.hit_rate > o.base_hit + 0.15, 'the odds model must beat the base rate by a wide margin');
  assert.ok(o.brier < o.base_brier);
  assert.equal(o.positives, pop.filter(tokenRecorded).length);
  assert.equal(radar.rows.length + pop.filter(tokenRecorded).length, pop.length);
  const again = validateOdds([...pop].reverse(), snapshot.as_of);
  for (const k of ['hit_rate', 'base_hit', 'brier', 'base_brier']) assert.ok(Math.abs(again[k] - o[k]) < 1e-9, k);
  assert.ok(fitOdds(pop, snapshot.as_of).coefficients.every(Number.isFinite));
});

test('odds rise with time tracked on a family that records them late', () => {
  const young = { slug: 'x', name: 'X', category: 'Yield', chains: ['Base'], tvl_usd: 2e8, change_7d: 0,
    mcap_usd: null, listed_at: radar.as_of, gecko_id: null, symbol: null };
  const old = { ...young, listed_at: '2020-01-01' };
  assert.ok(oddsOf(old, snapshot.as_of, radar.odds) > oddsOf(young, snapshot.as_of, radar.odds));
});

test('five explanatory peers come from the training set, category first, with real market caps', () => {
  const index = new Map(snapshot.protocols.map(p => [p.slug, p]));
  for (const p of radar.rows) {
    assert.equal(p.peers.length, 5);
    assert.equal(new Set(p.peers.map(q => q.slug)).size, 5);
    for (const [i, q] of p.peers.entries()) {
      assert.ok(radar.model.peer_slugs.includes(q.slug));
      assert.notEqual(q.slug, p.slug);
      assert.equal(q.mcap_usd, index.get(q.slug).mcap_usd);
      assert.equal(q.multiple, q.mcap_usd / q.tvl_usd);
      if (i && q.same_category) assert.ok(p.peers[i - 1].same_category);
      if (i && q.same_family && !q.same_category) assert.ok(p.peers[i - 1].same_family);
    }
  }
});

test('token-bearing, wrapped, versioned and exchange records are separated', () => {
  const p = radar.rows[0];
  assert.ok(exclusionReason({ ...p, name: 'Wrapped Coin' }));
  assert.ok(exclusionReason({ ...p, name: 'Protocol V2' }));
  assert.ok(exclusionReason({ ...p, category: 'CEX' }));
  assert.ok(exclusionReason({ ...p, name: 'Binance Earn' }));
  for (const r of radar.rows) if (exclusionReason(r)) assert.ok(r.watchlist && r.review_required);
  assert.equal(family('Lending'), 'credit');
  assert.equal(family('Bridge'), 'bridge');
});

test('known identity and access cautions stay on the board but never get funded plans', () => {
  for (const slug of ['bittensor-dtao', 'usdd', 'onre', 'sentora-curator', 'symbiotic', 'steakhouse-financial']) {
    const r = radar.rows.find(x => x.slug === slug);
    assert.ok(r && r.review_required && r.review_reasons.length);
    if (RESEARCH[slug] && RESEARCH[slug].status !== 'route') {
      assert.equal(r.plan.capital_usd, 0);
      assert.equal(economics(r).verdict, 'skip');
    } else assert.ok(['marginal', 'skip'].includes(economics(r).verdict));
  }
});

test('the farm verdict prices the deposit, the fees and the T-bill honestly', () => {
  const r = radar.rows.find(x => x.economics.verdict === 'farm') ?? radar.rows[0];
  const e = economics(r);
  assert.equal(e.deposit, ECONOMICS.deposit);
  assert.ok(Math.abs(e.fees - (2 + gasPerTx(r.plan.chain) * (3 + ECONOMICS.horizon_weeks / 2))) < 1e-9);
  assert.ok(Math.abs(e.tbill - e.deposit * ECONOMICS.tbill_apr * ECONOMICS.horizon_weeks / 52) < 1e-9);
  assert.ok(Math.abs(e.net - (e.dropped - e.fees)) < 1e-9);
  const richer = economics(r, { deposit: 25000 });
  assert.ok(richer.dropped > e.dropped && richer.net > e.net);
  const generous = economics(r, { drop_share: 0.14 });
  assert.ok(generous.net > e.net);
  assert.ok(economics(r, { deposit: 'plan' }).deposit > 1000);
  assert.ok(['farm', 'marginal', 'skip'].includes(e.verdict));
  for (const bad of [0, -1, 1e9]) assert.throws(() => economics(r, { deposit: bad }));
  assert.equal(gasPerTx(['Ethereum']), 3);
  assert.equal(gasPerTx(['Solana']), 0.01);
});

test('verdict counts and the best row agree with the board', () => {
  const counted = { farm: 0, marginal: 0, skip: 0 };
  for (const r of radar.rows) counted[r.economics.verdict]++;
  assert.deepEqual(counted, radar.verdicts);
  assert.equal(radar.verdicts.farm + radar.verdicts.marginal + radar.verdicts.skip, radar.rows.length);
  const best = radar.rows.filter(r => r.economics.tradeable).reduce((a, r) => r.economics.per_hour > a.economics.per_hour ? r : a);
  assert.equal(radar.best_per_hour.slug, best.slug);
  assert.equal(radar.best_per_hour.slug !== '', true);
});

test('the documentation lane is explicit and never leaks into the model', () => {
  assert.equal(Object.keys(RESEARCH).length, 9);
  assert.equal(RESEARCH_DATE, '2026-11-21');
  assert.equal(radar.rows.filter(r => r.research?.status === 'route').length, 4);
  for (const [slug, note] of Object.entries(RESEARCH)) {
    assert.equal(note.actions.length, 3);
    assert.ok(note.stop.length > 20);
    for (const [title, url] of note.sources) assert.equal(new URL(url).protocol, 'https:');
    assert.ok(radar.rows.some(r => r.slug === slug));
  }
  const p = planFor(snapshot.protocols.find(x => x.slug === 'steakhouse-financial'), snapshot.as_of);
  assert.equal(p.documented, 'route');
  assert.match(p.steps[0], /Steakhouse/);
});

test('percentiles behave and malformed external input is refused', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([], 0.5), 0);
  const corrupt = mutate => { const raw = structuredClone(snapshot); mutate(raw); return raw; };
  for (const raw of [corrupt(s => { s.as_of = '2026-02-30'; }), corrupt(s => { s.protocols[0].tvl_usd = -1; }),
    corrupt(s => { s.protocols[0].mcap_usd = -5; }), corrupt(s => { s.protocols[0].listed_at = '2099-01-01'; }),
    corrupt(s => { s.protocols[0].slug = '../escape'; }), corrupt(s => { s.protocols.push(s.protocols[0]); }),
    corrupt(s => { s.watchlist.push('invented'); }), corrupt(s => { s.watchlist.push(s.watchlist[0]); })]) {
    assert.throws(() => validateSnapshot(raw));
  }
});

test('external names stay data and never change a valuation', () => {
  const raw = structuredClone(snapshot);
  raw.protocols.find(p => p.slug === radar.rows[0].slug).name = '<img src=x onerror=alert(1)>';
  const out = buildRadar(validateSnapshot(raw), plansFor(raw));
  assert.equal(out.rows[0].implied_value_usd, radar.rows[0].implied_value_usd);
  assert.ok(out.rows[0].name.startsWith('<img'));
});

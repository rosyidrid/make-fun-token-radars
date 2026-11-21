import { researchFor } from './research.js';
export { validateSnapshot } from '../lib/validate.js';
// Three fitted pieces over the frozen snapshot, all validated held-out:
// value()     what a token would be worth if it launched (log-linear, in live-token market caps)
// odds()      how likely the protocol records a token       (logistic, in the board's population)
// economics() what one deposit buys, less its transactions, against a T-bill
export const MODEL_VERSION = 'fieldnote-3';
export const ECONOMICS = { deposit: 10000, drop_share: 0.07, horizon_weeks: 12, tbill_apr: 0.04, min_per_hour: 25, plan_share_of_tvl: 0.0002 };
const DAY = 86400000, MAX_VALUE = 1e14, RIDGE = 2, ODDS_RIDGE = 6, CATEGORY_PRIOR = 8, BOOTSTRAP = 200;
const EXCLUDED = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking',
  'Liquid Restaking', 'Restaked BTC', 'CEX', 'Staking Pool', 'Stablecoin Wrapper', 'Anchor BTC']);
const EXCHANGES = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED = /\b(wrapped|staked|staking)\b/i;
const FAMILY_ORDER = ['allocation', 'credit', 'markets', 'bridge', 'staking', 'realworld', 'other'];
const FAMILY_OF = [
  ['allocation', ['Risk Curators', 'Onchain Capital Allocator', 'Yield Aggregator', 'Yield', 'Liquidity Manager', 'CDP Manager', 'Indexes', 'Farm']],
  ['credit', ['Lending', 'Uncollateralized Lending', 'CDP', 'Collateral Markets']],
  ['markets', ['Dexs', 'Derivatives', 'Options', 'Prediction Market', 'Basis Trading', 'Leveraged Farming', 'Synthetics']],
  ['bridge', ['Bridge', 'Canonical Bridge', 'Cross Chain Bridge']],
  ['staking', ['Liquid Staking', 'Liquid Restaking', 'Restaking', 'Staking Pool', 'Restaked BTC', 'Anchor BTC']],
  ['realworld', ['RWA', 'CeDeFi', 'Insurance', 'Stablecoin Issuer', 'Stablecoin Wrapper', 'Decentralized BTC']],
];
export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const mean = v => v.reduce((s, n) => s + n, 0) / Math.max(v.length, 1);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
const expit = z => 1 / (1 + Math.exp(-clamp(z, -30, 30)));
export const ageDays = (p, asOf) => p.listed_at === null ? null : Math.floor((Date.parse(asOf) - Date.parse(p.listed_at)) / DAY);
export const tokenRecorded = p => p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
export function percentile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i % 1);
}
/** Gaussian elimination with partial pivoting. */
function solve(matrix, vector) {
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < vector.length; i++) {
    let pivot = i;
    for (let k = i + 1; k < vector.length; k++) if (Math.abs(a[k][i]) > Math.abs(a[pivot][i])) pivot = k;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    if (Math.abs(a[i][i]) < 1e-12) throw new Error('Valuation fit is singular.');
    const scale = a[i][i];
    for (let j = i; j <= vector.length; j++) a[i][j] /= scale;
    for (let k = 0; k < vector.length; k++) {
      if (k === i) continue;
      const w = a[k][i];
      for (let j = i; j <= vector.length; j++) a[k][j] -= w * a[i][j];
    }
  }
  return a.map(row => row[vector.length]);
}
/** Coarse business family: peers inside one family price a launch more alike than one category. */
export function family(category) {
  for (const [name, categories] of FAMILY_OF) if (categories.includes(category)) return name;
  return 'other';
}
/** The value model's four terms: size, momentum, time tracked, and a shrunk category offset. */
const valueFeatures = (p, asOf) => [1, Math.log(p.tvl_usd / 1e8),
  Math.log1p(clamp(p.change_7d ?? 0, -60, 120) / 100), Math.log1p(((ageDays(p, asOf) ?? 365)) / 365)];
function fitValue(peers, asOf) {
  const m = Array.from({ length: 4 }, () => Array(4).fill(0)), v = Array(4).fill(0);
  for (const p of peers) {
    const x = valueFeatures(p, asOf), y = Math.log(p.mcap_usd);
    for (let i = 0; i < 4; i++) {
      v[i] += x[i] * y;
      for (let j = 0; j < 4; j++) m[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < 4; i++) m[i][i] += RIDGE;
  const coefficients = solve(m, v);
  const groups = new Map();
  for (const p of peers) {
    const k = p.category ?? 'Unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(Math.log(p.mcap_usd) - dot(valueFeatures(p, asOf), coefficients));
  }
  const categories = Object.fromEntries([...groups].sort(([a], [b]) => order(a, b)).map(([k, r]) =>
    [k, { count: r.length, adjustment: clamp(mean(r) * r.length / (r.length + CATEGORY_PRIOR), -1.5, 1.5) }]));
  return { coefficients, categories };
}
const logValue = (p, asOf, model) => dot(valueFeatures(p, asOf), model.coefficients)
  + (model.categories[p.category ?? 'Unknown']?.adjustment ?? 0);
/** Why a no-token protocol is left out: a wrapped, bridged, versioned or exchange-linked record. */
export function exclusionReason(p) {
  if (EXCLUDED.has(p.category)) return 'Wrapped, staked, bridged or exchange exposure';
  if (WRAPPED.test(p.name)) return 'Name carries existing-token exposure';
  if (VERSIONED.test(p.name)) return 'Versioned product of another protocol';
  if (EXCHANGES.test(p.name)) return 'Exchange-linked product';
  return null;
}
/** The protocols the value model may read: a recorded token, a positive cap, a sane cap/TVL. */
export function valuePeers(protocols) {
  return protocols.filter(p => (p.gecko_id !== null || p.symbol !== null) && p.mcap_usd > 0
    && p.category !== 'CEX' && p.mcap_usd / p.tvl_usd >= 0.001 && p.mcap_usd / p.tvl_usd <= 100)
    .sort((a, b) => order(a.slug, b.slug));
}
/** A flat multiple read at $100M of TVL: the baseline every fitted term must beat. */
const flatMultiple = (peers, asOf) => percentile(peers.map(p => Math.log(p.mcap_usd / p.tvl_usd)), 0.5);
/** The smallest honest model: a slope on log TVL and nothing else. */
function solveSizeOnly(peers) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of peers) {
    const x = Math.log(p.tvl_usd / 1e8), y = Math.log(p.mcap_usd);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = peers.length, denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return [mean(peers.map(p => Math.log(p.mcap_usd))), 0, 0, 0];
  const slope = (n * sxy - sx * sy) / denom;
  return [(sy - slope * sx) / n, slope, 0, 0];
}
// Every term is judged by how much it lowers the miss on protocols it never saw. Three schemes: five folds…
export function validateValue(peers, asOf) {
  const foldFull = [], foldFlat = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = peers.filter((_, i) => i % 5 !== fold);
    const m = fitValue(train, asOf), flat = flatMultiple(train, asOf);
    for (const p of peers.filter((_, i) => i % 5 === fold)) {
      foldFull.push(Math.abs(Math.log(p.mcap_usd) - logValue(p, asOf, m)));
      foldFlat.push(Math.abs(Math.log(p.mcap_usd) - Math.log(p.tvl_usd) - flat));
    }
  }
  const looFull = [], looFlat = [], looSize = [], looSizeCategory = [], residual = [];
  for (let i = 0; i < peers.length; i++) {
    const p = peers[i], train = peers.filter((_, j) => j !== i);
    const m = fitValue(train, asOf), size = solveSizeOnly(train);
    looFull.push(Math.abs(Math.log(p.mcap_usd) - logValue(p, asOf, m)));
    looFlat.push(Math.abs(Math.log(p.mcap_usd) - Math.log(p.tvl_usd) - flatMultiple(train, asOf)));
    looSize.push(Math.abs(Math.log(p.mcap_usd) - dot(valueFeatures(p, asOf), size)));
    looSizeCategory.push(Math.abs(Math.log(p.mcap_usd) - (dot(valueFeatures(p, asOf), size) + (m.categories[p.category ?? 'Unknown']?.adjustment ?? 0))));
    residual.push(Math.log(p.mcap_usd) - logValue(p, asOf, m));
  }
  const byDate = [...peers].sort((a, b) => order(a.listed_at ?? '9999', b.listed_at ?? '9999') || order(a.slug, b.slug));
  const walkFull = [], walkFlat = [];
  for (let i = 20; i < byDate.length; i++) {
    const p = byDate[i], train = byDate.slice(0, i), m = fitValue(train, asOf);
    walkFull.push(Math.abs(Math.log(p.mcap_usd) - logValue(p, asOf, m)));
    walkFlat.push(Math.abs(Math.log(p.mcap_usd) - Math.log(p.tvl_usd) - flatMultiple(train, asOf)));
  }
  const factor = v => Math.exp(mean(v));
  const errs = [...looFull, ...walkFull];
  const within = hi => errs.filter(v => v <= hi).length / errs.length;
  return {
    folds: 5,
    five_fold: factor(foldFull), five_fold_flat: factor(foldFlat),
    leave_one_out: factor(looFull), leave_one_out_flat: factor(looFlat),
    walk_forward: factor(walkFull), walk_forward_flat: factor(walkFlat),
    typical_factor: factor(errs), flat_factor: factor([...looFlat, ...walkFlat]),
    ablation: { base_flat: factor([...looFlat, ...walkFlat]), size_curve: factor(looSize),
      size_and_category: factor(looSizeCategory), size_category_momentum_age: factor(looFull) },
    residual_low: percentile(residual, 0.1), residual_high: percentile(residual, 0.9),
    range_holds: { p25_p75: within(Math.log(1.5)), p10_p90: within(Math.log(2.5)) },
  };
}
// The odds model. A protocol that records a token is a positive; its features are size, time tracked, that…
export function fitOdds(protocols, asOf) {
  const rows = protocols.map(p => ({ x: oddsFeatures(p, asOf), y: tokenRecorded(p) ? 1 : 0 }));
  const k = rows[0].x.length;
  let beta = Array(k).fill(0);
  for (let iter = 0; iter < 80; iter++) {
    const grad = Array(k).fill(0), hess = Array.from({ length: k }, () => Array(k).fill(0));
    for (const r of rows) {
      const p = expit(dot(r.x, beta)), w = Math.max(p * (1 - p), 1e-6);
      for (let i = 0; i < k; i++) {
        grad[i] += r.x[i] * (r.y - p);
        for (let j = 0; j < k; j++) hess[i][j] += r.x[i] * r.x[j] * w;
      }
    }
    for (let i = 1; i < k; i++) { grad[i] -= ODDS_RIDGE * beta[i]; hess[i][i] += ODDS_RIDGE; }
    const step = solve(hess, grad);
    let move = 0;
    for (let i = 0; i < k; i++) { beta[i] += step[i]; move += Math.abs(step[i]); }
    if (move < 1e-10) break;
  }
  return { coefficients: beta, base_rate: mean(rows.map(r => r.y)), n: rows.length, positives: rows.reduce((s, r) => s + r.y, 0) };
}
/** The board's own population: every pre-token candidate, and every token that already trades. */
export function oddsPopulation(protocols, watchlist) {
  return protocols.filter(p => tokenRecorded(p)
    ? p.mcap_usd !== null && p.mcap_usd > 0 && !EXCLUDED.has(p.category)
    : watchlist.has(p.slug) || exclusionReason(p) === null);
}
export function oddsFeatures(p, asOf) {
  const years = ((ageDays(p, asOf) ?? 365)) / 365;
  return [1, Math.log(p.tvl_usd / 1e8), Math.log1p(years), years * years,
    ...FAMILY_ORDER.slice(0, -1).map(f => family(p.category) === f ? 1 : 0)];
}
export const oddsOf = (p, asOf, model) => clamp(expit(dot(oddsFeatures(p, asOf), model.coefficients)), 0.0005, 0.9995);
/** Held-out odds: five folds, a hit rate against the base rate, and a Brier score against the base rate's. */
export function validateOdds(population, asOf) {
  const briers = [], baseBriers = [], foldHit = [], foldBase = [];
  const base = mean(population.map(p => tokenRecorded(p) ? 1 : 0));
  for (let fold = 0; fold < 5; fold++) {
    const test = population.filter((_, i) => i % 5 === fold);
    const model = fitOdds(population.filter((_, i) => i % 5 !== fold), asOf);
    let correct = 0;
    for (const p of test) {
      const y = tokenRecorded(p) ? 1 : 0, q = oddsOf(p, asOf, model);
      if ((q >= 0.5 ? 1 : 0) === y) correct++;
      briers.push((q - y) ** 2);
      baseBriers.push((base - y) ** 2);
    }
    foldHit.push(correct / test.length);
    foldBase.push(test.length ? mean(test.map(p => tokenRecorded(p) ? 1 : 0)) : 0);
  }
  return { n: population.length, base_rate: base, hit_rate: mean(foldHit), base_hit: mean(foldBase),
    brier: mean(briers), base_brier: mean(baseBriers), lift_calls: mean(foldHit) - mean(foldBase),
    positives: population.filter(tokenRecorded).length };
}
/** Percentile ranges from refits, and the rank span those refits put the row in. */
export function bootstrap(protocols, board, asOf, rounds = BOOTSTRAP) {
  const peers = valuePeers(protocols);
  const values = new Map(board.map(r => [r.slug, []])), ranks = new Map(board.map(r => [r.slug, []]));
  let seed = 20261114;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let b = 0; b < rounds; b++) {
    const sample = Array.from({ length: peers.length }, () => peers[Math.floor(rand() * peers.length)]);
    let model;
    try { model = fitValue(sample, asOf); } catch { continue; }
    board.map(r => ({ slug: r.slug, value: Math.exp(clamp(logValue(r, asOf, model), 0, Math.log(MAX_VALUE))) }))
      .sort((a, c) => c.value - a.value || order(a.slug, c.slug))
      .forEach((s, i) => { values.get(s.slug)?.push(s.value); ranks.get(s.slug)?.push(i + 1); });
  }
  return { rounds, values, ranks };
}
/** One protocol's estimate: value, the two fitted ranges, and the terms that produced it. */
export function predict(p, asOf, model, validation) {
  const x = valueFeatures(p, asOf);
  const category = model.categories[p.category ?? 'Unknown'] ?? { count: 0, adjustment: 0 };
  const log = dot(x, model.coefficients) + category.adjustment;
  const toValue = n => Math.max(1, Math.min(MAX_VALUE, Math.round(Math.exp(clamp(n, 0, Math.log(MAX_VALUE))))));
  const base = toValue(log);
  return {
    implied_value_usd: base,
    low_value_usd: Math.min(base, toValue(log + Math.min(0, validation.residual_low))),
    high_value_usd: Math.max(base, toValue(log + Math.max(0, validation.residual_high))),
    age_days: ageDays(p, asOf), category_peers: category.count,
    extrapolated: p.tvl_usd < model.min_tvl || p.tvl_usd > model.max_tvl,
    factors: {
      intercept_usd: Math.exp(model.coefficients[0]),
      tvl: Math.exp(x[1] * model.coefficients[1]),
      growth: Math.exp(x[2] * model.coefficients[2]),
      age: Math.exp(x[3] * model.coefficients[3]),
      category: Math.exp(category.adjustment),
    },
  };
}
/** Explanatory neighbours: exact category first, then business family, then log-TVL distance. */
export function comparablePeers(p, protocols, model) {
  const allowed = new Set(model.peer_slugs);
  return protocols.filter(q => allowed.has(q.slug) && q.slug !== p.slug).map(q => {
    const sameCategory = q.category === p.category, shared = q.chains.filter(c => p.chains.includes(c));
    return { slug: q.slug, name: q.name, category: q.category, family: family(q.category), tvl_usd: q.tvl_usd,
      mcap_usd: q.mcap_usd, multiple: q.mcap_usd / q.tvl_usd, same_category: sameCategory,
      same_family: family(q.category) === family(p.category), shared_chains: shared,
      distance: Math.abs(Math.log(q.tvl_usd / p.tvl_usd)) + (shared.length ? 0 : 0.4) };
  }).sort((a, b) => Number(b.same_category) - Number(a.same_category) || Number(b.same_family) - Number(a.same_family)
    || a.distance - b.distance || order(a.slug, b.slug)).slice(0, 5);
}
/** On-chain cost per transaction, by the chain the plan actually uses. */
export function gasPerTx(chains) {
  const list = Array.isArray(chains) ? chains : [chains];
  if (list.includes('Ethereum')) return 3;
  const cheap = ['Solana', 'Sui', 'Aptos', 'Tron', 'Bittensor', 'XRPL EVM', 'Plasma', 'Tempo', 'Monad', 'Sonic', 'Katana', 'Proton', 'Ronin'];
  return list.some(c => cheap.includes(c)) ? 0.01 : 0.05;
}
const FALLBACK_STEPS = p => [
  `Verify ${p.name} against its official documentation and contracts; a missing token field is not proof that no token exists. Cost: $0. Time: 15 minutes.`,
  `Check ${p.category ?? 'the product'} for audits, permissions, withdrawal delays and current reward terms. Cost: $0. Time: 15 minutes.`,
  `Confirm one supported permissionless action and a tested exit before committing any capital. Cost: $0. Time: 20 minutes.`,
];
/** The plan a row falls back to when the build-time plan set is absent. */
const fallbackPlan = p => ({ label: 'Research only', documented: 'unreviewed',
  chain: p.chains[0] ?? 'an independently verified chain', capital_usd: 0, gas_per_tx: 0,
  opportunity_usd: 0, duration_days: 30,
  stop: 'Stop until the actual deposit and exit route is verified.', steps: FALLBACK_STEPS(p) });
// What one deposit buys: the modelled drop on the deposit's own share of the protocol, times the odds it…
export function economics(row, options = {}) {
  const o = { ...ECONOMICS, ...options };
  const deposit = o.deposit === 'plan' ? Math.max(250, Math.round(row.tvl_usd * o.plan_share_of_tvl / 50) * 50) : o.deposit;
  if (!finite(deposit) || deposit <= 0 || deposit > 1e6) throw new Error('Deposit must be $1–$1,000,000.');
  const tradeable = row.plan.capital_usd > 0, odds = row.launch_odds;
  const dropped = row.implied_value_usd * o.drop_share * (deposit / row.tvl_usd) * odds;
  const txCount = 3 + Math.floor(o.horizon_weeks / 2);
  const fees = (o.withdrawal_fee ?? 1) * 2 + gasPerTx(row.plan.chain) * txCount;
  const net = dropped - fees, hours = 2.6 + 0.25 * o.horizon_weeks;
  const perHour = tradeable ? net / hours : 0;
  const tbill = deposit * o.tbill_apr * (o.horizon_weeks / 52);
  const scale = row.implied_value_usd * odds * (deposit / row.tvl_usd);
  return { deposit, drop_share: o.drop_share, horizon_weeks: o.horizon_weeks, tbill_apr: o.tbill_apr,
    dropped, fees, net, hours, per_hour: perHour, tbill, tradeable,
    verdict: !tradeable || net <= 0 ? 'skip' : net >= tbill && perHour >= o.min_per_hour ? 'farm' : 'marginal',
    fee_break_even_share: scale > 0 ? fees / scale : null,
    odds_break_even: row.implied_value_usd * o.drop_share * (deposit / row.tvl_usd) > 0
      ? fees / (row.implied_value_usd * o.drop_share * (deposit / row.tvl_usd)) : null };
}
/** The whole universe in one group each: the ledger the page prints must sum to the snapshot. */
const LEDGER_CATEGORY = new Map([
  ['Bridge', 'Bridge'], ['Canonical Bridge', 'Bridge'], ['Cross Chain Bridge', 'Bridge'],
  ['Liquid Staking', 'Liquid staking or restaking'], ['Liquid Restaking', 'Liquid staking or restaking'],
  ['Restaking', 'Liquid staking or restaking'], ['Staking Pool', 'Liquid staking or restaking'],
  ['Restaked BTC', 'Liquid staking or restaking'], ['Anchor BTC', 'Liquid staking or restaking'],
  ['CEX', 'Exchange custody'], ['Stablecoin Wrapper', 'Stablecoin wrapper'],
]);
function ledgerGroups(snapshot, ranked) {
  return snapshot.protocols.map(p => {
    const reason = exclusionReason(p);
    const group = tokenRecorded(p) ? (p.mcap_usd !== null && p.mcap_usd > 0 ? 'Token trades' : 'Token on record')
      : ranked.has(p.slug) ? 'Ranked here'
      : LEDGER_CATEGORY.get(p.category) ?? (reason === 'Versioned product of another protocol' ? 'Versioned listing'
        : reason === 'Name carries existing-token exposure' ? 'Wrapped or staked'
        : reason === 'Exchange-linked product' ? 'Exchange custody'
        : reason === null ? 'Below the house floor' : 'Kind of a token');
    return { slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd,
      group, record: tokenRecorded(p) ? 'token recorded' : 'no token recorded' };
  });
}
export function buildRadar(snapshot, plans = {}) {
  const asOf = snapshot.as_of;
  const peers = valuePeers(snapshot.protocols);
  if (peers.length < 15) throw new Error('At least 15 usable live-token comparables are needed.');
  const model = fitValue(peers, asOf), validation = validateValue(peers, asOf);
  const watchlist = new Set(snapshot.watchlist);
  const population = oddsPopulation(snapshot.protocols, watchlist);
  const odds = { ...fitOdds(population, asOf), odds_ridge: ODDS_RIDGE, population: population.length };
  const oddsCheck = validateOdds(population, asOf);
  Object.assign(model, { peer_slugs: peers.map(p => p.slug), peer_count: peers.length,
    min_tvl: Math.min(...peers.map(p => p.tvl_usd)), max_tvl: Math.max(...peers.map(p => p.tvl_usd)),
    ridge: RIDGE, category_prior: CATEGORY_PRIOR, validation });
  const rows = snapshot.protocols.filter(p => !tokenRecorded(p)
    && (watchlist.has(p.slug) || exclusionReason(p) === null)).map(p => {
    const v = predict(p, asOf, model, validation), plan = plans[p.slug] ?? fallbackPlan(p), research = researchFor(p.slug);
    const reasons = [
      ...(exclusionReason(p) ? [`Watchlist retained; ${exclusionReason(p).toLowerCase()}`] : []),
      ...(research && research.status !== 'route' ? [research.title] : []),
      ...(v.category_peers < 3 ? ['Fewer than 3 same-category valuation peers'] : []),
      ...(v.extrapolated ? ['TVL outside observed peer support'] : []),
      ...(!research ? ['Product route not independently reviewed'] : []),
    ];
    return { ...p, ...v, watchlist: watchlist.has(p.slug), farm_steps: plan.steps, plan,
      peers: comparablePeers(p, snapshot.protocols, model), research,
      launch_odds: oddsOf(p, asOf, odds), review_reasons: reasons, review_required: reasons.length > 0 };
  }).sort((a, b) => b.implied_value_usd - a.implied_value_usd || order(a.slug, b.slug));
  const boot = bootstrap(snapshot.protocols, rows, asOf);
  for (const r of rows) {
    const values = boot.values.get(r.slug) ?? [], ranks = boot.ranks.get(r.slug) ?? [];
    r.p25_usd = values.length ? Math.max(1, Math.round(percentile(values, 0.25))) : r.implied_value_usd;
    r.p75_usd = values.length ? Math.max(1, Math.round(percentile(values, 0.75))) : r.implied_value_usd;
    r.rank_low = ranks.length ? Math.min(...ranks) : null;
    r.rank_high = ranks.length ? Math.max(...ranks) : null;
    r.economics = economics(r);
  }
  rows.forEach((r, i) => { r.rank = i + 1; });
  if (rows.length < 100 || rows.length > 4000) throw new Error(`Board needs 100–4000 candidates, found ${rows.length}.`);
  const covered = new Set(rows.map(r => r.slug));
  for (const slug of snapshot.watchlist) if (!covered.has(slug)) throw new Error(`Missing watchlist protocol: ${slug}`);
  for (const r of rows) for (const step of r.farm_steps) {
    if (step.length < 20 || step.length > 600) throw new Error(`Invalid farm step length for ${r.slug}.`);
  }
  const ledger = ledgerGroups(snapshot, covered), groups = {};
  for (const l of ledger) groups[l.group] = (groups[l.group] ?? 0) + 1;
  const verdicts = { farm: 0, marginal: 0, skip: 0 };
  let best = null;
  for (const r of rows) {
    verdicts[r.economics.verdict]++;
    if (r.economics.tradeable && (!best || r.economics.per_hour > best.economics.per_hour)) best = r;
  }
  return {
    version: MODEL_VERSION, as_of: asOf, source: snapshot.source, floor_usd: snapshot.floor_usd,
    universe_size: snapshot.protocols.length, watchlist_size: snapshot.watchlist.length,
    rows, ledger, model, odds, odds_check: oddsCheck, summary_economics: ECONOMICS,
    ledger_groups: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1] - a[1] || order(a[0], b[0]))),
    ledger_total: ledger.length, verdicts,
    best_per_hour: best ? { slug: best.slug, name: best.name, per_hour: best.economics.per_hour, net: best.economics.net, hours: best.economics.hours } : null,
    board_value_usd: rows.reduce((s, r) => s + r.implied_value_usd, 0),
    board_odds_value_usd: rows.reduce((s, r) => s + Math.round(r.implied_value_usd * r.launch_odds), 0),
    bootstrap_rounds: boot.rounds,
  };
}

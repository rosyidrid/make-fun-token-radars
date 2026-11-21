import { researchFor } from './research.js';
export { validateSnapshot } from '../lib/validate.js';
export const MODEL_VERSION = 'fieldnote-2';
const DAY = 86400000;
const MAX_VALUE = 100000000000000;
const RIDGE = 2;
const CATEGORY_PRIOR = 8;
const EXCLUDED = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking',
  'Liquid Restaking', 'Restaked BTC', 'CEX', 'Staking Pool', 'Stablecoin Wrapper', 'Anchor BTC']);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const mean = values => values.reduce((sum, n) => sum + n, 0) / Math.max(values.length, 1);
const finite = n => typeof n === 'number' && Number.isFinite(n);

export function ageDays(p, asOf) {
  return p.listed_at === null ? null : Math.floor((Date.parse(asOf) - Date.parse(p.listed_at)) / DAY);
}

export function tokenRecorded(p) {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

export function exclusionReason(p) {
  if (tokenRecorded(p)) return 'Token or market-cap record exists';
  if (EXCLUDED.has(p.category)) return 'Wrapped, staked, bridged, or exchange exposure';
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return 'Name suggests existing-token exposure';
  if (/\s(v\d+(\.\d+)?|\d+\.\d+)$/i.test(p.name)) return 'Versioned product; parent-token risk';
  if (/^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(p.name)) return 'Exchange-linked product';
  return null;
}

function features(p, asOf) {
  return [
    1,
    Math.log(p.tvl_usd / 100000000),
    Math.log1p(clamp(p.change_7d ?? 0, -60, 120) / 100),
    Math.log1p((ageDays(p, asOf) ?? 365) / 365),
  ];
}

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
      const weight = a[k][i];
      for (let j = i; j <= vector.length; j++) a[k][j] -= weight * a[i][j];
    }
  }
  return a.map(row => row[vector.length]);
}

function dot(a, b) { return a.reduce((sum, n, i) => sum + n * b[i], 0); }
function fit(peers, asOf) {
  const matrix = Array.from({ length: 4 }, () => Array(4).fill(0));
  const vector = Array(4).fill(0);
  for (const p of peers) {
    const x = features(p, asOf);
    const y = Math.log(p.mcap_usd);
    for (let i = 0; i < 4; i++) {
      vector[i] += x[i] * y;
      for (let j = 0; j < 4; j++) matrix[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < 4; i++) matrix[i][i] += RIDGE;
  const coefficients = solve(matrix, vector);
  const groups = new Map();
  for (const p of peers) {
    const category = p.category ?? 'Unknown';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(Math.log(p.mcap_usd) - dot(features(p, asOf), coefficients));
  }
  const categories = Object.fromEntries([...groups].sort(([a], [b]) => order(a, b)).map(([category, residuals]) =>
    [category, { count: residuals.length, adjustment: clamp(mean(residuals) * residuals.length / (residuals.length + CATEGORY_PRIOR), -1.5, 1.5) }]));
  return { coefficients, categories };
}

function logValue(p, asOf, model) {
  return dot(features(p, asOf), model.coefficients) + (model.categories[p.category ?? 'Unknown']?.adjustment ?? 0);
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i % 1);
}

export function trainModel(protocols, asOf) {
  // A live symbol/id is necessary, and extreme or missing market-cap ratios are not valuation peers.
  const peers = protocols.filter(p => (p.gecko_id !== null || p.symbol !== null)
    && p.mcap_usd > 0 && p.category !== 'CEX' && p.mcap_usd / p.tvl_usd >= 0.001
    && p.mcap_usd / p.tvl_usd <= 100).sort((a, b) => order(a.slug, b.slug));
  if (peers.length < 15) throw new Error('At least 15 usable live-token comparables are needed.');
  const residuals = [], modelErrors = [], baselineErrors = [];
  for (let fold = 0; fold < 5; fold++) {
    const training = peers.filter((_, i) => i % 5 !== fold);
    const heldOut = peers.filter((_, i) => i % 5 === fold);
    const model = fit(training, asOf);
    const baseline = percentile(training.map(p => Math.log(p.mcap_usd / p.tvl_usd)), 0.5);
    for (const p of heldOut) {
      const residual = Math.log(p.mcap_usd) - logValue(p, asOf, model);
      residuals.push(residual);
      modelErrors.push(Math.abs(residual));
      baselineErrors.push(Math.abs(Math.log(p.mcap_usd) - Math.log(p.tvl_usd) - baseline));
    }
  }
  const model = fit(peers, asOf);
  const minTVL = Math.min(...peers.map(p => p.tvl_usd));
  const maxTVL = Math.max(...peers.map(p => p.tvl_usd));
  return {
    ...model, version: MODEL_VERSION, peer_count: peers.length,
    peer_slugs: peers.map(p => p.slug), min_tvl: minTVL, max_tvl: maxTVL,
    ridge: RIDGE, category_prior: CATEGORY_PRIOR,
    validation: {
      folds: 5, log_mae: mean(modelErrors), baseline_log_mae: mean(baselineErrors),
      typical_factor: Math.exp(mean(modelErrors)), baseline_factor: Math.exp(mean(baselineErrors)),
      residual_low: percentile(residuals, 0.1), residual_high: percentile(residuals, 0.9),
    },
  };
}

export function predict(p, asOf, model) {
  const x = features(p, asOf);
  const category = model.categories[p.category ?? 'Unknown'] ?? { count: 0, adjustment: 0 };
  const log = dot(x, model.coefficients) + category.adjustment;
  const value = n => Math.max(1, Math.min(MAX_VALUE, Math.round(Math.exp(clamp(n, 0, Math.log(MAX_VALUE))))));
  const base = value(log);
  return {
    implied_value_usd: base,
    low_value_usd: Math.min(base, value(log + Math.min(0, model.validation.residual_low))),
    high_value_usd: Math.max(base, value(log + Math.max(0, model.validation.residual_high))),
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

/** Explanatory neighbors, not a second model: exact category first, then economic proximity. */
function businessFamily(category) {
  if (['Risk Curators', 'Onchain Capital Allocator', 'Yield Aggregator', 'Yield', 'Liquidity Manager', 'CDP Manager', 'Indexes'].includes(category)) return 'allocation';
  if (['Lending', 'Uncollateralized Lending', 'CDP', 'Collateral Markets'].includes(category)) return 'credit';
  if (['Dexs', 'Derivatives', 'Options', 'Prediction Market'].includes(category)) return 'markets';
  if (['Bridge', 'Canonical Bridge', 'Cross Chain Bridge'].includes(category)) return 'bridge';
  if (['Liquid Staking', 'Liquid Restaking', 'Restaking', 'Staking Pool', 'Restaked BTC'].includes(category)) return 'staking';
  return category;
}

export function comparablePeers(p, protocols, model) {
  const allowed = new Set(model.peer_slugs);
  return protocols.filter(peer => allowed.has(peer.slug) && peer.slug !== p.slug).map(peer => {
    const sameCategory = peer.category === p.category;
    const sameFamily = businessFamily(peer.category) === businessFamily(p.category);
    const sharedChains = peer.chains.filter(chain => p.chains.includes(chain));
    const distance = Math.abs(Math.log(peer.tvl_usd / p.tvl_usd)) + (sharedChains.length ? 0 : 0.4);
    return { slug: peer.slug, name: peer.name, category: peer.category,
      tvl_usd: peer.tvl_usd, mcap_usd: peer.mcap_usd, multiple: peer.mcap_usd / peer.tvl_usd,
      same_category: sameCategory, same_family: sameFamily, shared_chains: sharedChains, distance };
  }).sort((a, b) => Number(b.same_category) - Number(a.same_category)
    || Number(b.same_family) - Number(a.same_family)
    || a.distance - b.distance || order(a.slug, b.slug)).slice(0, 5);
}

function planProfile(category) {
  if (['Lending', 'Uncollateralized Lending', 'CDP', 'CDP Manager', 'Collateral Markets'].includes(category)) {
    return { label: 'Supply only', action: 'If the official app supports it, supply a supported stablecoin to one transparent lending market. Do not borrow or loop; first check caps, oracle risk and withdrawal liquidity.' };
  }
  if (['Dexs', 'Liquidity Manager'].includes(category)) {
    return { label: 'Small liquidity test', action: 'If public pools exist, inspect one liquid same-asset or stable pair. Simulate the swap and withdrawal first; use a narrow test amount only after checking pool fees and impermanent-loss exposure.' };
  }
  if (['Yield', 'Yield Aggregator', 'Onchain Capital Allocator', 'Risk Curators', 'Farm', 'Indexes'].includes(category)) {
    return { label: 'Verify vault route', action: 'Identify the actual host vault and its manager, assets and redemption rules. A curator is not necessarily a deposit app; use a supported vault only if a verified, permissionless route exists.' };
  }
  if (['RWA', 'CeDeFi', 'Insurance', 'Stablecoin Issuer', 'Stablecoin Wrapper', 'Staking Pool'].includes(category)) {
    return { label: 'Research only', action: 'Check legal eligibility, issuer risk, redemption terms and whether the asset is an existing-token wrapper. Do not deposit to chase a hypothetical governance token; stop if access or token identity is unclear.' };
  }
  if (['Derivatives', 'Options', 'Prediction Market', 'Leveraged Farming', 'Basis Trading'].includes(category)) {
    return { label: 'Research only', action: 'Review settlement, funding, liquidation and counterparty risks using documentation or a testnet. Do not open leveraged or speculative positions just to create activity for a possible reward.' };
  }
  return { label: 'Research only', action: 'Identify the actual product and verify a supported permissionless action from official documentation. The snapshot does not describe its app or reward rules; do not invent a deposit route.' };
}

export function farmPlan(p, age, capital = 100) {
  if (!finite(capital) || capital < 0 || capital > 10000) throw new Error('Pilot budget must be $0–$10,000.');
  const research = researchFor(p.slug);
  const lowCost = ['Base', 'Arbitrum', 'Optimism', 'Solana', 'Polygon', 'Avalanche', 'Binance'];
  const chain = research?.chain && p.chains.includes(research.chain) ? research.chain
    : lowCost.find(c => p.chains.includes(c)) ?? p.chains[0] ?? 'an independently verified supported chain';
  const profile = planProfile(p.category);
  const researchOnly = research ? research.status !== 'route' : profile.label === 'Research only';
  const fees = chain === 'Ethereum' ? [8, 40] : chain === 'Solana' ? [0.1, 2] : [0.5, 8];
  const duration = age !== null && age < 180 ? 45 : 30;
  const opportunity = Math.round(capital * 0.05 * duration / 365 * 100) / 100;
  const text = n => Number(n.toFixed(2)).toString();
  const steps = [
    `Verify ${p.name}'s official documentation and contracts from independent sources. Confirm whether a token already exists; a missing DefiLlama field is not proof. Cost: $0. Time: 15–25 minutes.`,
    `Check ${p.category ?? 'the product'} on ${chain}: audits, permissions, withdrawal delays and current reward terms. No reward campaign is verified by this snapshot. Cost: $0. Time: 15 minutes; stop if unclear.`,
    `${profile.action} Cost: ${researchOnly ? '$0; no live capital planned' : `at most $${capital} recoverable capital, subject to loss`}. Time: ${researchOnly ? '20 minutes of research' : '15–20 minutes after verification'}.`,
    `${researchOnly ? 'Use a testnet or read-only simulation, not a funded position.' : 'Use a dedicated wallet, minimum approvals and a simulated withdrawal. Do not bridge solely to farm.'} Estimated round-trip network budget on ${chain}: $${text(fees[0])}–$${text(fees[1])}; actual fees and bridge/slippage costs may differ. Time: 10 minutes.`,
    `Review over ${duration} days only if the verified position has independent utility. Do not manufacture weekly volume or assume a holding period qualifies for rewards. Cost: ${researchOnly ? '$0 capital commitment' : `$${text(opportunity)} opportunity cost at an assumed 5% APR, plus position risk`}. Time: 10 minutes weekly.`,
    `Log receipts, costs and exit conditions; test a small withdrawal before scaling. Verify any future claim through official channels and reject requests for a seed phrase. Cost: variable exit gas within the estimate, no promised payout. Time: 10 minutes.`,
  ];
  if (research) {
    steps.splice(0, 4,
      `Review ${p.name}: ${research.title}. Official documentation is separate from the frozen valuation snapshot; no onchain state was verified. Cost: $0. Time: 15 minutes.`,
      ...research.actions.map((action, i) => `${action.replaceAll('{capital}', `$${capital}`)} Cost: ${researchOnly ? '$0; read-only' : i === 1 ? `up to $${capital} at-risk principal, plus variable fees` : '$0 for verification'}. Time: ${i === 0 ? 15 : 20} minutes.`));
  }
  return { label: research ? researchOnly ? 'Research only' : 'Documented route' : profile.label,
    documentation: research?.status ?? 'unreviewed', chain, capital_usd: researchOnly ? 0 : capital,
    gas_low: researchOnly ? 0 : fees[0], gas_high: researchOnly ? 0 : fees[1],
    opportunity_usd: researchOnly ? 0 : opportunity, duration_days: duration, steps };
}

export function buildRadar(snapshot) {
  const model = trainModel(snapshot.protocols, snapshot.as_of);
  const watchlist = new Set(snapshot.watchlist);
  const ledger = snapshot.protocols.map(p => {
    const reason = exclusionReason(p);
    const selected = !tokenRecorded(p) && (watchlist.has(p.slug) || reason === null);
    return { slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd, chains: p.chains, status: selected ? 'candidate' : tokenRecorded(p) ? 'recorded' : 'excluded',
      reason: selected && reason ? `Watchlist retained; review required: ${reason}` : reason ?? 'No token recorded; eligible for research' };
  });
  const selected = new Set(ledger.filter(p => p.status === 'candidate').map(p => p.slug));
  const rows = snapshot.protocols.filter(p => selected.has(p.slug)).map(p => {
    const valuation = predict(p, snapshot.as_of, model);
    const plan = farmPlan(p, valuation.age_days);
    const research = researchFor(p.slug);
    const peers = comparablePeers(p, snapshot.protocols, model);
    const reasons = [
      ...(exclusionReason(p) ? [exclusionReason(p)] : []),
      ...(valuation.category_peers < 3 ? ['Fewer than 3 same-category valuation peers'] : []),
      ...(valuation.extrapolated ? ['TVL outside observed peer support'] : []),
      ...(research && research.status !== 'route' ? [research.title] : []),
      ...(!research ? ['Product route not independently reviewed'] : []),
    ];
    return { ...p, ...valuation, watchlist: watchlist.has(p.slug), farm_steps: plan.steps,
      peers, research, review_reasons: reasons, plan,
      review_required: exclusionReason(p) !== null || valuation.category_peers < 3 || valuation.extrapolated
        || Boolean(research && research.status !== 'route') };
  }).sort((a, b) => b.implied_value_usd - a.implied_value_usd || order(a.slug, b.slug))
    .map((p, i) => ({ ...p, rank: i + 1 }));
  if (rows.length < 100 || rows.length > 4000) throw new Error(`Board needs 100–4000 candidates, found ${rows.length}.`);
  const covered = new Set(rows.map(p => p.slug));
  for (const slug of snapshot.watchlist) if (!covered.has(slug)) throw new Error(`Missing watchlist protocol: ${slug}`);
  for (const p of rows) for (const step of p.farm_steps) {
    if (step.length < 20 || step.length > 600) throw new Error(`Invalid farm step length for ${p.slug}.`);
  }
  return { version: MODEL_VERSION, as_of: snapshot.as_of, source: snapshot.source,
    floor_usd: snapshot.floor_usd, universe_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length, rows, ledger, model };
}

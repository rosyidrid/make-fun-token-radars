import { researchFor } from '../dashboard/research.js';
import { gasPerTx } from '../dashboard/engine.js';

// Long-form plan copy, generated at build time and shipped as data. The board reads the result;
// the model and its validation stay in dashboard/ where the dossier shows them.
const PROFILES = [
  [['Lending', 'Uncollateralized Lending', 'CDP', 'CDP Manager', 'Collateral Markets'], 'Supply only',
    'supply a supported stablecoin to one transparent lending market; do not borrow or loop',
    'Stop if the market caps, oracle or withdrawal liquidity cannot be verified.'],
  [['Dexs', 'Liquidity Manager'], 'Narrow liquidity',
    'inspect one liquid same-asset or stable pair and simulate the swap and the withdrawal before funding',
    'Stop if pool depth, fee tier or impermanent-loss exposure is unclear.'],
  [['Yield', 'Yield Aggregator', 'Onchain Capital Allocator', 'Risk Curators', 'Farm', 'Indexes'], 'Verify vault route',
    'identify the host vault, its curator, its assets and its redemption rules',
    'Stop if no verified permissionless vault route exists.'],
  [['RWA', 'CeDeFi', 'Insurance', 'Stablecoin Issuer', 'Stablecoin Wrapper', 'Staking Pool'], 'Research only',
    'check eligibility, issuer risk, redemption terms and whether the asset wraps one that already trades',
    'Stop when access or token identity is unclear.'],
  [['Derivatives', 'Options', 'Prediction Market', 'Leveraged Farming', 'Basis Trading'], 'Research only',
    'review settlement, funding, liquidation and counterparty risk on a testnet',
    'Stop before any leveraged position opened to manufacture activity.'],
];

/** Six steps, each with a cost and a hand-on time, from the protocol's own record. */
export function planFor(p, asOf, capital = 10000) {
  const research = researchFor(p.slug);
  const low = ['Base', 'Arbitrum', 'Optimism', 'Solana', 'Polygon', 'Avalanche', 'Binance'];
  const chain = research?.chain && p.chains.includes(research.chain) ? research.chain
    : low.find(c => p.chains.includes(c)) ?? p.chains[0] ?? 'an independently verified chain';
  const found = PROFILES.find(([categories]) => categories.includes(p.category));
  const profile = found ? { label: found[1], action: found[2], stop: found[3] }
    : { label: 'Research only', action: 'identify the product and a supported permissionless action from official documentation', stop: 'Stop until the actual deposit and exit route is verified.' };
  const researchOnly = research ? research.status !== 'route' : profile.label === 'Research only';
  const years = p.listed_at === null ? null : (Date.parse(asOf) - Date.parse(p.listed_at)) / 86400000;
  const duration = years !== null && years < 180 ? 45 : 30;
  const opportunity = capital * 0.04 * (duration / 365);
  const perTx = gasPerTx(p.chains);
  const money = n => `$${Number(n.toFixed(2))}`;
  const steps = [
    `Verify ${p.name} against its official documentation and contracts. A missing DefiLlama token field is not proof that no token exists. Cost: $0. Time: 15–25 minutes.`,
    `Check ${p.category ?? 'the product'} on ${chain} for audits, permissions, withdrawal delays and current terms. No reward campaign is verified by this snapshot. Cost: $0. Time: 15 minutes; stop if unclear.`,
    `${profile.action.charAt(0).toUpperCase()}${profile.action.slice(1)}. Cost: ${researchOnly ? '$0; no live capital planned' : `at most ${money(capital)} of recoverable capital, subject to loss`}. Time: ${researchOnly ? '20 minutes of research' : '15–20 minutes after verification'}.`,
    `${researchOnly ? 'Use a testnet or read-only simulation, not a funded position.' : 'Use a dedicated wallet, minimum approvals and a simulated withdrawal. Do not bridge only to farm.'} Estimated network cost on ${chain}: ${money(perTx)} a transaction. Time: 10 minutes.`,
    `Review over ${duration} days only if the verified position has independent utility. Do not manufacture volume. Cost: ${researchOnly ? '$0 committed' : `${money(opportunity)} of opportunity cost at a 4% benchmark, plus position risk`}. Time: 10 minutes a week.`,
    'Keep receipts, costs and exit conditions, and test a small withdrawal before scaling. Verify any future claim through official channels; reject any request for a seed phrase. Cost: the exit transaction, no promised payout. Time: 10 minutes.',
  ];
  if (research) steps.splice(0, 4, `Review ${p.name}: ${research.title}. Documentation is a separate layer from this frozen valuation; no on-chain state was verified. Cost: $0. Time: 15 minutes.`,
    ...research.actions.map((a, i) => `${a.replaceAll('{capital}', money(capital))} Cost: ${researchOnly ? '$0; read-only' : i === 1 ? `at most ${money(capital)} at risk, plus network fees` : '$0 to verify'}. Time: ${i === 0 ? 15 : 20} minutes.`));
  return { label: research ? (researchOnly ? 'Research only' : 'Documented route') : profile.label,
    documented: research?.status ?? 'unreviewed', chain, capital_usd: researchOnly ? 0 : capital,
    gas_per_tx: researchOnly ? 0 : perTx, opportunity_usd: researchOnly ? 0 : opportunity,
    duration_days: duration, stop: research?.stop ?? profile.stop, steps };
}

/** Every plan the board needs, by slug, built once at build time. */
export function plansFor(snapshot) {
  return Object.fromEntries(snapshot.protocols.map(p => [p.slug, planFor(p, snapshot.as_of)]));
}

import { buildRadar, validateSnapshot, economics } from './engine.js';
import { RESEARCH_DATE } from './research.js';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => v === null || v === undefined || v < 0 ? '—'
  : '$' + (v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
    : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(v < 10 ? 2 : 0));
const cash = v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const int = n => new Intl.NumberFormat('en-US').format(n);
const pct = n => n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const PAGE = 8, LEDGER_PAGE = 25;
const WHY = { farm: 'the drop clears the fees and the benchmark', marginal: 'the drop clears the fees, not the benchmark', skip: 'fees or risk exceed the modelled drop' };
let radar, proof = null;
const state = { verdict: 'all', scope: 'all', search: '', category: '', chain: '', review: false, sort: 'implied_value_usd', dir: -1,
  page: 0, deposit: 10000, share: 0.07, ledgerSearch: '', ledgerGroup: '', ledgerPage: 0, open: null, tab: 'evidence' };
/** Every row's economics under the reader's own scenario, from the same fitted models. */
const scenario = row => economics(row, { deposit: state.deposit, drop_share: state.share });
const value = p => state.sort === 'name' ? null : (p[state.sort] ?? -999);
function rowsFor() {
  const q = state.search.trim().toLowerCase();
  return radar.rows.filter(p =>
    (state.verdict === 'all' || scenario(p).verdict === state.verdict)
    && (state.scope === 'all' || (state.scope === 'watchlist' ? p.watchlist
      : state.scope === 'documented' ? p.research?.status === 'route' : p.tvl_usd < radar.floor_usd))
    && (!q || `${p.name} ${p.slug} ${p.category} ${p.chains.join(' ')}`.toLowerCase().includes(q))
    && (!state.category || p.category === state.category) && (!state.chain || p.chains.includes(state.chain))
    && (!state.review || p.review_required))
    .map(p => ({ p, e: scenario(p) }))
    .sort((a, b) => value(a.p) === null
      ? cmp(a.p.name, b.p.name) * state.dir * -1 || a.p.rank - b.p.rank
      : (value(a.p) - value(b.p)) * state.dir || a.p.rank - b.p.rank);
}
/** The page proves itself: its own rows, hashed here, must equal the board the entry submitted. */
async function verify() {
  const board = window.FIELDNOTE_BOARD;
  if (!board || !window.crypto?.subtle) return { ok: null };
  const text = radar.rows.map(r => `${r.slug}:${r.implied_value_usd}`).join('\n');
  const mine = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const ranks = radar.rows.every((r, i) => r.rank === i + 1);
  const ordered = radar.rows.every((r, i) => i === 0 || radar.rows[i - 1].implied_value_usd >= r.implied_value_usd);
  const covered = radar.rows.filter(r => r.watchlist).length === radar.watchlist_size;
  return { ok: mine === board.digest && ranks && ordered && covered && radar.rows.length === board.rows,
    rows: board.rows, total: board.total_usd, mine, theirs: board.digest };
}
function kpis() {
  const v = radar.model.validation, o = radar.odds_check, b = radar.best_per_hour;
  const tiles = [
    ['RANKED', int(radar.rows.length), `${int(radar.universe_size)} records read in all`, ''],
    ['IF IT LAUNCHES', money(radar.board_value_usd), `odds-weighted ${money(radar.board_odds_value_usd)}`, 'hi'],
    ['VALUE MISS, HELD OUT', `×${v.typical_factor.toFixed(2)}`, `flat TVL multiple ×${v.flat_factor.toFixed(2)}`, v.typical_factor < v.flat_factor ? 'hi' : 'warn'],
    ['ODDS CALLED RIGHT', `${(o.hit_rate * 100).toFixed(0)}%`, `base rate ${(o.base_hit * 100).toFixed(0)}% · Brier ${o.brier.toFixed(3)} vs ${o.base_brier.toFixed(3)}`, 'hi'],
    ['WORTH FARMING', `${radar.verdicts.farm}<u> farm</u>`, `${radar.verdicts.marginal} marginal · ${radar.verdicts.skip} skip`, radar.verdicts.farm ? 'hi' : 'warn'],
    ['BEST PER HOUR', b ? `$${b.per_hour.toFixed(0)}<u>/h</u>` : '—', b ? `${esc(b.name)} · net ${cash(b.net)} · ${b.hours.toFixed(1)}h` : '', ''],
  ];
  $('kpis').innerHTML = tiles.map(([l, val, foot, cls]) => `<div class="kpi ${cls}"><small>${l}<span aria-hidden="true">◦</span></small><strong>${val}</strong><em>${foot}</em></div>`).join('');
  $('n-farm').textContent = radar.verdicts.farm; $('n-marginal').textContent = radar.verdicts.marginal; $('n-skip').textContent = radar.verdicts.skip;
  $('nav-count').textContent = radar.rows.length;
  $('caption').textContent = `${radar.rows.length} record no token and pass the screens`;
  $('coverage').textContent = `${radar.watchlist_size}/${radar.watchlist_size} watchlist · ${radar.version} · ${radar.bootstrap_rounds} refits`;
  $('side-date').textContent = radar.as_of; $('top-date').textContent = radar.as_of;
}
const TONES = ['#2f6b45', '#6f9a52', '#c2b45c', '#b98a4a', '#9c6f54', '#7d6a7f', '#5f7c86', '#8aa07b', '#c5cbb0'];
function ledgerStrip() {
  const entries = Object.entries(radar.ledger_groups), total = radar.ledger_total;
  $('ledger-total').textContent = `${int(total)} protocols · ${entries.length} groups`;
  $('ledger-bar').innerHTML = entries.map(([g, n], i) => `<i style="width:${n / total * 100}%;background:${TONES[i % TONES.length]}" title="${esc(g)}: ${n}"></i>`).join('');
  $('ledger-legend').innerHTML = entries.map(([g, n], i) => `<span><b style="color:${TONES[i % TONES.length]}">■</b> <b>${esc(g)}</b> ${n}</span>`).join('');
  $('ledger-chips').innerHTML = entries.map(([g, n]) => `<span>${esc(g)} · ${n}</span>`).join('');
  $('ledger-status').innerHTML = '<option value="">Every group</option>' + entries.map(([g, n]) => `<option value="${esc(g)}">${esc(g)} (${n})</option>`).join('');
}
function strip() {
  const v = radar.model.validation, o = radar.odds_check;
  $('strip').innerHTML = [
    proof === null ? '<b>…</b> checking this page against the submitted board'
      : proof.ok === null ? '<b>·</b> no digest available offline'
      : proof.ok ? `<b>✓</b> this table = board.json (${proof.rows} rows, digest ${proof.mine.slice(0, 12)})`
      : `<b>!</b> differs from board.json (${String(proof.mine).slice(0, 12)} vs ${String(proof.theirs).slice(0, 12)})`,
    proof?.ok ? '<b>✓</b> ranks 1 to N in order, values never rise' : '',
    proof?.ok ? `<b>✓</b> total ${money(radar.board_value_usd)} of ${money(proof.total)}` : '',
    proof?.ok ? `<b>✓</b> watchlist ${radar.watchlist_size} of ${radar.watchlist_size} ranked` : '',
    `<b>✓</b> ${radar.ledger_total} of ${int(radar.universe_size)} protocols in one group each`,
    `<b>✓</b> value by ${v.folds}-fold, leave-one-out and walk-forward`,
    `<b>✓</b> odds called right ${(o.hit_rate * 100).toFixed(0)}% against ${(o.base_hit * 100).toFixed(0)}% base`,
  ].filter(Boolean).join('');
}
function guide() {
  const b = radar.best_per_hour, e = radar.summary_economics;
  $('guide').innerHTML = `<p class="eyebrow">READ TWO NUMBERS</p><h3>Value is not odds.<br>Odds are not a plan.</h3>
    <div class="pair"><div><strong>×${radar.model.validation.typical_factor.toFixed(2)}</strong><span>value miss</span></div><div><strong>${(radar.odds_check.hit_rate * 100).toFixed(0)}%</strong><span>odds called right</span></div></div>
    <p>${cash(e.deposit)} for ${e.horizon_weeks} weeks at a ${(e.drop_share * 100).toFixed(0)}% drop share, less two withdrawals and every transaction, against a ${(e.tbill_apr * 100).toFixed(0)}% T-bill.</p>
    <hr><strong>Verdicts</strong><ol><li>Farm: clears fees and the benchmark, ${cash(e.min_per_hour)} an hour.</li><li>Marginal: clears fees only.</li><li>Skip: fees or risk win.</li></ol>
    ${b ? `<p class="note">Best on the board: ${esc(b.name)}, ${cash(b.net)} net in ${b.hours.toFixed(1)} hands-on hours.</p>` : ''}
    <p class="note">Rewards are unverified and capital can be lost.</p>`;
}
const icon = p => {
  const hue = [106, 40, 168, 22, 70, 210][[...p.slug].reduce((n, c) => n + c.charCodeAt(0), 0) % 6];
  return `<span class="ico" style="--icon-bg:hsl(${hue} 24% 91%);--icon-ink:hsl(${hue} 24% 32%)" aria-hidden="true">${esc(p.name[0])}</span>`;
};
function board() {
  const rows = rowsFor(), max = Math.max(...radar.rows.map(r => r.implied_value_usd));
  state.page = Math.min(state.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
  const start = state.page * PAGE;
  $('body').innerHTML = rows.slice(start, start + PAGE).map(({ p, e }) => `<tr><td class="id">${String(p.rank).padStart(3, '0')}</td>
      <td><span class="who"><button data-open="${esc(p.slug)}" aria-label="Open ${esc(p.name)}">${icon(p)}<span><strong>${esc(p.name)}</strong><small>${esc(p.category ?? 'Unclassified')}${p.watchlist ? ' · watchlist' : ''}${p.review_required ? ' · flag' : ''}</small></span></button></span></td>
      <td class="num val"><strong>${money(p.implied_value_usd)}</strong><small>${money(p.p25_usd)}–${money(p.p75_usd)}</small><span class="sbar" style="width:${Math.max(3, p.implied_value_usd / max * 42)}px" aria-hidden="true"></span></td>
      <td class="num"><strong>${(p.launch_odds * 100).toFixed(0)}%</strong><small>${p.rank_low === null ? '' : `rank ${p.rank_low}–${p.rank_high}`}</small></td>
      <td class="num">${money(p.tvl_usd)}</td><td class="num ${p.change_7d === null ? 'muted' : p.change_7d >= 0 ? 'pos' : 'neg'}">${pct(p.change_7d)}</td>
      <td><span class="tag ${e.verdict}">${e.verdict.toUpperCase()}</span><span class="net">${cash(e.net)}</span><span class="hrs">${e.tradeable ? `$${e.per_hour.toFixed(0)}/h · fees ${cash(e.fees)}` : 'no funded route'}</span></td>
      <td><span class="tag ${e.verdict === 'skip' ? 'skip' : 'farm'}">${esc(p.plan.label)}</span></td>
      <td><button class="id" data-open="${esc(p.slug)}" aria-label="Open ${esc(p.name)}">↗</button></td></tr>`).join('');
  $('empty').hidden = rows.length > 0; $('board').hidden = rows.length === 0;
  $('count').textContent = `${rows.length} of ${radar.rows.length} shown`;
  $('page-info').textContent = rows.length ? `${start + 1}–${Math.min(start + PAGE, rows.length)} of ${rows.length}` : 'nothing matches';
  $('prev').disabled = state.page === 0; $('next').disabled = start + PAGE >= rows.length;
  document.querySelectorAll('[data-sort]').forEach(b => {
    const on = b.dataset.sort === state.sort;
    b.querySelector('span').textContent = on ? (state.dir < 0 ? '↓' : '↑') : '↕';
    if (on) b.closest('th').setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
    else b.closest('th').removeAttribute('aria-sort');
  });
}
function ledger() {
  const q = state.ledgerSearch.trim().toLowerCase();
  const rows = radar.ledger.filter(l => (!state.ledgerGroup || l.group === state.ledgerGroup)
    && (!q || `${l.name} ${l.slug} ${l.category} ${l.group}`.toLowerCase().includes(q)));
  state.ledgerPage = Math.min(state.ledgerPage, Math.max(0, Math.ceil(rows.length / LEDGER_PAGE) - 1));
  const start = state.ledgerPage * LEDGER_PAGE;
  $('ledger-body').innerHTML = rows.slice(start, start + LEDGER_PAGE).map(l => `<tr><td><b>${esc(l.name)}</b><i>${esc(l.category ?? 'Unclassified')}</i></td>
    <td><span class="tag ${l.group === 'Ranked here' ? 'farm' : l.group === 'Token trades' ? 'marginal' : 'skip'}">${esc(l.group)}</span></td>
    <td class="muted">${esc(l.record)}${l.group === 'Ranked here' ? ' · ranked on the board' : ''}</td><td class="num">${money(l.tvl_usd)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">No protocol in this group.</td></tr>';
  $('ledger-info').textContent = `${rows.length ? start + 1 : 0}–${Math.min(start + LEDGER_PAGE, rows.length)} of ${rows.length}`;
  $('ledger-prev').disabled = start === 0; $('ledger-next').disabled = start + LEDGER_PAGE >= rows.length;
}
function model() {
  const v = radar.model.validation, o = radar.odds_check, b = radar.model.coefficients, e = radar.summary_economics, ab = v.ablation;
  $('model-content').innerHTML = `<div class="grid2">
    <article class="mcard full"><p class="eyebrow">WHAT THE NUMBER MEANS</p><h3>An if-it-launches value. Never a price.</h3>
      <div class="formula">log(value) = ${b[0].toFixed(4)} + ${b[1].toFixed(4)}·log(TVL/$100M) + ${b[2].toFixed(4)}·log(1+growth/100) + ${b[3].toFixed(4)}·log(1+years)</div>
      <p>Growth clips to −60%…+120%, missing growth is 0, missing tracking age is 365 days, and days tracked is not launch age. Ridge ${radar.model.ridge}, unpenalised intercept; category residual means shrink with ${radar.model.category_prior} priors and clip at ±1.5 log units. No protocol name, document or launch guess enters the fit.</p></article>
    <article class="mcard"><p class="eyebrow">ONE TERM AT A TIME</p><h3>Miss on protocols left out.</h3>
      <div class="formula">flat TVL multiple    ×${ab.base_flat.toFixed(2)}
+ size curve (TVL^b) ×${ab.size_curve.toFixed(2)}
+ category offset    ×${ab.size_and_category.toFixed(2)}
+ growth and age     ×${ab.size_category_momentum_age.toFixed(2)}</div>
      <p>Each line refits with one more term, leaving one protocol out at a time. Walk-forward refits only on protocols DefiLlama began tracking earlier, so a later one is never priced by itself. ${v.leave_one_out.toFixed(2)} leave-one-out and ${v.walk_forward.toFixed(2)} walk-forward disagree, so the headline is the pooled ×${v.typical_factor.toFixed(2)}.</p>
      <p>${radar.bootstrap_rounds} bootstrap refits of the ${radar.model.peer_count} comparables give every row its band and rank span; ${(v.range_holds.p25_p75 * 100).toFixed(0)}% of held-out misses land inside P25–P75 and ${(v.range_holds.p10_p90 * 100).toFixed(0)}% inside P10–P90. Model-error bands, not a confidence interval.</p></article>
    <article class="mcard"><p class="eyebrow">THE SECOND MODEL</p><h3>How likely a token arrives.</h3>
      <div class="pair"><div><strong>${(o.hit_rate * 100).toFixed(0)}%</strong><span>called right, ${o.n} protocols</span></div><div><strong>${(o.base_hit * 100).toFixed(0)}%</strong><span>base rate alone</span></div></div>
      <p>A ridge logistic over log size, years tracked, years squared and business family, fit on ${o.n} protocols (${o.positives} record a token) and scored five-fold. Brier ${o.brier.toFixed(3)} against ${o.base_brier.toFixed(3)} for the base rate: a ${(o.lift_calls * 100).toFixed(0)}-point lift.</p>
      <p class="warn">Called right is classification, not calibration. A 70% row is not every-other-time reliable, and the snapshot cannot see private plans.</p></article>
    <article class="mcard"><p class="eyebrow">COST BEFORE UPSIDE</p><h3>Principal is not a fee.</h3>
      <p>${cash(e.deposit)} for ${e.horizon_weeks} weeks at a ${(e.drop_share * 100).toFixed(0)}% drop share. The drop is the modelled value times the deposit's share of TVL times the odds. Fees are two withdrawals at $1.00 plus a transaction a fortnight and three setup transactions: Ethereum $3.00, most chains $0.05, the cheapest $0.01. Hands-on time is 2.6 hours plus 15 minutes a week.</p>
      <p>Farm clears the fees and a ${(e.tbill_apr * 100).toFixed(0)}% T-bill on the same money at ${cash(e.min_per_hour)} an hour. Marginal clears fees only. Bridging, slippage, protocol fees and losses are excluded.</p></article>
  </div>`;
}
function detail(slug, tab = state.tab) {
  const p = radar.rows.find(r => r.slug === slug);
  if (!p) return;
  state.open = slug; state.tab = tab;
  const e = scenario(p), plan = p.plan, f = p.factors, v = radar.model.validation;
  const evidence = `<h3>How this figure is made</h3>
    <p class="note">Five live-token neighbours below carry the market's own capitalisation. Another sector is marked: similar size is not similar economics.</p>
    <div class="peer"><table><thead><tr><th>LIVE-TOKEN PEER</th><th class="num">TVL</th><th class="num">MARKET CAP</th><th class="num">CAP/TVL</th><th>MATCH</th></tr></thead>
      <tbody>${p.peers.map(q => `<tr><td><b>${esc(q.name)}</b><i>${esc(q.category)}</i></td><td class="num">${money(q.tvl_usd)}</td><td class="num">${money(q.mcap_usd)}</td><td class="num">${q.multiple.toFixed(2)}×</td><td><span class="tag ${q.same_category ? 'farm' : 'marginal'}">${q.same_category ? 'Same sector' : q.same_family ? 'Related family' : 'Other sector'}</span></td></tr>`).join('')}</tbody></table></div>
    <div class="facts">${[['REFERENCE', money(f.intercept_usd)], ['TVL', `×${f.tvl.toFixed(3)}`], ['GROWTH', `×${f.growth.toFixed(3)}`], ['AGE', `×${f.age.toFixed(3)}`], ['SECTOR', `×${f.category.toFixed(3)}`]].map(([k, val]) => `<div><small>${k}</small><b>${val}</b></div>`).join('')}</div>
    <p class="note">Reference × the four terms gives the base estimate before rounding. ${money(p.p25_usd)}–${money(p.p75_usd)} is the middle half of ${radar.bootstrap_rounds} refits, ranking it ${p.rank_low}–${p.rank_high} across them. The pooled held-out miss is ×${v.typical_factor.toFixed(2)}, so read the band as a wide hint.</p>
    <h3 style="margin-top:16px">The odds, unpacked</h3>
    <p class="note">The ${(p.launch_odds * 100).toFixed(0)}% comes from this protocol's size, the ${p.age_days === null ? 'unknown (365 days assumed)' : int(p.age_days) + ' days'} DefiLlama has tracked it and its business family. Across the ${radar.odds_check.n} protocols the board reads, the model calls ${(radar.odds_check.hit_rate * 100).toFixed(0)}% right against a ${(radar.odds_check.base_hit * 100).toFixed(0)}% base rate.</p>`;
  const farm = `<h3>${esc(plan.label)} · ${esc(plan.chain)}</h3>
    <div class="econ"><div><small>MODELLED DROP</small><b>${cash(e.dropped)}</b></div><div><small>FEES</small><b>${cash(e.fees)}</b></div><div><small>NET</small><b>${cash(e.net)}</b></div><div><small>PER HOUR</small><b>${e.tradeable ? '$' + e.per_hour.toFixed(1) : '—'}</b></div></div>
    <p class="note"><span class="tag ${e.verdict}">${e.verdict.toUpperCase()}</span> — ${esc(WHY[e.verdict])}. The same ${cash(e.deposit)} in a ${(e.tbill_apr * 100).toFixed(0)}% T-bill over ${e.horizon_weeks} weeks returns ${cash(e.tbill)}. The drop assumes a ${(e.drop_share * 100).toFixed(0)}% share of ${money(p.implied_value_usd)} at ${(p.launch_odds * 100).toFixed(0)}% odds${e.fee_break_even_share === null ? '' : `, and fees are covered while the drop share stays above ${(e.fee_break_even_share * 100).toFixed(2)}%`}${e.odds_break_even === null ? '' : `, or the odds stay above ${(e.odds_break_even * 100).toFixed(1)}% at a ${(e.drop_share * 100).toFixed(0)}% share`}. ${e.hours.toFixed(1)} hands-on hours; bridging, slippage, protocol fees and losses excluded.</p>
    <ol class="steps">${plan.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
    $('dlg').innerHTML = `<div class="d-head"><div><h2 id="d-name">${esc(p.name)}</h2><p class="d-sub">${esc(p.category ?? 'Unclassified')} · ${esc(plan.chain)} · ${p.watchlist ? 'house watchlist' : 'extended set'}</p></div><span class="d-rank">RANK ${String(p.rank).padStart(3, '0')} · ${radar.version}</span></div>
    <div class="d-kpi"><div><small>IF A TOKEN LAUNCHES</small><strong>${money(p.implied_value_usd)}</strong><em>middle half ${money(p.p25_usd)}–${money(p.p75_usd)} · rank ${p.rank_low}–${p.rank_high} over ${radar.bootstrap_rounds} refits</em></div>
      <div><small>LAUNCH ODDS</small><strong>${(p.launch_odds * 100).toFixed(0)}%</strong><em>called right ${(radar.odds_check.hit_rate * 100).toFixed(0)}% of the time</em></div>
      <div><small>SNAPSHOT TVL</small><strong>${money(p.tvl_usd)}</strong><em>${pct(p.change_7d)} over seven days</em></div>
      <div><small>TIME TRACKED</small><strong>${p.age_days === null ? '—' : int(p.age_days)}</strong><em>days, not launch age</em></div></div>
    <div class="d-cols"><section>
      <div class="tabs" role="group" aria-label="Fieldnote section">${[['evidence', 'Valuation and odds'], ['farm', 'Farm and exit']].map(([k, l]) => `<button data-tab="${k}" aria-pressed="${state.tab === k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div>${state.tab === 'farm' ? farm : evidence}</div></section>
      <aside class="side-note2"><p class="eyebrow">${p.review_required ? 'REVIEW FLAG' : 'NO FLAG RAISED'}</p>
        <h3>${esc(p.research?.title ?? 'The route is still a hypothesis.')}</h3>
        <p>${esc(p.research?.summary ?? 'No protocol-specific documentation has been reviewed. The model can rank this record, but the snapshot cannot verify its app, assets or reward rules.')}</p>
        <div class="stop"><b>STOP CONDITION</b><p class="note">${esc(plan.stop)}</p></div>
        <p class="eyebrow">STILL TO CHECK</p><ul>${[...p.review_reasons, 'Reward and token allocation unverified'].map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        ${p.research ? `<p class="eyebrow">SOURCES, CHECKED ${RESEARCH_DATE}</p><ul>${p.research.sources.map(([t, u]) => `<li><b>${esc(t)}</b><br><code>${esc(u)}</code></li>`).join('')}</ul>` : ''}
        <p class="note">Snapshot ${radar.as_of}. A documented product can still have no confirmed token or reward programme. Never a trade recommendation.</p></aside></div>`;
  if (!$('detail').open) $('detail').showModal();
}
function view(name) {
  const page = ['radar', 'ledger', 'model'].includes(name) ? name : 'radar';
  for (const k of ['radar', 'ledger', 'model']) $(`${k}-view`).hidden = k !== page;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === page));
  $('crumb').textContent = { radar: 'LAUNCH RADAR', ledger: 'THE 758 LEDGER', model: 'METHOD AND TESTS' }[page];
}
function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('detail=')) {
    view('radar');
    const q = new URLSearchParams(hash);
    detail(q.get('detail'), q.get('tab') === 'farm' ? 'farm' : 'evidence');
    return;
  }
  if ($('detail').open) $('detail').close();
  if (hash === 'filtered') { view('radar'); state.verdict = 'farm'; state.page = 0; sync(); board(); return; }
  view(hash);
}
function sync() {
  document.querySelectorAll('[data-verdict]').forEach(b => { const on = b.dataset.verdict === state.verdict; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  document.querySelectorAll('[data-scope]').forEach(b => { const on = b.dataset.scope === state.scope; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  $('deposit').value = String(state.deposit); $('share').value = String(state.share);
}
function bind() {
  $('main').addEventListener('click', ev => {
    const open = ev.target.closest('[data-open]');
    if (open) location.hash = `detail=${encodeURIComponent(open.dataset.open)}`;
    if (ev.target.closest('#method-link')) location.hash = 'model';
  });
  $('dlg').addEventListener('click', ev => { const t = ev.target.closest('[data-tab]'); if (t) detail(state.open, t.dataset.tab); });
  $('close').addEventListener('click', () => $('detail').close());
  $('detail').addEventListener('close', () => { if (location.hash.startsWith('#detail=')) history.replaceState(null, '', '#radar'); });
  document.querySelectorAll('[data-verdict]').forEach(b => b.addEventListener('click', () => { state.verdict = b.dataset.verdict; state.page = 0; sync(); board(); }));
  document.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { state.scope = b.dataset.scope; state.page = 0; sync(); board(); }));
  document.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.sort;
    state.dir = state.sort === k ? -state.dir : k === 'name' ? 1 : -1;
    state.sort = k; state.page = 0; board();
  }));
  for (const [id, key, ev] of [['search', 'search', 'input'], ['category', 'category', 'change'], ['chain', 'chain', 'change']]) {
    $(id).addEventListener(ev, () => { state[key] = $(id).value; state.page = 0; board(); });
  }
  $('deposit').addEventListener('change', () => { state.deposit = $('deposit').value === 'plan' ? 'plan' : Number($('deposit').value); state.page = 0; board(); guide(); });
  $('share').addEventListener('change', () => { state.share = Number($('share').value); state.page = 0; board(); guide(); });
  $('review').addEventListener('change', () => { state.review = $('review').checked; state.page = 0; board(); });
  const reset = () => { Object.assign(state, { verdict: 'all', scope: 'all', search: '', category: '', chain: '', review: false, page: 0 });
    $('search').value = ''; $('category').value = ''; $('chain').value = ''; $('review').checked = false; sync(); board(); };
  $('reset').addEventListener('click', reset); $('empty-reset').addEventListener('click', reset);
  $('prev').addEventListener('click', () => { state.page--; board(); });
  $('next').addEventListener('click', () => { state.page++; board(); });
  for (const [id, key, ev] of [['ledger-search', 'ledgerSearch', 'input'], ['ledger-status', 'ledgerGroup', 'change']]) {
    $(id).addEventListener(ev, () => { state[key] = $(id).value; state.ledgerPage = 0; ledger(); });
  }
  $('ledger-prev').addEventListener('click', () => { state.ledgerPage--; ledger(); });
  $('ledger-next').addEventListener('click', () => { state.ledgerPage++; ledger(); });
  window.addEventListener('hashchange', route);
}
try {
  radar = buildRadar(validateSnapshot(window.FIELDNOTE_SNAPSHOT), window.FIELDNOTE_PLANS ?? {});
  kpis(); ledgerStrip(); guide();
  $('category').innerHTML = '<option value="">All sectors</option>' + [...new Set(radar.rows.map(p => p.category).filter(Boolean).sort(cmp))].map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('chain').innerHTML = '<option value="">All chains</option>' + [...new Set(radar.rows.flatMap(p => p.chains).sort(cmp))].map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sync(); board(); ledger(); model(); bind(); route();
  verify().then(r => { proof = r; strip(); }).catch(() => { proof = { ok: false }; strip(); });
} catch (error) {
  $('fatal').hidden = false;
  $('fatal').textContent = `FIELDNOTE could not load: ${error.message} Serve the generated output directory over local HTTP; see README.md.`;
  $('radar-view').hidden = true;
}

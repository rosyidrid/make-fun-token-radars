import { buildRadar, validateSnapshot, farmPlan } from './engine.js';
import { RESEARCH_DATE } from './research.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => {
  if (value === null || value === undefined || value < 0) return 'Not reported';
  const n = Math.abs(value);
  return '$' + (n >= 1e9 ? (value / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (value / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? (value / 1e3).toFixed(1) + 'K' : value.toFixed(0));
};
const integer = n => new Intl.NumberFormat('en-US').format(n);
const pct = n => n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const PAGE_SIZE = 9;
const LEDGER_PAGE_SIZE = 25;
let radar;
let activeProtocol = null;
let detailTab = 'evidence';
let pilotBudget = 100;
const state = { scope: 'all', search: '', category: '', chain: '', review: false, sort: 'implied_value_usd', direction: -1, page: 0,
  ledgerSearch: '', ledgerStatus: '', ledgerPage: 0 };

function protocolIcon(p) {
  const hues = [106, 40, 172, 22, 70, 214];
  const seed = [...p.slug].reduce((n, c) => n + c.charCodeAt(0), 0);
  const hue = hues[seed % hues.length];
  return `<span class="protocol-icon" style="--icon-bg:hsl(${hue} 25% 91%);--icon-ink:hsl(${hue} 25% 33%)" aria-hidden="true">${escape(p.name[0])}</span>`;
}

function options(select, values, first) {
  select.innerHTML = `<option value="">${escape(first)}</option>` + [...new Set(values)].sort(byText)
    .map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join('');
}

function stats() {
  const underFloor = radar.rows.filter(p => p.tvl_usd < radar.floor_usd).length;
  const totalTVL = radar.rows.reduce((sum, p) => sum + p.tvl_usd, 0);
  const model = radar.model;
  const cards = [
    ['PROTOCOLS IN VIEW', integer(radar.rows.length), `${integer(radar.universe_size)} records fully classified`, '◉'],
    ['WATCHLIST COVERAGE', `${radar.watchlist_size}<small> / ${radar.watchlist_size}</small>`, '<strong>100% covered</strong> · no omissions', '✓'],
    ['CANDIDATE TVL', money(totalTVL), `${underFloor} discoveries below the $50M floor`, '↗'],
    ['VALUATION PEERS', integer(model.peer_count), `5-fold error: ×/÷${model.validation.typical_factor.toFixed(1)} · not precise`, '⌁'],
  ];
  $('stats').innerHTML = cards.map(([label, value, foot, icon]) => `<div class="stat"><span class="stat-label">${label}<span aria-hidden="true">${icon}</span></span><strong class="stat-number">${value}</strong><span class="stat-foot">${foot}</span></div>`).join('');
  $('nav-count').textContent = radar.rows.length;
  $('candidate-caption').textContent = `${radar.rows.length} no-token-record candidates`;
  $('coverage-note').textContent = `${radar.watchlist_size}/${radar.watchlist_size} watchlist · ${radar.version}`;
  $('side-date').textContent = radar.as_of;
  $('top-date').textContent = radar.as_of;
}

function filteredRows() {
  const query = state.search.trim().toLowerCase();
  return radar.rows.filter(p =>
    (state.scope === 'all' || (state.scope === 'watchlist' ? p.watchlist
      : state.scope === 'documented' ? p.research?.status === 'route' : p.tvl_usd < radar.floor_usd))
    && (!query || `${p.name} ${p.slug} ${p.category} ${p.chains.join(' ')}`.toLowerCase().includes(query))
    && (!state.category || p.category === state.category)
    && (!state.chain || p.chains.includes(state.chain))
    && (!state.review || p.review_required))
    .sort((a, b) => {
      const av = a[state.sort], bv = b[state.sort];
      if (av === null || bv === null) return av === bv ? a.rank - b.rank : av === null ? 1 : -1;
      const difference = typeof av === 'string' ? byText(av, bv) : av - bv;
      return difference * state.direction || a.rank - b.rank;
    });
}

function renderBoard() {
  const rows = filteredRows();
  state.page = Math.min(state.page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
  const start = state.page * PAGE_SIZE;
  $('board-body').innerHTML = rows.slice(start, start + PAGE_SIZE).map(p => {
    const changeClass = p.change_7d === null ? 'neutral' : p.change_7d >= 0 ? 'positive' : 'negative';
    const caution = p.plan.label === 'Research only' || p.review_required;
    return `<tr><td class="rank">${String(p.rank).padStart(2, '0')}</td><td><button class="protocol-button" data-detail="${escape(p.slug)}" aria-label="Inspect ${escape(p.name)}">${protocolIcon(p)}<span><strong>${escape(p.name)}</strong><small>${escape(p.category ?? 'Unclassified')}${p.watchlist ? ' · watchlist' : ''}</small></span></button></td>
      <td class="numeric value-cell"><strong>${money(p.implied_value_usd)}</strong><small>${money(p.low_value_usd)} – ${money(p.high_value_usd)}</small></td>
      <td class="numeric">${money(p.tvl_usd)}</td><td class="numeric ${changeClass}">${pct(p.change_7d)}</td>
      <td><span class="route${caution ? ' caution' : ''}">${escape(signalLabel(p))}</span></td>
      <td><button class="row-arrow" data-detail="${escape(p.slug)}" aria-label="Open ${escape(p.name)} fieldnote">↗</button></td></tr>`;
  }).join('');
  $('empty').hidden = rows.length !== 0;
  $('board-table').hidden = rows.length === 0;
  $('result-count').textContent = `${rows.length} of ${radar.rows.length} protocols`;
  $('page-info').textContent = rows.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} · ranks stay tied to model value` : 'No matching protocols';
  $('previous').disabled = state.page === 0;
  $('next').disabled = start + PAGE_SIZE >= rows.length;
  document.querySelectorAll('[data-sort]').forEach(button => {
    const active = button.dataset.sort === state.sort;
    button.querySelector('span').textContent = active ? (state.direction < 0 ? '↓' : '↑') : '↕';
    const th = button.closest('th');
    if (active) th.setAttribute('aria-sort', state.direction < 0 ? 'descending' : 'ascending');
    else th.removeAttribute('aria-sort');
  });
}

function signalLabel(p) {
  return { route: 'Route documented', identity: 'Identity conflict', product: 'Product token exists',
    access: 'Access / exit check' }[p.research?.status] ?? 'Snapshot only';
}

function renderOverview() {
  const rows = radar.rows;
  const xMin = Math.floor(Math.log10(Math.min(...rows.map(p => p.tvl_usd))));
  const xMax = Math.ceil(Math.log10(Math.max(...rows.map(p => p.tvl_usd))));
  const yMin = Math.floor(Math.log10(Math.min(...rows.map(p => p.implied_value_usd))));
  const yMax = Math.ceil(Math.log10(Math.max(...rows.map(p => p.implied_value_usd))));
  const x = n => 53 + (Math.log10(n) - xMin) / (xMax - xMin) * 537;
  const y = n => 151 - (Math.log10(n) - yMin) / (yMax - yMin) * 126;
  let grid = '';
  for (let i = xMin; i <= xMax; i++) grid += `<line x1="${x(10 ** i)}" x2="${x(10 ** i)}" y1="25" y2="151"/><text x="${x(10 ** i)}" y="171" text-anchor="middle">${money(10 ** i)}</text>`;
  for (let i = yMin; i <= yMax; i++) grid += `<line x1="53" x2="590" y1="${y(10 ** i)}" y2="${y(10 ** i)}"/><text x="44" y="${y(10 ** i) + 3}" text-anchor="end">${money(10 ** i)}</text>`;
  const color = p => ['identity', 'product'].includes(p.research?.status) ? '#e8aa79'
    : p.research?.status === 'route' ? '#d5ed9f' : '#7ba795';
  const points = [...rows].reverse().map(p => `<a href="#detail=${encodeURIComponent(p.slug)}" aria-label="${escape(p.name)}: TVL ${money(p.tvl_usd)}, conditional value ${money(p.implied_value_usd)}"><circle cx="${x(p.tvl_usd).toFixed(1)}" cy="${y(p.implied_value_usd).toFixed(1)}" r="${p.research ? 4.5 : 2.7}" fill="${color(p)}" opacity="${p.research ? 1 : 0.6}"><title>${escape(p.name)} · ${signalLabel(p)}</title></circle></a>`).join('');
  $('market-map').innerHTML = `<svg viewBox="0 0 630 191" role="img" aria-label="All ${rows.length} candidates by recorded TVL and conditional implied value, both log scaled"><g class="chart-grid">${grid}</g>${points}<text x="320" y="190" class="axis-title" text-anchor="middle">RECORDED TVL →</text><text x="54" y="12" class="axis-title">CONDITIONAL VALUE ↑</text></svg><div class="chart-legend"><span><i></i>Snapshot candidate</span><span><i class="documented"></i>Route documented</span><span><i class="conflict"></i>Identity / product caution</span></div>`;
  const reviewed = rows.filter(p => p.research).length;
  const routes = rows.filter(p => p.research?.status === 'route').length;
  $('research-brief').innerHTML = `<div class="brief-number">${reviewed}<span>records reviewed against official docs<br>${routes} documented product routes · ${rows.length - reviewed} not reviewed</span></div>
    <button data-open="bittensor-dtao"><b>01</b><span><strong>dTAO is not tokenless.</strong><small>TAO and subnet alpha already exist.</small></span><span>↗</span></button>
    <button data-open="onre"><b>02</b><span><strong>Buying is not redeeming.</strong><small>ONyc primary exits need verified access.</small></span><span>↗</span></button>
    <p>Docs checked ${RESEARCH_DATE}. No contract state or reward eligibility verified.</p>`;
  const v = radar.model.validation;
  $('insight-panel').innerHTML = `<p class="eyebrow">ANALYST'S MARGIN NOTE</p><h3>Not every missing ticker is an opportunity.</h3><p>Rank reflects conditional value—not launch likelihood or farming profitability. Review flags stay visible, even on the house watchlist.</p>
    <div class="validation-pair"><div><strong>×${v.typical_factor.toFixed(2)}</strong><span>Model error</span></div><div><strong>×${v.baseline_factor.toFixed(2)}</strong><span>Simple baseline</span></div></div><p>5-fold held-out multiplicative error. Lower is better; neither number is precise enough for an investment decision.</p>
    <button class="text-button" data-method>Inspect the methodology ↗</button><hr><p class="eyebrow">READ EACH FIELDNOTE</p><ol><li>Check the token identity.</li><li>Inspect the nearest peers.</li><li>Cost the route and the exit.</li></ol><p class="note">Documentation ≠ security approval.<br>All token rewards remain unverified.</p>`;
}

function reset() {
  Object.assign(state, { scope: 'all', search: '', category: '', chain: '', review: false, page: 0 });
  $('search').value = ''; $('category').value = ''; $('chain').value = ''; $('review-filter').checked = false;
  scopeButtons();
  renderBoard();
}

function scopeButtons() {
  document.querySelectorAll('[data-scope]').forEach(button => {
    const active = button.dataset.scope === state.scope;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function renderLedger() {
  const counts = ['candidate', 'recorded', 'excluded'].map(status => radar.ledger.filter(p => p.status === status).length);
  $('ledger-summary').innerHTML = [['Universe records', radar.universe_size], ['Research candidates', counts[0]],
    ['Token / market-cap recorded', counts[1]], ['Excluded exposure', counts[2]]]
    .map(([label, value]) => `<div><strong>${integer(value)}</strong><span>${escape(label)}</span></div>`).join('');
  const query = state.ledgerSearch.trim().toLowerCase();
  const rows = radar.ledger.filter(p => (!state.ledgerStatus || state.ledgerStatus === p.status)
    && (!query || `${p.name} ${p.slug} ${p.category} ${p.reason}`.toLowerCase().includes(query)));
  state.ledgerPage = Math.min(state.ledgerPage, Math.max(0, Math.ceil(rows.length / LEDGER_PAGE_SIZE) - 1));
  const start = state.ledgerPage * LEDGER_PAGE_SIZE;
  $('ledger-body').innerHTML = rows.slice(start, start + LEDGER_PAGE_SIZE).map(p => `<tr><td>${escape(p.name)}<br><small class="neutral">${escape(p.category)}</small></td><td><span class="route${p.status === 'excluded' ? ' caution' : ''}">${p.status === 'recorded' ? 'Token recorded' : p.status === 'candidate' ? 'Candidate' : 'Excluded exposure'}</span></td><td>${escape(p.reason)}${p.status === 'recorded' ? `<br>Recorded market cap: ${money(p.mcap_usd)} · not a launch estimate` : ''}</td><td class="numeric">${money(p.tvl_usd)}</td></tr>`).join('')
    || '<tr><td colspan="4">No records match this search.</td></tr>';
  $('ledger-info').textContent = `${rows.length ? start + 1 : 0}–${Math.min(start + LEDGER_PAGE_SIZE, rows.length)} of ${rows.length}`;
  $('ledger-previous').disabled = start === 0;
  $('ledger-next').disabled = start + LEDGER_PAGE_SIZE >= rows.length;
}

function renderModel() {
  const m = radar.model, v = m.validation;
  const b = m.coefficients;
  $('model-content').innerHTML = `<div class="model-grid">
    <article class="model-card full"><p class="eyebrow">REPRODUCIBLE MODEL</p><h3>Conditional market cap, not a price.</h3><div class="formula">log(value) = ${b[0].toFixed(4)} + ${b[1].toFixed(4)}·log(TVL/$100M)
+ ${b[2].toFixed(4)}·log(1+growth/100) + ${b[3].toFixed(4)}·log(1+days/365) + category offset</div>
    <p>Growth clip −60%…120%, missing = 0. Unknown tracking age = 365 days, not launch age. Ridge ${m.ridge}; unpenalized intercept. Category residuals shrink with ${m.category_prior} prior observations, clip ±1.5. No names or launch guesses.</p></article>
    <article class="model-card"><p class="eyebrow">Held-out, not fitted-in-sample</p><h3>Error, not certainty.</h3><div class="validation-pair"><div><strong>×${v.typical_factor.toFixed(2)}</strong><span>Model error</span></div><div><strong>×${v.baseline_factor.toFixed(2)}</strong><span>TVL baseline</span></div></div><p>5 folds by sorted slug. Fit model, offsets and median-MC/TVL baseline on training folds only; metric exp(mean absolute log error).</p><p class="warning">Bands: held-out residual P10–P90, expanded to include base. They are not a confidence interval or a future-token validation.</p></article>
    <article class="model-card"><p class="eyebrow">${m.peer_count} PEERS</p><h3>Inspect the context.</h3><p>Require token ID/symbol, positive market cap, MC/TVL 0.001–100; exclude CEX. Explanatory neighbors prioritize category, then related business family, then log-TVL distance plus 0.4 with no shared chain. They do not refit the model.</p><p>Flag &lt;3 category peers or TVL outside ${money(m.min_tvl)}–${money(m.max_tvl)}. Token rights and collateral overlap remain unmodeled.</p></article>
    <article class="model-card"><p class="eyebrow">TWO EVIDENCE LANES</p><h3>Keep contradictions visible.</h3><p>All ${radar.watchlist_size} watchlist rows retained, including identity conflicts. Parent metadata is missing. Docs checked ${RESEARCH_DATE} never change snapshot valuations; unreviewed workflows remain labeled. No security or reward eligibility is verified.</p></article>
    <article class="model-card"><p class="eyebrow">COST THE EXIT</p><h3>Principal is not a fee.</h3><p>Pilot budgets separate principal, gas and 5% APR opportunity cost. Break-even covers gas + opportunity only, excluding slippage, bridging, protocol fees and losses. Review horizons are not eligibility rules. Identity/access conflicts use $0 live capital.</p></article>
    <article class="model-card full"><p>${escape(radar.source)} · ${escape(radar.as_of)}. No live prices, APIs or remote assets. Browser and entrypoint use the same engine and static research dataset.</p></article>
  </div>`;
}

function openDetail(slug, tab = 'evidence') {
  const p = radar.rows.find(row => row.slug === slug);
  if (!p) return;
  activeProtocol = p; detailTab = tab; pilotBudget = 100;
  renderDetail();
  if (!$('detail').open) $('detail').showModal();
}

function renderDetail() {
  const p = activeProtocol;
  const plan = farmPlan(p, p.age_days, pilotBudget);
  const f = p.factors;
  const notes = p.research;
  const evidence = `<h3>The comparison behind the estimate</h3><p class="note">Actual market caps of five training-set neighbors. ${p.category_peers} same-category peers in the full fit. Another category is explicitly marked; similar TVL is not identical economics.</p>
    <div class="table-wrap peer-wrap"><table><thead><tr><th>LIVE-TOKEN PEER</th><th class="numeric">TVL</th><th class="numeric">MARKET CAP</th><th class="numeric">MC/TVL</th><th>MATCH</th></tr></thead><tbody>${p.peers.map(peer => `<tr><td><strong>${escape(peer.name)}</strong><small>${escape(peer.category)}</small></td><td class="numeric">${money(peer.tvl_usd)}</td><td class="numeric">${money(peer.mcap_usd)}</td><td class="numeric">${peer.multiple.toFixed(2)}×</td><td><span class="route${peer.same_category ? '' : ' caution'}">${peer.same_category ? 'Same category' : peer.same_family ? 'Related family' : 'Other category'}</span></td></tr>`).join('')}</tbody></table></div>
    <h3 class="spaced-heading">Recover the number</h3><div class="factor-strip">${[['Reference', money(f.intercept_usd)], ['TVL', f.tvl], ['Growth', f.growth], ['Age', f.age], ['Category', f.category]].map(([label, n]) => `<div><small>${label}</small><strong>${typeof n === 'number' ? '×' + n.toFixed(3) : n}</strong></div>`).join('')}</div><p class="note">Reference × four factors = base estimate before rounding. Bands reflect peer errors, not token-launch probabilities.</p>`;
  const costs = plan.capital_usd ? `<div class="cost-grid"><div><small>AT-RISK PRINCIPAL</small><strong>$${plan.capital_usd}</strong></div><div><small>ROUND-TRIP GAS</small><strong>$${plan.gas_low}–$${plan.gas_high}</strong></div><div><small>OPPORTUNITY COST</small><strong>$${plan.opportunity_usd.toFixed(2)}</strong></div></div><p class="note">Illustrative reward needed to cover gas + opportunity cost: <b>$${(plan.gas_low + plan.opportunity_usd).toFixed(2)}–$${(plan.gas_high + plan.opportunity_usd).toFixed(2)}</b>. Not a payout prediction. Excludes bridging, slippage, protocol fees and capital losses. ${plan.duration_days} days at assumed 5% APR.</p>` : '<p class="warning">Live-capital budget: $0. Resolve identity or access questions before any funded experiment.</p>';
  const farm = `<div class="plan-heading"><h3>${escape(plan.label)} · ${escape(plan.chain)}</h3><label>Pilot scenario <select id="pilot-budget" ${plan.capital_usd ? '' : 'disabled'}>${[50, 100, 500].map(n => `<option value="${n}" ${n === pilotBudget ? 'selected' : ''}>$${n}</option>`).join('')}</select></label></div>${costs}<ol class="plan-list">${plan.steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol>`;
  const sources = notes ? `<h3>Official documentation reviewed</h3><p class="note">Checked ${RESEARCH_DATE}, after the ${radar.as_of} snapshot. These notes do not change the ranking and do not verify current onchain state.</p>${notes.sources.map(([title, url]) => `<article class="source-card"><strong>${escape(title)}</strong><code>${escape(url)}</code><span>Primary source · URL shown as text to preserve offline operation</span></article>`).join('')}<p class="warning">The documented product can exist without a separately confirmed governance token or reward program. Documentation is not a security endorsement.</p>` : `<h3>No protocol-specific source review yet.</h3><p>This workflow is derived from ${escape(p.category)} and snapshot data only. It is not verified app guidance; confirm official documentation and supported routes before action.</p>`;
  $('detail-content').innerHTML = `<div class="detail-heading"><div><h2 id="detail-name">${escape(p.name)}</h2><p class="detail-sub">${escape(p.category)} · ${escape(plan.chain)} · ${p.watchlist ? 'House watchlist' : 'Extended set'}</p></div><span class="detail-rank">MODEL RANK ${String(p.rank).padStart(2, '0')}</span></div>
    <div class="detail-value"><div><label>CONDITIONAL IMPLIED VALUE</label><strong>${money(p.implied_value_usd)}</strong><small>Peer-error band ${money(p.low_value_usd)}–${money(p.high_value_usd)}</small></div><div><label>SNAPSHOT TVL</label><strong>${money(p.tvl_usd)}</strong><small>${pct(p.change_7d)} seven-day change</small></div><div><label>TIME TRACKED</label><strong>${p.age_days === null ? '—' : integer(p.age_days)}<small> days</small></strong><small>Not the protocol launch date</small></div></div>
    <div class="detail-columns"><section><div class="detail-tabs" role="group" aria-label="Fieldnote section">${[['evidence', 'Valuation evidence'], ['farm', 'Farm & exit plan'], ['sources', 'Sources']].map(([tab, label]) => `<button data-detail-tab="${tab}" aria-pressed="${detailTab === tab}" class="${detailTab === tab ? 'selected' : ''}">${label}</button>`).join('')}</div><div class="detail-panel">${detailTab === 'farm' ? farm : detailTab === 'sources' ? sources : evidence}</div></section>
    <aside class="research-note"><p class="eyebrow">${escape(signalLabel(p))}</p><h3>${escape(notes?.title ?? 'The route is still a hypothesis.')}</h3><p>${escape(notes?.summary ?? 'No protocol-specific documentation has been reviewed. The model can rank this record, but the snapshot cannot verify its app, assets or reward rules.')}</p><div class="stop-box"><strong>STOP CONDITION</strong><p>${escape(notes?.stop ?? 'Stop before funding until the actual product, supported assets and exit route are verified.')}</p></div>
    <h4>What still needs checking</h4><ul>${[...p.review_reasons, 'Reward / token allocation unverified'].map(reason => `<li>${escape(reason)}</li>`).join('')}</ul><p class="note">Snapshot ${radar.as_of}${notes ? ` · Docs ${RESEARCH_DATE}` : ''}. Never a trade recommendation.</p></aside></div>`;
  const select = $('pilot-budget');
  if (select) select.addEventListener('change', () => {
    const value = Number(select.value);
    if ([50, 100, 500].includes(value)) { pilotBudget = value; renderDetail(); $('pilot-budget').focus(); }
  });
}

function view(name) {
  const page = ['radar', 'universe', 'model'].includes(name) ? name : 'radar';
  for (const key of ['radar', 'universe', 'model']) $(`${key}-view`).hidden = key !== page;
  document.querySelectorAll('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === page));
  $('breadcrumb').textContent = { radar: 'LAUNCH RADAR', universe: 'UNIVERSE LEDGER', model: 'VALUE METHODOLOGY' }[page];
}

function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('detail=')) {
    view('radar');
    const params = new URLSearchParams(hash);
    const tab = ['evidence', 'farm', 'sources'].includes(params.get('tab')) ? params.get('tab') : 'evidence';
    openDetail(params.get('detail'), tab);
    return;
  }
  if ($('detail').open) $('detail').close();
  if (hash === 'filtered') {
    view('radar');
    state.scope = 'early'; state.page = 0;
    scopeButtons(); renderBoard();
  } else view(hash);
}

function bind() {
  $('main').addEventListener('click', event => {
    const open = event.target.closest('[data-open]');
    if (open) location.hash = `detail=${encodeURIComponent(open.dataset.open)}`;
    if (event.target.closest('[data-method]')) location.hash = 'model';
  });
  $('detail-content').addEventListener('click', event => {
    const button = event.target.closest('[data-detail-tab]');
    if (button) { detailTab = button.dataset.detailTab; renderDetail(); }
  });
  $('board-body').addEventListener('click', event => {
    const button = event.target.closest('[data-detail]');
    if (button) location.hash = `detail=${encodeURIComponent(button.dataset.detail)}`;
  });
  $('close-detail').addEventListener('click', () => $('detail').close());
  $('detail').addEventListener('close', () => {
    if (location.hash.startsWith('#detail=')) history.replaceState(null, '', '#radar');
  });
  document.querySelectorAll('[data-scope]').forEach(button => button.addEventListener('click', () => {
    state.scope = button.dataset.scope; state.page = 0; scopeButtons(); renderBoard();
  }));
  document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    state.direction = state.sort === key ? -state.direction : key === 'name' ? 1 : -1;
    state.sort = key; state.page = 0; renderBoard();
  }));
  for (const [id, key, event] of [['search', 'search', 'input'], ['category', 'category', 'change'], ['chain', 'chain', 'change']]) {
    $(id).addEventListener(event, () => { state[key] = $(id).value; state.page = 0; renderBoard(); });
  }
  $('review-filter').addEventListener('change', () => { state.review = $('review-filter').checked; state.page = 0; renderBoard(); });
  $('reset').addEventListener('click', reset); $('empty-reset').addEventListener('click', reset);
  $('previous').addEventListener('click', () => { state.page--; renderBoard(); });
  $('next').addEventListener('click', () => { state.page++; renderBoard(); });
  $('method-link').addEventListener('click', () => { location.hash = 'model'; });
  for (const [id, key, event] of [['ledger-search', 'ledgerSearch', 'input'], ['ledger-status', 'ledgerStatus', 'change']]) {
    $(id).addEventListener(event, () => { state[key] = $(id).value; state.ledgerPage = 0; renderLedger(); });
  }
  $('ledger-previous').addEventListener('click', () => { state.ledgerPage--; renderLedger(); });
  $('ledger-next').addEventListener('click', () => { state.ledgerPage++; renderLedger(); });
  window.addEventListener('hashchange', route);
}

try {
  const snapshot = validateSnapshot(window.FIELDNOTE_SNAPSHOT);
  radar = buildRadar(snapshot);
  stats();
  options($('category'), radar.rows.map(p => p.category).filter(Boolean), 'All sectors');
  options($('chain'), radar.rows.flatMap(p => p.chains), 'All networks');
  renderBoard(); renderOverview(); renderLedger(); renderModel(); bind(); route();
} catch (error) {
  $('fatal').hidden = false;
  $('fatal').textContent = `FIELDNOTE could not load: ${error.message} Serve the generated out/ directory, not the source dashboard/. See README.md.`;
  $('radar-view').hidden = true;
}

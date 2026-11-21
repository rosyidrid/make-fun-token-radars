/** DOM-contract tests, not a substitute for real browser rendering or screenshots. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset; this.value = ''; this.checked = false; this.hidden = false;
    this.disabled = false; this.open = false; this.innerHTML = ''; this.textContent = '';
    this.listeners = new Map(); this.attributes = new Map();
    this.classList = { toggle() {} };
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  emit(type, event = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector() { return this.child ??= new Element(); }
  closest() { return this.parent ??= new Element(); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
}

const snapshot = JSON.parse(await readFile(process.env.FIELDNOTE_SNAPSHOT
  ?? '../.makefun-local/kit/token-radar-01-kit/input/snapshot.json', 'utf8'));
snapshot.protocols.find(p => p.slug === 'steakhouse-financial').name = '<img src=x onerror=alert(1)>';
const elements = new Map();
const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
const groups = {
  '[data-sort]': ['name', 'implied_value_usd', 'tvl_usd', 'change_7d'].map(sort => new Element({ sort })),
  '[data-scope]': ['all', 'watchlist', 'early', 'documented'].map(scope => new Element({ scope })),
  '[data-nav]': ['radar', 'universe', 'model'].map(nav => new Element({ nav })),
};
globalThis.document = { getElementById: element, querySelectorAll: selector => groups[selector] ?? [] };
globalThis.window = new Element();
window.FIELDNOTE_SNAPSHOT = snapshot;
globalThis.location = { hash: '#radar' };
globalThis.history = { replaceState(_state, _title, hash) { location.hash = hash; } };
await import('../dashboard/app.js');

function reset() { element('reset').emit('click'); }
function route(hash) { location.hash = hash; window.emit('hashchange'); }

test('application initializes, shows real counts, and escapes external HTML', () => {
  assert.equal(element('fatal').textContent, '');
  assert.equal(Number(element('nav-count').textContent), 192);
  assert.match(element('stats').innerHTML, /758 records fully classified/);
  assert.match(element('stats').innerHTML, /100% covered/);
  assert.match(element('board-body').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(element('board-body').innerHTML, /<img src=x/);
});

test('search has an empty state and reset restores candidates', () => {
  element('search').value = 'no-such-protocol-xyz';
  element('search').emit('input');
  assert.equal(element('empty').hidden, false);
  assert.equal(element('board-table').hidden, true);
  assert.equal(element('result-count').textContent, '0 of 192 protocols');
  reset();
  assert.equal(element('empty').hidden, true);
  assert.equal(element('result-count').textContent, '192 of 192 protocols');
});

test('watchlist scope, sector filtering, pagination and sort events are wired', () => {
  groups['[data-scope]'].find(button => button.dataset.scope === 'documented').emit('click');
  assert.equal(element('result-count').textContent, '4 of 192 protocols');
  groups['[data-scope]'].find(button => button.dataset.scope === 'watchlist').emit('click');
  assert.equal(element('result-count').textContent, '40 of 192 protocols');
  element('next').emit('click');
  assert.match(element('page-info').textContent, /^10–18 of 40/);
  reset();
  element('category').value = 'Lending';
  element('category').emit('change');
  assert.match(element('board-body').innerHTML, /Lending/);
  assert.doesNotMatch(element('board-body').innerHTML, /Risk Curators/);
  groups['[data-sort]'].find(button => button.dataset.sort === 'name').emit('click');
  assert.equal(groups['[data-sort]'][0].parent.attributes.get('aria-sort'), 'ascending');
  reset();
});

test('detail route renders valuation, costed plan, and accessible dialog', () => {
  route('#detail=steakhouse-financial');
  assert.equal(element('detail').open, true);
  assert.match(element('detail-content').innerHTML, /CONDITIONAL IMPLIED VALUE/);
  assert.match(element('detail-content').innerHTML, /Route documented/);
  assert.match(element('detail-content').innerHTML, /MODEL RANK/);
  assert.match(element('detail-content').innerHTML, /&lt;img/);
  element('close-detail').emit('click');
  assert.equal(element('detail').open, false);
  assert.equal(location.hash, '#radar');
});

test('universe and methodology routes expose provenance and validation caveats', () => {
  route('#universe');
  assert.equal(element('universe-view').hidden, false);
  assert.equal(element('radar-view').hidden, true);
  element('ledger-status').value = 'recorded';
  element('ledger-status').emit('change');
  assert.match(element('ledger-body').innerHTML, /Token recorded/);
  assert.doesNotMatch(element('ledger-body').innerHTML, /Candidate<\/span>/);
  route('#model');
  assert.equal(element('model-view').hidden, false);
  assert.match(element('model-content').innerHTML, /Held-out, not fitted-in-sample/);
  assert.match(element('model-content').innerHTML, /not a confidence interval/);
  assert.match(element('model-content').innerHTML, /No live prices/);
  route('#filtered');
  assert.equal(element('radar-view').hidden, false);
  assert.notEqual(element('result-count').textContent, '192 of 192 protocols');
});

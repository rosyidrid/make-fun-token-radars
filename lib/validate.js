const finite = n => typeof n === 'number' && Number.isFinite(n);
const nullable = n => n === null || finite(n);
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

export function validateSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Snapshot must be an object.');
  if (!validDate(raw.as_of)) throw new Error('Snapshot has an invalid as_of date.');
  if (typeof raw.source !== 'string' || !raw.source.trim()) throw new Error('Snapshot source is missing.');
  if (!Number.isSafeInteger(raw.floor_usd) || raw.floor_usd <= 0) throw new Error('Invalid watchlist floor.');
  if (!Array.isArray(raw.protocols) || !raw.protocols.length || raw.protocols.length > 10000) throw new Error('Invalid protocols array.');
  const seen = new Set();
  for (const p of raw.protocols) {
    if (!p || typeof p !== 'object' || typeof p.slug !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._()+-]{0,127}$/.test(p.slug) || seen.has(p.slug)) throw new Error('Invalid or duplicate protocol slug.');
    seen.add(p.slug);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 256) throw new Error(`Invalid name: ${p.slug}`);
    if (!Number.isSafeInteger(p.tvl_usd) || p.tvl_usd <= 0) throw new Error(`Invalid TVL: ${p.slug}`);
    // -1 is an unavailable-market-cap sentinel present in the official input.
    if (!nullable(p.change_7d) || !nullable(p.mcap_usd)
      || (p.mcap_usd !== null && (!Number.isSafeInteger(p.mcap_usd) || p.mcap_usd < -1))) throw new Error(`Invalid financial data: ${p.slug}`);
    if (p.category !== null && typeof p.category !== 'string') throw new Error(`Invalid category: ${p.slug}`);
    if (!Array.isArray(p.chains) || p.chains.some(c => typeof c !== 'string' || c.length > 100)) throw new Error(`Invalid chains: ${p.slug}`);
    for (const k of ['gecko_id', 'symbol']) {
      if (p[k] !== null && typeof p[k] !== 'string') throw new Error(`Invalid ${k}: ${p.slug}`);
    }
    if (p.listed_at !== null && (!validDate(p.listed_at) || p.listed_at > raw.as_of)) throw new Error(`Invalid listing date: ${p.slug}`);
  }
  if (!Array.isArray(raw.watchlist) || new Set(raw.watchlist).size !== raw.watchlist.length
    || raw.watchlist.some(slug => typeof slug !== 'string' || !seen.has(slug))) throw new Error('Invalid watchlist membership.');
  return raw;
}

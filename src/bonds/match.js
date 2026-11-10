// Company-name matching between project proponents and electoral bond purchasers.
// Only exact matches after normalisation count as a match. Group relationships (parent /
// subsidiary) are never inferred from names – they come from config/entities.json, where
// each one cites its evidence.

const SUFFIXES = [
  [/\bPVT\b\.?/g, 'PRIVATE'],
  [/\bPRIVATE\s+LTD\b/g, 'PRIVATE LIMITED'],
  [/\bLTD\b\.?/g, 'LIMITED'],
  [/\bCO\b\.?/g, 'COMPANY'],
  [/\bCORPN\b\.?/g, 'CORPORATION'],
  [/&/g, ' AND '],
];

/** "M/s. Torrent Power Ltd." and "TORRENT POWER LIMITED" → "TORRENTPOWERLIMITED". */
export function canonicalCompany(name) {
  let s = String(name ?? '')
    .toUpperCase()
    .replace(/^\s*(M\s*\/\s*S\.?|MESSRS\.?)\s*/, '')
    .replace(/\(.*?\)/g, ' ');
  for (const [re, rep] of SUFFIXES) s = s.replace(re, rep);
  // Spaces are dropped entirely: the bond PDFs wrap names mid-word ("INFRASTRUCTURES LI MITED").
  return s.replace(/[^A-Z0-9]/g, '');
}

/** Pulls company names out of free text such as MPCB hearing titles. */
export function extractCompanies(text) {
  const out = new Set();
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const re = /M\/s\.?\s*(?:M\/s\.?\s*)?([A-Z][A-Za-z0-9&.,'() -]{2,120}?(?:Private Limited|Pvt\.? Ltd\.?|Limited|Ltd\.?|LLP|Corporation|Company))/g;
  for (const m of t.matchAll(re)) out.add(m[1].trim().replace(/[.,]$/, ''));
  const by = /(?:proposed by|proponent:?|developed by)\s+(?:M\/s\.?\s*)?([A-Z][A-Za-z0-9&.,'() -]{2,120}?(?:Private Limited|Pvt\.? Ltd\.?|Limited|Ltd\.?|LLP|Corporation|Company))/gi;
  for (const m of t.matchAll(by)) out.add(m[1].trim().replace(/[.,]$/, ''));
  return [...out];
}

export function buildIndex(bonds) {
  const byKey = new Map();
  for (const p of bonds?.purchasers ?? []) byKey.set(p.key, p);
  return byKey;
}

/**
 * @returns {{exact: object[], groups: object[]}}
 *   exact  – purchasers whose normalised name equals a proponent name in the text
 *   groups – verified group links from config/entities.json that apply to this text
 */
export function bondLinks(text, index, entities) {
  const exact = [];
  for (const name of extractCompanies(text)) {
    const p = index.get(canonicalCompany(name));
    if (p && !exact.some((e) => e.key === p.key)) exact.push({ ...p, matchedOn: name, basis: 'exact company name' });
  }
  const groups = [];
  for (const g of entities?.groups ?? []) {
    if (!g.proponentPatterns.some((pat) => new RegExp(pat, 'i').test(text))) continue;
    const purchases = g.purchasers
      .map((x) => ({ ...x, purchaser: index.get(canonicalCompany(x.name)) }))
      .filter((x) => x.purchaser);
    groups.push({ id: g.id, name: g.name, purchases, searched: g.searched ?? [], note: g.note ?? null });
  }
  return { exact, groups };
}

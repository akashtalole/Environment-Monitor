// Links records from any source to watchlist projects, and flags unknown
// Maharashtra PSP-like records as "discovered" candidates.

const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

function wordHit(haystack, needle) {
  const n = norm(needle).trim();
  if (!n) return false;
  // Short tokens like "PSP" need word boundaries; longer phrases can match as substrings.
  if (n.length <= 4) return new RegExp(`(^|[^a-z0-9])${escape(n)}([^a-z0-9]|$)`).test(haystack);
  return haystack.includes(n);
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function recordText(rec) {
  return norm([rec.title, rec.proposalNo, rec.status, rec.text, ...Object.values(rec.fields ?? {})].join(' | '));
}

/** @returns {string[]} ids of matching projects */
export function matchProjects(rec, projects) {
  const hay = recordText(rec);
  const ids = [];
  for (const p of projects) {
    const allIds = Object.values(p.ids ?? {}).flat().filter(Boolean);
    const idHit = allIds.some((id) => hay.includes(norm(id)));
    const kwHit = (p.keywords ?? []).some((k) => wordHit(hay, k));
    if (idHit || kwHit) ids.push(p.id);
  }
  return ids;
}

export function isDiscovery(rec, discovery) {
  if (!discovery) return false;
  const hay = recordText(rec);
  const kw = (discovery.keywords ?? []).some((k) => wordHit(hay, k));
  if (!kw) return false;
  if (!discovery.regions?.length || rec.region === 'Maharashtra') return true;
  return discovery.regions.some((r) => hay.includes(norm(r)));
}

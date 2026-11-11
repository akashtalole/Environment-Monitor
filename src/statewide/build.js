// Builds data/statewide.json: every Maharashtra project seen on any source, classified by
// sector, located to district/taluka, placed against the WGEEP (Gadgil) zoning, and linked
// to electoral bond purchases by the proponent (exact name or documented group link).
import path from 'node:path';
import * as store from '../lib/store.js';
import { matchProjects } from '../lib/match.js';
import { hash } from '../lib/util.js';
import { bondLinks, buildIndex, extractCompanies } from '../bonds/match.js';

// Two tiers: specific terms decide first; generic words ("road", "plant") only as a fallback,
// because addresses often contain them ("Gut No. 12, Pune-Nashik Road").
export const SECTORS = [
  ['Pumped storage & hydro', /pumped storage|pump storage|\bPSP\b|hydro ?(electric|power)|hydel/i, null],
  ['Mining & quarrying', /\bmin(e|es|ing)\b|quarry|stone crush|sand (mining|ghat|spots?|blocks?|belts?)|bauxite|manganese|laterite|\bcoal\b|opencast|open cast|iron ore|limestone|dolomite|silica sand/i, null],
  ['Industry & chemicals', /MIDC|chemical|pharma|distiller|ethanol|\bsugar\b|sakhar|karkhana|cement|\bsteels?\b|refiner|fertili[sz]er|textile|manufactur|ferro|alloy|foundry|molasses|KLPD|API |bulk drug|agro/i, /industr|plant|unit|factory/i],
  ['Roads, rail & ports', /highway|expressway|express way|mahamarg|access.?control|railway|\bport\b|jetty|airport|harbour|metro rail|\bNHAI\b|ring road/i, /\broad\b|bridge|corridor|terminal/i],
  ['Thermal & other power', /thermal power|power plant|power project|\bTPP\b|solar|wind (farm|power)|transmission line|substation/i, /\bMW\b/i],
  ['Irrigation & water', /irrigation|\bdam\b|barrage|canal|lift scheme|water supply|kolhapur type weir/i, /reservoir/i],
  ['Waste & effluent', /waste|CETP|\bSTP\b|sewage|landfill|bio-?medical|incinerat/i, null],
  ['Real estate & townships', /residential|township|housing|IT park|real estate|construction project|hotel|resort|\bSRA\b|slum/i, /building|commercial|realt(y|ors?)|builders?|developers?|gruha|nirman/i],
  ['Coastal (CRZ)', /\bCRZ\b|coastal|creek/i, null],
];
export const classifySector = (text) =>
  SECTORS.find(([, strong]) => strong.test(text))?.[0] ?? SECTORS.find(([, , weak]) => weak?.test(text))?.[0] ?? 'Other';

const DISTRICT_ALIASES = {
  Ahmednagar: ['Ahmednagar', 'Ahmadnagar', 'Ahilyanagar', 'A.Nagar'],
  Aurangabad: ['Aurangabad', 'Chhatrapati Sambhajinagar', 'Sambhajinagar'],
  Osmanabad: ['Osmanabad', 'Dharashiv'],
  Raigad: ['Raigad', 'Raigarh', 'Alibag'],
  Mumbai: ['Mumbai', 'Bombay'],
  Beed: ['Beed', 'Bid'],
  Gondia: ['Gondia', 'Gondiya'],
  Buldhana: ['Buldhana', 'Buldana'],
};

export function detectDistricts(text, districtNames) {
  const found = [];
  for (const d of districtNames) {
    const names = DISTRICT_ALIASES[d] ?? [d];
    if (names.some((n) => new RegExp(`\\b${n.replace(/[.]/g, '\\.')}\\b`, 'i').test(text))) found.push(d);
  }
  return found;
}

/** Talukas only count when the text marks them as such ("Tal. Maval", "Maval Taluka", "Tehsil Junnar"). */
export function detectTalukas(text, wgTalukas, districts) {
  const t = String(text).replace(/\s+/g, ' ');
  const marked = [];
  for (const m of t.matchAll(/\b(?:Tal(?:uka)?|Tehsil|Tahsil|Tq)\.?\s*[-:–]?\s*([A-Z][A-Za-z]+(?:\s(?:&|and)\s[A-Z][A-Za-z]+)?)/g))
    marked.push(...m[1].split(/\s(?:&|and)\s/));
  for (const m of t.matchAll(/\b([A-Z][A-Za-z]+)\s+(?:Taluka|Tehsil|Tahsil)\b/g)) marked.push(m[1]);
  const lower = new Set(marked.map((s) => s.toLowerCase()));
  const hits = [];
  for (const row of wgTalukas) {
    const names = [row.taluka, row.wgeepName, ...(row.aliases ?? [])].map((s) => s.replace(/\s*\(.*\)/, '').toLowerCase());
    if (!names.some((n) => lower.has(n))) continue;
    // Ambiguous names (Khed exists in Pune and Ratnagiri) need the district to agree.
    if (districts.length && !districts.includes(row.district)) continue;
    if (!hits.some((h) => h.taluka === row.taluka)) hits.push(row);
  }
  return { hits, marked: [...new Set(marked)] };
}

const ZONE_RANK = { ESZ1: 3, ESZ2: 2, ESZ3: 1 };
const GUIDELINE_SECTOR = {
  'Pumped storage & hydro': 'energy',
  'Thermal & other power': 'energy',
  'Mining & quarrying': 'mining',
  'Industry & chemicals': 'industry',
  'Roads, rail & ports': 'transport',
};

function projectKey(title) {
  return String(title)
    .toLowerCase()
    .replace(/environmental impact assessment|\(eia\)|public hearing( for)?|proposed|project|the\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 90);
}

export async function buildStatewide({ log = console } = {}) {
  const cfg = await store.loadConfig();
  const wg = await store.readJson(path.join(store.ROOT, 'config/western-ghats.json'));
  const entities = await store.readJson(path.join(store.ROOT, 'config/entities.json'), { groups: [] });
  const bonds = await store.readJson(path.join(store.DATA_DIR, 'reference', 'electoral-bonds.json'), null);
  const analytics = await store.readJson(path.join(store.DATA_DIR, 'analytics.json'), null);
  const geo = await store.readJson(path.join(store.ROOT, 'web', 'data', 'maharashtra-districts.geojson'), null);
  const districtNames = geo ? geo.features.map((f) => f.properties.district) : [];
  const index = buildIndex(bonds);
  const wgDistricts = new Set(wg.westernGhatsDistricts);

  const byKey = new Map();
  for (const s of cfg.sources) {
    const snap = await store.loadSnapshot(s.id);
    for (const r of Object.values(snap?.records ?? {})) {
      const text = [r.title, r.text].filter(Boolean).join(' | ');
      const isMH = r.region === 'Maharashtra' || /\/MH\//.test(r.proposalNo ?? '') || /maharashtra/i.test(text);
      if (!isMH || s.id === 'mpcb-cac' || s.connector === 'page-watch') continue;
      const key = projectKey(r.title);
      const prev = byKey.get(key);
      const sourceRef = { sourceId: s.id, sourceName: s.name, url: r.url, status: r.status, date: r.date };
      if (prev) {
        prev.sources.push(sourceRef);
        prev.docs.push(...(r.docs ?? []).filter((d) => !prev.docs.some((x) => x.url === d.url)));
        if (r.date && (!prev.date || r.date > prev.date)) prev.date = r.date;
        prev.text += ' | ' + text;
      } else byKey.set(key, { key, title: r.title, text, date: r.date ?? null, proposalNo: r.proposalNo ?? null, sources: [sourceRef], docs: [...(r.docs ?? [])] });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const projects = [...byKey.values()].map((p) => {
    const sector = classifySector(p.title);
    const districts = detectDistricts(p.text, districtNames);
    const { hits, marked } = detectTalukas(p.text, wg.talukas, districts);
    const zone = hits.reduce((best, h) => (ZONE_RANK[h.zone] > (ZONE_RANK[best] ?? 0) ? h.zone : best), null);
    const inWgDistrict = districts.some((d) => wgDistricts.has(d));
    const gKey = GUIDELINE_SECTOR[sector];
    const links = bondLinks(p.text, index, entities);
    const watch = matchProjects({ title: p.title, text: p.text }, cfg.projects);
    const upcoming = p.sources.some((s) => s.sourceId === 'mpcb-hearings-upcoming') && p.date && p.date >= today;
    return {
      id: hash(p.key),
      title: p.title,
      proponents: extractCompanies(p.text),
      sector,
      districts,
      talukas: hits.map((h) => ({ taluka: h.taluka, district: h.district, zone: h.zone, wgeepName: h.wgeepName, partial: !!h.partial })),
      talukasMentioned: marked,
      westernGhats: {
        inWgDistrict,
        zone,
        status: zone ? `WGEEP ${zone}` : inWgDistrict ? (hits.length ? 'WG district' : 'WG district, taluka not identified') : districts.length ? 'Outside WG districts' : 'Location not identified',
        guideline: zone && gKey ? { sector: gKey, text: wg.guidelines[gKey][zone], page: wg.guidelines[gKey].page } : null,
      },
      date: p.date,
      upcoming,
      proposalNo: p.proposalNo,
      sources: p.sources,
      docs: p.docs.slice(0, 8),
      watchlistIds: watch,
      bonds: {
        exact: links.exact.map(({ key, name, cr, bonds: n, first, last, byParty, matchedOn }) => ({ key, name, cr, bonds: n, first, last, byParty, matchedOn })),
        groups: links.groups.map((g) => ({
          ...g,
          purchases: g.purchases.map((x) => ({ name: x.name, relation: x.relation, evidence: x.evidence, cr: x.purchaser.cr, bonds: x.purchaser.bonds, first: x.purchaser.first, last: x.purchaser.last, byParty: x.purchaser.byParty })),
        })),
      },
    };
  });
  projects.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

  // Aggregates the dashboard needs.
  const count = (fn) => projects.reduce((m, p) => (fn(p).forEach((k) => (m[k] = (m[k] ?? 0) + 1)), m), {});
  const zoneRows = wg.talukas.map((t) => ({ ...t, projects: projects.filter((p) => p.talukas.some((x) => x.taluka === t.taluka)).length }));
  const bondCompanies = new Map();
  for (const p of projects) {
    for (const e of p.bonds.exact) bondCompanies.set(e.key, { ...e, basis: 'exact company name', projects: [...(bondCompanies.get(e.key)?.projects ?? []), p.id] });
    for (const g of p.bonds.groups)
      for (const x of g.purchases) {
        const k = `${g.id}:${x.name}`;
        bondCompanies.set(k, { key: k, name: x.name, cr: x.cr, bonds: x.bonds, first: x.first, last: x.last, byParty: x.byParty, basis: x.relation, evidence: x.evidence, projects: [...(bondCompanies.get(k)?.projects ?? []), p.id] });
      }
  }
  const psp = (analytics?.projects ?? []).map((a) => {
    const proj = cfg.projects.find((x) => x.id === a.id);
    const zones = (proj?.talukas ?? []).map((t) => wg.talukas.find((r) => r.taluka.toLowerCase() === t.toLowerCase())).filter(Boolean);
    return {
      id: a.id, name: a.name, capacityMW: a.capacityMW, score: a.scores.overall, coverage: a.scores.coveragePct,
      forestHa: a.metrics.forestLandHa?.value ?? null, trees: a.metrics.treesFelled?.value ?? null, damHeightM: a.metrics.maxDamHeightM?.value ?? null,
      protectedAreaKm: a.metrics.protectedAreaKm?.value ?? null, westernGhatsESA: a.metrics.westernGhatsESA?.value ?? null,
      talukaZones: zones.map((z) => ({ taluka: z.taluka, zone: z.zone })),
      highFlags: a.flags.filter((f) => f.severity === 'high').map((f) => f.title),
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    totals: {
      projects: projects.length,
      inWgDistricts: projects.filter((p) => p.westernGhats.inWgDistrict).length,
      inEsz1: projects.filter((p) => p.westernGhats.zone === 'ESZ1').length,
      upcoming: projects.filter((p) => p.upcoming).length,
      withBondLinks: projects.filter((p) => p.bonds.exact.length || p.bonds.groups.some((g) => g.purchases.length)).length,
    },
    bySector: count((p) => [p.sector]),
    byDistrict: count((p) => p.districts),
    byYear: count((p) => (p.date ? [p.date.slice(0, 4)] : [])),
    byZone: count((p) => [p.westernGhats.zone ?? (p.westernGhats.inWgDistrict ? 'WG district (zone unknown)' : 'Outside / unknown')]),
    wgTalukas: zoneRows,
    bondCompanies: [...bondCompanies.values()].sort((a, b) => b.cr - a.cr),
    bondSource: bonds ? { ...bonds.source, verification: bonds.verification, parties: bonds.parties.slice(0, 12) } : null,
    entitiesNote: entities._readme,
    groupsSearched: entities.groups.map((g) => ({ id: g.id, name: g.name, searched: g.searched, note: g.note, hasPurchases: g.purchasers.length > 0 })),
    westernGhats: { sources: wg.sources, timeline: wg.timeline, summary: wg.maharashtraSummary, guidelines: wg.guidelines, passages: wg.passages, districts: wg.westernGhatsDistricts, talukaNameNote: wg.talukaNameNote },
    psp,
    projects,
  };
  await store.writeJson(path.join(store.DATA_DIR, 'statewide.json'), out);
  log.info(`Statewide: ${projects.length} projects, ${out.totals.inWgDistricts} in Western Ghats districts, ${out.totals.inEsz1} in WGEEP ESZ1 talukas, ${out.totals.withBondLinks} with electoral bond links`);
  return out;
}

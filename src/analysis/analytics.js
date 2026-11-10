// Turns per-document extractions into per-project impact analytics:
//   merged metrics with evidence → derived intensities → risk flags → screening index → peer stats.
import { METRICS, METRIC_BY_KEY } from './metrics.js';

const DOC_PRIORITY = { eia_report: 0, executive_summary: 1, ec_letter: 2, tor_letter: 3, public_hearing_minutes: 4, committee_minutes: 5, forest_clearance: 5, public_hearing_order: 6, committee_agenda: 7, advertisement: 8, other: 9 };
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Picks one value per metric across all documents of a project. Claude's value wins over
 * the rule-based one; among documents, full reports win over summaries over letters.
 * Disagreements beyond the tolerance are kept as conflicts so a human can check them.
 */
export function mergeMetrics(extractions, tolerance = 0.1) {
  const sorted = [...extractions].sort(
    (a, b) => (DOC_PRIORITY[a.documentType] ?? 9) - (DOC_PRIORITY[b.documentType] ?? 9) || String(b.date ?? '').localeCompare(String(a.date ?? '')),
  );
  const metrics = {};
  const conflicts = [];
  for (const m of METRICS) {
    const candidates = [];
    for (const ex of sorted)
      for (const src of [ex.llmMetrics, ex.ruleMetrics]) {
        const v = src?.[m.key];
        if (v?.value != null && v.value !== '') candidates.push({ ...v, unit: m.unit, docUrl: ex.url, docLabel: ex.label, documentType: ex.documentType });
      }
    if (!candidates.length) continue;
    const best = candidates.find((c) => c.method === 'llm') ?? candidates[0];
    metrics[m.key] = best;
    if (m.type === 'number') {
      const differing = candidates.filter((c) => typeof c.value === 'number' && Math.abs(c.value - best.value) > Math.abs(best.value) * tolerance);
      if (differing.length)
        conflicts.push({ key: m.key, label: m.label, chosen: best.value, others: differing.map((c) => ({ value: c.value, method: c.method, docLabel: c.docLabel, page: c.page })) });
    }
  }
  return { metrics, conflicts };
}

const val = (metrics, key) => metrics[key]?.value ?? null;

export function deriveMetrics(metrics) {
  const v = (k) => val(metrics, k);
  const mw = v('capacityMW');
  const hours = v('storageHours');
  const gwh = mw && hours ? (mw * hours) / 1000 : null;
  const per = (x, d = mw) => (x != null && d ? x / d : null);
  const empSpend = v('empTotalCr') ?? v('empCapitalCr');
  return {
    storageGWh: round(gwh, 2),
    forestSharePct: round(v('forestLandHa') != null && v('totalLandHa') ? (v('forestLandHa') / v('totalLandHa')) * 100 : null, 1),
    landHaPerMW: round(per(v('totalLandHa')), 4),
    forestHaPerMW: round(per(v('forestLandHa')), 4),
    landHaPerGWh: round(per(v('totalLandHa'), gwh), 2),
    treesPerMW: round(per(v('treesFelled')), 2),
    treesPerForestHa: round(per(v('treesFelled'), v('forestLandHa')), 1),
    muckLakhCumPerMW: round(per(v('muckLakhCum')), 4),
    costCrPerMW: round(per(v('projectCostCr')), 3),
    costCrPerGWh: round(per(v('projectCostCr'), gwh), 1),
    // Upper reservoir = the working storage each PSP must build; the lower one is often an existing dam.
    upperReservoirMCMPerGWh: round(per(v('upperReservoirMCM'), gwh), 3),
    annualMakeupMCMPerGWh: round(per(v('annualMakeupMCM'), gwh), 3),
    empPctOfCost: round(empSpend != null && v('projectCostCr') ? (empSpend / v('projectCostCr')) * 100 : null, 2),
    caCrPerForestHa: round(per(v('compensatoryAfforestationCr'), v('forestLandHa')), 3),
    affectedHouseholdsPerMW: round(per(v('affectedHouseholds')), 3),
  };
}

/** Rule-based risk flags. severity: high | medium | low | info */
export function riskFlags(metrics, derived, cfg, extras = {}) {
  const v = (k) => val(metrics, k);
  const t = cfg.flags;
  const flags = [];
  const add = (severity, code, title, detail, keys = []) =>
    flags.push({ severity, code, title, detail, evidence: keys.map((k) => metrics[k]).filter(Boolean).map(({ value, page, quote, docUrl, docLabel, method }) => ({ value, page, quote, docUrl, docLabel, method })) });

  const km = v('protectedAreaKm');
  const pa = v('nearestProtectedArea') ?? 'a protected area';
  if (v('insideESZ') === true) add('high', 'esz', 'Inside an Eco-Sensitive Zone', `The report places the project inside the notified ESZ of ${pa}.`, ['insideESZ']);
  if (km != null && km < t.protectedAreaKmHigh)
    add('high', 'pa-near', `${km} km from ${pa}`, `Within ${t.protectedAreaKmHigh} km of a protected area – the default ESZ extent where no ESZ is notified, so wildlife (SBWL/NBWL) scrutiny is likely.`, ['protectedAreaKm', 'nearestProtectedArea']);
  else if (km != null && km < t.protectedAreaKmMedium)
    add('medium', 'pa-near', `${km} km from ${pa}`, `Close to the ${t.protectedAreaKmHigh} km protected-area buffer.`, ['protectedAreaKm', 'nearestProtectedArea']);
  if (v('westernGhatsESA') === true)
    add('high', 'wg-esa', 'In draft Western Ghats ESA', 'The project area falls in villages covered by the draft Western Ghats Ecologically Sensitive Area notification.', ['westernGhatsESA']);

  const forest = v('forestLandHa');
  if (forest != null && forest >= t.forestHaHigh) add('high', 'forest', `${forest} ha forest diversion`, `Large forest diversion (≥ ${t.forestHaHigh} ha); Stage-I/II forest clearance from MoEFCC.`, ['forestLandHa']);
  else if (forest != null && forest >= t.forestHaMedium) add('medium', 'forest', `${forest} ha forest diversion`, 'Forest clearance (Stage-I/II) needed under the Van (Sanrakshan Evam Samvardhan) Adhiniyam.', ['forestLandHa']);
  if (derived.forestSharePct != null && derived.forestSharePct >= 50) add('medium', 'forest-share', `${derived.forestSharePct}% of land is forest`, 'Most of the project footprint is forest land.', ['forestLandHa', 'totalLandHa']);

  const trees = v('treesFelled');
  if (trees != null && trees >= t.treesHigh) add('high', 'trees', `${trees.toLocaleString('en-IN')} trees to be felled`, '', ['treesFelled']);
  else if (trees != null && trees >= t.treesMedium) add('medium', 'trees', `${trees.toLocaleString('en-IN')} trees to be felled`, '', ['treesFelled']);

  const sch = v('scheduleISpecies');
  if (sch != null && sch >= t.scheduleIHigh) add('high', 'sch1', `${sch} Schedule-I species reported`, 'Species with the highest protection under the Wild Life (Protection) Act occur in the study area; a species conservation plan is required.', ['scheduleISpecies']);
  else if (sch != null && sch > 0) add('medium', 'sch1', `${sch} Schedule-I species reported`, '', ['scheduleISpecies']);
  const crEn = (extras.threatenedSpeciesList ?? []).filter((s) => ['CR', 'EN'].includes(s.status));
  if (crEn.length) add('high', 'iucn', `${crEn.length} Critically Endangered / Endangered species`, crEn.map((s) => `${s.name} (${s.status})`).join(', '), ['threatenedSpecies']);

  const tribal = v('tribalSharePct');
  if (tribal != null && tribal >= t.tribalPctHigh) add('high', 'tribal', `${tribal}% Scheduled Tribe population`, 'Majority tribal area: Forest Rights Act settlement and Gram Sabha consent (and PESA, where Scheduled Area) are likely to apply.', ['tribalSharePct']);
  else if (tribal != null && tribal >= t.tribalPctMedium) add('medium', 'tribal', `${tribal}% Scheduled Tribe population`, 'Significant tribal population; check Forest Rights Act compliance.', ['tribalSharePct']);

  const displaced = v('displacedFamilies');
  if (displaced != null && displaced > 0) add('high', 'displacement', `${displaced} families displaced`, 'Physical displacement requires an R&R plan under the RFCTLARR Act 2013.', ['displacedFamilies']);
  const hh = v('affectedHouseholds');
  if (hh != null && hh > 0 && v('rrPlanRequired') === false) add('medium', 'rr-gap', `${hh} affected households, no R&R plan`, 'Households are reported as affected but the report says no R&R plan is required.', ['affectedHouseholds', 'rrPlanRequired']);

  if (derived.empPctOfCost != null && derived.empPctOfCost < t.empPctOfCostLow)
    add('medium', 'emp-low', `EMP budget is ${derived.empPctOfCost}% of project cost`, `Below ${t.empPctOfCostLow}% of the capital cost.`, ['empTotalCr', 'empCapitalCr', 'projectCostCr']);
  const zone = v('seismicZone');
  if (zone === 'V' || zone === 'IV') add(zone === 'V' ? 'high' : 'medium', 'seismic', `Seismic zone ${zone}`, 'Dams and embankments in a high seismic zone.', ['seismicZone']);
  const heritage = String(v('heritageNearby') ?? '');
  const nearHeritage = [...heritage.matchAll(/([^;(]+)\((\d+(?:\.\d+)?)\s*km\)/g)].filter((m) => +m[2] <= t.heritageKm).map((m) => `${m[1].trim()} (${m[2]} km)`);
  if (nearHeritage.length) add('low', 'heritage', 'Heritage / tourism sites nearby', nearHeritage.join(', '), ['heritageNearby']);

  for (const c of extras.conflicts ?? [])
    flags.push({ severity: 'info', code: 'conflict', title: `Documents disagree on ${c.label}`, detail: `Using ${c.chosen}; also stated: ${c.others.map((o) => `${o.value} (${o.docLabel ?? 'doc'} p${o.page ?? '?'})`).join(', ')}`, evidence: [] });
  for (const d of extras.unreadable ?? [])
    flags.push({ severity: 'info', code: 'unreadable', title: 'Scanned document not analysed', detail: `${d.label}: no text layer. Set ANTHROPIC_API_KEY so Claude can read the scanned pages.`, evidence: [] });

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Screening index: each dimension 0–100 from available components; overall = weighted mean. */
export function impactScores(metrics, derived, cfg, extras = {}) {
  const v = (k) => val(metrics, k);
  const ref = cfg.reference;
  const part = (x, r) => (x == null ? null : clamp01(x / r));
  const avg = (xs) => {
    const ok = xs.filter((x) => x != null);
    return ok.length ? { score: Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 100), components: ok.length, of: xs.length } : { score: null, components: 0, of: xs.length };
  };
  const km = v('protectedAreaKm');
  const threatened = v('threatenedSpecies') ?? (extras.threatenedSpeciesList?.length || null);
  const dims = {
    land: avg([part(derived.forestHaPerMW, ref.forestHaPerMW), part(derived.landHaPerMW, ref.landHaPerMW), part(v('forestLandHa'), ref.forestHa)]),
    biodiversity: avg([
      km == null ? null : clamp01(1 - km / ref.protectedAreaKmZero),
      part(v('scheduleISpecies'), ref.scheduleISpecies),
      part(threatened, ref.threatenedSpecies),
      v('westernGhatsESA') == null ? null : v('westernGhatsESA') ? 1 : 0,
    ]),
    social: avg([part(v('affectedHouseholds'), ref.affectedHouseholds), part(v('displacedFamilies'), ref.displacedFamilies), part(v('tribalSharePct'), ref.tribalSharePct)]),
    water: avg([part(derived.upperReservoirMCMPerGWh, ref.upperReservoirMCMPerGWh), part(derived.annualMakeupMCMPerGWh, ref.annualMakeupMCMPerGWh)]),
    construction: avg([part(derived.treesPerMW, ref.treesPerMW), part(derived.muckLakhCumPerMW, ref.muckLakhCumPerMW)]),
  };
  let wsum = 0;
  let total = 0;
  for (const [k, d] of Object.entries(dims)) if (d.score != null) (wsum += cfg.weights[k]), (total += d.score * cfg.weights[k]);
  const filled = Object.values(dims).reduce((s, d) => s + d.components, 0);
  const possible = Object.values(dims).reduce((s, d) => s + d.of, 0);
  return { overall: wsum ? Math.round(total / wsum) : null, dimensions: dims, coveragePct: Math.round((filled / possible) * 100) };
}

/** Median / min / max for each numeric metric and derived figure across projects. */
export function peerStats(projects) {
  const keys = new Set();
  for (const p of projects) {
    for (const [k, m] of Object.entries(p.metrics)) if (typeof m.value === 'number') keys.add(`metrics.${k}`);
    for (const [k, x] of Object.entries(p.derived)) if (typeof x === 'number') keys.add(`derived.${k}`);
  }
  const out = {};
  for (const key of keys) {
    const [kind, k] = key.split('.');
    const vals = projects
      .map((p) => ({ id: p.id, v: kind === 'metrics' ? p.metrics[k]?.value : p.derived[k] }))
      .filter((x) => typeof x.v === 'number')
      .sort((a, b) => a.v - b.v);
    if (!vals.length) continue;
    const mid = Math.floor(vals.length / 2);
    out[k] = {
      n: vals.length,
      min: vals[0].v,
      max: vals.at(-1).v,
      median: vals.length % 2 ? vals[mid].v : (vals[mid - 1].v + vals[mid].v) / 2,
      rank: Object.fromEntries(vals.map((x, i) => [x.id, i + 1])), // 1 = lowest
    };
  }
  return out;
}

export function completeness(metrics) {
  const keyMetrics = ['capacityMW', 'totalLandHa', 'forestLandHa', 'treesFelled', 'protectedAreaKm', 'scheduleISpecies', 'affectedHouseholds', 'projectCostCr', 'empCapitalCr', 'muckLakhCum'];
  const have = keyMetrics.filter((k) => metrics[k]?.value != null);
  return { pct: Math.round((have.length / keyMetrics.length) * 100), missing: keyMetrics.filter((k) => !have.includes(k)).map((k) => METRIC_BY_KEY[k].label) };
}

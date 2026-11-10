// Rule-based extraction: deterministic, free, works offline. Tuned on the phrasing used
// in Indian EIA/EMP executive summaries (MoEFCC format). Every value keeps the page
// number and the sentence it came from, so the dashboard can show the evidence.
import { PROPOSAL_NO_RE, toIsoDate } from '../lib/util.js';

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const MONEY = String.raw`(?:₹|Rs\.?|INR)\s*${NUM}\s*(crores?|cr\.?|lakhs?|lacs?)`;
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

export const num = (s) => {
  if (s == null) return null;
  const w = WORDS[String(s).toLowerCase()];
  if (w) return w;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
/** Rupee amount in crore from a number + "crore"/"lakh" unit. */
export const toCrore = (n, unit) => (n == null ? null : /lakh|lac/i.test(unit ?? '') ? +(num(n) / 100).toFixed(4) : num(n));

/** Removes running headers/footers: lines in the top/bottom of a page that repeat on most pages. */
export function stripRepeatedLines(pages, edge = 4) {
  if (pages.length < 4) return pages;
  const norm = (l) => l.trim().replace(/\s+/g, ' ').replace(/\b\d{1,3}\b$/, '#');
  const edges = (p) => {
    const lines = p.split('\n').map((l, i) => ({ l, i })).filter((x) => x.l.trim());
    return [...lines.slice(0, edge), ...lines.slice(-edge)];
  };
  const counts = new Map();
  for (const p of pages) for (const k of new Set(edges(p).map((x) => norm(x.l)).filter((k) => k.length > 3))) counts.set(k, (counts.get(k) ?? 0) + 1);
  const repeated = new Set([...counts].filter(([, c]) => c >= Math.max(3, pages.length * 0.5)).map(([k]) => k));
  return pages.map((p) => {
    const drop = new Set(edges(p).filter((x) => repeated.has(norm(x.l))).map((x) => x.i));
    return p.split('\n').filter((_, i) => !drop.has(i)).join('\n');
  });
}

/** Each page is flattened to one line so sentences split across lines still match. */
const flatten = (p) => p.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/\s{2,}/g, ' ');

function quoteAround(text, index, length) {
  const start = Math.max(0, text.lastIndexOf('. ', index - 1) + 2, index - 160);
  const endDot = text.indexOf('. ', index + length);
  const end = Math.min(text.length, endDot === -1 ? index + length + 160 : Math.min(endDot + 1, index + length + 200));
  return text.slice(start, end).trim();
}

function* matches(pages, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (let i = 0; i < pages.length; i++) {
    for (const m of pages[i].matchAll(g)) yield { m, page: i + 1, quote: quoteAround(pages[i], m.index, m[0].length) };
  }
}

// --- rule table -------------------------------------------------------------
// value(m) maps a regex match to a value; agg picks among all matches.
const R = (key, patterns, value, agg = 'first', extra = {}) => ({ key, patterns: [].concat(patterns), value, agg, ...extra });
const n1 = (m) => num(m[1]);
const money = (m) => toCrore(m[1], m[2]);

const RULES = [
  R('storageHours', /(?:daily hours of generation|generation (?:duration|hours)|hours of (?:power )?generation)\s*:?\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:hr|hours?)/i, n1),
  R('projectCostCr', [new RegExp(String.raw`(?:total |estimated |completion )?(?:project cost|cost of the project)[^₹R.]{0,60}?${MONEY}`, 'i')], money),
  R('constructionMonths', [/(?:within a period of|construction period of|completion period of|completed in|be completed within)\s*(\d+)\s*months/i, /(\d+)\s*months \(excluding/i], n1),
  R('loopType', /\b(open|closed)[\s-]loop\b/i, (m) => `${m[1].toLowerCase()} loop`, 'mode', { raw: true }),
  R('maxDamHeightM', [/(?:maximum|max\.?)\s*(?:dam\s*)?height of\s*(\d+(?:\.\d+)?)\s*m\b/i, /height of (?:the )?(?:dam|embankment)\s*:?\s*(?:avg\.?\s*height\s*\()?(\d+(?:\.\d+)?)\s*m\b/i], n1, 'max'),
  R('eiaConsultant', /(?:assigned|entrusted|engaged|awarded)[^.]{0,160}?(?:to|with)\s+M\/s\.?\s*([A-Z][A-Za-z&.,() -]{3,80}?(?:Limited|Ltd\.?|LLP|Pvt\.?\s*Ltd\.?))/, (m) => m[1].trim()),
  R('torDate', /\bToR\b(?:(?!\bOM\b|Office Memorandum)[^.]){0,120}?(?:on|dated|issued on|accorded on)\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+,?\s+\d{4})/i, (m) => toIsoDate(m[1].replace(/(\d)(st|nd|rd|th)/, '$1')), 'max'),

  R('totalLandHa', [new RegExp(String.raw`total (?:permanent )?land requirement[^.]{0,140}?${NUM}\s*ha\b`, 'i'), new RegExp(String.raw`(?:requires?|acquisition of)\s*(?:about |approximately )?${NUM}\s*ha\b(?:[^.]{0,20}in which)`, 'i')], n1, 'max'),
  R('forestLandHa', [new RegExp(String.raw`${NUM}\s*ha(?:\s+(?:is|of|of the))*\s+(?:reserve(?:d)?\s+)?forest\s+land`, 'i'), new RegExp(String.raw`(?:diversion|divert)\w* (?:of )?(?:a )?${NUM}\s*ha`, 'i')], n1, 'max'),
  R('nonForestLandHa', new RegExp(String.raw`${NUM}\s*ha(?:\s+(?:is|of|of the))*\s+non[\s-]forest`, 'i'), n1, 'max'),
  R('submergenceHa', new RegExp(String.raw`submergence (?:area )?(?:of )?[^.]{0,40}?${NUM}\s*ha\b`, 'i'), n1, 'max'),
  R('treesFelled', [new RegExp(String.raw`(?:cutting|felling|removal) of (?:about |approximately |around )?${NUM}\s*trees`, 'i'), new RegExp(String.raw`${NUM}\s*trees (?:are|will be|to be|shall be) (?:felled|cut)`, 'i')], n1, 'max'),
  R('muckLakhCum', [new RegExp(String.raw`muck[^.]{0,120}?${NUM}\s*lakh\s*(?:cum|m3|m³|cubic)`, 'i'), new RegExp(String.raw`muck[^.]{0,120}?${NUM}\s*(?:million (?:cum|m3|cubic)|Mm3)`, 'i')], (m) => (/million|Mm3/i.test(m[0]) ? num(m[1]) * 10 : num(m[1])), 'max'),
  R('muckDisposalHa', new RegExp(String.raw`(?:muck disposal|dumping) (?:sites?|areas?)[^.]{0,140}?area of\s*(?:about |approximately )?${NUM}\s*ha`, 'i'), n1),

  R('initialFillMCM', /(?:initial|one[- ]time)[\s/]*(?:one[- ]time\s*)?filling[^.]{0,100}?(\d+(?:\.\d+)?)\s*(?:MCM|Mm3|Mm³)/i, n1),
  R('annualMakeupMCM', /annual make-?up[^.]{0,120}?(\d+(?:\.\d+)?)\s*(?:MCM|Mm3|Mm³)/i, n1),
  R('waterSource', /(?:source for initial filling|water (?:will be|shall be) (?:drawn|sourced|lifted) from)\s*:?\s*([A-Z][\w ]{2,40}?(?:River|Dam|Reservoir|Lake))/, (m) => m[1].trim()),

  R('westernGhatsESA', [/falls?\s+(?:with)?in\s+(?:the\s+)?(?:draft\s+notification\s+(?:for|of)\s+)?(?:the\s+)?Western Ghats?\s+(?:ESA|Eco)/i, /(?:outside|not (?:in|within))\s+(?:the\s+)?Western Ghats?\s+(?:ESA|Eco)/i], (m) => !/\boutside\b|\bnot\b/i.test(m[0])),
  R('insideESZ', /(outside|within|inside)\s+(?:of\s+)?(?:the\s+)?(?:notified\s+)?Eco-?\s?sensitive\s+Zone/i, (m) => m[1].toLowerCase() !== 'outside'),
  R('scheduleISpecies', /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+species(?:\s+of\s+[a-z]+)?\s+(?:are\s+|is\s+)?(?:categori[sz]ed\s+as|listed\s+(?:under|as|in)|under)\s+schedule[\s-]*I\b/i, n1, 'sum'),
  R('plantSpecies', [/list of (\d+) species of (?:angiosperm )?plants/i, /(\d+)\s+(?:plant|floral|angiosperm)\s+species/i], n1, 'max'),

  R('studyAreaVillages', [/(?:total of|covers)\s*(?:a total of\s*)?(\d+)\s+villages\s+in\s+the\s+study area/i, /study area (?:comprises|consists of|covers) (\d+) villages/i], n1),
  R('affectedHouseholds', [new RegExp(String.raw`affected villages? (?:comprise|have|has|consists? of)\s*${NUM}\s*households`, 'i'), new RegExp(String.raw`${NUM}\s*(?:project affected (?:families|households)|PAFs?)\b`, 'i')], n1, 'max'),
  R('affectedPopulation', new RegExp(String.raw`affected villages?[^.]{0,80}?population of\s*${NUM}`, 'i'), n1),
  R('displacedFamilies', [new RegExp(String.raw`${NUM}\s*(?:families|households)\s*(?:will be|are|to be|shall be)\s*(?:displaced|relocated|resettled)`, 'i'), new RegExp(String.raw`(?:project displaced families|PDFs)\s*\(?[^.]{0,20}?${NUM}`, 'i')], n1, 'max'),
  R('tribalSharePct', [/Scheduled Tribes?\s*(?:\(ST\)\s*)?population[^.]{0,80}?(\d+(?:\.\d+)?)\s*%/i, /(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:individuals\s+|population\s+)?belong(?:ing|s)?\s+to\s+(?:the\s+)?Scheduled\s+Tribes?/i], n1, 'max'),
  R('rrPlanRequired', [/(?:R\s?&\s?R|Resettlement\s*(?:&|and)\s*Rehabilitation)\s*Plan\s+is\s+not\s+required/i, /(?:R\s?&\s?R|Resettlement\s*(?:&|and)\s*Rehabilitation)\s*Plan\s+(?:has been|is|shall be)\s+(?:prepared|proposed|formulated)/i], (m) => !/not required/i.test(m[0])),
  R('heritageNearby', /\b((?:[A-Z][\w']+\s){0,3}(?:caves?|Fort|Temple|Waterfalls?|Ghat))\b[^.]{0,60}?(\d+(?:\.\d+)?)\s*km/g, (m) => `${m[1].trim()} (${m[2]} km)`, 'list'),

  R('compensatoryAfforestationCr', new RegExp(String.raw`Compensatory Afforestation(?: Plan)?[^.]{0,80}?${MONEY}`, 'i'), money),
  R('biodiversityPlanCr', new RegExp(String.raw`Biodiversity (?:Management|Conservation)[^.]{0,140}?${MONEY}`, 'i'), money),
  R('muckPlanCr', new RegExp(String.raw`muck[^.]{0,260}?${MONEY}`, 'i'), money, 'max'),
  R('monitoringCr', [new RegExp(String.raw`${MONEY}[^.]{0,120}?environmental monitoring`, 'i'), new RegExp(String.raw`environmental monitoring[^.]{0,80}?${MONEY}`, 'i')], money),
  R('empCapitalCr', new RegExp(String.raw`(?:total|overall)[^.]{0,40}?(?:EMP|environmental management plan)[^.]{0,100}?${MONEY}`, 'i'), money, 'max'),
  R('cerCr', new RegExp(String.raw`(?:\bCER\b|Corporate Environment(?:al)? Responsibility|\bCSR\b)(?:(?!project cost)[^.]){0,120}?${MONEY}`, 'i'), money, 'max'),
  R('co2ReductionMtPerYr', /(\d+(?:\.\d+)?)\s*million\s*(?:tonnes?\s*(?:of\s*)?)?t?CO2e?\b/i, n1, 'max'),

  R('seismicZone', /(?:seismic|IS[\s-]?1893|BIS)[^.]{0,120}?zone[\s-]*(II|III|IV|V)\b|zone[\s-]*(II|III|IV|V)\b[^.]{0,60}?(?:seismic|IS[\s-]?1893|BIS)/i, (m) => m[1] || m[2]),
  R('pm10MaxUgm3', /PM\s?10\b[^.]{0,80}?\bis\s*(\d+(?:\.\d+)?)\s*(?:μg|µg|ug)/i, n1, 'max'),
  R('pm25MaxUgm3', /PM\s?2\.5\b[^.]{0,80}?\bis\s*(\d+(?:\.\d+)?)\s*(?:μg|µg|ug)/i, n1, 'max'),
  R('annualRainfallMm', [new RegExp(String.raw`(?:average|mean|normal) annual rainfall[^.]{0,60}?${NUM}\s*mm`, 'i'), new RegExp(String.raw`averaging (?:about |around )?${NUM}\s*mm`, 'i')], n1),
];

function aggregate(hits, agg) {
  if (!hits.length) return null;
  if (agg === 'first') return hits[0];
  if (agg === 'max') return hits.reduce((a, b) => (b.value > a.value ? b : a));
  if (agg === 'sum') {
    const seen = new Set();
    const uniq = hits.filter((h) => !seen.has(h.quote) && seen.add(h.quote));
    return { ...uniq[0], value: uniq.reduce((s, h) => s + h.value, 0), note: uniq.length > 1 ? `sum of ${uniq.length} mentions` : undefined };
  }
  if (agg === 'mode') {
    const counts = new Map();
    for (const h of hits) counts.set(h.value, (counts.get(h.value) ?? 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    return hits.find((h) => h.value === best);
  }
  if (agg === 'list') {
    const vals = [...new Set(hits.map((h) => h.value))].slice(0, 6);
    return { ...hits[0], value: vals.join('; ') };
  }
  return hits[0];
}

/** Most frequently stated MW figure ≥ 50 – the title, salient features and text all repeat it. */
function capacity(pages) {
  for (const re of [
    new RegExp(String.raw`(?:total )?installed capacity(?: of)?(?: the)?(?: proposed)?[^.]{0,60}?(?:is|of)\s*${NUM}\s*MW\b`, 'i'),
    new RegExp(String.raw`\(\s*${NUM}\s*MW\s*\)`, 'i'),
  ]) {
    const explicit = [...matches(pages, re)].map((h) => ({ ...h, value: num(h.m[1]) })).filter((h) => h.value >= 50);
    if (explicit.length) return aggregate(explicit, 'mode');
  }
  const hits = [...matches(pages, new RegExp(String.raw`${NUM}\s*MW\b`, 'g'))]
    .map((h) => ({ ...h, value: num(h.m[1]) }))
    .filter((h) => h.value >= 50 && h.value <= 20000);
  return aggregate(hits, 'mode');
}

function reservoirs(pages) {
  const out = {};
  for (const h of matches(pages, /upper and lower reservoirs?\s+(?:is|are)\s+(\d+(?:\.\d+)?)\s*(?:MCM|Mm3)\s*(?:&|and)\s*(\d+(?:\.\d+)?)\s*(?:MCM|Mm3)/i)) {
    out.upperReservoirMCM ??= { value: num(h.m[1]), page: h.page, quote: h.quote };
    out.lowerReservoirMCM ??= { value: num(h.m[2]), page: h.page, quote: h.quote };
  }
  for (const h of matches(pages, /gross storage(?:\s+capacity)?\s+of\s+(?:the\s+)?(?:existing\s+)?(upper|lower)\s+reservoir\s+is\s+(\d+(?:\.\d+)?)\s*(?:MCM|Mm3)/i)) {
    out[`${h.m[1].toLowerCase()}ReservoirMCM`] ??= { value: num(h.m[2]), page: h.page, quote: h.quote };
  }
  return out;
}

function protectedArea(pages) {
  const re = /((?:[A-Z][\w']+\s){1,3}(?:Wildlife Sanctuary|National Park|Tiger Reserve|Bird Sanctuary|Conservation Reserve))(?:\s*\((?:WLS|NP|TR)\))?[^.]{0,100}?(?:distance of|is|approximately|around|about|at)\s*(?:around |about |approximately |~)?(\d+(?:\.\d+)?)\s*km/g;
  const hits = [...matches(pages, re)].map((h) => ({ ...h, value: num(h.m[2]), name: h.m[1].trim() }));
  if (!hits.length) return {};
  const best = hits.reduce((a, b) => (b.value < a.value ? b : a));
  return {
    protectedAreaKm: { value: best.value, page: best.page, quote: best.quote },
    nearestProtectedArea: { value: best.name, page: best.page, quote: best.quote },
  };
}

/** Proposal / file numbers mentioned anywhere – used to auto-link PARIVESH records. */
export function findReferences(pages) {
  const text = pages.join('\n');
  const proposals = [...new Set((text.match(new RegExp(PROPOSAL_NO_RE.source, 'gi')) ?? []).map((s) => s.toUpperCase()))];
  const files = [...new Set(text.match(/\bJ-\d{5}\/\d+\/\d{4}-IA\.?\s?[IV]+(?:\s?\([A-Z]\))?/g) ?? [])];
  const torIds = [...new Set(text.match(/\bTO\d{2}[A-Z]\d{4}[A-Z]{2}\d{7}[A-Z]\b/g) ?? [])];
  return { proposals, files, torIds };
}

/**
 * Reads the "Cost for implementing EMP" table: one row per plan, capital cost first and
 * total last. Units come from the table header (lakh or crore).
 */
export function parseEmpTable(pages) {
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const at = p.search(/Component of EMP|Cost (?:for|of) (?:Implementing )?(?:the )?Environment(?:al)? Management Plan|EMP Budget/i);
    if (at < 0) continue;
    const block = p.slice(Math.max(0, at - 400));
    const inLakh = /lakh|lac/i.test(block.slice(0, 900));
    const toCr = (v) => (v == null ? null : +(inLakh ? v / 100 : v).toFixed(4));
    const components = [];
    let total = null;
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*(\d{1,2})\.?\s+(.+?)\s{2,}([\d.,\s]+?)\s*$/);
      const t = line.match(/^\s*(?:Grand\s+)?Total\s+([\d.,\s]+?)\s*$/i);
      const nums = (s) => s.trim().split(/\s+/).map((x) => num(x)).filter((x) => x != null);
      if (m) {
        const v = nums(m[3]);
        if (v.length) components.push({ label: m[2].replace(/[*]+$/, '').trim(), capitalCr: toCr(v[0]), totalCr: v.length > 1 ? toCr(v.at(-1)) : null });
      } else if (t && components.length) {
        const v = nums(t[1]);
        if (v.length) total = { capitalCr: toCr(v[0]), totalCr: v.length > 1 ? toCr(v.at(-1)) : null };
        break;
      }
    }
    if (components.length >= 3 && total) {
      // Some tables give capital + yearly columns with the total cut off; only trust
      // the last column as a total when it is at least the capital figure.
      const totalCr = total.totalCr != null && total.totalCr >= total.capitalCr ? total.totalCr : null;
      return { page: i + 1, capitalCr: total.capitalCr, totalCr, components, quote: `EMP cost table: ${components.length} components, total capital ${total.capitalCr} Cr` };
    }
  }
  return null;
}

/** @param {string[]} rawPages @returns {Record<string, {value:any,page:number,quote:string,method:'rule',note?:string}>} */
export function extractWithRules(rawPages) {
  const layoutPages = stripRepeatedLines(rawPages);
  const pages = layoutPages.map(flatten);
  const out = {};
  const emp = parseEmpTable(layoutPages);
  if (emp) {
    out.empCapitalCr = { value: emp.capitalCr, page: emp.page, quote: emp.quote };
    if (emp.totalCr != null) out.empTotalCr = { value: emp.totalCr, page: emp.page, quote: emp.quote };
    const row = (re) => emp.components.find((c) => re.test(c.label));
    const rowMetric = (key, re) => {
      const r = row(re);
      if (r && (r.totalCr ?? r.capitalCr)) out[key] = { value: r.totalCr ?? r.capitalCr, page: emp.page, quote: `EMP cost table – ${r.label}` };
    };
    rowMetric('cerCr', /\bCER\b|local area development/i);
    rowMetric('compensatoryAfforestationCr', /compensatory afforestation/i);
    rowMetric('biodiversityPlanCr', /biodiversity/i);
    rowMetric('muckPlanCr', /muck/i);
    rowMetric('monitoringCr', /environmental monitoring/i);
  }
  const components = emp?.components ?? [];
  const rawFlat = rawPages.map(flatten); // headers often carry capacity / loop type, so some rules read unstripped pages
  const cap = capacity(rawFlat);
  if (cap) out.capacityMW = cap;
  Object.assign(out, reservoirs(pages), protectedArea(pages));
  for (const rule of RULES) {
    if (out[rule.key]) continue;
    const hits = [];
    for (const p of rule.patterns)
      for (const h of matches(rule.raw ? rawFlat : pages, p)) {
        const value = rule.value(h.m);
        if (value != null && value !== '' && !Number.isNaN(value)) hits.push({ value, page: h.page, quote: h.quote });
      }
    const best = aggregate(hits, rule.agg);
    if (best) out[rule.key] = best;
  }
  // Derive the missing land component when two of the three are known.
  const { totalLandHa: t, forestLandHa: f, nonForestLandHa: nf } = out;
  if (!t && f && nf) out.totalLandHa = { value: +(f.value + nf.value).toFixed(4), page: f.page, quote: 'Derived: forest + non-forest land', derived: true };
  if (t && f && !nf && t.value > f.value) out.nonForestLandHa = { value: +(t.value - f.value).toFixed(4), page: t.page, quote: 'Derived: total − forest land', derived: true };

  for (const [k, v] of Object.entries(out)) out[k] = { ...v, method: 'rule' };
  for (const v of Object.values(out)) delete v.m;
  return { metrics: out, empComponents: components };
}

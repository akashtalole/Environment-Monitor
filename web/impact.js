const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, digits = 2) => {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v !== 'number') return String(v);
  const d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : digits;
  return v.toLocaleString('en-IN', { maximumFractionDigits: d });
};

// Same metric list as src/analysis/metrics.js (labels/units/groups) – kept small here for the table.
const GROUPS = { project: 'Project', land: 'Land & forest', water: 'Water', biodiversity: 'Biodiversity', social: 'People', mitigation: 'Mitigation & budgets', baseline: 'Baseline environment' };

const INTENSITIES = [
  { key: 'forestHaPerMW', label: 'Forest land diverted', unit: 'ha per MW', src: 'derived' },
  { key: 'landHaPerMW', label: 'Total land', unit: 'ha per MW', src: 'derived' },
  { key: 'treesPerMW', label: 'Trees felled', unit: 'trees per MW', src: 'derived' },
  { key: 'muckLakhCumPerMW', label: 'Muck generated', unit: 'lakh m³ per MW', src: 'derived' },
  { key: 'forestSharePct', label: 'Forest share of footprint', unit: '% of land', src: 'derived' },
  { key: 'upperReservoirMCMPerGWh', label: 'Upper reservoir storage', unit: 'MCM per GWh stored', src: 'derived' },
  { key: 'protectedAreaKm', label: 'Distance to protected area', unit: 'km (shorter = closer)', src: 'metrics' },
  { key: 'scheduleISpecies', label: 'Schedule-I species', unit: 'species reported', src: 'metrics' },
  { key: 'tribalSharePct', label: 'Scheduled Tribe population', unit: '% of study area', src: 'metrics' },
  { key: 'affectedHouseholds', label: 'Affected households', unit: 'households', src: 'metrics' },
  { key: 'costCrPerMW', label: 'Project cost', unit: '₹ Cr per MW', src: 'derived' },
  { key: 'empPctOfCost', label: 'EMP budget', unit: '% of project cost', src: 'derived' },
];
const DIMENSIONS = { land: 'Land & forest', biodiversity: 'Biodiversity', social: 'People', water: 'Water', construction: 'Construction' };

let data;
let metricsMeta = [];
let selected = null;
const tips = new Map();
let tipSeq = 0;

/** Registers tooltip content and returns an attribute string. Content is rendered with textContent. */
function tipAttr(title, lines = [], quote, { focusable = true } = {}) {
  const id = `t${tipSeq++}`;
  tips.set(id, { title, lines, quote });
  return `data-tip="${id}"${focusable ? ' tabindex="0"' : ''}`;
}

function value(p, item) {
  return item.src === 'derived' ? p.derived[item.key] : p.metrics[item.key]?.value;
}
function evidence(p, key) {
  return p.metrics[key];
}

async function load() {
  const a = await fetch('data/analytics.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
  if (!a) throw new Error('No analytics yet. Run "node src/cli.js analyze" first.');
  data = a;
  metricsMeta = buildMeta();
  selected = data.projects[0]?.id ?? null;
  render();
}

function buildMeta() {
  // Derive the metric list (in extraction order) from what the data contains.
  const order = [];
  for (const p of data.projects) for (const k of Object.keys(p.metrics)) if (!order.includes(k)) order.push(k);
  return order;
}

function render() {
  tips.clear();
  $('#generated').textContent = `analysed ${new Date(data.generatedAt).toLocaleString('en-IN')} · ${data.method}`;
  renderTiles();
  renderScores();
  renderMultiples();
  renderFlags();
  renderDetail();
  renderMetricsTable();
  renderMethod();
}

function renderTiles() {
  const ps = data.projects;
  const docs = ps.flatMap((p) => p.documents);
  const sum = (k) => ps.reduce((s, p) => s + (p.metrics[k]?.value ?? 0), 0);
  const high = ps.reduce((s, p) => s + p.flags.filter((f) => f.severity === 'high').length, 0);
  const mw = sum('capacityMW');
  const tiles = [
    ['Projects analysed', ps.length, `${fmt(mw)} MW combined`],
    ['Documents read', docs.length, `${docs.filter((d) => d.scanned && !d.llm).length} scanned, awaiting Claude`],
    ['High-severity flags', high, 'across all projects'],
    ['Forest land to divert', `${fmt(sum('forestLandHa'))} ha`, 'as stated in reports'],
    ['Trees to be felled', fmt(sum('treesFelled')), ps.filter((p) => p.metrics.treesFelled).length < ps.length ? 'not reported for every project' : 'all projects'],
  ];
  $('#tiles').innerHTML = tiles.map(([k, v, s]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
}

function bar(label, v, max, { dim = false, display, tip } = {}) {
  const pct = v == null || !max ? 0 : Math.max(1, (Math.abs(v) / max) * 100);
  return `<span class="lbl" title="${esc(label)}">${esc(label)}</span>
    <span class="track hit" ${tip ?? ''}>${v == null ? '' : `<span class="fill ${dim ? 'dim' : ''}" style="width:${pct}%"></span>`}</span>
    <span class="val ${v == null ? 'na' : ''}">${v == null ? 'not reported' : esc(display ?? fmt(v))}</span>`;
}

function renderScores() {
  $('#scores').innerHTML = data.projects
    .map((p) => {
      const counts = ['high', 'medium', 'low'].map((s) => [s, p.flags.filter((f) => f.severity === s).length]).filter(([, n]) => n);
      const dims = Object.entries(DIMENSIONS)
        .map(([k, label]) => {
          const d = p.scores.dimensions[k];
          return bar(label, d.score, 100, {
            tip: tipAttr(`${label}: ${d.score ?? 'no data'}`, [`Based on ${d.components} of ${d.of} indicators found in the documents.`], null, { focusable: false }),
          });
        })
        .join('');
      return `<button class="score-card" data-id="${esc(p.id)}" aria-pressed="${p.id === selected}">
        <h3>${esc(p.name)}</h3>
        <div class="score-head"><span class="big">${p.scores.overall ?? '—'}</span><span class="of">/ 100 · ${p.scores.coveragePct}% of indicators available</span></div>
        <div class="chips">${counts.map(([s, n]) => `<span class="sev ${s}">${n} ${s}</span>`).join('')}</div>
        <div class="bars">${dims}</div>
      </button>`;
    })
    .join('');
  document.querySelectorAll('.score-card').forEach((el) =>
    el.addEventListener('click', () => {
      selected = el.dataset.id;
      render();
    }),
  );
}

function renderMultiples() {
  $('#multiples').innerHTML = INTENSITIES.map((item) => {
    const rows = data.projects.map((p) => ({ p, v: value(p, item) }));
    if (rows.every((r) => r.v == null)) return '';
    const max = Math.max(...rows.map((r) => Math.abs(r.v ?? 0)));
    const body = rows
      .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
      .map(({ p, v }) => {
        const ev = item.src === 'metrics' ? evidence(p, item.key) : null;
        return bar(shortName(p.name), v, max, {
          dim: selected && p.id !== selected,
          tip: tipAttr(`${p.name}: ${fmt(v)} ${item.unit}`, ev ? [`${ev.docLabel ?? 'document'}, page ${ev.page ?? '?'} (${ev.method === 'llm' ? 'Claude' : 'rule'})`] : derivedNote(p, item.key), ev?.quote),
        });
      })
      .join('');
    return `<div class="multiple"><h3>${esc(item.label)}</h3><div class="unit">${esc(item.unit)}</div><div class="bars">${body}</div></div>`;
  }).join('');
}

function derivedNote(p, key) {
  const m = (k) => p.metrics[k]?.value;
  const notes = {
    forestHaPerMW: `${fmt(m('forestLandHa'))} ha ÷ ${fmt(m('capacityMW'))} MW`,
    landHaPerMW: `${fmt(m('totalLandHa'))} ha ÷ ${fmt(m('capacityMW'))} MW`,
    treesPerMW: `${fmt(m('treesFelled'))} trees ÷ ${fmt(m('capacityMW'))} MW`,
    muckLakhCumPerMW: `${fmt(m('muckLakhCum'))} lakh m³ ÷ ${fmt(m('capacityMW'))} MW`,
    forestSharePct: `${fmt(m('forestLandHa'))} ÷ ${fmt(m('totalLandHa'))} ha`,
    upperReservoirMCMPerGWh: `${fmt(m('upperReservoirMCM'))} MCM ÷ ${fmt(p.derived.storageGWh)} GWh`,
    costCrPerMW: `₹${fmt(m('projectCostCr'))} Cr ÷ ${fmt(m('capacityMW'))} MW`,
    empPctOfCost: `₹${fmt(m('empTotalCr') ?? m('empCapitalCr'))} Cr ÷ ₹${fmt(m('projectCostCr'))} Cr`,
  };
  return notes[key] ? [`Calculated: ${notes[key]}`] : [];
}

const shortName = (n) => n.replace(/\s*Pumped Storage (Hydro )?Project/i, ' PSP');

function renderFlags() {
  const codes = [];
  for (const p of data.projects) for (const f of p.flags) if (f.severity !== 'info' && !codes.find((c) => c.code === f.code)) codes.push({ code: f.code, title: f.title.replace(/^[\d.,%]+\s*/, '') });
  const LABEL = { esz: 'Inside Eco-Sensitive Zone', 'pa-near': 'Near protected area', 'wg-esa': 'Western Ghats ESA', forest: 'Forest diversion', 'forest-share': 'Forest-dominated footprint', trees: 'Tree felling', sch1: 'Schedule-I species', iucn: 'Endangered species', tribal: 'Tribal population', displacement: 'Displacement', 'rr-gap': 'R&R gap', 'emp-low': 'Low EMP budget', seismic: 'Seismic risk', heritage: 'Heritage nearby' };
  const head = `<thead><tr><th>Flag</th>${data.projects.map((p) => `<th class="${p.id === selected ? 'sel' : ''}">${esc(shortName(p.name))}</th>`).join('')}</tr></thead>`;
  const rows = codes
    .map(({ code }) => {
      const cells = data.projects
        .map((p) => {
          const f = p.flags.find((x) => x.code === code);
          if (!f) return `<td class="cell ${p.id === selected ? 'sel' : ''}"><span class="val na">–</span></td>`;
          const ev = f.evidence[0];
          return `<td class="cell ${p.id === selected ? 'sel' : ''}" ${tipAttr(f.title, [f.detail, ev ? `${ev.docLabel ?? ''} p.${ev.page ?? '?'}` : ''].filter(Boolean), ev?.quote)}><span class="sev ${f.severity}">${f.severity}</span></td>`;
        })
        .join('');
      return `<tr><th scope="row">${esc(LABEL[code] ?? code)}</th>${cells}</tr>`;
    })
    .join('');
  $('#flags').innerHTML = codes.length ? head + `<tbody>${rows}</tbody>` : '<tr><td class="empty">No flags.</td></tr>';
}

function renderDetail() {
  const p = data.projects.find((x) => x.id === selected);
  if (!p) return ($('#detail').innerHTML = '<p class="empty">Select a project.</p>');
  $('#detail-title').textContent = p.name;
  const sec = (title, html) => `<div><h3>${esc(title)}</h3>${html}</div>`;
  const evLink = (ev) => (ev?.docUrl ? ` <a href="${esc(ev.docUrl)}#page=${ev.page ?? 1}" target="_blank" rel="noopener">${esc(ev.docLabel ?? 'source')} p.${ev.page ?? '?'} ↗</a>` : '');

  const flags = p.flags.length
    ? `<ul class="flag-list">${p.flags
        .map((f) => {
          const ev = f.evidence[0];
          return `<li><div class="t"><span class="sev ${f.severity}">${f.severity}</span>${esc(f.title)}</div>${f.detail ? `<div class="d">${esc(f.detail)}${evLink(ev)}</div>` : ev ? `<div class="d">${evLink(ev)}</div>` : ''}${ev?.quote ? `<blockquote class="ev">“${esc(ev.quote.slice(0, 280))}”</blockquote>` : ''}</li>`;
        })
        .join('')}</ul>`
    : '<p class="empty">No flags raised.</p>';

  const emp = [...(p.empComponents ?? [])].filter((c) => (c.totalCr ?? c.capitalCr) > 0).sort((a, b) => (b.totalCr ?? b.capitalCr) - (a.totalCr ?? a.capitalCr));
  const empMax = Math.max(0, ...emp.map((c) => c.totalCr ?? c.capitalCr));
  const empHtml = emp.length
    ? `<div class="bars">${emp.map((c) => bar(c.label, c.totalCr ?? c.capitalCr, empMax, { display: `₹${fmt(c.totalCr ?? c.capitalCr)} Cr`, tip: tipAttr(c.label, [`Capital ₹${fmt(c.capitalCr)} Cr`, c.totalCr != null ? `Capital + recurring ₹${fmt(c.totalCr)} Cr` : '']) })).join('')}</div>`
    : '<p class="empty">No EMP cost table found.</p>';

  const list = (items, f) => (items?.length ? `<ul class="plain">${items.map(f).join('')}</ul>` : '<p class="empty">Not available – needs Claude extraction (set ANTHROPIC_API_KEY).</p>');
  const refs = p.references;
  const refHtml = `<ul class="plain">
      ${refs.proposals.map((r) => `<li>${esc(r)} <span class="badge llm">tracked on PARIVESH</span></li>`).join('')}
      ${refs.files.map((r) => `<li>MoEFCC file ${esc(r)}</li>`).join('')}
      ${refs.torIds.map((r) => `<li>ToR ID ${esc(r)}</li>`).join('')}
    </ul>${refs.proposals.length + refs.files.length + refs.torIds.length ? '' : '<p class="empty">None found.</p>'}`;
  const docs = `<ul class="plain">${p.documents
    .map((d) => `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label)}</a> · ${d.pageCount} pages · ${esc(d.documentType.replace(/_/g, ' '))} · ${d.llm ? 'rules + Claude' : d.scanned ? 'scanned – needs Claude' : `${d.ruleMetricCount} figures by rules`}${d.llmError ? ` · Claude error: ${esc(d.llmError)}` : ''}</li>`)
    .join('')}</ul>`;

  $('#detail').innerHTML = [
    sec('Risk flags & evidence', flags),
    sec('EMP budget by component', empHtml),
    sec('Key impacts identified', list(p.keyImpacts, (k) => `<li><span class="sev ${k.severity}">${k.severity}</span> <b>${esc(k.category)}</b> (${esc(k.phase)}): ${esc(k.summary)}${k.mitigation ? `<br><span class="d">Mitigation: ${esc(k.mitigation)}</span>` : ''}</li>`)),
    sec('Protected & threatened species', list([...p.species.threatened.map((s) => `${s.name} — IUCN ${s.status}`), ...p.species.scheduleI.map((s) => `${s} — Schedule I`)], (s) => `<li>${esc(s)}</li>`)),
    sec('Public hearing concerns', list(p.publicConcerns, (c) => `<li>${esc(c.issue)}${c.proponentResponse ? `<br><span class="d">Response: ${esc(c.proponentResponse)}</span>` : ''}</li>`)),
    sec('Reference numbers found', refHtml),
    sec('Documents', docs),
  ].join('');
}

function renderMetricsTable() {
  const groupOf = {};
  const labelOf = {};
  const unitOf = {};
  for (const p of data.projects) for (const [k, m] of Object.entries(p.metrics)) (unitOf[k] ??= m.unit);
  Object.assign(labelOf, METRIC_LABELS);
  for (const k of metricsMeta) groupOf[k] = METRIC_GROUPS[k] ?? 'project';
  const head = `<thead><tr><th>Figure</th>${data.projects.map((p) => `<th class="${p.id === selected ? 'sel' : ''}">${esc(shortName(p.name))}</th>`).join('')}</tr></thead>`;
  let body = '';
  for (const [g, gLabel] of Object.entries(GROUPS)) {
    const keys = metricsMeta.filter((k) => groupOf[k] === g);
    if (!keys.length) continue;
    body += `<tr class="group"><th colspan="${data.projects.length + 1}">${esc(gLabel)}</th></tr>`;
    for (const k of keys) {
      const cells = data.projects
        .map((p) => {
          const m = p.metrics[k];
          if (!m) return `<td class="${p.id === selected ? 'sel' : ''}"><span class="val na">–</span></td>`;
          const conflict = p.conflicts.find((c) => c.key === k);
          return `<td class="num ${p.id === selected ? 'sel' : ''}" ${tipAttr(`${labelOf[k] ?? k}: ${fmt(m.value)} ${m.unit ?? ''}`, [`${m.docLabel ?? 'document'}, page ${m.page ?? '?'}`, conflict ? `Other documents say: ${conflict.others.map((o) => o.value).join(', ')}` : ''].filter(Boolean), m.quote)}>${esc(fmt(m.value))}<span class="badge ${m.method}">${m.method === 'llm' ? 'AI' : 'R'}</span>${conflict ? '<span class="warn" aria-label="documents disagree">⚠</span>' : ''}</td>`;
        })
        .join('');
      body += `<tr><th scope="row">${esc(labelOf[k] ?? k)} <span class="val na">${esc(unitOf[k] ?? '')}</span></th>${cells}</tr>`;
    }
  }
  $('#metrics').innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderMethod() {
  const c = data.config;
  $('#method').innerHTML = `
    <p>Figures are extracted from the EIA/EMP executive summaries, hearing orders and other PDFs linked to each project on MPCB and PARIVESH. Every figure links to the page and sentence it came from. <b>R</b> marks values found by built-in rules; <b>AI</b> marks values Claude read from the PDF (used when an Anthropic API key is set; Claude also reads scanned pages).</p>
    <p>The screening index compares projects with each other. Each indicator is scaled linearly to a reference level (e.g. ${c.reference.forestHaPerMW} ha forest per MW, ${c.reference.protectedAreaKmZero} km to a protected area = 0), averaged per dimension, then weighted (${Object.entries(c.weights).map(([k, w]) => `${k} ×${w}`).join(', ')}). Missing indicators are left out, so check the coverage figure. It is not a regulatory rating; the reference levels are in <code>config/analytics.json</code>.</p>
    <p>Reports are prepared by consultants hired by the project proponent. Treat the figures as the proponent's own claims.</p>`;
}

// Labels/groups mirrored from src/analysis/metrics.js
const METRIC_LABELS = {
  capacityMW: 'Installed capacity', storageHours: 'Daily generation hours', projectCostCr: 'Project cost', constructionMonths: 'Construction period', loopType: 'Loop type', maxDamHeightM: 'Max dam height', eiaConsultant: 'EIA consultant', torDate: 'ToR granted on',
  totalLandHa: 'Total land', forestLandHa: 'Forest land diverted', nonForestLandHa: 'Non-forest land', submergenceHa: 'Submergence area', treesFelled: 'Trees to be felled', muckLakhCum: 'Muck generated', muckDisposalHa: 'Muck disposal area',
  upperReservoirMCM: 'Upper reservoir storage', lowerReservoirMCM: 'Lower reservoir storage', initialFillMCM: 'Initial filling', annualMakeupMCM: 'Annual make-up water', waterSource: 'Water source',
  nearestProtectedArea: 'Nearest protected area', protectedAreaKm: 'Distance to protected area', westernGhatsESA: 'In Western Ghats ESA (draft)', insideESZ: 'Inside notified ESZ', scheduleISpecies: 'Schedule-I species', threatenedSpecies: 'IUCN threatened species', plantSpecies: 'Plant species recorded',
  studyAreaVillages: 'Villages in study area', affectedVillages: 'Directly affected villages', affectedHouseholds: 'Affected households', affectedPopulation: 'Affected population', displacedFamilies: 'Families displaced', tribalSharePct: 'Scheduled Tribe share', rrPlanRequired: 'R&R plan required', heritageNearby: 'Heritage / tourist sites nearby',
  empCapitalCr: 'EMP budget (capital)', empTotalCr: 'EMP budget (capital + recurring)', compensatoryAfforestationCr: 'Compensatory afforestation', biodiversityPlanCr: 'Biodiversity / wildlife plan', muckPlanCr: 'Muck disposal plan', monitoringCr: 'Environmental monitoring', cerCr: 'CER / local area development', co2ReductionMtPerYr: 'Claimed CO₂ reduction',
  seismicZone: 'Seismic zone', pm10MaxUgm3: 'Max PM10 (baseline)', pm25MaxUgm3: 'Max PM2.5 (baseline)', annualRainfallMm: 'Annual rainfall',
};
const METRIC_GROUPS = Object.fromEntries(
  Object.entries({
    project: ['capacityMW', 'storageHours', 'projectCostCr', 'constructionMonths', 'loopType', 'maxDamHeightM', 'eiaConsultant', 'torDate'],
    land: ['totalLandHa', 'forestLandHa', 'nonForestLandHa', 'submergenceHa', 'treesFelled', 'muckLakhCum', 'muckDisposalHa'],
    water: ['upperReservoirMCM', 'lowerReservoirMCM', 'initialFillMCM', 'annualMakeupMCM', 'waterSource'],
    biodiversity: ['nearestProtectedArea', 'protectedAreaKm', 'westernGhatsESA', 'insideESZ', 'scheduleISpecies', 'threatenedSpecies', 'plantSpecies'],
    social: ['studyAreaVillages', 'affectedVillages', 'affectedHouseholds', 'affectedPopulation', 'displacedFamilies', 'tribalSharePct', 'rrPlanRequired', 'heritageNearby'],
    mitigation: ['empCapitalCr', 'empTotalCr', 'compensatoryAfforestationCr', 'biodiversityPlanCr', 'muckPlanCr', 'monitoringCr', 'cerCr', 'co2ReductionMtPerYr'],
    baseline: ['seismicZone', 'pm10MaxUgm3', 'pm25MaxUgm3', 'annualRainfallMm'],
  }).flatMap(([g, keys]) => keys.map((k) => [k, g])),
);

// ---- tooltip: one floating element, content via textContent only ----
const tip = $('#tip');
function showTip(el, x, y) {
  const t = tips.get(el.dataset.tip);
  if (!t) return;
  tip.replaceChildren();
  const h = document.createElement('div');
  h.className = 'tt';
  h.textContent = t.title;
  tip.append(h);
  for (const l of t.lines.filter(Boolean)) {
    const d = document.createElement('div');
    d.textContent = l;
    tip.append(d);
  }
  if (t.quote) {
    const q = document.createElement('div');
    q.className = 'tq';
    q.textContent = `“${t.quote.slice(0, 300)}”`;
    tip.append(q);
  }
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(y + 14, innerHeight - r.height - 8)}px`;
}
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (el) showTip(el, e.clientX, e.clientY);
  else tip.hidden = true;
});
document.addEventListener('focusin', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) return;
  const r = el.getBoundingClientRect();
  showTip(el, r.left, r.bottom);
});
document.addEventListener('focusout', () => (tip.hidden = true));

load().catch((e) => {
  document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="empty">${esc(e.message)}</p>`);
});

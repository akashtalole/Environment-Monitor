const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtCr = (v) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;
const PAGE = 25;

let data;
let geo;
const state = { q: '', sector: '', district: '', zone: '', year: '', taluka: '', upcoming: false, bonds: false, sort: 'date', dir: 'desc', page: 0 };

// ---------- tooltip (content via textContent) ----------
const tips = new Map();
let tipSeq = 0;
const tipAttr = (title, lines = []) => {
  const id = `t${tipSeq++}`;
  tips.set(id, { title, lines });
  return `data-tip="${id}"`;
};
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
  if (el) {
    const r = el.getBoundingClientRect();
    showTip(el, r.left, r.bottom);
  }
});
document.addEventListener('focusout', () => (tip.hidden = true));

// ---------- state <-> URL ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(state)) {
    if (!p.has(k)) continue;
    const v = p.get(k);
    state[k] = typeof state[k] === 'boolean' ? v === '1' : typeof state[k] === 'number' ? +v || 0 : v;
  }
}
function writeHash() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) {
    if (v === '' || v === false || (k === 'page' && v === 0) || (k === 'sort' && v === 'date') || (k === 'dir' && v === 'desc')) continue;
    p.set(k, v === true ? '1' : v);
  }
  history.replaceState(null, '', p.toString() ? `#${p}` : location.pathname);
}

const zoneOf = (p) => p.westernGhats.zone ?? (p.westernGhats.inWgDistrict ? 'wg' : 'outside');
const hasBond = (p) => p.bonds.exact.length > 0 || p.bonds.groups.some((g) => g.purchases.length);

function filtered() {
  const q = state.q.trim().toLowerCase();
  return data.projects.filter(
    (p) =>
      (!q || [p.title, ...p.proponents, ...p.districts, ...p.talukasMentioned].join(' ').toLowerCase().includes(q)) &&
      (!state.sector || p.sector === state.sector) &&
      (!state.district || p.districts.includes(state.district)) &&
      (!state.zone || (state.zone === 'wg' ? p.westernGhats.inWgDistrict : zoneOf(p) === state.zone)) &&
      (!state.year || (p.date ?? '').startsWith(state.year)) &&
      (!state.taluka || p.talukas.some((t) => t.taluka === state.taluka)) &&
      (!state.upcoming || p.upcoming) &&
      (!state.bonds || hasBond(p)),
  );
}

// ---------- boot ----------
async function load() {
  [data, geo] = await Promise.all([
    fetch('data/statewide.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('No statewide data yet. Run "node src/cli.js statewide".')))),
    fetch('data/maharashtra-districts.geojson').then((r) => r.json()),
  ]);
  readHash();
  initFilters();
  renderStatic();
  render();
}

function initFilters() {
  const opt = (sel, items, label) => ($(sel).innerHTML = `<option value="">${esc(label)}</option>` + items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''));
  opt('#f-sector', Object.entries(data.bySector).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, `${k} (${n})`]), 'All sectors');
  opt('#f-district', geo.features.map((f) => f.properties.district).sort().map((d) => [d, `${d} (${data.byDistrict[d] ?? 0})`]), 'All districts');
  opt('#f-zone', [['ESZ1', 'WGEEP ESZ1 (highest sensitivity)'], ['ESZ2', 'WGEEP ESZ2'], ['ESZ3', 'WGEEP ESZ3'], ['wg', 'Any Western Ghats district'], ['outside', 'Outside / location unknown']], 'All zones');
  opt('#f-year', Object.keys(data.byYear).sort().reverse().map((y) => [y, `${y} (${data.byYear[y]})`]), 'All years');
  const bind = (sel, key, ev = 'change', val = (el) => el.value) =>
    $(sel).addEventListener(ev, (e) => {
      state[key] = val(e.target);
      state.page = 0;
      render();
    });
  bind('#f-q', 'q', 'input');
  bind('#f-sector', 'sector');
  bind('#f-district', 'district');
  bind('#f-zone', 'zone');
  bind('#f-year', 'year');
  bind('#f-upcoming', 'upcoming', 'change', (el) => el.checked);
  bind('#f-bonds', 'bonds', 'change', (el) => el.checked);
  $('#f-reset').addEventListener('click', () => {
    Object.assign(state, { q: '', sector: '', district: '', zone: '', year: '', taluka: '', upcoming: false, bonds: false, page: 0 });
    render();
  });
  $('#f-share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $('#f-share').textContent = 'Copied';
    } catch {
      $('#f-share').textContent = 'Copy from address bar';
    }
    setTimeout(() => ($('#f-share').textContent = 'Copy link'), 1500);
  });
  $('#wg-outline').addEventListener('change', renderMap);
  $('#drawer-close').addEventListener('click', () => ($('#drawer').hidden = true));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && ($('#drawer').hidden = true));
  $('#dl-csv').addEventListener('click', (e) => {
    e.preventDefault();
    downloadCsv(filtered());
  });
}

function syncControls() {
  $('#f-q').value = state.q;
  $('#f-sector').value = state.sector;
  $('#f-district').value = state.district;
  $('#f-zone').value = state.zone;
  $('#f-year').value = state.year;
  $('#f-upcoming').checked = state.upcoming;
  $('#f-bonds').checked = state.bonds;
}

function render() {
  tips.clear();
  syncControls();
  writeHash();
  const rows = filtered();
  $('#f-count').textContent = `${rows.length} of ${data.projects.length} projects${state.taluka ? ` · taluka ${state.taluka}` : ''}`;
  renderTiles(rows);
  renderMap(rows);
  renderSector(rows);
  renderZone(rows);
  renderYear(rows);
  renderTable(rows);
}

// ---------- tiles ----------
function renderTiles(rows) {
  const t = [
    ['Projects', rows.length, `${data.projects.length} tracked statewide`],
    ['In Western Ghats districts', rows.filter((p) => p.westernGhats.inWgDistrict).length, 'district-level'],
    ['In WGEEP ESZ1 talukas', rows.filter((p) => p.westernGhats.zone === 'ESZ1').length, 'highest sensitivity'],
    ['Upcoming hearings', rows.filter((p) => p.upcoming).length, 'per MPCB'],
    ['Proponents with bond purchases', rows.filter(hasBond).length, 'exact name or documented parent'],
  ];
  $('#tiles').innerHTML = t.map(([k, v, s]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
}

// ---------- map: plain SVG from the district GeoJSON ----------
function projector() {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => (typeof c[0] === 'number' ? ((minX = Math.min(minX, c[0])), (maxX = Math.max(maxX, c[0])), (minY = Math.min(minY, c[1])), (maxY = Math.max(maxY, c[1]))) : c.forEach(walk));
  geo.features.forEach((f) => walk(f.geometry.coordinates));
  const kx = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  const W = 800;
  const s = W / ((maxX - minX) * kx);
  const H = (maxY - minY) * s;
  return { W, H, p: ([x, y]) => [((x - minX) * kx * s).toFixed(1), ((maxY - y) * s).toFixed(1)] };
}
let proj;
function pathOf(geom) {
  const rings = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return rings.map((poly) => poly.map((ring) => 'M' + ring.map((pt) => proj.p(pt).join(',')).join('L') + 'Z').join('')).join('');
}
function renderMap(rows = filtered()) {
  proj ??= projector();
  const counts = {};
  for (const p of rows) for (const d of p.districts) counts[d] = (counts[d] ?? 0) + 1;
  const max = Math.max(1, ...Object.values(counts));
  const bins = [0.18, 0.36, 0.56, 0.78, 1];
  const opacity = (n) => (n ? bins[Math.min(4, Math.floor((n / max) * 4.999))] : 0);
  const wgSet = new Set(data.westernGhats.districts);
  const outline = $('#wg-outline').checked;
  const svg = $('#map');
  svg.setAttribute('viewBox', `0 0 ${proj.W} ${proj.H}`);
  svg.innerHTML =
    `<rect width="${proj.W}" height="${proj.H}" fill="transparent"/>` +
    geo.features
      .map((f) => {
        const d = f.properties.district;
        const n = counts[d] ?? 0;
        return `<path class="d ${state.district === d ? 'sel' : ''}" d="${pathOf(f.geometry)}" data-d="${esc(d)}" tabindex="0" role="button" aria-label="${esc(d)}: ${n} projects"
          style="fill: color-mix(in srgb, var(--series-1) ${Math.round(opacity(n) * 100)}%, var(--panel-2))"
          ${tipAttr(`${d}: ${n} project${n === 1 ? '' : 's'}`, [wgSet.has(d) ? 'Western Ghats district (WGEEP)' : '', state.district === d ? 'Click again to clear' : 'Click to filter'])}></path>`;
      })
      .join('') +
    (outline ? geo.features.filter((f) => wgSet.has(f.properties.district)).map((f) => `<path class="wg" d="${pathOf(f.geometry)}"></path>`).join('') : '');
  svg.querySelectorAll('path.d').forEach((el) => {
    const pick = () => {
      state.district = state.district === el.dataset.d ? '' : el.dataset.d;
      state.page = 0;
      render();
    };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
  });
  const steps = bins.map((b) => `<span style="background: color-mix(in srgb, var(--series-1) ${b * 100}%, var(--panel-2))"></span>`).join('');
  $('#map-legend').innerHTML = `<span>Fewer</span><span class="ramp">${steps}</span><span>More (max ${max})</span>${outline ? '<span class="wgkey"><i></i>Western Ghats district</span>' : ''}<span>· districts are counted once per project they mention</span>`;
}

// ---------- charts ----------
function hbar(el, entries, onPick, active) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  el.innerHTML =
    entries
      .map(
        ([k, v, label]) => `<span class="lbl ${onPick ? 'click' : ''}" data-k="${esc(k)}" title="${esc(label ?? k)}">${esc(label ?? k)}</span>
      <span class="track" ${tipAttr(`${label ?? k}: ${v}`, [onPick ? 'Click the label to filter' : ''])}><span class="fill ${active && active !== k ? 'dim' : ''}" style="width:${v ? Math.max(1, (v / max) * 100) : 0}%"></span></span>
      <span class="val">${v}</span>`,
      )
      .join('') || '<span class="val na">No projects</span>';
  if (onPick) el.querySelectorAll('.lbl').forEach((l) => l.addEventListener('click', () => onPick(l.dataset.k)));
}
function renderSector(rows) {
  const c = {};
  rows.forEach((p) => (c[p.sector] = (c[p.sector] ?? 0) + 1));
  hbar($('#c-sector'), Object.entries(c).sort((a, b) => b[1] - a[1]), (k) => ((state.sector = state.sector === k ? '' : k), (state.page = 0), render()), state.sector);
}
function renderZone(rows) {
  const labels = { ESZ1: 'ESZ1 – highest', ESZ2: 'ESZ2 – high', ESZ3: 'ESZ3 – moderate', wg: 'WG district, taluka unknown', outside: 'Outside / unknown' };
  const c = { ESZ1: 0, ESZ2: 0, ESZ3: 0, wg: 0, outside: 0 };
  rows.forEach((p) => c[zoneOf(p)]++);
  hbar($('#c-zone'), Object.entries(c).map(([k, v]) => [k, v, labels[k]]), (k) => ((state.zone = state.zone === k ? '' : k), (state.page = 0), render()), state.zone);
}
function renderYear(rows) {
  const c = {};
  rows.forEach((p) => p.date && (c[p.date.slice(0, 4)] = (c[p.date.slice(0, 4)] ?? 0) + 1));
  const years = Object.keys(data.byYear).sort();
  const max = Math.max(1, ...Object.values(c));
  $('#c-year').innerHTML = years
    .map((y) => `<div class="col" ${tipAttr(`${y}: ${c[y] ?? 0} hearings`, ['Click to filter'])} data-y="${y}" role="button" tabindex="0"><span class="v">${c[y] ?? ''}</span><span class="bar" style="height:${((c[y] ?? 0) / max) * 120}px; ${state.year && state.year !== y ? 'background: var(--muted-fill)' : ''}"></span><span class="k">${y}</span></div>`)
    .join('');
  $('#c-year').querySelectorAll('.col').forEach((el) => el.addEventListener('click', () => ((state.year = state.year === el.dataset.y ? '' : el.dataset.y), (state.page = 0), render())));
}

// ---------- table ----------
const COLS = [
  ['date', 'Date', (p) => p.date ?? ''],
  ['title', 'Project', (p) => p.title],
  ['sector', 'Sector', (p) => p.sector],
  ['district', 'District', (p) => p.districts.join(', ')],
  ['zone', 'Western Ghats', (p) => ({ ESZ1: 1, ESZ2: 2, ESZ3: 3, wg: 4, outside: 5 })[zoneOf(p)]],
  ['bonds', 'Bonds', (p) => -(p.bonds.exact.reduce((s, b) => s + b.cr, 0) + p.bonds.groups.reduce((s, g) => s + g.purchases.reduce((t, x) => t + x.cr, 0), 0))],
];
const zoneChip = (p) =>
  p.westernGhats.zone
    ? `<span class="zone ${p.westernGhats.zone}">${p.westernGhats.zone}</span>`
    : `<span class="zone none">${p.westernGhats.inWgDistrict ? 'WG district' : '—'}</span>`;
const bondChip = (p) => {
  const total = p.bonds.exact.reduce((s, b) => s + b.cr, 0) + p.bonds.groups.reduce((s, g) => s + g.purchases.reduce((t, x) => t + x.cr, 0), 0);
  return total ? `<span class="money">${fmtCr(total)}</span>` : '';
};
function renderTable(rows) {
  const col = COLS.find((c) => c[0] === state.sort) ?? COLS[0];
  const sorted = [...rows].sort((a, b) => {
    const x = col[2](a);
    const y = col[2](b);
    const r = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return state.dir === 'asc' ? r : -r;
  });
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  state.page = Math.min(state.page, pages - 1);
  const slice = sorted.slice(state.page * PAGE, state.page * PAGE + PAGE);
  $('#ptable').innerHTML =
    `<thead><tr>${COLS.map(([k, l]) => `<th scope="col" data-k="${k}" aria-sort="${state.sort === k ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}" tabindex="0">${esc(l)}</th>`).join('')}</tr></thead><tbody>` +
    (slice
      .map(
        (p) => `<tr data-id="${p.id}" tabindex="0">
      <td class="nowrap">${fmtDate(p.date)}${p.upcoming ? '<div class="sub2"><span class="tag new">upcoming</span></div>' : ''}</td>
      <td class="t">${esc(p.title.slice(0, 200))}${p.title.length > 200 ? '…' : ''}${p.proponents.length ? `<div class="sub2">${esc(p.proponents.join('; '))}</div>` : ''}</td>
      <td>${esc(p.sector)}</td>
      <td>${esc(p.districts.join(', ') || '—')}${p.talukas.length ? `<div class="sub2">${esc(p.talukas.map((t) => t.taluka).join(', '))}</div>` : ''}</td>
      <td>${zoneChip(p)}</td>
      <td>${bondChip(p)}</td></tr>`,
      )
      .join('') || `<tr><td colspan="${COLS.length}" class="empty">No projects match these filters.</td></tr>`) +
    '</tbody>';
  $('#ptable').querySelectorAll('th').forEach((th) =>
    th.addEventListener('click', () => {
      state.dir = state.sort === th.dataset.k && state.dir === 'desc' ? 'asc' : 'desc';
      state.sort = th.dataset.k;
      render();
    }),
  );
  $('#ptable').querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.id));
    tr.addEventListener('keydown', (e) => e.key === 'Enter' && openDrawer(tr.dataset.id));
  });
  $('#pager').innerHTML = `<button class="btn" id="pg-prev" ${state.page ? '' : 'disabled'}>‹ Prev</button><span>Page ${state.page + 1} of ${pages}</span><button class="btn" id="pg-next" ${state.page < pages - 1 ? '' : 'disabled'}>Next ›</button>`;
  $('#pg-prev').addEventListener('click', () => (state.page--, render()));
  $('#pg-next').addEventListener('click', () => (state.page++, render()));
}

function partyBars(byParty) {
  const max = Math.max(1, ...byParty.map((x) => x.cr));
  return `<div class="bars">${byParty.map((x) => `<span class="lbl" title="${esc(x.name)}">${esc(x.name)}</span><span class="track" ${tipAttr(`${x.name}: ${fmtCr(x.cr)}`, ['Bonds bought by this purchaser and encashed by this party, matched by bond number'])}><span class="fill" style="width:${Math.max(1, (x.cr / max) * 100)}%"></span></span><span class="val">${fmtCr(x.cr)}</span>`).join('')}</div>`;
}

function openDrawer(id) {
  const p = data.projects.find((x) => x.id === id);
  if (!p) return;
  const g = p.westernGhats.guideline;
  const bondBlocks = [
    ...p.bonds.exact.map((b) => `<div class="box"><h4>Electoral bonds – exact name match</h4><b>${esc(b.name)}</b>: ${fmtCr(b.cr)} in ${b.bonds} bonds (${fmtDate(b.first)} – ${fmtDate(b.last)})${partyBars(b.byParty)}</div>`),
    ...p.bonds.groups.flatMap((gr) =>
      gr.purchases.length
        ? gr.purchases.map((x) => `<div class="box"><h4>Electoral bonds – ${esc(x.relation)}</h4><b>${esc(x.name)}</b>: ${fmtCr(x.cr)} in ${x.bonds} bonds (${fmtDate(x.first)} – ${fmtDate(x.last)})${x.evidence ? `<blockquote>“${esc(x.evidence.text)}” — <a href="${esc(x.evidence.url)}#page=${x.evidence.page}" target="_blank" rel="noopener">${esc(x.evidence.document)}, p.${x.evidence.page}</a></blockquote>` : ''}${partyBars(x.byParty)}${gr.note ? `<p class="note">${esc(gr.note)}</p>` : ''}</div>`)
        : [`<div class="box"><h4>Electoral bonds – ${esc(gr.name)}</h4>${esc(gr.note ?? 'No purchases found.')}</div>`],
    ),
  ].join('');
  $('#drawer-body').innerHTML = `
    <h3>${esc(p.title)}</h3>
    <div>${zoneChip(p)} ${bondChip(p)} ${p.upcoming ? '<span class="tag new">upcoming hearing</span>' : ''}</div>
    <dl>
      <dt>Date</dt><dd>${fmtDate(p.date)}</dd>
      <dt>Sector</dt><dd>${esc(p.sector)}</dd>
      <dt>Proponent</dt><dd>${esc(p.proponents.join('; ') || 'Not identified in the listing')}</dd>
      <dt>District</dt><dd>${esc(p.districts.join(', ') || 'Not identified')}</dd>
      <dt>Taluka</dt><dd>${esc(p.talukasMentioned.join(', ') || '—')}</dd>
      <dt>Western Ghats</dt><dd>${esc(p.westernGhats.status)}${p.talukas.map((t) => `<br>${esc(t.taluka)} (${esc(t.district)}): WGEEP ${t.zone}${t.wgeepName !== t.taluka ? ` – listed as “${esc(t.wgeepName)}”` : ''}${t.partial ? ' – under 50% of taluka inside the boundary' : ''}`).join('')}</dd>
      ${p.proposalNo ? `<dt>Proposal no.</dt><dd>${esc(p.proposalNo)}</dd>` : ''}
      <dt>Sources</dt><dd>${p.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.sourceName)}</a>${s.status ? ` – ${esc(s.status)}` : ''}`).join('<br>')}</dd>
      <dt>Documents</dt><dd>${p.docs.map((d) => `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label)}</a>`).join('<br>') || '—'}</dd>
    </dl>
    ${g ? `<div class="box"><h4>Gadgil panel guideline for ${esc(g.sector)} in ${esc(p.westernGhats.zone)}</h4>${esc(g.text)}<p class="note">WGEEP report (2011), PDF p.${g.page}. A recommendation – not adopted into law.</p></div>` : ''}
    ${p.watchlistIds.length ? `<div class="box"><h4>Report-level impact analysis</h4>This project is on the watchlist. <a href="impact.html">See extracted impact figures and risk flags →</a></div>` : ''}
    ${bondBlocks}`;
  $('#drawer').hidden = false;
  $('#drawer-close').focus();
}

// ---------- static sections ----------
function renderStatic() {
  $('#generated').textContent = `data built ${fmtDate(data.generatedAt)}`;
  const wg = data.westernGhats;
  const badge = (v) => (v === true ? '<span class="vbadge ok">primary source</span>' : v === 'secondary' ? '<span class="vbadge">secondary source</span>' : '<span class="vbadge warn">unconfirmed</span>');
  const srcLink = (key, page) => (key && wg.sources[key] ? ` <a href="${esc(wg.sources[key].url)}${page ? `#page=${page}` : ''}" target="_blank" rel="noopener">source${page ? `, p.${page}` : ''}</a>` : '');
  $('#wg-timeline').innerHTML = wg.timeline.map((t) => `<li><span class="when">${esc(t.date)}</span>${badge(t.verified)}<div>${esc(t.event)}${srcLink(t.source, t.page)}</div></li>`).join('');
  const sectors = { energy: 'Power & hydro', mining: 'Mining', industry: 'Polluting industry', transport: 'Roads & rail' };
  $('#wg-guides').innerHTML =
    `<thead><tr><th>Sector</th><th><span class="zone ESZ1">ESZ1</span></th><th><span class="zone ESZ2">ESZ2</span></th><th><span class="zone ESZ3">ESZ3</span></th></tr></thead><tbody>` +
    Object.entries(sectors).map(([k, l]) => `<tr><th scope="row">${esc(l)}<div class="note">p.${wg.guidelines[k].page}</div></th>${['ESZ1', 'ESZ2', 'ESZ3'].map((z) => `<td>${esc(wg.guidelines[k][z])}</td>`).join('')}</tr>`).join('') +
    `</tbody>`;
  $('#wg-passages').innerHTML = wg.passages
    .map((p) => `<div class="passage"><div class="th">${esc(p.theme)}</div><h4>${esc(p.title)}</h4><blockquote>“${esc(p.text)}”</blockquote><div class="note">WGEEP report, p.${p.page}${srcLink(p.source, p.page)}</div>${p.relevance ? `<div class="rel">${esc(p.relevance)}</div>` : ''}</div>`)
    .join('');
  $('#wg-note').textContent = `${wg.summary.text} ${wg.talukaNameNote}`;
  const rows = [...data.wgTalukas].sort((a, b) => a.zone.localeCompare(b.zone) || b.projects - a.projects || a.taluka.localeCompare(b.taluka));
  $('#wg-talukas').innerHTML =
    `<thead><tr><th>Taluka</th><th>District</th><th>Zone</th><th>Projects</th></tr></thead><tbody>` +
    rows
      .map((t) => `<tr><th scope="row">${t.projects ? `<a href="#" data-taluka="${esc(t.taluka)}">${esc(t.taluka)}</a>` : esc(t.taluka)}${t.wgeepName !== t.taluka ? `<div class="note">WGEEP: ${esc(t.wgeepName)}</div>` : ''}</th><td>${esc(t.district)}</td><td><span class="zone ${t.zone}">${t.zone}</span>${t.partial ? '<div class="note">&lt;50% in WG</div>' : ''}</td><td class="num">${t.projects || '–'}</td></tr>`)
      .join('') +
    '</tbody>';
  $('#wg-talukas').querySelectorAll('a[data-taluka]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      state.taluka = a.dataset.taluka;
      state.page = 0;
      render();
      $('#ptable').scrollIntoView({ behavior: 'smooth' });
    }),
  );

  $('#psp').innerHTML = data.psp.length
    ? `<thead><tr><th>Project</th><th>MW</th><th>Taluka zones (WGEEP)</th><th>Forest land</th><th>Trees</th><th>Max dam height</th><th>Protected area</th><th>Draft WG ESA</th><th>Screening index</th><th>High flags</th></tr></thead><tbody>` +
      data.psp
        .map(
          (p) => `<tr><th scope="row"><a href="impact.html">${esc(p.name)}</a></th><td class="num">${p.capacityMW ?? '—'}</td>
          <td>${p.talukaZones.map((z) => `${esc(z.taluka)} <span class="zone ${z.zone}">${z.zone}</span>`).join('<br>') || '—'}</td>
          <td class="num">${p.forestHa != null ? `${p.forestHa} ha` : '—'}</td><td class="num">${p.trees != null ? p.trees.toLocaleString('en-IN') : '—'}</td>
          <td class="num">${p.damHeightM != null ? `${p.damHeightM} m` : '—'}</td><td class="num">${p.protectedAreaKm != null ? `${p.protectedAreaKm} km` : '—'}</td>
          <td>${p.westernGhatsESA === true ? 'Yes (per EIA)' : p.westernGhatsESA === false ? 'No (per EIA)' : '—'}</td>
          <td class="num">${p.score ?? '—'}<div class="note">${p.coverage}% coverage</div></td>
          <td>${p.highFlags.map((f) => `<span class="sev high">${esc(f)}</span>`).join(' ')}</td></tr>`,
        )
        .join('') +
      '</tbody>'
    : '<tr><td class="empty">Run "node src/cli.js analyze" to add report-level figures.</td></tr>';

  // Bonds
  const b = data.bondCompanies;
  $('#bond-list').innerHTML =
    (b.length
      ? b
          .map((x) => {
            const projs = data.projects.filter((p) => x.projects.includes(p.id));
            return `<div class="bond"><h4><span class="amt">${fmtCr(x.cr)}</span> ${esc(x.name)}</h4>
            <div class="basis">Link to project: ${esc(x.basis)} · ${x.bonds} bonds, ${fmtDate(x.first)} – ${fmtDate(x.last)}</div>
            ${x.evidence ? `<blockquote>“${esc(x.evidence.text)}” — <a href="${esc(x.evidence.url)}#page=${x.evidence.page}" target="_blank" rel="noopener">${esc(x.evidence.document)}, p.${x.evidence.page}</a></blockquote>` : ''}
            ${partyBars(x.byParty)}
            <div class="note" style="margin-top:6px">Projects: ${projs.map((p) => `<a href="#" data-open="${p.id}">${esc(p.title.slice(0, 90))}</a>`).join('; ')}</div></div>`;
          })
          .join('')
      : '<p class="empty">No proponent in the current data matches an electoral bond purchaser.</p>') +
    `<h3 class="sub">Checked with no purchases found</h3><ul class="plain">${data.groupsSearched.filter((g) => !g.hasPurchases).map((g) => `<li><b>${esc(g.name)}</b> – ${esc(g.note)}</li>`).join('')}</ul>`;
  $('#bond-list').querySelectorAll('a[data-open]').forEach((a) => a.addEventListener('click', (e) => (e.preventDefault(), openDrawer(a.dataset.open))));
  const v = data.bondSource?.verification;
  $('#bond-notes').innerHTML = data.bondSource
    ? `<p><b>What this shows.</b> Electoral bonds bought by companies that are proponents of projects on this dashboard, and which parties encashed them. Bonds are linked to parties by their unique bond number, as disclosed by the Election Commission of India on 21 March 2024 on the Supreme Court's orders.</p>
       <p><b>How companies are matched.</b> Only (1) an exact company-name match after removing punctuation and “Pvt/Ltd” variants, or (2) a parent/subsidiary link documented in a cited source. Group companies are never assumed from similar names.</p>
       <p><b>Caveats.</b> Buying electoral bonds was legal at the time. A purchase does not show any link to a clearance decision. Clearances are granted by MoEFCC / SEIAA, not by political parties. The scheme was struck down by the Supreme Court on 15 February 2024.</p>
       <p><b>Verification.</b> ${v.purchaseRows.toLocaleString('en-IN')} purchase rows (${fmtCr(v.purchaseCr)}) and ${v.encashRows.toLocaleString('en-IN')} encashment rows (${fmtCr(v.encashCr)}) – identical to the ECI PDFs. ${v.matchedBonds.toLocaleString('en-IN')} bonds linked to a party by number. <a href="${esc(data.bondSource.eciPage)}" target="_blank" rel="noopener">ECI disclosure</a> · <a href="${esc(data.bondSource.csvRepo)}" target="_blank" rel="noopener">CSV conversion</a> (commit ${esc(data.bondSource.commit.slice(0, 7))}).</p>`
    : '<p>Electoral bond data not built yet: run "node src/cli.js bonds".</p>';

  $('#sources').innerHTML = `
    <p><b>Projects.</b> MPCB public hearing listings (upcoming and conducted), plus PARIVESH when reachable. Sector, district and taluka are read from the listing text: talukas only count when marked “Tal.”/“Taluka”/“Tehsil”, so many projects show “taluka not identified”.</p>
    <p><b>Western Ghats zoning.</b> <a href="${esc(wg.sources.wgeep.url)}" target="_blank" rel="noopener">Report of the Western Ghats Ecology Expert Panel</a> (Gadgil, 31 Aug 2011), Appendices 2–3 (taluka zones) and Table 6 (sector guidelines). The zoning is shown as a reference for what the expert panel recommended; it was not adopted. The later Kasturirangan (HLWG) recommendations and the draft ESA notifications are summarised from secondary sources and marked as such.</p>
    <p><b>Impact figures.</b> Extracted from the EIA/EMP documents themselves (see Impact analytics). They are the proponent's own claims.</p>
    <p><b>Map.</b> Census 2011 district boundaries (with Palghar), via an open dataset; indicative only.</p>`;
}

function downloadCsv(rows) {
  const cols = ['date', 'title', 'proponents', 'sector', 'districts', 'talukas', 'wgeep_zone', 'in_wg_district', 'upcoming', 'bond_purchases_cr', 'source_urls'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((p) =>
    [
      p.date, p.title, p.proponents.join('; '), p.sector, p.districts.join('; '), p.talukas.map((t) => t.taluka).join('; '),
      p.westernGhats.zone ?? '', p.westernGhats.inWgDistrict, p.upcoming,
      p.bonds.exact.reduce((s, b) => s + b.cr, 0) + p.bonds.groups.reduce((s, g) => s + g.purchases.reduce((t, x) => t + x.cr, 0), 0),
      p.sources.map((s) => s.url).join(' '),
    ].map(q).join(','),
  );
  const blob = new Blob([[cols.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'maharashtra-projects.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

addEventListener('hashchange', () => {
  if (!data) return;
  Object.assign(state, { q: '', sector: '', district: '', zone: '', year: '', taluka: '', upcoming: false, bonds: false, sort: 'date', dir: 'desc', page: 0 });
  readHash();
  render();
});

load().catch((e) => document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="empty">${esc(e.message)}</p>`));

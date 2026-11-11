const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const docsLinks = (docs = []) => docs.slice(0, 4).map((d) => `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label)}</a>`).join(' · ');

let data;
let map;
const markers = {};

async function load() {
  const res = await fetch('data/dashboard.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('No dashboard data yet. Run "npm run monitor" first.');
  data = await res.json();
  render();
}

function render() {
  $('#generated').textContent = `updated ${ago(data.generatedAt)}`;
  $('#health').innerHTML = data.sources
    .filter((s) => s.health !== 'DISABLED')
    .map((s) => `<span class="pill ${s.health}" title="${esc(s.name)}: ${esc(s.error || s.note || s.health)}">${esc(s.id)}</span>`)
    .join('');
  renderProjects();
  renderEvents();
  renderHearings();
  renderDiscovered();
  renderSources();
  renderMap();
}

function trackBar(track, info) {
  const steps = data.tracks[track] ?? [];
  const idx = steps.indexOf(info.stage);
  const cls = info.outcome === 'rejected' ? 'rejected' : '';
  return `<div class="track"><b>${track}</b><div class="steps ${cls}">${steps
    .map((_, i) => `<span class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"></span>`)
    .join('')}</div><div class="stage-label">${esc(info.stage)}${info.outcome ? ` · ${esc(info.outcome)}` : ''}${info.date ? ` · ${fmtDate(info.date)}` : ''}</div></div>`;
}

function renderProjects() {
  $('#watch-count').textContent = `${data.projects.length} projects`;
  $('#projects').innerHTML = data.projects
    .map((p) => {
      const tracks = Object.entries(p.tracks);
      const ids = Object.values(p.ids ?? {}).flat();
      return `<article class="project" data-id="${esc(p.id)}">
        <h3>${esc(p.name)} ${p.verified ? '' : '<span class="unverified" title="Seed entry – not yet confirmed on a portal">UNVERIFIED</span>'}<span class="mw">${p.capacityMW ?? '?'} MW</span></h3>
        <div class="who">${esc(p.developer ?? 'Developer unknown')} · ${esc((p.talukas ?? []).join(', '))} · ${esc(p.districts.join(', '))}</div>
        ${tracks.length ? tracks.map(([t, v]) => trackBar(t, v)).join('') : '<div class="who">No portal records matched yet</div>'}
        <div class="records">
          ${ids.length ? `<div>IDs: ${ids.map(esc).join(', ')}</div>` : '<div>No proposal numbers yet – add with <code>envmon add-id</code></div>'}
          ${p.records.map((r) => `<div><span class="tag">${esc(r.sourceId)}</span> ${esc(r.title.slice(0, 160))} ${r.status ? `– ${esc(r.status)}` : ''} ${docsLinks(r.docs)}</div>`).join('')}
          ${p.notes ? `<div>${esc(p.notes)}</div>` : ''}
        </div>
      </article>`;
    })
    .join('');
  document.querySelectorAll('.project').forEach((el) =>
    el.addEventListener('click', () => {
      el.classList.toggle('active');
      const p = data.projects.find((x) => x.id === el.dataset.id);
      if (map && p?.location) map.flyTo({ center: [p.location.lng, p.location.lat], zoom: 9 });
    }),
  );
}

function renderEvents() {
  const only = $('#only-relevant').checked;
  const evs = data.events.filter((e) => !only || e.projectIds?.length || e.discovered);
  $('#events').innerHTML = evs.length
    ? evs
        .slice(0, 200)
        .map(
          (e) => `<li class="${e.projectIds?.length ? 'hit' : ''}">
        <div class="row1"><span class="tag ${e.kind}">${e.initial ? 'baseline' : e.kind}</span>
          ${e.projectNames?.map((n) => `<span class="tag proj">${esc(n)}</span>`).join('') ?? ''}
          ${e.discovered ? '<span class="tag proj">discovered</span>' : ''}
          <span class="when" style="margin-left:auto">${ago(e.at)}</span></div>
        <div class="title">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</div>
        <div class="sub">${esc(e.sourceName)}${e.status ? ` · ${esc(e.status)}` : ''}${
            e.changes?.length ? ` · ${e.changes.map((c) => `${esc(c.field)}: ${esc(c.from)} → ${esc(c.to)}`).join('; ')}` : ''
          }</div></li>`,
        )
        .join('')
    : '<li class="empty">No activity yet. Changes appear here after the second run of each source.</li>';
}

function renderHearings() {
  const q = $('#hearing-filter').value.trim().toLowerCase();
  const list = data.hearings.filter((h) => !q || h.title.toLowerCase().includes(q));
  const today = new Date().toISOString().slice(0, 10);
  // Upcoming first (soonest first), then past (most recent first).
  const upcoming = list.filter((h) => h.date && h.date >= today);
  const rest = list.filter((h) => !h.date || h.date < today).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  $('#hearings').innerHTML = [...upcoming, ...rest]
    .slice(0, 150)
    .map(
      (h) => `<li class="${h.past ? 'past' : ''} ${h.projectIds?.length || h.discovered ? 'hit' : ''}">
      <div class="row1"><span class="when">${fmtDate(h.date)}</span><span class="title">${esc(h.title)}</span></div>
      <div class="sub">${docsLinks(h.docs)}</div></li>`,
    )
    .join('') || '<li class="empty">No hearings loaded.</li>';
}

function renderDiscovered() {
  $('#discovered').innerHTML =
    data.discovered
      .map(
        (r) => `<li><div class="title">${esc(r.title)}</div>
      <div class="sub">${esc(r.sourceName)}${r.status ? ` · ${esc(r.status)}` : ''} ${docsLinks(r.docs)}</div></li>`,
      )
      .join('') || '<li class="empty">Nothing new outside the watchlist.</li>';
}

function renderSources() {
  $('#sources').innerHTML = data.sources
    .map(
      (s) => `<tr><td><span class="pill ${s.health}">${s.health}</span></td>
      <td><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>
        ${s.error ? `<div class="err">${esc(s.error)}</div>` : s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</td>
      <td class="note">${s.recordCount ?? '–'} rec<br>${ago(s.lastOk)}</td></tr>`,
    )
    .join('');
}

function renderMap() {
  if (!window.maplibregl) return;
  if (!map) {
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [75.4, 19.0],
      zoom: 5.6,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  }
  for (const p of data.projects) {
    if (!p.location || markers[p.id]) continue;
    const el = document.createElement('div');
    el.className = `marker ${p.verified ? '' : 'unverified'}`;
    const stages = Object.entries(p.tracks).map(([t, v]) => `${t}: ${esc(v.stage)}`).join('<br>') || 'No portal records yet';
    markers[p.id] = new maplibregl.Marker({ element: el })
      .setLngLat([p.location.lng, p.location.lat])
      .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(`<b>${esc(p.name)}</b><br>${p.capacityMW ?? '?'} MW · ${esc(p.developer ?? '')}<br>${stages}`))
      .addTo(map);
  }
}

$('#only-relevant').addEventListener('change', renderEvents);
$('#hearing-filter').addEventListener('input', renderHearings);
load().catch((e) => {
  document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="empty" style="grid-column:1/-1">${esc(e.message)}</p>`);
});
setInterval(() => load().catch(() => {}), 5 * 60_000);

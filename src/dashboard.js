// Builds data/dashboard.json – everything the web UI needs in one file.
import * as store from './lib/store.js';
import { TRACKS, stageIndex } from './lib/stages.js';
import { matchProjects, isDiscovery } from './lib/match.js';

function health(source, st, now) {
  if (!source.enabled) return 'DISABLED';
  if (!st?.lastRun) return 'NEVER';
  if (st.status === 'ERROR') return 'ERROR';
  if (st.status === 'SKIPPED') return 'SKIPPED';
  const age = (now - Date.parse(st.lastOk)) / 3600_000;
  return age > (source.refreshHours ?? 24) * 2 ? 'STALE' : 'OK';
}

export async function buildDashboard() {
  const cfg = await store.loadConfig();
  const state = await store.loadState();
  const events = await store.loadEvents();
  const now = Date.now();

  const records = [];
  for (const s of cfg.sources) {
    const snap = await store.loadSnapshot(s.id);
    for (const r of Object.values(snap?.records ?? {})) {
      // Re-match against the current watchlist so config edits show up without refetching.
      const projectIds = matchProjects(r, cfg.projects);
      records.push({ ...r, projectIds, discovered: !projectIds.length && isDiscovery(r, cfg.discovery), sourceName: s.name });
    }
  }

  const projects = cfg.projects.map((p) => {
    const mine = records.filter((r) => r.projectIds?.includes(p.id));
    const tracks = {};
    for (const r of mine) {
      if (!r.track || !r.stage) continue;
      const cur = tracks[r.track];
      if (!cur || stageIndex(r.track, r.stage) > stageIndex(r.track, cur.stage))
        tracks[r.track] = { stage: r.stage, outcome: r.outcome, sourceId: r.sourceId, date: r.date, title: r.title, url: r.url };
    }
    const evs = events.filter((e) => e.projectIds?.includes(p.id));
    return {
      ...p,
      tracks,
      records: mine
        .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
        .map(({ text, fields, ...r }) => r),
      lastEventAt: evs.at(-1)?.at ?? null,
    };
  });

  const today = new Date().toISOString().slice(0, 10);
  const hearings = records
    .filter((r) => r.sourceId === 'mpcb-hearings-upcoming')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(({ text, fields, ...r }) => ({ ...r, past: r.date && r.date < today }));

  const dashboard = {
    generatedAt: new Date().toISOString(),
    tracks: TRACKS,
    projects,
    sources: cfg.sources.map((s) => {
      const st = state.sources[s.id] ?? {};
      return { id: s.id, name: s.name, url: s.url, connector: s.connector, refreshHours: s.refreshHours, health: health(s, st, now), ...st };
    }),
    events: events
      .filter((e) => !e.initial || e.projectIds?.length || e.discovered)
      .slice(-400)
      .reverse(),
    discovered: records.filter((r) => r.discovered).map(({ text, ...r }) => r),
    hearings,
  };
  await store.writeJson(store.paths.dashboard(), dashboard);
  return dashboard;
}

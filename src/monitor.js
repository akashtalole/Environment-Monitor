import connectors from './connectors/index.js';
import { matchProjects, isDiscovery } from './lib/match.js';
import { classify, trackFromProposalNo } from './lib/stages.js';
import { hash } from './lib/util.js';
import * as store from './lib/store.js';
import { notify } from './lib/notify.js';
import { buildDashboard } from './dashboard.js';

const DIFF_FIELDS = ['title', 'status', 'stage', 'outcome', 'date', 'proposalNo', 'docs'];

function enrich(rec, source, projects, discovery) {
  const projectIds = matchProjects(rec, projects);
  const c = classify(rec.status, source.connector === 'mpcb' && /hearing/i.test(source.id) ? 'public hearing' : '', rec.fields?.clearanceType);
  const track = trackFromProposalNo(rec.proposalNo ?? '') ?? c.track;
  const { raw, ...slim } = rec; // raw API payloads are kept only for the parivesh probe
  return {
    ...slim,
    sourceId: source.id,
    projectIds,
    discovered: !projectIds.length && isDiscovery(rec, discovery),
    track,
    stage: c.stage,
    outcome: c.outcome,
    rawFieldCount: raw ? Object.keys(raw).length : undefined,
  };
}

const canon = (rec, f) => (f === 'docs' ? (rec.docs ?? []).map((d) => d.url).sort().join(' ') : rec[f] ?? null);

export function diffRecords(prev, next, { source, projectsById, at, initial }) {
  const events = [];
  const mk = (rec, kind, changes = []) => ({
    id: hash(source.id, rec.key, kind, at, JSON.stringify(changes)),
    at,
    sourceId: source.id,
    sourceName: source.name,
    kind,
    recordKey: rec.key,
    title: rec.title,
    url: rec.url,
    proposalNo: rec.proposalNo ?? null,
    status: rec.status ?? null,
    track: rec.track ?? null,
    stage: rec.stage ?? null,
    projectIds: rec.projectIds,
    projectNames: rec.projectIds.map((id) => projectsById[id]?.name ?? id),
    discovered: rec.discovered,
    changes,
    initial,
  });
  for (const rec of Object.values(next)) {
    const old = prev?.[rec.key];
    if (!old) {
      events.push(mk(rec, 'new'));
      continue;
    }
    const changes = DIFF_FIELDS.filter((f) => String(canon(old, f)) !== String(canon(rec, f))).map((f) => ({
      field: f,
      from: f === 'docs' ? `${old.docs?.length ?? 0} docs` : old[f] ?? null,
      to: f === 'docs' ? `${rec.docs?.length ?? 0} docs` : rec[f] ?? null,
    }));
    if (changes.length) events.push(mk(rec, 'changed', changes));
  }
  for (const old of Object.values(prev ?? {})) {
    if (!next[old.key] && (old.projectIds?.length || old.discovered)) events.push(mk(old, 'removed'));
  }
  return events;
}

function isDue(source, st, now) {
  if (!st?.lastRun) return true;
  return now - Date.parse(st.lastRun) >= (source.refreshHours ?? 24) * 3600_000 * 0.9;
}

/**
 * @param {{only?: string[], force?: boolean, log?: Console, notifyEnabled?: boolean}} opts
 */
export async function runMonitor({ only, force = false, log = console, notifyEnabled = true } = {}) {
  const cfg = await store.loadConfig();
  const state = await store.loadState();
  const projectsById = Object.fromEntries(cfg.projects.map((p) => [p.id, p]));
  const now = Date.now();
  const allEvents = [];

  for (const source of cfg.sources) {
    if (only?.length && !only.includes(source.id)) continue;
    if (!source.enabled && !only?.length) continue;
    const st = (state.sources[source.id] ??= {});
    if (!force && !only?.length && !isDue(source, st, now)) {
      log.info(`- ${source.id}: not due`);
      continue;
    }
    const connector = connectors[source.connector];
    if (!connector) {
      log.warn(`- ${source.id}: unknown connector "${source.connector}"`);
      continue;
    }
    log.info(`- ${source.id}: running…`);
    const started = Date.now();
    const at = new Date().toISOString();
    st.lastRun = at;
    try {
      const result = await connector.run({ source, projects: cfg.projects, discovery: cfg.discovery, log });
      const next = {};
      for (const r of result.records) next[r.key] = enrich(r, source, cfg.projects, cfg.discovery);
      const prevSnap = await store.loadSnapshot(source.id);
      const events = diffRecords(prevSnap?.records, next, { source, projectsById, at, initial: !prevSnap });
      await store.saveSnapshot(source.id, { sourceId: source.id, fetchedAt: at, records: next });
      Object.assign(st, {
        status: result.skipped ? 'SKIPPED' : 'OK',
        lastOk: at,
        error: null,
        note: result.skipped ?? (result.warnings?.length ? result.warnings.slice(0, 3).join('; ') : null),
        recordCount: Object.keys(next).length,
        relevantCount: Object.values(next).filter((r) => r.projectIds.length || r.discovered).length,
        durationMs: Date.now() - started,
      });
      allEvents.push(...events);
      log.info(`  ${st.status}: ${st.recordCount} records, ${events.filter((e) => !e.initial).length} new events${prevSnap ? '' : ' (baseline)'}`);
    } catch (e) {
      Object.assign(st, { status: 'ERROR', error: e.message, durationMs: Date.now() - started });
      log.warn(`  ERROR: ${e.message}`);
    }
  }

  await store.saveState(state);
  await store.appendEvents(allEvents);
  await buildDashboard();
  if (notifyEnabled) await notify(allEvents, log);
  return { events: allEvents, state };
}

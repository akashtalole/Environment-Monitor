import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = process.env.ENVMON_DATA_DIR || path.join(ROOT, 'data');
const MAX_EVENTS = 5000;

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export const paths = {
  state: () => path.join(DATA_DIR, 'state.json'),
  events: () => path.join(DATA_DIR, 'events.json'),
  snapshot: (sourceId) => path.join(DATA_DIR, 'snapshots', `${sourceId}.json`),
  raw: (sourceId, name) => path.join(DATA_DIR, 'raw', sourceId, name),
  dashboard: () => path.join(DATA_DIR, 'dashboard.json'),
};

export async function loadConfig() {
  const projects = await readJson(path.join(ROOT, 'config/projects.json'), { projects: [] });
  const sources = await readJson(path.join(ROOT, 'config/sources.json'), { sources: [] });
  // Proposal numbers found inside a project's documents are tracked automatically.
  const analytics = await readJson(path.join(DATA_DIR, 'analytics.json'), null);
  for (const a of analytics?.projects ?? []) {
    const p = projects.projects.find((x) => x.id === a.id);
    if (!p) continue;
    const ids = ((p.ids ??= {}).parivesh ??= []);
    for (const n of a.references?.proposals ?? []) if (!ids.includes(n)) (ids.push(n), (p.idsFromDocuments ??= []).push(n));
  }
  return { ...projects, sources: sources.sources };
}

export const loadState = () => readJson(paths.state(), { sources: {} });
export const saveState = (s) => writeJson(paths.state(), s);
export const loadSnapshot = (id) => readJson(paths.snapshot(id), null);
export const saveSnapshot = (id, snap) => writeJson(paths.snapshot(id), snap);
export const loadEvents = () => readJson(paths.events(), []);

export async function appendEvents(newEvents) {
  if (!newEvents.length) return;
  const events = await loadEvents();
  events.push(...newEvents);
  events.sort((a, b) => a.at.localeCompare(b.at));
  await writeJson(paths.events(), events.slice(-MAX_EVENTS));
}

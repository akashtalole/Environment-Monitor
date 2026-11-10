#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runMonitor } from './monitor.js';
import { buildDashboard } from './dashboard.js';
import * as store from './lib/store.js';
import { loadPlaywright, searchParivesh } from './connectors/parivesh-track.js';
import { runAnalysis } from './analysis/run.js';
import { buildStatewide } from './statewide/build.js';
import { buildBonds } from './bonds/build.js';

const HELP = `Environment Monitor – track EC / EIA / FC / WL / CRZ / PCB approvals

Usage:
  envmon run [--force] [--source id,id] [--no-notify] [--analyze]
                                                         Run all due sources (or the listed ones)
  envmon track <proposal-no|keyword> [--headed]         One-off PARIVESH "Track Your Proposal" lookup
  envmon probe <proposal-no|keyword> [--headed]         Dump PARIVESH network calls for tuning the connector
  envmon add-id <project-id> <id> [--portal parivesh|ecLegacy|fcLegacy]
                                                         Attach a proposal number to a watchlist project
  envmon analyze [--force] [--no-llm] [--project id,id]  Extract impact data from report PDFs → data/analytics.json
                                                         (uses Claude too when ANTHROPIC_API_KEY is set)
  envmon statewide                                       Build data/statewide.json for the Maharashtra dashboard
  envmon bonds [--dir path]                              Rebuild electoral bond reference data (verified against ECI totals)
  envmon list                                            Watchlist and source health
  envmon dashboard                                       Rebuild data/dashboard.json

Examples:
  envmon track IA/MH/RIV/123456/2025
  envmon run --source mpcb-hearings-upcoming,mpcb-cac
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: 'boolean', default: false },
    source: { type: 'string' },
    'no-notify': { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    portal: { type: 'string', default: 'parivesh' },
    help: { type: 'boolean', short: 'h' },
    analyze: { type: 'boolean', default: false },
    'no-llm': { type: 'boolean', default: false },
    project: { type: 'string' },
    dir: { type: 'string' },
  },
});
const [cmd, ...args] = positionals;

async function pariveshLookup(query, { dump }) {
  const cfg = await store.loadConfig();
  const source = cfg.sources.find((s) => s.connector === 'parivesh-track');
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !flags.headed, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const r = await searchParivesh(browser, source, query);
    if (dump) {
      const file = store.paths.raw('parivesh-track', `probe-${Date.now()}.json`);
      await store.writeJson(file, { query, at: new Date().toISOString(), exchanges: r.exchanges, tables: r.tables, records: r.records });
      console.log(`Network calls (${r.exchanges.length}):`);
      for (const e of r.exchanges) console.log(`  [${e.phase}] ${e.method} ${e.status} ${e.url}${e.postData ? `  body=${e.postData.slice(0, 120)}` : ''}`);
      console.log(`\nFull dump: ${path.relative(process.cwd(), file)}`);
    }
    console.log(`\n${r.records.length} record(s) for "${query}":`);
    for (const rec of r.records)
      console.log(`\n• ${rec.proposalNo ?? '(no number)'} – ${rec.title}\n  Status: ${rec.status ?? '?'}\n  ${Object.entries(rec.fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n  ')}`);
  } finally {
    await browser.close();
  }
}

async function addId(projectId, id) {
  const file = path.join(store.ROOT, 'config/projects.json');
  const cfg = await store.readJson(file);
  const p = cfg.projects.find((x) => x.id === projectId);
  if (!p) throw new Error(`No project "${projectId}". Known: ${cfg.projects.map((x) => x.id).join(', ')}`);
  const list = ((p.ids ??= {})[flags.portal] ??= []);
  if (!list.includes(id)) list.push(id);
  await store.writeJson(file, cfg);
  console.log(`Added ${id} to ${projectId}.ids.${flags.portal}`);
}

async function list() {
  const d = await buildDashboard();
  console.log('Watchlist:');
  for (const p of d.projects) {
    const tr = Object.entries(p.tracks).map(([t, v]) => `${t}: ${v.stage}${v.outcome ? ` (${v.outcome})` : ''}`).join(', ') || 'no portal records yet';
    console.log(`  ${p.verified ? '✓' : '?'} ${p.name} – ${p.capacityMW ?? '?'} MW, ${p.districts.join('/')}  [${tr}]`);
  }
  console.log('\nSources:');
  for (const s of d.sources) console.log(`  ${s.health.padEnd(8)} ${s.id.padEnd(26)} ${s.lastRun ?? 'never'}${s.error ? `  ${s.error}` : ''}`);
}

try {
  if (flags.help || !cmd) console.log(HELP);
  else if (cmd === 'run') {
    await runMonitor({ force: flags.force, only: flags.source?.split(',').map((s) => s.trim()), notifyEnabled: !flags['no-notify'] });
    if (flags.analyze) await runAnalysis({ llm: flags['no-llm'] ? false : undefined });
    await buildStatewide();
  } else if (cmd === 'analyze')
    await runAnalysis({ force: flags.force, llm: flags['no-llm'] ? false : undefined, only: flags.project?.split(',').map((s) => s.trim()) });
  else if (cmd === 'track' || cmd === 'probe') {
    if (!args[0]) throw new Error(`Usage: envmon ${cmd} <proposal-no|keyword>`);
    await pariveshLookup(args.join(' '), { dump: cmd === 'probe' });
  } else if (cmd === 'add-id') await addId(args[0], args[1]);
  else if (cmd === 'statewide') await buildStatewide();
  else if (cmd === 'bonds') await buildBonds({ dir: flags.dir });
  else if (cmd === 'list') await list();
  else if (cmd === 'dashboard') console.log(`Wrote ${store.paths.dashboard()} (${(await buildDashboard()).projects.length} projects)`);
  else console.log(HELP);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
}

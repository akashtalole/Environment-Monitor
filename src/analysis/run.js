// `envmon analyze`: collect report PDFs linked to watchlist projects, extract impact data
// (rules always, Claude when configured), and write data/analytics.json.
import path from 'node:path';
import * as store from '../lib/store.js';
import { matchProjects } from '../lib/match.js';
import { toIsoDate } from '../lib/util.js';
import { downloadPdf, extractPages, textStats } from './pdf.js';
import { extractWithRules, findReferences } from './rules.js';
import { extractWithClaude, llmEnabled, llmMetrics, LLM_MODEL } from './llm.js';
import { mergeMetrics, deriveMetrics, riskFlags, impactScores, peerStats, completeness } from './analytics.js';

export const EXTRACTOR_VERSION = 3; // bump when rules change so cached rule output is refreshed
const extractionFile = (sha) => path.join(store.DATA_DIR, 'extractions', `${sha.slice(0, 20)}.json`);

const isPdf = (url) => /\.pdf($|\?)/i.test(url) || /\/files\//.test(url);

/** Every PDF attached to a record that matches a watchlist project, plus manual `documents`. */
export async function collectDocuments(cfg) {
  const docs = new Map();
  const add = (d) => {
    const prev = docs.get(d.url);
    if (prev) prev.projectIds = [...new Set([...prev.projectIds, ...d.projectIds])];
    else docs.set(d.url, d);
  };
  for (const s of cfg.sources) {
    const snap = await store.loadSnapshot(s.id);
    for (const r of Object.values(snap?.records ?? {})) {
      const projectIds = matchProjects(r, cfg.projects);
      if (!projectIds.length) continue;
      for (const d of r.docs ?? [])
        if (d.url && isPdf(d.url))
          add({ url: d.url, label: d.label, projectIds, sourceId: s.id, recordTitle: r.title, date: r.date ?? null, caFile: s.caFile });
    }
  }
  for (const p of cfg.projects)
    for (const d of p.documents ?? []) add({ url: d.url, label: d.label ?? 'Document', projectIds: [p.id], sourceId: 'manual', date: toIsoDate(d.date) });
  return [...docs.values()];
}

export function guessDocumentType(label = '', url = '', firstPage = '') {
  const s = `${label} ${url} ${firstPage.slice(0, 600)}`;
  if (/executive[\s_-]*summary/i.test(s)) return 'executive_summary';
  if (/hearing[\s_-]*order|office[\s_-]*order/i.test(s)) return 'public_hearing_order';
  if (/(public[\s_-]*hearing).*(minutes|proceedings)|\bMoM\b/i.test(s)) return 'public_hearing_minutes';
  if (/\b(add|advert|advertisement|notice)\b/i.test(s)) return 'advertisement';
  if (/minutes/i.test(s)) return 'committee_minutes';
  if (/agenda/i.test(s)) return 'committee_agenda';
  if (/terms of reference|\bToR\b.*letter/i.test(s)) return 'tor_letter';
  if (/environment(al)? clearance.*(granted|accorded)/i.test(s)) return 'ec_letter';
  if (/EIA|impact assessment/i.test(s)) return 'eia_report';
  return 'other';
}

/** Extracts one document, reusing the cached result when nothing would change. */
export async function analyzeDocument(doc, { useLlm, force = false, log = console, client } = {}) {
  const dl = await downloadPdf(doc.url, { caFile: doc.caFile });
  const cacheFile = extractionFile(dl.sha256);
  const cached = await store.readJson(cacheFile, null);
  const cacheOk = cached && cached.extractorVersion === EXTRACTOR_VERSION && (cached.llm || !useLlm);
  if (cacheOk && !force) return { ...cached, url: doc.url, label: doc.label, projectIds: doc.projectIds, date: doc.date };

  const { pages, engine } = await extractPages(dl.file);
  const stats = textStats(pages);
  const rules = stats.scanned ? { metrics: {}, empComponents: [] } : extractWithRules(pages);
  const result = {
    extractorVersion: EXTRACTOR_VERSION,
    sha256: dl.sha256,
    bytes: dl.bytes,
    engine,
    ...stats,
    extractedAt: new Date().toISOString(),
    documentType: guessDocumentType(doc.label, doc.url, pages[0] ?? ''),
    references: findReferences(pages),
    ruleMetrics: rules.metrics,
    empComponents: rules.empComponents,
    llm: cached?.llm ?? null,
    llmError: null,
  };
  if (useLlm && (!cached?.llm || force)) {
    try {
      log.info(`    Claude (${LLM_MODEL}) reading ${doc.label}…`);
      const r = await extractWithClaude({ file: dl.file, bytes: dl.bytes, pages, scanned: stats.scanned }, { client });
      result.llm = { model: r.model, chunks: r.chunks, output: r.output, usage: r.usage ?? null };
    } catch (e) {
      result.llmError = e.message;
      log.warn(`    Claude extraction failed: ${e.message}`);
    }
  }
  if (result.llm?.output?.documentType) result.documentType = result.llm.output.documentType;
  await store.writeJson(cacheFile, result);
  return { ...result, url: doc.url, label: doc.label, projectIds: doc.projectIds, date: doc.date };
}

export function buildProjectAnalytics(project, extractions, cfgA, wg = null) {
  // The same PDF is often posted twice (e.g. "_1.pdf"): analyse each file once.
  const unique = [...new Map(extractions.map((e) => [e.sha256, e])).values()];
  const withMetrics = unique.map((e) => ({ ...e, llmMetrics: e.llm ? llmMetrics(e.llm.output) : null }));
  const { metrics, conflicts } = mergeMetrics(withMetrics, cfgA.flags.conflictTolerance);
  const derived = deriveMetrics(metrics);
  const llmOut = withMetrics.map((e) => e.llm?.output).filter(Boolean);
  const list = (k) => llmOut.flatMap((o) => o[k] ?? []);
  const threatenedSpeciesList = [...new Map(list('threatenedSpeciesList').map((s) => [s.name.toLowerCase(), s])).values()];
  const unreadable = unique.filter((e) => e.scanned && !e.llm).map((e) => ({ label: e.label, url: e.url }));
  const references = {
    proposals: [...new Set([...unique.flatMap((e) => e.references?.proposals ?? []), ...llmOut.flatMap((o) => o.references.proposalNumbers)].map((s) => s.toUpperCase()))],
    files: [...new Set([...unique.flatMap((e) => e.references?.files ?? []), ...llmOut.flatMap((o) => o.references.fileNumbers)])],
    torIds: [...new Set(unique.flatMap((e) => e.references?.torIds ?? []))],
  };
  const emp = unique.map((e) => e.empComponents).filter((c) => c?.length).sort((a, b) => b.length - a.length)[0] ?? [];
  return {
    id: project.id,
    name: project.name,
    capacityMW: metrics.capacityMW?.value ?? project.capacityMW ?? null,
    metrics,
    derived,
    scores: impactScores(metrics, derived, cfgA, { threatenedSpeciesList }),
    flags: riskFlags(metrics, derived, cfgA, {
      threatenedSpeciesList, conflicts, unreadable,
      wgeepZones: (project.talukas ?? []).map((t) => wg?.talukas.find((r) => [r.taluka, r.wgeepName].some((n) => n.toLowerCase() === t.toLowerCase()))).filter(Boolean),
      wgeepGuidelines: wg?.guidelines, wgeepUrl: wg?.sources.wgeep.url,
    }),
    completeness: completeness(metrics),
    conflicts,
    empComponents: emp,
    species: { scheduleI: [...new Set(list('scheduleISpeciesList'))], threatened: threatenedSpeciesList },
    keyImpacts: list('keyImpacts'),
    publicConcerns: list('publicConcerns'),
    conditions: list('conditions'),
    summaries: llmOut.map((o) => o.summary),
    references,
    documents: unique.map((e) => ({
      url: e.url, label: e.label, documentType: e.documentType, pageCount: e.pageCount, scanned: e.scanned, date: e.date,
      ruleMetricCount: Object.keys(e.ruleMetrics ?? {}).length, llm: e.llm ? e.llm.model : null, llmError: e.llmError ?? null,
    })),
  };
}

export async function runAnalysis({ force = false, llm, only, log = console } = {}) {
  const cfg = await store.loadConfig();
  const cfgA = await store.readJson(path.join(store.ROOT, 'config/analytics.json'));
  const wg = await store.readJson(path.join(store.ROOT, 'config/western-ghats.json'), null);
  const useLlm = llm ?? llmEnabled();
  const docs = (await collectDocuments(cfg)).filter((d) => !only?.length || d.projectIds.some((id) => only.includes(id)));
  log.info(`Analysing ${docs.length} document(s)${useLlm ? ` with rules + Claude (${LLM_MODEL})` : ' with rules only (set ANTHROPIC_API_KEY to add Claude)'}`);

  const extractions = [];
  const failures = [];
  for (const d of docs) {
    try {
      const ex = await analyzeDocument(d, { useLlm, force, log });
      log.info(`  ✓ ${d.label} – ${ex.pageCount} pages, ${Object.keys(ex.ruleMetrics).length} rule metrics${ex.llm ? ', Claude ✓' : ''}${ex.scanned ? ' (scanned)' : ''}`);
      extractions.push(ex);
    } catch (e) {
      failures.push({ url: d.url, label: d.label, projectIds: d.projectIds, error: e.message });
      log.warn(`  ✗ ${d.label}: ${e.message}`);
    }
  }

  const projects = cfg.projects
    .map((p) => buildProjectAnalytics(p, extractions.filter((e) => e.projectIds.includes(p.id)), cfgA, wg))
    .filter((p) => p.documents.length);
  const analytics = {
    generatedAt: new Date().toISOString(),
    method: useLlm ? `rules + ${LLM_MODEL}` : 'rules',
    config: cfgA,
    projects,
    peers: peerStats(projects),
    failures,
  };
  await store.writeJson(path.join(store.DATA_DIR, 'analytics.json'), analytics);
  log.info(`Wrote data/analytics.json – ${projects.length} project(s) with documents`);
  return analytics;
}

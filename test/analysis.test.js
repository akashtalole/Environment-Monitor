import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractWithRules, parseEmpTable, stripRepeatedLines, findReferences, toCrore } from '../src/analysis/rules.js';
import { mergeMetrics, deriveMetrics, riskFlags, impactScores, peerStats } from '../src/analysis/analytics.js';
import { extractWithClaude, llmMetrics, mergeOutputs, ExtractionSchema } from '../src/analysis/llm.js';
import { guessDocumentType } from '../src/analysis/run.js';
import { METRICS } from '../src/analysis/metrics.js';

const cfgA = JSON.parse(await fs.readFile(new URL('../config/analytics.json', import.meta.url), 'utf8'));

// Sentences in the style of real MoEFCC executive summaries (taken from the Maharashtra PSP reports).
const PAGES = [
  `Saidongar 2 – Maval Open Loop Pumped Storage Project (1200 MW), Pune & Raigad
Accordingly, the project has obtained Fresh ToR on 18.02.2025 from 23rd ToR EAC Meeting.
The proposal number uploaded on PARIVESH Portal is FP/MH/HYD/IRRIG/556376/2025.
outside the notified Eco-sensitive Zone of the nearest protected area. The aerial
distance from the project site to the Bhimashankar Wildlife Sanctuary (WLS) is
approximately 14.45 km.`,
  `Saidongar 2 – Maval Open Loop Pumped Storage Project (1200 MW), Pune & Raigad
The gross storage capacities of upper and lower reservoirs is 7.22 MCM & 28.96 MCM respectively.
  3.     Daily hours of generation                       6 Hr.
The total land requirement for these activities is estimated to be approximately 141.44 ha (35.6 ha forest land and
105.84 ha of non-forest land). The total muck generation would be of the order 58.06 Lakh cum.
Project Cost: The total project cost has been estimated at ₹6,088.67 Crores.`,
  `Saidongar 2 – Maval Open Loop Pumped Storage Project (1200 MW), Pune & Raigad
The proposed project has been carefully designed to escape the ecologically sensitive areas
but falls in draft notification for Western Ghats ESA. This project will require 35.60 ha Forest
land and cutting of about 9,554 trees along with the shrubs. Among the reported mammals, 8 species
are categorised as schedule I species. The affected villages comprise 505 households and a
population of 2,653. The total percentage of Scheduled Tribe population in the study area is 64.2%.
The Raigad and Pune district area falls under Seismic zone-III as per BIS.`,
  `Saidongar 2 – Maval Open Loop Pumped Storage Project (1200 MW), Pune & Raigad
                     Table 3: Cost for Implementing Environmental Management Plan
    S. No.                      Component of EMP        Capital Cost (Rs. in lakh)   Year 1   Total Cost
       1   Catchment Area Treatment Plan                          175.12   0.00     175.12
       2   Biodiversity Conservation & Wildlife Management Plan   209.00   0.00     209.00
       3   Muck Dumping and Management Plan                        22.68  93.67     626.88
       4   CER/Local Area Development Plan                       1000.00   0.00    1000.00
                                       Total                     1406.80  93.67    2011.00`,
];

test('rules extract the core impact metrics with page evidence', () => {
  const { metrics: m, empComponents } = extractWithRules(PAGES);
  const v = (k) => m[k]?.value;
  assert.equal(v('capacityMW'), 1200);
  assert.equal(v('storageHours'), 6);
  assert.equal(v('projectCostCr'), 6088.67);
  assert.equal(v('totalLandHa'), 141.44);
  assert.equal(v('forestLandHa'), 35.6);
  assert.equal(v('nonForestLandHa'), 105.84);
  assert.equal(v('treesFelled'), 9554);
  assert.equal(v('muckLakhCum'), 58.06);
  assert.equal(v('upperReservoirMCM'), 7.22);
  assert.equal(v('lowerReservoirMCM'), 28.96);
  assert.equal(v('protectedAreaKm'), 14.45);
  assert.equal(v('nearestProtectedArea'), 'Bhimashankar Wildlife Sanctuary');
  assert.equal(v('westernGhatsESA'), true, '"notification" must not read as "not"');
  assert.equal(v('insideESZ'), false);
  assert.equal(v('scheduleISpecies'), 8);
  assert.equal(v('affectedHouseholds'), 505);
  assert.equal(v('affectedPopulation'), 2653);
  assert.equal(v('tribalSharePct'), 64.2);
  assert.equal(v('seismicZone'), 'III');
  assert.equal(v('torDate'), '2025-02-18');
  assert.equal(v('loopType'), 'open loop');
  assert.equal(m.treesFelled.page, 3);
  assert.match(m.treesFelled.quote, /9,554 trees/);
  assert.equal(m.treesFelled.method, 'rule');
  // EMP table (lakh → crore)
  assert.equal(empComponents.length, 4);
  assert.equal(v('empCapitalCr'), 14.068);
  assert.equal(v('empTotalCr'), 20.11);
  assert.equal(v('cerCr'), 10);
});

test('capacity prefers the stated total over repeated unit sizes', () => {
  const { metrics } = extractWithRules(['The total installed capacity of proposed Shirawta PSP is 1800 MW (5 x 300 MW + 2 x 150 MW). Units 300 MW, 300 MW, 300 MW.']);
  assert.equal(metrics.capacityMW.value, 1800);
});

test('running headers are removed before matching', () => {
  const body = (i) => Array.from({ length: 12 }, (_, j) => `Paragraph ${j} of page ${i} discussing impacts.`).join('\n');
  const pages = Array.from({ length: 5 }, (_, i) => `Draft EIA & EMP Report\n${body(i)}\nAA/W&E/2656/EIA/R0 ${i + 1}`);
  const out = stripRepeatedLines(pages);
  assert.ok(out.every((p) => !p.includes('Draft EIA') && !p.includes('AA/W&E')));
  assert.ok(out[2].includes('Paragraph 11 of page 2'));
});

test('references: multi-segment PARIVESH numbers, MoEFCC file numbers, ToR ids', () => {
  const r = findReferences(['FP/MH/HYD/IRRIG/556376/2025 and IA/MH/RIV/123/2024; File No: J-12011/05/2025-IA. I (R); ToR TO24A0000MH5642838A']);
  assert.deepEqual(r.proposals, ['FP/MH/HYD/IRRIG/556376/2025', 'IA/MH/RIV/123/2024']);
  assert.equal(r.files.length, 1);
  assert.deepEqual(r.torIds, ['TO24A0000MH5642838A']);
  assert.equal(toCrore('93', 'Lakhs'), 0.93);
});

test('EMP table parser rejects tables without a total row', () => {
  assert.equal(parseEmpTable(['Component of EMP\n 1  Something   10.0\n 2  Other  5.0']), null);
});

test('merge prefers Claude, flags conflicts between documents', () => {
  const ex = [
    { documentType: 'executive_summary', label: 'ES', url: 'a', ruleMetrics: { forestLandHa: { value: 35.6, page: 2, quote: 'q', method: 'rule' } }, llmMetrics: { forestLandHa: { value: 35.6, page: 2, quote: 'q', method: 'llm' } } },
    { documentType: 'public_hearing_order', label: 'Order', url: 'b', ruleMetrics: { forestLandHa: { value: 60, page: 1, quote: 'q2', method: 'rule' } } },
  ];
  const { metrics, conflicts } = mergeMetrics(ex);
  assert.equal(metrics.forestLandHa.method, 'llm');
  assert.equal(metrics.forestLandHa.docLabel, 'ES');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].others[0].value, 60);
});

test('derived intensities, flags and screening index', () => {
  const { metrics: m } = extractWithRules(PAGES);
  const metrics = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, docLabel: 'ES' }]));
  const d = deriveMetrics(metrics);
  assert.equal(d.storageGWh, 7.2);
  assert.equal(d.forestHaPerMW, 0.0297);
  assert.equal(d.treesPerMW, 7.96);
  assert.equal(d.upperReservoirMCMPerGWh, 1.003);
  assert.equal(d.costCrPerMW, 5.074);

  const flags = riskFlags(metrics, d, cfgA, { threatenedSpeciesList: [{ name: 'Indian Softshell Turtle', status: 'EN' }] });
  const codes = flags.map((f) => f.code);
  for (const c of ['wg-esa', 'sch1', 'tribal', 'iucn', 'pa-near', 'forest']) assert.ok(codes.includes(c), c);
  assert.equal(flags[0].severity, 'high', 'sorted by severity');
  assert.ok(flags.find((f) => f.code === 'trees').evidence[0].quote.includes('9,554'));

  const s = impactScores(metrics, d, cfgA);
  assert.ok(s.overall > 0 && s.overall <= 100);
  for (const dim of Object.values(s.dimensions)) assert.ok(dim.score == null || (dim.score >= 0 && dim.score <= 100));
  assert.ok(s.coveragePct > 50);
});

test('peer stats rank projects (1 = lowest)', () => {
  const peers = peerStats([
    { id: 'a', metrics: { forestLandHa: { value: 35 } }, derived: { treesPerMW: 8 } },
    { id: 'b', metrics: { forestLandHa: { value: 160 } }, derived: { treesPerMW: null } },
    { id: 'c', metrics: { forestLandHa: { value: 60 } }, derived: {} },
  ]);
  assert.equal(peers.forestLandHa.median, 60);
  assert.deepEqual(peers.forestLandHa.rank, { a: 1, c: 2, b: 3 });
  assert.equal(peers.treesPerMW.n, 1);
});

test('document type guessing', () => {
  assert.equal(guessDocumentType('Executive Summary/CRZ Draft Notification'), 'executive_summary');
  assert.equal(guessDocumentType('Environmental Public Hearing Order'), 'public_hearing_order');
  assert.equal(guessDocumentType('Remarks/Advertisement'), 'advertisement');
});

// ---- Claude path with a mocked client --------------------------------------
function emptyOutput() {
  return {
    documentType: 'executive_summary', projectName: 'X PSP', proponent: 'Acme', summary: 's',
    metrics: Object.fromEntries(METRICS.map((m) => [m.key, { value: null, page: null, quote: null }])),
    references: { proposalNumbers: [], fileNumbers: [] }, scheduleISpeciesList: [], threatenedSpeciesList: [],
    keyImpacts: [], publicConcerns: [], conditions: [],
  };
}

test('Claude extraction sends the PDF with fallbacks and parses the result', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'envmon-')), 'doc.pdf');
  await fs.writeFile(file, '%PDF-1.4 test');
  const out = emptyOutput();
  out.metrics.treesFelled = { value: 9554, page: 12, quote: 'cutting of about 9,554 trees' };
  out.scheduleISpeciesList = ['Leopard', 'Indian Cobra'];
  assert.ok(ExtractionSchema.safeParse(out).success, 'fixture matches schema');
  let request;
  const client = { beta: { messages: { parse: async (req) => ((request = req), { stop_reason: 'end_turn', parsed_output: out, model: req.model, usage: {} }) } } };

  const r = await extractWithClaude({ file, bytes: 13, pages: ['p1'], scanned: true }, { client });
  assert.equal(request.model, 'claude-opus-5-5');
  assert.deepEqual(request.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(request.fallbacks, 'default');
  assert.equal(request.messages[0].content[0].type, 'document');
  assert.equal(request.messages[0].content[0].source.media_type, 'application/pdf');
  assert.equal(request.output_config.format.type, 'json_schema');
  const m = llmMetrics(r.output);
  assert.deepEqual(Object.keys(m), ['treesFelled']);
  assert.equal(m.treesFelled.method, 'llm');

  const refusing = { beta: { messages: { parse: async () => ({ stop_reason: 'refusal', stop_details: { category: 'bio' }, parsed_output: null }) } } };
  await assert.rejects(extractWithClaude({ file, bytes: 13, pages: ['p1'] }, { client: refusing }), /declined/);
});

test('chunked Claude results merge without duplicates', () => {
  const a = emptyOutput();
  const b = emptyOutput();
  a.metrics.forestLandHa = { value: 35.6, page: 2, quote: 'q' };
  b.metrics.forestLandHa = { value: 99, page: 40, quote: 'q' };
  b.metrics.treesFelled = { value: 10, page: 41, quote: 'q' };
  a.scheduleISpeciesList = ['Leopard'];
  b.scheduleISpeciesList = ['Leopard', 'Sloth Bear'];
  const m = mergeOutputs([a, b]);
  assert.equal(m.metrics.forestLandHa.value, 35.6);
  assert.equal(m.metrics.treesFelled.value, 10);
  assert.deepEqual(m.scheduleISpeciesList, ['Leopard', 'Sloth Bear']);
});

// PARIVESH 2.0 "Track Your Proposal" (Angular SPA). Its backend API is undocumented and
// changes, so instead of hard-coding endpoints we drive the real page in a headless
// browser, type the proposal number / keyword, and read both:
//   1. every JSON response the page receives (most reliable – full field set), and
//   2. the rendered result table (fallback).
// Endpoints seen are logged to data/raw/parivesh-track/endpoints.json, and `envmon probe`
// dumps the full network exchange so the connector can be tuned without guesswork.
import { createRequire } from 'node:module';
import path from 'node:path';
import { writeJson, readJson, paths } from '../lib/store.js';
import { clean, hash, toIsoDate, PROPOSAL_NO_RE } from '../lib/util.js';

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const dirs = [...(process.env.NODE_PATH?.split(path.delimiter) ?? []), '/opt/node-tools/node_modules', '/usr/lib/node_modules'];
    for (const d of dirs.filter(Boolean)) {
      try {
        return createRequire(path.join(d, 'noop.js'))('playwright');
      } catch {}
    }
    throw new Error('Playwright is not installed. Run: npm install playwright && npx playwright install chromium');
  }
}

// ---------- JSON extraction ----------

const FIELD_PATTERNS = {
  proposalNo: /^(proposal_?no|proposal_?number|proposalNo|proposal_?code|sw_?no|single_?window.*no|application_?no|proposal_?id_?no)$/i,
  title: /^(project_?name|proposal_?name|name_?of_?(the_?)?project|projectName|proposalName|proposal_?title)$/i,
  status: /^(status|proposal_?status|current_?status|proposalStatus|current_?stage|stage|status_?name|statusName)$/i,
  state: /^(state|state_?name|stateName|project_?state)$/i,
  district: /^(district|district_?name|districtName)$/i,
  company: /^(proponent|proponent_?name|user_?agency|user_?agency_?name|company|company_?name|applicant_?name|organization_?name|organisation)$/i,
  clearanceType: /^(clearance_?type|clearanceType|major_?clearance_?type|workgroup|work_?group|type_?of_?clearance)$/i,
  category: /^(category|project_?category)$/i,
  sector: /^(sector|project_?sector|sector_?name|activity|activity_?name)$/i,
  submittedOn: /^(date_?of_?submission|submission_?date|submitted_?on|created_?on|createdOn|date_?of_?application)$/i,
  updatedOn: /^(updated_?on|updatedOn|last_?updated|status_?date|modified_?on)$/i,
};

function primitiveEntries(obj, prefix = '', depth = 0, out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v == null || v === '') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && !Array.isArray(v) && depth < 2) primitiveEntries(v, key, depth + 1, out);
    else if (typeof v !== 'object') out[key] = clean(v).slice(0, 500);
  }
  return out;
}

function looksLikeProposal(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.some((k) => FIELD_PATTERNS.proposalNo.test(k))) return true;
  return Object.values(obj).some((v) => typeof v === 'string' && new RegExp(PROPOSAL_NO_RE.source, 'i').test(v));
}

function* walk(node, depth = 0) {
  if (depth > 8 || node == null || typeof node !== 'object') return;
  if (looksLikeProposal(node)) {
    yield node;
    return;
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) yield* walk(v, depth + 1);
}

export function proposalFromObject(obj, url) {
  const flat = primitiveEntries(obj);
  const get = (field) => {
    const re = FIELD_PATTERNS[field];
    const hit = Object.entries(flat).find(([k]) => re.test(k.split('.').pop()));
    return hit?.[1] ?? null;
  };
  let proposalNo = get('proposalNo');
  if (!proposalNo || !new RegExp(PROPOSAL_NO_RE.source, 'i').test(proposalNo)) {
    const m = Object.values(flat).join(' ').match(new RegExp(PROPOSAL_NO_RE.source, 'i'));
    proposalNo = m?.[0] ?? proposalNo;
  }
  const title = get('title') ?? proposalNo ?? 'Untitled proposal';
  return {
    key: proposalNo ? proposalNo.toUpperCase() : hash(JSON.stringify(flat)),
    proposalNo: proposalNo?.toUpperCase() ?? null,
    title,
    status: get('status'),
    region: get('state'),
    date: toIsoDate(get('updatedOn') ?? get('submittedOn')),
    url,
    fields: {
      state: get('state'),
      district: get('district'),
      proponent: get('company'),
      clearanceType: get('clearanceType'),
      category: get('category'),
      sector: get('sector'),
      submittedOn: get('submittedOn'),
      updatedOn: get('updatedOn'),
    },
    text: Object.values(flat).join(' | ').slice(0, 4000),
    raw: flat,
  };
}

export function extractFromJson(payloads, url) {
  const byKey = new Map();
  for (const p of payloads) for (const obj of walk(p)) {
    const rec = proposalFromObject(obj, url);
    // Later/larger payloads (detail calls) enrich earlier list rows.
    const prev = byKey.get(rec.key);
    byKey.set(rec.key, prev ? mergeRecords(prev, rec) : rec);
  }
  return [...byKey.values()];
}

function mergeRecords(a, b) {
  const pickBetter = (x, y) => (y != null && y !== '' ? y : x);
  const fields = { ...a.fields };
  for (const [k, v] of Object.entries(b.fields)) fields[k] = pickBetter(fields[k], v);
  return {
    ...a,
    title: a.title === a.proposalNo ? b.title : a.title,
    status: pickBetter(a.status, b.status),
    region: pickBetter(a.region, b.region),
    date: pickBetter(a.date, b.date),
    fields,
    raw: { ...a.raw, ...b.raw },
  };
}

// ---------- DOM fallback ----------

export function recordsFromTable({ headers, rows }, url) {
  return rows
    .map((cells) => {
      const obj = Object.fromEntries(cells.map((c, i) => [headers[i] || `col${i}`, c]));
      const text = cells.join(' | ');
      const proposalNo = text.match(new RegExp(PROPOSAL_NO_RE.source, 'i'))?.[0]?.toUpperCase() ?? null;
      const find = (re) => Object.entries(obj).find(([k]) => re.test(k))?.[1] ?? null;
      return {
        key: proposalNo ?? hash(text),
        proposalNo,
        title: find(/project|proposal name|name/i) ?? text.slice(0, 160),
        status: find(/status|stage/i),
        region: find(/state|location/i),
        date: toIsoDate(find(/date/i)),
        url,
        fields: obj,
        text,
      };
    })
    .filter((r) => r.text.length > 5);
}

// ---------- browser driver ----------

async function findSearchInput(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (await loc.count().catch(() => 0)) return loc;
  }
  return null;
}

async function readTables(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('table')].map((t) => ({
      headers: [...t.querySelectorAll('thead th, tr:first-child th')].map((th) => th.innerText.trim()),
      rows: [...t.querySelectorAll('tbody tr')]
        .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim()))
        .filter((r) => r.length > 1),
    })),
  );
}

/**
 * Runs one search on the Track Your Proposal page.
 * @returns {{records:object[], exchanges:object[], tables:object[]}}
 */
export async function searchParivesh(browser, source, query, { log = console } = {}) {
  const opts = source.options ?? {};
  const context = await browser.newContext({ locale: 'en-IN' });
  const page = await context.newPage();
  const exchanges = [];
  let collecting = false;
  page.on('response', async (res) => {
    const req = res.request();
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    const ct = res.headers()['content-type'] || '';
    const entry = { phase: collecting ? 'search' : 'load', method: req.method(), url: res.url(), status: res.status(), postData: req.postData() ?? null };
    if (ct.includes('json')) entry.json = await res.json().catch(() => null);
    exchanges.push(entry);
  });

  try {
    const resp = await page.goto(source.url, { waitUntil: 'networkidle', timeout: opts.navigationTimeoutMs ?? 90000 });
    if (!resp || resp.status() >= 400) throw new Error(`PARIVESH page returned HTTP ${resp?.status() ?? 'no response'} (site down, or blocking traffic from outside India)`);
    const input = await findSearchInput(page, opts.searchInputSelectors ?? ['input[type=text]']);
    if (!input) throw new Error('Search box not found on Track Your Proposal page (update searchInputSelectors in config/sources.json)');
    collecting = true;
    await input.fill(query);
    const btn = page.getByRole('button', { name: new RegExp(opts.searchButtonText ?? 'search', 'i') }).first();
    if (await btn.count()) await btn.click().catch(() => input.press('Enter'));
    else await input.press('Enter');
    await Promise.race([
      page.waitForResponse((r) => /json/.test(r.headers()['content-type'] || ''), { timeout: opts.resultTimeoutMs ?? 45000 }),
      page.waitForSelector('tbody tr td', { timeout: opts.resultTimeoutMs ?? 45000 }),
    ]).catch(() => log.warn(`  parivesh: no result signal for "${query}"`));
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const tables = await readTables(page);
    const searchJson = exchanges.filter((e) => e.phase === 'search' && e.json).map((e) => e.json);
    let records = extractFromJson(searchJson, source.url);
    if (!records.length) records = tables.flatMap((t) => recordsFromTable(t, source.url));
    return { records, exchanges, tables };
  } finally {
    await context.close();
  }
}

async function recordEndpoints(exchanges) {
  const file = paths.raw('parivesh-track', 'endpoints.json');
  const known = await readJson(file, {});
  for (const e of exchanges) {
    const u = new URL(e.url);
    const k = `${e.method} ${u.origin}${u.pathname}`;
    known[k] = { lastSeen: new Date().toISOString(), status: e.status, exampleQuery: u.search || null, examplePostData: e.postData?.slice(0, 500) ?? null };
  }
  await writeJson(file, known);
}

export default {
  id: 'parivesh-track',
  async run({ source, projects, discovery, log }) {
    const queries = new Set();
    for (const p of projects) for (const id of p.ids?.parivesh ?? []) queries.add(id);
    // Name-based searches find proposals before their numbers are known.
    for (const p of projects) if (!p.ids?.parivesh?.length) for (const k of p.keywords ?? []) queries.add(k);
    for (const k of source.options?.discoveryQueries ?? discovery?.keywords?.filter((k) => k.length > 4) ?? []) queries.add(k);

    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    const records = new Map();
    const errors = [];
    try {
      for (const q of queries) {
        try {
          const r = await searchParivesh(browser, source, q, { log });
          await recordEndpoints(r.exchanges);
          for (const rec of r.records) records.set(rec.key, { ...rec, fields: { ...rec.fields, matchedQuery: q } });
          log.info(`  parivesh "${q}": ${r.records.length} record(s)`);
        } catch (e) {
          errors.push(`${q}: ${e.message}`);
          log.warn(`  parivesh "${q}" failed: ${e.message}`);
          if (errors.length >= 2 && records.size === 0) break; // site down – don't hammer it
        }
      }
    } finally {
      await browser.close();
    }
    if (!records.size && errors.length) throw new Error(errors[0]);
    return { records: [...records.values()], warnings: errors };
  },
};

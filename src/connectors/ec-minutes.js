// environmentclearance.nic.in/report_uploaded_minutes.aspx – uploaded minutes of MoEFCC
// committee (EAC/SEAC) meetings. ASP.NET WebForms page: we read the largest data grid,
// follow GridView pager postbacks, and (optionally) download each new minutes PDF once to
// search it for watchlist projects. PDF hits (term, page, snippet) are added to the record
// text, so the normal project matching and discovery rules pick them up.
import * as cheerio from 'cheerio';
import path from 'node:path';
import { HttpSession } from '../lib/http.js';
import { absUrl, clean, hash, toIsoDate } from '../lib/util.js';
import { formFields } from './aspnet.js';
import * as store from '../lib/store.js';

/** Parses the main grid: header labels + one record per data row. */
export function parseMinutesGrid(html, pageUrl) {
  const $ = cheerio.load(html);
  // The grid is the table with the most multi-cell rows of its own (nested pager tables don't count).
  const tables = $('table')
    .toArray()
    .map((t) => ({ t, score: $(t).find('> tbody > tr, > tr').filter((_, tr) => $(tr).children('td,th').length > 1).length + $(t).find('a[href]').length / 10 }))
    .sort((a, b) => b.score - a.score);
  const grid = tables[0]?.t;
  if (!grid) return { headers: [], rows: [], pager: [] };
  const trs = $(grid).find('> tbody > tr, > tr').toArray();
  const headerRow = trs.find((tr) => $(tr).children('th').length > 1) ?? trs[0];
  const headers = $(headerRow).children('th,td').map((_, c) => clean($(c).text())).get();
  const pager = [];
  const rows = [];
  for (const tr of trs) {
    if (tr === headerRow) continue;
    const cells = $(tr).children('td');
    // GridView pager row: a single cell holding a nested table of page links.
    const postbacks = $(tr).find('a[href*="__doPostBack"]').map((_, a) => $(a).attr('href')).get();
    if (cells.length <= 1 && postbacks.length) {
      for (const h of postbacks) {
        const m = h.match(/__doPostBack\('([^']+)','(Page\$[^']+)'\)/);
        if (m) pager.push({ target: m[1], argument: m[2], label: clean($(tr).find(`a[href="${h}"]`).text()) });
      }
      continue;
    }
    if (cells.length < 2) continue;
    const texts = cells.map((_, td) => clean($(td).text())).get();
    const links = $(tr)
      .find('a[href]')
      .map((_, a) => ({ label: clean($(a).text()) || 'Minutes', url: absUrl($(a).attr('href'), pageUrl) }))
      .get()
      .filter((l) => l.url && !/^javascript:/i.test(l.url));
    rows.push({ cells: texts, links });
  }
  return { headers, rows, pager };
}

const col = (headers, re) => headers.findIndex((h) => re.test(h));

export function minutesRecord({ cells, links }, headers, pageUrl) {
  const at = (re) => {
    const i = col(headers, re);
    return i >= 0 ? cells[i] : null;
  };
  const text = cells.join(' | ');
  const dateText = at(/date/i) ?? text.match(/\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b|\b\d{1,2}[- ][A-Za-z]{3,9}[- ,]+\d{4}\b/)?.[0] ?? null;
  const committee = at(/committee|sector|category|activity|eac|seac/i);
  const meeting = at(/meeting|subject|title|description|minutes|agenda/i);
  const title = clean([committee, meeting].filter(Boolean).join(' – ')) || cells.filter((c) => c.length > 3 && !/^\d+$/.test(c)).sort((a, b) => b.length - a.length)[0] || text.slice(0, 160);
  const pdf = links.find((l) => /\.pdf($|\?)/i.test(l.url)) ?? links[0];
  return {
    key: pdf ? hash(pdf.url) : hash(text),
    title: `EC minutes: ${title}`.slice(0, 300),
    date: toIsoDate(dateText),
    status: 'Minutes uploaded',
    url: pageUrl,
    docs: links,
    fields: Object.fromEntries(headers.map((h, i) => [h || `col${i}`, cells[i] ?? ''])),
    text,
  };
}

/** Search terms: watchlist keywords and proposal numbers, plus discovery keywords. */
export function searchTerms(projects, discovery) {
  const terms = new Map();
  for (const p of projects) for (const k of [...(p.keywords ?? []), ...Object.values(p.ids ?? {}).flat()]) if (k) terms.set(k.toLowerCase(), { term: k, projectId: p.id });
  for (const k of discovery?.keywords ?? []) if (k.length > 3) terms.set(k.toLowerCase(), { term: k, projectId: null });
  return [...terms.values()];
}

export function findHits(pages, terms) {
  const hits = [];
  pages.forEach((raw, i) => {
    const page = raw.replace(/\s+/g, ' ');
    const lower = page.toLowerCase();
    for (const t of terms) {
      const idx = lower.indexOf(t.term.toLowerCase());
      if (idx < 0) continue;
      const before = /^[a-z0-9]/i.test(t.term) && /[a-z0-9]/i.test(lower[idx - 1] ?? '');
      if (before) continue;
      hits.push({ term: t.term, projectId: t.projectId, page: i + 1, snippet: page.slice(Math.max(0, idx - 140), idx + t.term.length + 160).trim() });
    }
  });
  // One hit per term per page is enough.
  return [...new Map(hits.map((h) => [`${h.term}|${h.page}`, h])).values()];
}

async function scanPdfs(records, { source, projects, discovery, log }) {
  const max = source.options?.maxPdfScansPerRun ?? 20;
  if (!max) return;
  const { downloadPdf, extractPages } = await import('../analysis/pdf.js');
  const file = path.join(store.DATA_DIR, 'minutes-scans.json');
  const cache = await store.readJson(file, {});
  const terms = searchTerms(projects, discovery);
  let scanned = 0;
  for (const r of records) {
    const pdf = r.docs.find((d) => /\.pdf($|\?)/i.test(d.url));
    if (!pdf) continue;
    if (!cache[pdf.url] && scanned < max) {
      try {
        const dl = await downloadPdf(pdf.url, { caFile: source.caFile });
        const { pages } = await extractPages(dl.file);
        cache[pdf.url] = { scannedAt: new Date().toISOString(), pages: pages.length, textless: pages.join('').trim().length < 200, hits: findHits(pages, terms) };
      } catch (e) {
        cache[pdf.url] = { scannedAt: new Date().toISOString(), error: e.message, hits: [] };
        log.warn(`  ec-minutes: could not scan ${pdf.url}: ${e.message}`);
      }
      scanned++;
    }
    const scan = cache[pdf.url];
    if (scan?.hits?.length) {
      const byTerm = new Map();
      for (const h of scan.hits) byTerm.set(h.term, [...(byTerm.get(h.term) ?? []), h.page]);
      r.fields.pdfHits = [...byTerm]
        .map(([t, pages]) => `${t} (pp. ${pages.slice(0, 5).join(', ')}${pages.length > 5 ? ` … +${pages.length - 5} more` : ''})`)
        .join('; ');
      r.text += ' | ' + scan.hits.map((h) => h.snippet).join(' | ');
      r.status = `Minutes uploaded – mentions ${[...new Set(scan.hits.map((h) => h.term))].join(', ')}`;
    }
  }
  if (scanned) log.info(`  ec-minutes: scanned ${scanned} new minutes PDF(s)`);
  await store.writeJson(file, cache);
}

export default {
  id: 'ec-minutes',
  async run({ source, projects, discovery, log }) {
    const http = new HttpSession({ caFile: source.caFile, timeoutMs: 120000 });
    const url = source.url;
    let html = await http.getText(url);
    let grid = parseMinutesGrid(html, url);

    // Some report pages show nothing until "Search"/"Show" is pressed with default filters.
    if (grid.rows.length < 2) {
      const f = formFields(html);
      if (f.submits[0]) {
        const body = new URLSearchParams({ ...f.fields, [f.submits[0].name]: f.submits[0].value });
        html = (await http.request(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', referer: url } })).text;
        grid = parseMinutesGrid(html, url);
      }
    }
    if (!grid.rows.length) throw new Error('No minutes table found on the page (layout may have changed)');

    const records = new Map();
    const add = (g) => g.rows.map((r) => minutesRecord(r, g.headers.length ? g.headers : grid.headers, url)).forEach((r) => records.set(r.key, r));
    add(grid);

    // Follow GridView pager postbacks (Page$2, Page$3, …).
    const maxPages = source.options?.maxPages ?? 10;
    const seen = new Set(['Page$1']);
    let queue = grid.pager.filter((p) => /^Page\$\d+$/.test(p.argument));
    for (let i = 1; i < maxPages && queue.length; i++) {
      const next = queue.find((p) => !seen.has(p.argument));
      if (!next) break;
      seen.add(next.argument);
      const f = formFields(html);
      const body = new URLSearchParams({ ...f.fields, __EVENTTARGET: next.target, __EVENTARGUMENT: next.argument });
      const res = await http.request(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', referer: url } });
      html = res.text;
      const g = parseMinutesGrid(html, url);
      const before = records.size;
      add(g);
      if (records.size === before) break;
      queue = [...queue, ...g.pager.filter((p) => /^Page\$\d+$/.test(p.argument))];
    }

    const list = [...records.values()];
    await scanPdfs(list, { source, projects, discovery, log });
    log.info(`  ec-minutes: ${list.length} minutes across ${seen.size} page(s)`);
    return { records: list };
  },
};

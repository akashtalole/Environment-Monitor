// Maharashtra Pollution Control Board (Drupal site): public hearing listings and
// Consent Appraisal Committee (CAC) meetings. Tables use stable `headers` attributes.
import * as cheerio from 'cheerio';
import { HttpSession } from '../lib/http.js';
import { absUrl, clean, hash, toIsoDate } from '../lib/util.js';

export function parseTable(html, baseUrl) {
  const $ = cheerio.load(html);
  const table = $('table.views-table').first();
  if (!table.length) return [];
  const headers = table
    .find('thead th')
    .map((_, th) => ({ id: $(th).attr('id'), label: clean($(th).text()) }))
    .get();
  return table
    .find('tbody tr')
    .map((_, tr) => {
      const row = {};
      $(tr)
        .find('td')
        .each((i, td) => {
          const hid = $(td).attr('headers') || headers[i]?.id || `col${i}`;
          const label = headers.find((h) => h.id === hid)?.label || hid;
          const links = $(td)
            .find('a[href]')
            .map((_, a) => ({ label: clean($(a).text()) || label, url: absUrl($(a).attr('href'), baseUrl) }))
            .get();
          row[label] = { text: clean($(td).text()), links };
        });
      return row;
    })
    .get();
}

const pick = (row, re) => Object.entries(row).find(([k]) => re.test(k))?.[1];

export function hearingRecord(row, sourceUrl) {
  const title = pick(row, /name of industry|industry/i)?.text ?? '';
  const dateText = pick(row, /date/i)?.text ?? '';
  const docs = Object.entries(row).flatMap(([col, cell]) =>
    cell.links.map((l) => ({ label: /click here/i.test(l.label) ? col : l.label, url: l.url })),
  );
  const remarks = pick(row, /remark/i)?.text || null;
  return {
    key: hash(title, dateText),
    title,
    date: toIsoDate(dateText),
    status: dateText ? `Public hearing ${dateText}` : "Listed for public hearing (date not given)",
    region: 'Maharashtra',
    url: sourceUrl,
    docs,
    fields: { hearingDate: dateText, remarks, documents: docs.map((d) => d.label).join(', ') },
  };
}

export function cacRecord(row, sourceUrl) {
  const dateText = pick(row, /date/i)?.text ?? '';
  const agenda = pick(row, /agenda/i);
  const minutes = pick(row, /minute/i);
  const atr = pick(row, /action/i);
  const title = agenda?.text || minutes?.text || `CAC meeting ${dateText}`;
  const docs = [agenda, minutes, atr].flatMap((c) => c?.links ?? []);
  return {
    key: hash('cac', dateText, title),
    title: `MPCB CAC: ${title}`,
    date: toIsoDate(dateText),
    status: minutes?.links?.length ? 'Minutes published' : 'Agenda published',
    region: 'Maharashtra',
    url: sourceUrl,
    docs,
    fields: { meetingDate: dateText, hasMinutes: String(!!minutes?.links?.length), hasATR: String(!!atr?.links?.length) },
  };
}

export default {
  id: 'mpcb',
  async run({ source, log }) {
    const http = new HttpSession({ caFile: source.caFile });
    const kind = source.options?.kind ?? 'public-hearing';
    const maxPages = source.options?.maxPages ?? 5;
    const records = [];
    let prevSig = null;
    for (let page = 0; page < maxPages; page++) {
      const url = page ? `${source.url}?page=${page}` : source.url;
      const rows = parseTable(await http.getText(url), url);
      const sig = hash(JSON.stringify(rows));
      if (!rows.length || sig === prevSig) break; // Drupal repeats the last page when out of range
      prevSig = sig;
      for (const row of rows) records.push(kind === 'cac' ? cacRecord(row, source.url) : hearingRecord(row, source.url));
    }
    return { records };
  },
};

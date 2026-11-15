import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseMinutesGrid, minutesRecord, findHits, searchTerms } from '../src/connectors/ec-minutes.js';

// Standard ASP.NET GridView markup (header row of <th>, data rows, pager row with a nested table).
const page = (rows, pageNo, pages = 2) => `<html><body><form method="post" action="report_uploaded_minutes.aspx" id="form1">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="vs${pageNo}" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="ev" />
<table><tr><td>Ministry of Environment, Forest and Climate Change</td></tr></table>
<table id="GridView1" class="ez1">
  <tr><th>S.No.</th><th>Sector</th><th>Meeting Details</th><th>Date of Meeting</th><th>Minutes</th></tr>
  ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td><a href="writereaddata/minutes/${r[3]}">View</a></td></tr>`).join('')}
  <tr><td colspan="5"><table><tr>${Array.from({ length: pages }, (_, i) => (i + 1 === pageNo ? `<td><span>${i + 1}</span></td>` : `<td><a href="javascript:__doPostBack('GridView1','Page$${i + 1}')">${i + 1}</a></td>`)).join('')}</tr></table></td></tr>
</table></form></body></html>`;

const P1 = [
  ['River Valley and Hydroelectric Projects', '45th Meeting of EAC (River Valley)', '12/10/2026', 'rv45.pdf'],
  ['Industrial Projects - 1', '12th Meeting of EAC (Industry-1)', '05/10/2026', 'ind12.pdf'],
];
const P2 = [['Mining Projects', '30th Meeting of EAC (Mining)', '28/09/2026', 'mining30.pdf']];

test('parses the minutes grid, its headers and pager', () => {
  const g = parseMinutesGrid(page(P1, 1), 'https://environmentclearance.nic.in/report_uploaded_minutes.aspx');
  assert.deepEqual(g.headers, ['S.No.', 'Sector', 'Meeting Details', 'Date of Meeting', 'Minutes']);
  assert.equal(g.rows.length, 2);
  assert.deepEqual(g.pager, [{ target: 'GridView1', argument: 'Page$2', label: '2' }]);
  const r = minutesRecord(g.rows[0], g.headers, 'https://environmentclearance.nic.in/report_uploaded_minutes.aspx');
  assert.equal(r.title, 'EC minutes: River Valley and Hydroelectric Projects – 45th Meeting of EAC (River Valley)');
  assert.equal(r.date, '2026-10-12');
  assert.equal(r.docs[0].url, 'https://environmentclearance.nic.in/writereaddata/minutes/rv45.pdf');
});

test('PDF hits: watchlist keywords and proposal numbers with page and snippet', () => {
  const terms = searchTerms(
    [{ id: 'bhivpuri-psp', keywords: ['Bhivpuri'], ids: { parivesh: ['IA/MH/RIV/123/2025'] } }],
    { keywords: ['pumped storage', 'PSP'] },
  );
  const hits = findHits(['Agenda item 3: Bhivpuri Pumped Storage Project (1000 MW) by Tata Power, Proposal IA/MH/RIV/123/2025', 'nothing here', 'ESP filter'], terms);
  assert.deepEqual(hits.map((h) => `${h.term}@${h.page}`).sort(), ['Bhivpuri@1', 'IA/MH/RIV/123/2025@1', 'pumped storage@1']);
  assert.equal(hits.find((h) => h.term === 'Bhivpuri').projectId, 'bhivpuri-psp');
  assert.ok(!hits.some((h) => h.term === 'PSP'), 'short discovery terms skipped');
});

test('connector follows GridView postbacks (end to end against a local server)', async () => {
  let posts = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'text/html');
      if (req.method === 'POST') {
        posts++;
        const p = new URLSearchParams(body);
        assert.equal(p.get('__EVENTTARGET'), 'GridView1');
        assert.equal(p.get('__VIEWSTATE'), 'vs1');
        return res.end(page(P2, 2));
      }
      res.end(page(P1, 1));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const prevDir = process.env.ENVMON_DATA_DIR;
  process.env.ENVMON_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'envmon-'));
  try {
    const { default: connector } = await import('../src/connectors/ec-minutes.js');
    const url = `http://127.0.0.1:${server.address().port}/report_uploaded_minutes.aspx`;
    const quiet = { info() {}, warn() {} };
    const { records } = await connector.run({ source: { id: 'ec-minutes', url, options: { maxPages: 5, maxPdfScansPerRun: 0 } }, projects: [], discovery: {}, log: quiet });
    assert.equal(posts, 1);
    assert.equal(records.length, 3);
    assert.ok(records.some((r) => /Mining/.test(r.title)));
  } finally {
    server.close();
    if (prevDir === undefined) delete process.env.ENVMON_DATA_DIR;
    else process.env.ENVMON_DATA_DIR = prevDir;
  }
});

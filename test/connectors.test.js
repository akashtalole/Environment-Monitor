import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTable, hearingRecord, cacRecord } from '../src/connectors/mpcb.js';
import { extractFromJson, recordsFromTable } from '../src/connectors/parivesh-track.js';
import { meetingRecord } from '../src/connectors/parivesh-committees.js';
import { formFields, keyValueRows } from '../src/connectors/aspnet.js';
import { fcRecord } from '../src/connectors/fc-legacy.js';
import { linksAsRecords } from '../src/connectors/page-watch.js';

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('MPCB public hearing table (real page)', () => {
  const url = 'https://www.mpcb.gov.in/en/public-hearing-upcoming?page=1';
  const rows = parseTable(fixture('mpcb-public-hearing-upcoming.html'), url);
  assert.equal(rows.length, 10);
  const recs = rows.map((r) => hearingRecord(r, url));
  const psp = recs.find((r) => /MALSHEJ GHAT BHORANDE/.test(r.title));
  assert.ok(psp, 'finds the Malshej Ghat PSP hearing');
  assert.equal(psp.date, '2026-08-21');
  assert.ok(psp.docs.length >= 1 && psp.docs.every((d) => d.url.startsWith('https://')));
  assert.equal(new Set(recs.map((r) => r.key)).size, recs.length, 'keys are unique');
});

test('MPCB CAC meetings table (real page)', () => {
  const url = 'https://www.mpcb.gov.in/en/cac-meetings';
  const recs = parseTable(fixture('mpcb-cac-meetings.html'), url).map((r) => cacRecord(r, url));
  assert.equal(recs.length, 10);
  assert.equal(recs[0].date, '2026-01-23');
  assert.equal(recs[0].status, 'Minutes published');
  assert.ok(recs[0].docs.some((d) => /minutes/i.test(d.url)));
});

test('PARIVESH: proposals extracted from nested JSON and merged across calls', () => {
  const list = { status: 200, data: { content: [
    { proposalNo: 'IA/MH/RIV/123456/2025', projectName: 'Test PSP', proposalStatus: 'EC Granted', state: 'Maharashtra', dateOfSubmission: '12/03/2025' },
    { proposalNo: 'FP/MH/HYD/45678/2025', projectName: 'Test PSP forest', proposalStatus: 'Stage-I Approved' },
  ] } };
  const detail = { data: { proposal_no: 'IA/MH/RIV/123456/2025', proponent_name: 'Acme Hydro', district: 'Pune' } };
  const recs = extractFromJson([list, detail], 'https://parivesh.nic.in');
  assert.equal(recs.length, 2);
  const ec = recs.find((r) => r.proposalNo === 'IA/MH/RIV/123456/2025');
  assert.equal(ec.title, 'Test PSP');
  assert.equal(ec.status, 'EC Granted');
  assert.equal(ec.fields.proponent, 'Acme Hydro');
  assert.equal(ec.fields.district, 'Pune');
  assert.equal(ec.date, '2025-03-12');
});

test('PARIVESH: proposal number found in values when the key name is unknown', () => {
  const recs = extractFromJson([[{ ref: 'SIA/MH/IND2/99999/2024', nm: 'Something' }]], 'u');
  assert.equal(recs[0].key, 'SIA/MH/IND2/99999/2024');
});

test('PARIVESH: DOM table fallback', () => {
  const recs = recordsFromTable(
    { headers: ['S.No', 'Proposal No', 'Project Name', 'State', 'Status'], rows: [['1', 'IA/MH/RIV/1/2025', 'Bhivpuri PSP', 'Maharashtra', 'Under ToR']] },
    'u',
  );
  assert.equal(recs[0].proposalNo, 'IA/MH/RIV/1/2025');
  assert.equal(recs[0].title, 'Bhivpuri PSP');
  assert.equal(recs[0].status, 'Under ToR');
});

test('PARIVESH committee meeting record', () => {
  const r = meetingRecord(
    { meeting_id: 77, subject: '15th EAC (River Valley & Hydro)', from_date: '2026-10-05', Agenda_URL: '/files/a.pdf', Project_Sector: 'River Valley' },
    { label: 'EAC (Central) Agenda', committee: 'CatA', type: 'Agenda' },
    'https://parivesh.nic.in',
  );
  assert.equal(r.key, 'CatA-Agenda-77');
  assert.equal(r.docs[0].url, 'https://parivesh.nic.in/files/a.pdf');
  assert.equal(r.date, '2026-10-05');
});

test('ASP.NET helpers: form fields and key/value report', () => {
  const html = `<form action="Search.aspx"><input type="hidden" name="__VIEWSTATE" value="vs"/>
    <input type="text" name="textbox2"/><select name="ddlstate"><option value="-All-">All</option><option value="MH" selected>MH</option></select>
    <input type="submit" name="btn" value="Search"/></form>`;
  const f = formFields(html);
  assert.equal(f.fields.__VIEWSTATE, 'vs');
  assert.equal(f.fields.ddlstate, 'MH');
  assert.deepEqual(f.textInputs, ['textbox2']);
  assert.equal(f.submits[0].name, 'btn');

  const kv = keyValueRows(`<table><tr><td>Proposal Name :</td><td>Shirawta PSP</td></tr>
    <tr><td>Proposal Status</td><td>Approved Stage-I</td></tr><tr><td>State</td><td>Maharashtra</td></tr></table>`);
  const rec = fcRecord('FP/MH/HYD/1/2020', kv, 'u');
  assert.equal(rec.title, 'Shirawta PSP');
  assert.equal(rec.status, 'Approved Stage-I');
});

test('page-watch turns links into records and skips navigation chrome', () => {
  const recs = linksAsRecords(
    `<body><a href="/">Home</a><a href="/notice/1.pdf">Direction issued under Section 5 to M/s XYZ</a><a href="/notice/1.pdf">dup</a></body>`,
    'https://cpcb.nic.in/',
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0].url, 'https://cpcb.nic.in/notice/1.pdf');
});

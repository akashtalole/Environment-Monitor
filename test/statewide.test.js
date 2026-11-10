import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { classifySector, detectDistricts, detectTalukas } from '../src/statewide/build.js';
import { canonicalCompany, extractCompanies, bondLinks, buildIndex } from '../src/bonds/match.js';
import { parseCsv, aggregate, EXPECTED } from '../src/bonds/build.js';

const wg = JSON.parse(await fs.readFile(new URL('../config/western-ghats.json', import.meta.url), 'utf8'));
const DISTRICTS = ['Pune', 'Ratnagiri', 'Raigad', 'Thane', 'Kolhapur', 'Ahmednagar', 'Akola', 'Satara'];

test('WGEEP reference data matches the report tables', () => {
  const main = wg.talukas.filter((t) => t.appendix === 2);
  const n = (z) => main.filter((t) => t.zone === z).length;
  // Table 3 (p.45): 32 ESZ1 / 4 ESZ2 / 14 ESZ3. Appendix 2 prints 3 ESZ1 rows and 1 ESZ3 row only as "n.a. (code)",
  // so 29 + 3 = 32 and 13 + 1 = 14.
  assert.equal(n('ESZ2'), 4);
  assert.equal(n('ESZ3'), 13);
  assert.equal(n('ESZ1'), 29);
  for (const t of wg.talukas) assert.ok(['ESZ1', 'ESZ2', 'ESZ3'].includes(t.zone), t.taluka);
  for (const k of ['energy', 'mining', 'industry', 'transport']) for (const z of ['ESZ1', 'ESZ2', 'ESZ3']) assert.ok(wg.guidelines[k][z]);
});

test('sector rules prefer specific terms over address words', () => {
  assert.equal(classifySector('Synthetic Organic Chemicals manufacturing at Gut No 5, Pune-Nashik Road'), 'Industry & chemicals');
  assert.equal(classifySector('Shakteepeeth Mahamarg in Parbhani District'), 'Roads, rail & ports');
  assert.equal(classifySector('26 Sand Spots located in Parbhani'), 'Mining & quarrying');
  assert.equal(classifySector('Shirawta Off-stream Open Loop Pumped Storage Hydro Project (1800 MW)'), 'Pumped storage & hydro');
  assert.equal(classifySector('Kukadi Sahakri Sakhar Karkhana Ltd., Tal-Shrigonda'), 'Industry & chemicals');
  assert.equal(classifySector('Richa Realtors'), 'Real estate & townships');
});

test('districts with aliases', () => {
  assert.deepEqual(detectDistricts('Tal. Pen, Dist. Raigarh', DISTRICTS), ['Raigad']);
  assert.deepEqual(detectDistricts('Ahilyanagar district', DISTRICTS), ['Ahmednagar']);
});

test('talukas need a "Tal./Taluka/Tehsil" marker and an agreeing district', () => {
  const t = (s, d) => detectTalukas(s, wg.talukas, d).hits.map((h) => `${h.taluka}:${h.zone}`);
  assert.deepEqual(t('Village Khandshi, Tal-Maval, Dist-Pune', ['Pune']), ['Maval:ESZ1']);
  assert.deepEqual(t('Plant at Mawal Taluka, Dist-Pune', ['Pune']), ['Maval:ESZ1'], 'spelling alias');
  assert.deepEqual(t('Tehsil Junnar & Murbad, District Pune & Thane', ['Pune', 'Thane']).sort(), ['Junnar:ESZ3', 'Murbad:ESZ1']);
  assert.deepEqual(t('Tal. Khed, Dist. Ratnagiri', ['Ratnagiri']), ['Khed:ESZ3'], 'Khed resolved by district');
  assert.deepEqual(t('Pune-Mumbai old highway near Maval', ['Pune']), [], 'no marker, no match');
  assert.deepEqual(t('Tal. Man, Dist. Satara', ['Satara']), ['Man:ESZ3']);
  assert.deepEqual(t('a man from Satara', ['Satara']), []);
});

test('company names: canonical form and extraction', () => {
  assert.equal(canonicalCompany('M/s. Torrent Power Ltd.'), canonicalCompany('TORRENT POWER LIMITED'));
  assert.equal(canonicalCompany('MEGHA ENGINEERING AND INFRASTRUCTURES LI MITED'), canonicalCompany('Megha Engineering & Infrastructures Ltd'));
  assert.notEqual(canonicalCompany('Torrent Pharmaceuticals Ltd'), canonicalCompany('Torrent Power Ltd'));
  assert.deepEqual(extractCompanies('Proposed by M/s. M/s Adani Renewable Energy Fifty Two Limited Ahmedabad'), ['Adani Renewable Energy Fifty Two Limited']);
  assert.deepEqual(extractCompanies('M/s Torrent PSH4 Pvt Ltd are developing'), ['Torrent PSH4 Pvt Ltd']);
});

test('bond links: exact names and documented group links only', () => {
  const index = buildIndex({ purchasers: [
    { key: canonicalCompany('TORRENT POWER LIMITED'), name: 'TORRENT POWER LIMITED', cr: 106.5, byParty: [] },
    { key: canonicalCompany('ULTRA TECH CEMENT LIMITED'), name: 'ULTRA TECH CEMENT LIMITED', cr: 15, byParty: [] },
  ] });
  const entities = { groups: [{ id: 'torrent', name: 'Torrent', proponentPatterns: ['Torrent\\s+PSH'], purchasers: [{ name: 'TORRENT POWER LIMITED', relation: 'Parent' }] }, { id: 'adani', name: 'Adani', proponentPatterns: ['Adani'], purchasers: [], note: 'none' }] };
  const a = bondLinks('M/s Torrent PSH4 Pvt Ltd are developing a PSP', index, entities);
  assert.equal(a.exact.length, 0, 'subsidiary name is not the purchaser name');
  assert.equal(a.groups[0].purchases[0].purchaser.cr, 106.5);
  const b = bondLinks('Laterite mine of M/s. Ultra Tech Cement Ltd., Chandrapur', index, entities);
  assert.equal(b.exact[0].cr, 15);
  const c = bondLinks('M/s. Adani Renewable Energy Fifty Two Limited', index, entities);
  assert.equal(c.groups[0].purchases.length, 0);
  assert.equal(c.groups[0].note, 'none');
});

test('CSV parser handles quotes, commas and newlines', () => {
  const rows = parseCsv('"a","b"\n"x, y","1,00,000"\r\n"he said ""hi""","2"\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: '1,00,000' }, { a: 'he said "hi"', b: '2' }]);
});

test('bond aggregation refuses data that does not match the ECI totals', () => {
  const p = [{ 'Name of the Purchaser': 'A LTD', Denominations: '1,00,000', Prefix: 'OL', 'Bond Number': '1', 'Date of Purchase': '12/Apr/2019' }];
  const e = [{ 'Name of the Political Party': 'X', Denominations: '1,00,000', Prefix: 'OL', 'Bond Number': '1' }];
  assert.throws(() => aggregate(p, e), /Verification failed/);
  assert.equal(EXPECTED.purchaseCr, 12155.51);
});

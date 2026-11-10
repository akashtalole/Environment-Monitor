// Builds data/reference/electoral-bonds.json from the electoral bond disclosures the
// Election Commission of India published on 21 March 2024 (data supplied by SBI under the
// Supreme Court's order). We use a CSV conversion of the two ECI PDFs and refuse to build
// unless row counts and totals match the PDFs exactly. Each purchase is linked to the party
// that encashed it through the bond's prefix + number.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetch, EnvHttpProxyAgent } from 'undici';
import * as store from '../lib/store.js';
import { canonicalCompany } from './match.js';

export const SOURCE = {
  publisher: 'Election Commission of India – Disclosure of Electoral Bonds (data supplied by SBI), released 21 March 2024',
  eciPage: 'https://www.eci.gov.in/disclosure-of-electoral-bonds',
  csvRepo: 'https://github.com/saisantoshv3/electoral_bonds',
  commit: 'aa8b9e022d29f762fd174fa9371ad2e02a85e777',
  files: {
    purchased: { path: 'data/purchased.csv', sha256: '87ff9c1616c8eadceba597b6b5818a40f892fa8690d34fd882a2d6256de05777' },
    encashed: { path: 'data/encashed.csv', sha256: 'ab071815de9d045478628ba2c4d7c431edd27d39025f955c038c157da8354d91' },
  },
};
// Checked against the last serial number and the sum of denominations in the ECI PDFs.
export const EXPECTED = { purchaseRows: 18871, purchaseCr: 12155.51, encashRows: 20421, encashCr: 12769.09 };

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const rupees = (s) => Number(String(s).replace(/,/g, ''));
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const isoDate = (s) => {
  const m = String(s).match(/(\d{1,2})\/([A-Za-z]{3})\/(\d{4})/);
  return m ? `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};
const cr = (r) => Math.round(r / 1e5) / 100; // rupees → crore, 2 dp

async function loadFile(name, dir) {
  const f = SOURCE.files[name];
  let buf;
  if (dir) buf = await fs.readFile(path.join(dir, f.path));
  else {
    const url = `https://raw.githubusercontent.com/saisantoshv3/electoral_bonds/${SOURCE.commit}/${f.path}`;
    const r = await fetch(url, { dispatcher: new EnvHttpProxyAgent() });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== f.sha256) throw new Error(`${f.path}: checksum ${sha} does not match the pinned file`);
  return buf.toString('utf8');
}

export function aggregate(purchased, encashed) {
  const sum = (rows) => rows.reduce((s, r) => s + rupees(r.Denominations), 0);
  const check = {
    purchaseRows: purchased.length,
    purchaseCr: cr(sum(purchased)),
    encashRows: encashed.length,
    encashCr: cr(sum(encashed)),
  };
  for (const [k, v] of Object.entries(EXPECTED))
    if (Math.abs(check[k] - v) > 0.005) throw new Error(`Verification failed: ${k} = ${check[k]}, ECI PDFs say ${v}`);

  const partyOf = new Map();
  const partyTotals = {};
  for (const r of encashed) {
    const party = r['Name of the Political Party'].replace(/\s+/g, ' ');
    partyOf.set(`${r.Prefix}-${r['Bond Number']}`, party);
    partyTotals[party] = (partyTotals[party] ?? 0) + rupees(r.Denominations);
  }

  const purchasers = new Map();
  let matched = 0;
  for (const r of purchased) {
    const raw = r['Name of the Purchaser'].replace(/\s+/g, ' ');
    const key = canonicalCompany(raw);
    const p = purchasers.get(key) ?? { key, names: {}, totalRs: 0, bonds: 0, first: null, last: null, byParty: {}, unmatchedRs: 0 };
    const amt = rupees(r.Denominations);
    const date = isoDate(r['Date of Purchase']);
    p.names[raw] = (p.names[raw] ?? 0) + amt;
    p.totalRs += amt;
    p.bonds++;
    if (date && (!p.first || date < p.first)) p.first = date;
    if (date && (!p.last || date > p.last)) p.last = date;
    const party = partyOf.get(`${r.Prefix}-${r['Bond Number']}`);
    if (party) (p.byParty[party] = (p.byParty[party] ?? 0) + amt), matched++;
    else p.unmatchedRs += amt;
    purchasers.set(key, p);
  }

  return {
    verification: { ...check, matchedBonds: matched, expected: EXPECTED, status: 'matches ECI PDFs' },
    parties: Object.entries(partyTotals).map(([name, rs]) => ({ name, cr: cr(rs) })).sort((a, b) => b.cr - a.cr),
    purchasers: [...purchasers.values()]
      .map((p) => ({
        key: p.key,
        name: Object.entries(p.names).sort((a, b) => b[1] - a[1])[0][0],
        aliases: Object.keys(p.names),
        cr: cr(p.totalRs),
        bonds: p.bonds,
        first: p.first,
        last: p.last,
        byParty: Object.entries(p.byParty).map(([name, rs]) => ({ name, cr: cr(rs) })).sort((a, b) => b.cr - a.cr),
        unmatchedCr: cr(p.unmatchedRs),
      }))
      .sort((a, b) => b.cr - a.cr),
  };
}

export async function buildBonds({ dir, log = console } = {}) {
  const purchased = parseCsv(await loadFile('purchased', dir));
  const encashed = parseCsv(await loadFile('encashed', dir));
  const out = { generatedAt: new Date().toISOString(), source: SOURCE, ...aggregate(purchased, encashed) };
  await store.writeJson(path.join(store.DATA_DIR, 'reference', 'electoral-bonds.json'), out);
  log.info(`Electoral bonds: ${out.purchasers.length} purchasers, ₹${out.verification.purchaseCr} Cr purchased, ${out.verification.matchedBonds} bonds linked to a party`);
  return out;
}

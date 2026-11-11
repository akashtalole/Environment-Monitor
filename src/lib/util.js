import crypto from 'node:crypto';

export const hash = (...parts) => crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);

export const clean = (s) =>
  String(s ?? '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const absUrl = (href, base) => {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Parses Indian portal dates (02-Dec-2026, 23/01/2026, 2026-01-23, 1700000000000) to YYYY-MM-DD. */
export function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  const s = clean(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[-/ .]([A-Za-z]{3})[A-Za-z]*[-/ .,]+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()] != null)
    return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return iso(+m[3], +m[2] - 1, +m[1]);
  return null;
}
const iso = (y, mo, d) => `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export const PROPOSAL_NO_RE = /\b(?:IA|SIA|FP|WL|CRZ)\/[A-Z]{2}\/(?:[A-Z0-9]+\/){1,3}\d+\/\d{4}\b/gi;

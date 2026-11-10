// Downloads report PDFs into a local cache and extracts per-page text.
// Uses poppler's `pdftotext -layout` when installed (keeps table columns aligned),
// otherwise the pure-JS `unpdf` (pdf.js). Pages with no text layer are counted so
// scanned documents can be routed to Claude, which reads page images directly.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetch } from 'undici';
import { HttpSession } from '../lib/http.js';
import { DATA_DIR } from '../lib/store.js';

const run = promisify(execFile);
export const CACHE_DIR = path.join(DATA_DIR, 'raw', 'docs');

export const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** @returns {Promise<{file:string, sha256:string, bytes:number}>} */
export async function downloadPdf(url, { caFile } = {}) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const urlKey = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, `${urlKey}.pdf`);
  try {
    const buf = await fs.readFile(file);
    return { file, sha256: sha(buf), bytes: buf.length };
  } catch {}
  const http = new HttpSession({ caFile });
  let buf;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { dispatcher: http.dispatcher, signal: AbortSignal.timeout(180000), headers: { accept: 'application/pdf,*/*' } });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} for ${url}`), { status: r.status });
      buf = Buffer.from(await r.arrayBuffer());
      break;
    } catch (e) {
      if (attempt >= 4 || (e.status && e.status < 500)) throw e;
      await new Promise((res) => setTimeout(res, 2000 * 2 ** (attempt - 1)));
    }
  }
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error(`Not a PDF: ${url}`);
  await fs.writeFile(file, buf);
  return { file, sha256: sha(buf), bytes: buf.length };
}

let hasPdftotext;
async function pdftotextAvailable() {
  if (hasPdftotext === undefined) hasPdftotext = await run('pdftotext', ['-v']).then(() => true, () => false);
  return hasPdftotext;
}

/** @returns {Promise<{pages:string[], engine:string}>} one string per page (1-indexed = index+1) */
export async function extractPages(file) {
  if (await pdftotextAvailable()) {
    const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 256 * 1024 * 1024 });
    const pages = stdout.split('\f');
    if (pages.at(-1)?.trim() === '') pages.pop();
    return { pages, engine: 'pdftotext' };
  }
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(file)));
  const { text } = await extractText(pdf, { mergePages: false });
  return { pages: text, engine: 'unpdf' };
}

/** Summary of how much of the document is machine-readable. */
export function textStats(pages) {
  const empty = pages.filter((p) => p.replace(/\s/g, '').length < 40).length;
  return { pageCount: pages.length, emptyPages: empty, scanned: pages.length > 0 && empty / pages.length > 0.6 };
}

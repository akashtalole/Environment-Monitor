// Helpers for the legacy ASP.NET WebForms portals (environmentclearance / forestsclearance).
import * as cheerio from 'cheerio';
import { clean } from '../lib/util.js';

/** Collects the form's current field values (hidden __VIEWSTATE etc., selects, inputs). */
export function formFields(html, formSel = 'form') {
  const $ = cheerio.load(html);
  const form = $(formSel).first();
  const fields = {};
  form.find('input[name]').each((_, el) => {
    const type = ($(el).attr('type') || 'text').toLowerCase();
    if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
    if (['checkbox', 'radio'].includes(type) && $(el).attr('checked') == null) return;
    fields[$(el).attr('name')] = $(el).attr('value') ?? '';
  });
  form.find('select[name]').each((_, el) => {
    const sel = $(el).find('option[selected]').first();
    fields[$(el).attr('name')] = (sel.length ? sel : $(el).find('option').first()).attr('value') ?? '';
  });
  const textInputs = form
    .find('input[name]')
    .filter((_, el) => ['text', 'search', ''].includes(($(el).attr('type') || 'text').toLowerCase()) && !/^__/.test($(el).attr('name')))
    .map((_, el) => $(el).attr('name'))
    .get();
  const submits = form
    .find('input[type=submit][name], button[type=submit][name], input[type=image][name]')
    .map((_, el) => ({ name: $(el).attr('name'), value: $(el).attr('value') ?? clean($(el).text()) }))
    .get();
  return { fields, textInputs, submits, action: form.attr('action') };
}

/** Parses label/value pairs from a "report" style page (two-cell rows). */
export function keyValueRows(html) {
  const $ = cheerio.load(html);
  const out = {};
  $('tr').each((_, tr) => {
    const cells = $(tr).children('td,th');
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const k = clean($(cells[i]).text()).replace(/[:：]\s*$/, '');
      const v = clean($(cells[i + 1]).text());
      if (k && v && k.length < 80 && !(k in out)) out[k] = v.slice(0, 1000);
    }
  });
  return out;
}

/** Generic grid parser: returns rows as arrays of cell text, plus links per row. */
export function gridRows(html, tableSel = 'table') {
  const $ = cheerio.load(html);
  const best = $(tableSel)
    .toArray()
    .map((t) => ({ t, n: $(t).find('tr').length }))
    .sort((a, b) => b.n - a.n)[0];
  if (!best) return [];
  return $(best.t)
    .find('tr')
    .toArray()
    .map((tr) => ({
      cells: $(tr).children('td').map((_, td) => clean($(td).text())).get(),
      links: $(tr).find('a[href]').map((_, a) => ({ label: clean($(a).text()), href: $(a).attr('href') })).get(),
    }))
    .filter((r) => r.cells.length > 2);
}

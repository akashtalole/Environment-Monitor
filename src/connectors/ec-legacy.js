// environmentclearance.nic.in – legacy EC portal (proposals before PARIVESH 2.0).
// Search.aspx is an ASP.NET WebForms page: we GET it, replay its hidden fields with the
// proposal number / keyword in the text box, and parse the result grid.
import { HttpSession } from '../lib/http.js';
import { formFields, gridRows } from './aspnet.js';
import { absUrl, hash, PROPOSAL_NO_RE } from '../lib/util.js';

const LEGACY_NO = /\b(?:IA\/[A-Z]{2}\/[A-Z]+\/\d+\/\d{4}|SIA\/[A-Z]{2}\/[A-Z]+\/\d+\/\d{4}|J-\d+\/\d+\/\d{4}-[A-Z.()\s-]+)/i;

export function ecRecordsFromGrid(rows, base) {
  return rows
    .map(({ cells, links }) => {
      const text = cells.join(' | ');
      const proposalNo = (text.match(new RegExp(PROPOSAL_NO_RE.source, 'i')) ?? text.match(LEGACY_NO))?.[0] ?? null;
      const longest = [...cells].sort((a, b) => b.length - a.length)[0];
      return {
        key: proposalNo?.toUpperCase() ?? hash(text),
        proposalNo: proposalNo?.toUpperCase() ?? null,
        title: longest?.slice(0, 200) ?? text.slice(0, 200),
        status: cells.find((c) => /granted|pending|reject|return|deferred|closed|delist|accepted|ToR|EC/i.test(c) && c.length < 80) ?? null,
        url: base,
        docs: links.map((l) => ({ label: l.label || 'Document', url: absUrl(l.href, base) })).filter((d) => d.url),
        fields: Object.fromEntries(cells.map((c, i) => [`col${i}`, c])),
        text,
      };
    })
    .filter((r) => r.proposalNo || r.text.length > 40);
}

export default {
  id: 'ec-legacy',
  async run({ source, projects, log }) {
    const queries = [...new Set(projects.flatMap((p) => p.ids?.ecLegacy ?? []))];
    if (!queries.length) return { records: [], skipped: 'No ecLegacy ids on the watchlist' };
    const http = new HttpSession({ caFile: source.caFile });
    const searchUrl = `${source.url}/Search.aspx`;
    const records = [];
    for (const q of queries) {
      const html = await http.getText(searchUrl);
      const { fields, textInputs, submits } = formFields(html);
      const box = textInputs.find((n) => /text|txt|search|prop/i.test(n)) ?? textInputs[0];
      if (!box) throw new Error('Search box not found on Search.aspx');
      fields[box] = q;
      if (submits[0]) fields[submits[0].name] = submits[0].value;
      const res = await http.request(searchUrl, {
        method: 'POST',
        body: new URLSearchParams(fields),
        headers: { 'content-type': 'application/x-www-form-urlencoded', referer: searchUrl },
      });
      const found = ecRecordsFromGrid(gridRows(res.text, 'table.ez1, table'), source.url + '/');
      log.info(`  ec-legacy "${q}": ${found.length}`);
      records.push(...found.map((r) => ({ ...r, fields: { ...r.fields, matchedQuery: q } })));
    }
    return { records };
  },
};

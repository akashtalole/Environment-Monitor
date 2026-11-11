// forestsclearance.nic.in – legacy Forest Clearance portal (proposals filed before PARIVESH 2.0).
// Report pages take the proposal number as ?pid=, e.g. viewreport.aspx?pid=FP/MH/HYD/12345/2019
import { HttpSession } from '../lib/http.js';
import { keyValueRows } from './aspnet.js';
import { toIsoDate } from '../lib/util.js';

const find = (kv, re) => Object.entries(kv).find(([k]) => re.test(k))?.[1] ?? null;

export function fcRecord(pid, kv, url) {
  return {
    key: pid.toUpperCase(),
    proposalNo: pid.toUpperCase(),
    title: find(kv, /proposal name|name of (the )?proposal|project name/i) ?? pid,
    status: find(kv, /proposal status|current status|^status/i),
    region: find(kv, /^state/i),
    date: toIsoDate(find(kv, /date of (stage|approval|in.principle|final)|last updated|date of submission/i)),
    url,
    fields: {
      userAgency: find(kv, /user agency/i),
      district: find(kv, /district/i),
      areaHa: find(kv, /area (applied|proposed)|forest area/i),
      category: find(kv, /category/i),
      stageI: find(kv, /stage.?i\b|in.principle/i),
      stageII: find(kv, /stage.?ii\b|final approval/i),
    },
    text: Object.entries(kv).map(([k, v]) => `${k}: ${v}`).join(' | ').slice(0, 4000),
  };
}

export default {
  id: 'fc-legacy',
  async run({ source, projects, log }) {
    const ids = [...new Set(projects.flatMap((p) => p.ids?.fcLegacy ?? []))];
    if (!ids.length) return { records: [], skipped: 'No fcLegacy ids on the watchlist' };
    const http = new HttpSession({ caFile: source.caFile });
    const records = [];
    for (const pid of ids) {
      const kv = {};
      let url;
      for (const page of source.options?.reportPages ?? ['viewreport.aspx']) {
        const u = `${source.url}/${page}?pid=${encodeURIComponent(pid)}`;
        try {
          Object.assign(kv, keyValueRows(await http.getText(u)));
          url ??= u;
        } catch (e) {
          log.warn(`  fc-legacy ${pid} ${page}: ${e.message}`);
        }
      }
      if (Object.keys(kv).length) records.push(fcRecord(pid, kv, url));
    }
    if (!records.length) throw new Error(`No FC legacy reports could be read for ${ids.join(', ')}`);
    return { records };
  },
};

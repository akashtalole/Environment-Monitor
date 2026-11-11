// PARIVESH committee agendas & minutes (EAC, SEAC, FAC, REC, Wildlife, CRZ).
// Endpoint: GET /parivesh_api/proponentApplicant/getParivesh1AgendaMom
// (public, no auth; used by open-source MoEFCC scrapers). Each record is a meeting;
// we match its subject/sector text against the watchlist and discovery keywords.
import { HttpSession } from '../lib/http.js';
import { absUrl, clean, hash, toIsoDate } from '../lib/util.js';

const ENDPOINT = '/parivesh_api/proponentApplicant/getParivesh1AgendaMom';

export function meetingRecord(r, feed, base) {
  const val = (...keys) => {
    for (const k of keys) {
      const hit = Object.keys(r).find((x) => x.toLowerCase() === k.toLowerCase());
      if (hit && r[hit] != null && r[hit] !== '') return r[hit];
    }
    return null;
  };
  const docUrl = val('Agenda_URL', 'agenda_url', 'MoM_URL', 'Mom_URL', 'mom_url', 'url', 'document_url');
  const subject = clean(val('subject', 'Subject', 'meeting_subject', 'title') ?? '');
  const date = val('from_date', 'meeting_date', 'date', 'to_date');
  const id = val('meeting_id', 'Agenda_id', 'agenda_id', 'mom_id', 'id');
  const extra = Object.entries(r)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${clean(v)}`)
    .join(' | ');
  return {
    key: `${feed.committee}-${feed.type}-${id ?? hash(subject, String(date))}`,
    title: `${feed.label}: ${subject || 'Meeting'}`,
    date: toIsoDate(date),
    status: `${feed.type === 'Mom' ? 'Minutes' : 'Agenda'} published`,
    url: docUrl ? absUrl(docUrl, base) : base,
    docs: docUrl ? [{ label: feed.type === 'Mom' ? 'Minutes' : 'Agenda', url: absUrl(docUrl, base) }] : [],
    region: clean(val('state', 'state_name', 'State') ?? '') || null,
    fields: { committee: feed.label, sector: clean(val('Project_Sector', 'project_sector', 'sector') ?? '') || null },
    text: extra.slice(0, 4000),
  };
}

export default {
  id: 'parivesh-committees',
  async run({ source, log }) {
    const http = new HttpSession({ caFile: source.caFile, retries: 2 });
    const records = [];
    const warnings = [];
    for (const feed of source.options?.feeds ?? []) {
      const q = new URLSearchParams({ committee: feed.committee, workgroup: feed.workgroup, type: feed.type, authority: feed.authority });
      try {
        const data = await http.getJson(`${source.url}${ENDPOINT}?${q}`);
        const list = Array.isArray(data) ? data : data?.data ?? data?.content ?? [];
        records.push(...list.map((r) => meetingRecord(r, feed, source.url)));
        log.info(`  ${feed.label}: ${list.length}`);
      } catch (e) {
        warnings.push(`${feed.label}: ${e.message}`);
        if (warnings.length >= 2 && !records.length) break; // portal unreachable
      }
    }
    if (!records.length && warnings.length) throw new Error(warnings[0]);
    return { records, warnings };
  },
};

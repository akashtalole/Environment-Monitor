// Turns free-text portal statuses into a common stage model so the dashboard can
// show where each project sits across EC / FC / Wildlife / CRZ / state consent tracks.

export const TRACKS = {
  EC: ['ToR applied', 'ToR granted', 'Public hearing', 'EC applied', 'Appraisal (EAC/SEAC)', 'EC granted'],
  FC: ['FC applied', 'Under examination', 'Stage-I (in-principle)', 'Stage-II (final)'],
  WL: ['WL applied', 'SBWL', 'NBWL', 'WL granted'],
  CRZ: ['CRZ applied', 'CZMA', 'CRZ granted'],
  PCB: ['Consent applied', 'CAC', 'Consent granted'],
};

const RULES = [
  // Negative outcomes first so "EC rejected" doesn't read as "EC".
  { re: /\b(reject|refus|denied|not recommended)/i, outcome: 'rejected' },
  { re: /\b(return|closed|delist|withdraw|lapsed|transferred)/i, outcome: 'closed' },
  { re: /\b(EDS|ADS|essential details|additional details|sought)/i, outcome: 'info-sought' },
  { re: /\bdeferred\b/i, outcome: 'deferred' },
];

const STAGE_RULES = [
  { track: 'FC', stage: 'Stage-II (final)', re: /stage[\s-]*(ii|2)\b|final approval|in final/i },
  { track: 'FC', stage: 'Stage-I (in-principle)', re: /stage[\s-]*(i|1)\b|in[\s-]*principle/i },
  { track: 'FC', stage: 'Under examination', re: /\b(FAC|REC|forest advisory|regional empowered|DFO|nodal officer|site inspection)\b/i },
  { track: 'FC', stage: 'FC applied', re: /forest (clearance|proposal)|\bFP\/[A-Z]{2}\//i },
  { track: 'WL', stage: 'NBWL', re: /\bNBWL|standing committee of national board/i },
  { track: 'WL', stage: 'SBWL', re: /\bSBWL|state board for wild ?life/i },
  { track: 'WL', stage: 'WL applied', re: /wild ?life (clearance|proposal)|\bWL\/[A-Z]{2}\//i },
  { track: 'CRZ', stage: 'CZMA', re: /\b(MCZMA|CZMA)\b/i },
  { track: 'CRZ', stage: 'CRZ applied', re: /\bCRZ\b/i },
  { track: 'PCB', stage: 'CAC', re: /consent appraisal committee|\bCAC\b/i },
  { track: 'PCB', stage: 'Consent granted', re: /consent (granted|issued)|\bCTE\b.*granted|\bCTO\b.*granted/i },
  { track: 'EC', stage: 'EC granted', re: /\b(EC|environment(al)? clearance)\b.*\b(granted|issued|accorded)|granted.*\bEC\b|\bEC letter/i },
  { track: 'EC', stage: 'ToR granted', re: /\bToR\b.*\b(granted|issued|accorded)|terms of reference.*(granted|issued)/i },
  { track: 'EC', stage: 'Appraisal (EAC/SEAC)', re: /\b(EAC|SEAC|SEIAA|expert appraisal|under appraisal|recommended|placed (in|before)|agenda|minutes)\b/i },
  { track: 'EC', stage: 'Public hearing', re: /public hearing|jan ?sunwai/i },
  { track: 'EC', stage: 'ToR applied', re: /\bToR\b|terms of reference/i },
  { track: 'EC', stage: 'EC applied', re: /\b(EC|environment(al)? clearance|EIA|IA\/[A-Z]{2}\/|SIA\/[A-Z]{2}\/)/i },
];

/** @returns {{track:string|null, stage:string|null, outcome:string|null}} */
export function classify(...texts) {
  const text = texts.filter(Boolean).join(' | ');
  if (!text) return { track: null, stage: null, outcome: null };
  const outcome = RULES.find((r) => r.re.test(text))?.outcome ?? null;
  const hit = STAGE_RULES.find((r) => r.re.test(text));
  return { track: hit?.track ?? null, stage: hit?.stage ?? null, outcome };
}

/** Clearance type from a PARIVESH-style proposal number, e.g. IA/MH/RIV/1234/2025 → EC. */
export function trackFromProposalNo(no = '') {
  const p = no.toUpperCase();
  if (/^FP\//.test(p)) return 'FC';
  if (/^WL\//.test(p)) return 'WL';
  if (/^(IA|SIA)\/.+\/(CRZ)/.test(p) || /^CRZ\//.test(p)) return 'CRZ';
  if (/^(IA|SIA)\//.test(p)) return 'EC';
  return null;
}

export function stageIndex(track, stage) {
  return TRACKS[track]?.indexOf(stage) ?? -1;
}

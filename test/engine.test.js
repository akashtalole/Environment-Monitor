import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, trackFromProposalNo } from '../src/lib/stages.js';
import { matchProjects, isDiscovery } from '../src/lib/match.js';
import { toIsoDate } from '../src/lib/util.js';
import { diffRecords } from '../src/monitor.js';

const projects = [
  { id: 'malshej', keywords: ['Malshej', 'Bhorande'], ids: { parivesh: [] } },
  { id: 'bhivpuri', keywords: ['Bhivpuri'], ids: { parivesh: ['IA/MH/RIV/111/2025'] } },
];
const discovery = { keywords: ['pumped storage', 'PSP'], regions: ['Maharashtra', 'Raigad'] };

test('dates in portal formats', () => {
  assert.equal(toIsoDate('02-Dec-2026'), '2026-12-02');
  assert.equal(toIsoDate('23/01/2026'), '2026-01-23');
  assert.equal(toIsoDate('2026-01-23T10:00:00'), '2026-01-23');
  assert.equal(toIsoDate('21 August, 2026'), '2026-08-21');
  assert.equal(toIsoDate(''), null);
});

test('status classification', () => {
  assert.deepEqual(classify('EC Granted'), { track: 'EC', stage: 'EC granted', outcome: null });
  assert.equal(classify('ToR issued').stage, 'ToR granted');
  assert.equal(classify('Approved Stage-I').stage, 'Stage-I (in-principle)');
  assert.equal(classify('Placed in EAC meeting').stage, 'Appraisal (EAC/SEAC)');
  assert.equal(classify('EC rejected').outcome, 'rejected');
  assert.equal(classify('EDS raised').outcome, 'info-sought');
  assert.equal(trackFromProposalNo('FP/MH/HYD/1/2025'), 'FC');
  assert.equal(trackFromProposalNo('SIA/MH/IND2/1/2025'), 'EC');
});

test('project matching by keyword and by proposal number', () => {
  assert.deepEqual(matchProjects({ title: 'MALSHEJ GHAT BHORANDE PUMPED STORAGE PROJECT' }, projects), ['malshej']);
  assert.deepEqual(matchProjects({ title: 'x', proposalNo: 'IA/MH/RIV/111/2025' }, projects), ['bhivpuri']);
  assert.deepEqual(matchProjects({ title: 'Krishna-Koyna lift irrigation' }, projects), []);
});

test('discovery needs a PSP keyword and a Maharashtra region term', () => {
  assert.ok(isDiscovery({ title: 'Saidongar-2 Pumped Storage Project, Dist. Raigad' }, discovery));
  assert.ok(!isDiscovery({ title: 'Pinnapuram Pumped Storage, Andhra Pradesh' }, discovery));
  assert.ok(!isDiscovery({ title: 'Mhaisal Pump House, Sangli' }, discovery), 'PSP needs whole-word match');
  assert.ok(isDiscovery({ title: 'XYZ PSP', region: 'Maharashtra' }, discovery));
});

test('diff emits new, changed and removed events', () => {
  const source = { id: 's', name: 'S' };
  const base = { key: 'k1', title: 'A', status: 'ToR applied', projectIds: ['malshej'], discovered: false, docs: [] };
  const prev = { k1: base, k2: { key: 'k2', title: 'Gone', projectIds: ['bhivpuri'], discovered: false } };
  const next = { k1: { ...base, status: 'ToR granted', docs: [{ url: 'u' }] }, k3: { key: 'k3', title: 'New', projectIds: [], discovered: true } };
  const ev = diffRecords(prev, next, { source, projectsById: {}, at: '2026-01-01T00:00:00Z', initial: false });
  const byKind = Object.fromEntries(ev.map((e) => [e.kind, e]));
  assert.deepEqual(Object.keys(byKind).sort(), ['changed', 'new', 'removed']);
  assert.deepEqual(byKind.changed.changes.map((c) => c.field), ['status', 'docs']);
  assert.equal(byKind.removed.recordKey, 'k2');
});

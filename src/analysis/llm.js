// Optional Claude-based extraction. Runs when ANTHROPIC_API_KEY (or another Anthropic
// credential) is available. Claude reads the PDF itself – including scanned pages that
// have no text layer – and returns schema-validated JSON with page numbers and verbatim
// quotes for every value, plus things rules can't capture: species lists, the impact
// matrix, public-hearing concerns and EC conditions.
import fs from 'node:fs/promises';
import { z } from 'zod';
import { METRICS, IMPACT_CATEGORIES } from './metrics.js';

export const LLM_MODEL = process.env.ENVMON_LLM_MODEL || 'claude-opus-5-5';
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_PDF_PAGES = 550;
const TEXT_CHUNK_CHARS = 600_000;

const evidence = (valueSchema) =>
  z.object({
    value: valueSchema.nullable(),
    page: z.number().int().nullable(),
    quote: z.string().nullable(),
  });

const metricShape = Object.fromEntries(
  METRICS.map((m) => [m.key, evidence(m.type === 'number' ? z.number() : m.type === 'boolean' ? z.boolean() : z.string())]),
);

export const ExtractionSchema = z.object({
  documentType: z.enum([
    'eia_report', 'executive_summary', 'public_hearing_order', 'public_hearing_minutes', 'tor_letter',
    'ec_letter', 'committee_agenda', 'committee_minutes', 'forest_clearance', 'advertisement', 'other',
  ]),
  projectName: z.string().nullable(),
  proponent: z.string().nullable(),
  summary: z.string(),
  metrics: z.object(metricShape),
  references: z.object({ proposalNumbers: z.array(z.string()), fileNumbers: z.array(z.string()) }),
  scheduleISpeciesList: z.array(z.string()),
  threatenedSpeciesList: z.array(z.object({ name: z.string(), status: z.enum(['CR', 'EN', 'VU', 'NT']) })),
  keyImpacts: z.array(
    z.object({
      category: z.enum(IMPACT_CATEGORIES),
      phase: z.enum(['construction', 'operation', 'both']),
      severity: z.enum(['low', 'medium', 'high']),
      summary: z.string(),
      mitigation: z.string().nullable(),
      page: z.number().int().nullable(),
    }),
  ),
  publicConcerns: z.array(z.object({ issue: z.string(), proponentResponse: z.string().nullable(), page: z.number().int().nullable() })),
  conditions: z.array(z.object({ text: z.string(), page: z.number().int().nullable() })),
});

const metricGuide = METRICS.map((m) => `- ${m.key}: ${m.label}${m.unit ? ` [${m.unit}]` : ''}${m.hint ? ` (${m.hint})` : ''}`).join('\n');

export const SYSTEM_PROMPT = `You extract facts from Indian environmental clearance documents (EIA/EMP reports, executive summaries, public hearing orders and minutes, ToR/EC letters, EAC/SEAC/FAC agendas and minutes) for an environmental impact analytics tool.

Rules:
- Report only what the document states. If a value is not stated, set value, page and quote to null. Never estimate.
- quote: copy the supporting text verbatim from the document (max ~300 characters). page: the 1-based PDF page it is on.
- Convert units to the ones in brackets: 1 crore = 100 lakh, so "₹93 lakh" is 0.93 crore; "58.06 lakh cum" stays 58.06 lakh m³; "1 Mm3" = 1 MCM; 1 sq km = 100 ha.
- For counts of Schedule-I or threatened species, add up all taxa (mammals, birds, herpetofauna, fish, plants) and list the names.
- protectedAreaKm is the shortest distance to any National Park, Wildlife Sanctuary, Tiger Reserve or Conservation Reserve.
- empCapitalCr / empTotalCr come from the EMP cost table total (capital, and capital + recurring).
- keyImpacts: the significant adverse impacts the document identifies, with its proposed mitigation. Use severity "high" for irreversible or large-scale impacts (forest loss, habitat fragmentation, displacement), "medium" for significant but mitigable ones, "low" otherwise.
- publicConcerns: issues raised by the public at a hearing (minutes only). conditions: specific conditions in ToR/EC/FC letters.

Metrics:
${metricGuide}`;

let client;
async function getClient() {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

export function llmEnabled() {
  if (process.env.ENVMON_LLM === 'off') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ENVMON_LLM === 'on');
}

async function callClaude(content, anthropic) {
  const response = await anthropic.beta.messages.parse({
    model: LLM_MODEL,
    max_tokens: 16000,
    // Server-side fallback: if a safety classifier declines, the API retries on a fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: zodOutputFormat(ExtractionSchema) },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') throw new Error(`Claude declined (${response.stop_details?.category ?? 'no category'})`);
  if (response.stop_reason === 'max_tokens') throw new Error('Extraction hit max_tokens');
  if (!response.parsed_output) throw new Error('Claude returned no parseable extraction');
  return { output: response.parsed_output, model: response.model, usage: response.usage };
}

let zodOutputFormat;

/**
 * @param {{file:string, bytes:number, pages:string[], scanned:boolean}} doc
 * @param {{client?: any}} opts – inject a client for tests
 */
export async function extractWithClaude(doc, opts = {}) {
  zodOutputFormat ??= (await import('@anthropic-ai/sdk/helpers/zod')).zodOutputFormat;
  const anthropic = opts.client ?? (await getClient());
  const ask = 'Extract the metrics and lists defined in the system prompt from this document.';

  // Whole PDF when it fits: Claude sees tables, maps and scanned pages as images.
  if (doc.bytes <= MAX_PDF_BYTES && doc.pages.length <= MAX_PDF_PAGES) {
    const data = (await fs.readFile(doc.file)).toString('base64');
    const r = await callClaude(
      [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }, { type: 'text', text: ask }],
      anthropic,
    );
    return { ...r, chunks: 1 };
  }
  // Very large reports: send the text layer in page-tagged chunks and merge.
  const chunks = [];
  let cur = '';
  doc.pages.forEach((p, i) => {
    const block = `\n=== Page ${i + 1} ===\n${p}`;
    if (cur.length + block.length > TEXT_CHUNK_CHARS && cur) (chunks.push(cur), (cur = ''));
    cur += block;
  });
  if (cur) chunks.push(cur);
  const outputs = [];
  for (const c of chunks) outputs.push((await callClaude([{ type: 'text', text: `${ask}\nThis is part of a longer report; page numbers are marked.\n${c}` }], anthropic)).output);
  return { output: mergeOutputs(outputs), model: LLM_MODEL, chunks: chunks.length };
}

/** Combines chunk results: first non-null metric wins, lists are concatenated and de-duplicated. */
export function mergeOutputs(outputs) {
  const [first, ...rest] = outputs;
  const merged = structuredClone(first);
  for (const o of rest) {
    for (const [k, v] of Object.entries(o.metrics)) if (merged.metrics[k]?.value == null && v.value != null) merged.metrics[k] = v;
    for (const key of ['scheduleISpeciesList', 'threatenedSpeciesList', 'keyImpacts', 'publicConcerns', 'conditions']) merged[key].push(...o[key]);
    merged.references.proposalNumbers.push(...o.references.proposalNumbers);
    merged.references.fileNumbers.push(...o.references.fileNumbers);
  }
  merged.scheduleISpeciesList = [...new Set(merged.scheduleISpeciesList)];
  merged.references.proposalNumbers = [...new Set(merged.references.proposalNumbers)];
  merged.references.fileNumbers = [...new Set(merged.references.fileNumbers)];
  return merged;
}

/** Normalises Claude's metrics into the shared { key: {value,page,quote,method} } shape. */
export function llmMetrics(output) {
  const out = {};
  for (const [k, v] of Object.entries(output.metrics)) if (v?.value != null) out[k] = { value: v.value, page: v.page, quote: v.quote ?? '', method: 'llm' };
  return out;
}

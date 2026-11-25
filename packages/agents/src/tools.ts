import { z } from 'zod';
import type { Permission } from '@astra/contracts';
import type { AgentApiClient } from './api-client';

/**
 * The approved tool catalogue (E15-F02-S01). Every tool wraps a platform API and names the permission it
 * needs, so an agent can never do more than the person it acts for. Tools the specification forbids to
 * agents (publishing plans or manuals, declining cover, overriding sanctions, changing warrants) are never
 * added here.
 */
export interface ToolDefinition<TInput extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: TInput;
  permission: Permission;
  /**
   * Write tools are refused for L0 and L1 agents whatever their warrant says. Propose tools only submit a
   * proposal that a person reviews and applies; they are refused for L0 agents.
   */
  risk: 'read' | 'propose' | 'write';
  run(input: z.infer<TInput>, api: AgentApiClient): Promise<unknown>;
}

function defineTool<T extends z.ZodType>(def: ToolDefinition<T>): ToolDefinition<T> {
  return def;
}

const limit = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe('Maximum rows to return (default 20).');

export const listAccounts = defineTool({
  name: 'list_accounts',
  description:
    'List accounts (travel sellers, card issuers and banks) the requester can see. Filter by status, kind or a name/code search. Returns id, code, name, kind, status and timestamps, plus nextCursor when more rows exist.',
  input: z.strictObject({
    status: z.enum(['onboarding', 'active', 'suspended', 'closed']).optional(),
    kind: z.enum(['travel_account', 'card_issuer', 'bank']).optional(),
    query: z.string().max(100).optional().describe('Text to match in the account name or code.'),
    limit,
  }),
  permission: 'accounts:read',
  risk: 'read',
  run: (i, api) =>
    api.get('/v1/accounts', { status: i.status, kind: i.kind, q: i.query, limit: i.limit ?? 20 }),
});

export const getAccount = defineTool({
  name: 'get_account',
  description: 'Get one account by its UUID.',
  input: z.strictObject({ accountId: z.uuid() }),
  permission: 'accounts:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/accounts/${i.accountId}`),
});

export const listEvents = defineTool({
  name: 'list_events',
  description:
    'List business events, newest first. Filter by event type (for example AccountRegistered), account UUID or correlation ID.',
  input: z.strictObject({
    type: z.string().max(64).optional(),
    accountId: z.uuid().optional(),
    correlationId: z.string().max(128).optional(),
    limit,
  }),
  permission: 'events:read',
  risk: 'read',
  run: (i, api) =>
    api.get('/v1/events', {
      type: i.type,
      accountId: i.accountId,
      correlationId: i.correlationId,
      limit: i.limit ?? 20,
    }),
});

export const listDeliveries = defineTool({
  name: 'list_event_deliveries',
  description:
    'List event deliveries to subscribers. Use status "dead" for the dead-letter queue (deliveries that used up their retries), "pending" for deliveries still being retried.',
  input: z.strictObject({
    status: z.enum(['pending', 'delivered', 'dead']).optional(),
    subscriber: z.string().max(200).optional(),
    limit,
  }),
  permission: 'events:read',
  risk: 'read',
  run: (i, api) =>
    api.get('/v1/event-deliveries', {
      status: i.status,
      subscriber: i.subscriber,
      limit: i.limit ?? 20,
    }),
});

export const searchAudit = defineTool({
  name: 'search_audit_trail',
  description:
    'Search the audit trail, newest first: who did what, when and why. Filter by action (for example account.registered), actor type, actor ID, resource type and ID, account UUID or correlation ID.',
  input: z.strictObject({
    action: z.string().max(100).optional(),
    actorType: z.enum(['user', 'partner', 'agent', 'system']).optional(),
    actorId: z.string().max(200).optional(),
    resourceType: z.string().max(100).optional(),
    resourceId: z.string().max(200).optional(),
    accountId: z.uuid().optional(),
    correlationId: z.string().max(128).optional(),
    limit,
  }),
  permission: 'audit:read',
  risk: 'read',
  run: (i, api) =>
    api.get('/v1/audit', {
      action: i.action,
      actorType: i.actorType,
      actorId: i.actorId,
      resourceType: i.resourceType,
      resourceId: i.resourceId,
      accountId: i.accountId,
      correlationId: i.correlationId,
      limit: i.limit ?? 20,
    }),
});

export const listFeatureFlags = defineTool({
  name: 'list_feature_flags',
  description: 'List feature flags with their global value and per-account overrides.',
  input: z.strictObject({}),
  permission: 'flags:read',
  risk: 'read',
  run: (_i, api) => api.get('/v1/feature-flags'),
});


// ---------------- Configuration agents (Increment 8) ----------------

const editionId = z.uuid().describe('The form edition (document) UUID.');
const manualId = z.uuid().describe('The rate manual version UUID.');

interface EditionText {
  text: string;
  pageStarts: number[];
}

/** The text of one page with the absolute character offset of its first character. */
function pageSlice(t: EditionText, page: number) {
  const starts = t.pageStarts.length ? t.pageStarts : [0];
  const start = starts[page - 1];
  if (start === undefined) return null;
  const end = starts[page] ?? t.text.length;
  return { page, offset: start, text: t.text.slice(start, end) };
}

export const getFormEdition = defineTool({
  name: 'get_form_edition',
  description:
    'Get a form library document (a filed form, schedule or rate manual): form number, edition, title, kind, insurer, page count and whether a variable map exists.',
  input: z.strictObject({ editionId }),
  permission: 'forms:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/form-editions/${i.editionId}`),
});

export const readDocument = defineTool({
  name: 'read_document',
  description:
    'Read a form library document by page. Without a page it returns the page count and the first 160 characters of every page; with a page it returns that page’s text and the absolute character offset of its first character. Offsets in other tools are absolute, so offset + position in the page text is the position in the whole document.',
  input: z.strictObject({ editionId, page: z.number().int().min(1).max(2000).optional().describe('1-based page number.') }),
  permission: 'forms:read',
  risk: 'read',
  run: async (i, api) => {
    const t = await api.get<EditionText>(`/v1/form-editions/${i.editionId}/text`);
    const pages = t.pageStarts.length ? t.pageStarts.length : 1;
    if (i.page === undefined) {
      return {
        pages,
        characters: t.text.length,
        outline: Array.from({ length: pages }, (_, n) => ({ page: n + 1, begins: pageSlice(t, n + 1)!.text.slice(0, 160) })),
      };
    }
    return pageSlice(t, i.page) ?? { error: `The document has ${pages} pages.` };
  },
});

export const findText = defineTool({
  name: 'find_text',
  description:
    'Find every occurrence of some exact wording in a form library document. Returns the absolute start and end character offsets, the page and the surrounding text of each, so a variable can be located exactly. Matching ignores letter case.',
  input: z.strictObject({ editionId, query: z.string().min(2).max(300), limit: z.number().int().min(1).max(30).optional() }),
  permission: 'forms:read',
  risk: 'read',
  run: async (i, api) => {
    const t = await api.get<EditionText>(`/v1/form-editions/${i.editionId}/text`);
    const hay = t.text.toLowerCase();
    const needle = i.query.toLowerCase();
    const out: { start: number; end: number; page: number; excerpt: string; context: string }[] = [];
    let at = hay.indexOf(needle);
    while (at >= 0 && out.length < (i.limit ?? 10)) {
      const starts = t.pageStarts.length ? t.pageStarts : [0];
      const page = starts.filter((s) => s <= at).length;
      out.push({ start: at, end: at + needle.length, page, excerpt: t.text.slice(at, at + needle.length), context: t.text.slice(Math.max(0, at - 80), at + needle.length + 80) });
      at = hay.indexOf(needle, at + needle.length);
    }
    return { matches: out, truncated: at >= 0 };
  },
});

export const listTextBrackets = defineTool({
  name: 'list_text_brackets',
  description:
    'List the bracketed wording and placeholders of a form: the places where a filed form varies. Each has exact offsets, the exact excerpt, its page, a deterministic suggested variable type with its range or options (when the wording is clear), and whether it is already mapped in a draft or approved map. Start here, then read the surrounding text before deciding.',
  input: z.strictObject({ editionId }),
  permission: 'forms:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/form-editions/${i.editionId}/brackets`),
});

export const getVariableMaps = defineTool({
  name: 'get_variable_maps',
  description: 'List the variable map versions of a form edition and return the variables of the newest one (key, label, type, constraints, location).',
  input: z.strictObject({ editionId }),
  permission: 'forms:read',
  risk: 'read',
  run: async (i, api) => {
    const maps = await api.get<{ items: { id: string; version: number; status: string }[] }>(`/v1/form-editions/${i.editionId}/maps`);
    const newest = maps.items[0];
    return { versions: maps.items, newest: newest ? await api.get(`/v1/variable-maps/${newest.id}`) : null };
  },
});

export const getManualOutline = defineTool({
  name: 'get_manual_outline',
  description:
    'Get a rate manual version without its table rows: code, state, benefit, status, formula (exposure, variables, peril package, waivers, supplemental, conversion) and every table’s id, name, page, keys and row count.',
  input: z.strictObject({ manualId }),
  permission: 'rating:read',
  risk: 'read',
  run: async (i, api) => {
    const m = await api.get<{ document: { tables: { id: string; name: string; page: string; keys: unknown; rows: unknown[]; unused: unknown; unknown: unknown }[] } & Record<string, unknown> } & Record<string, unknown>>(`/v1/rate-manuals/${i.manualId}`);
    const { document: d, ...meta } = m;
    return { ...meta, formula: { ...d, tables: undefined }, tables: d.tables.map((t) => ({ id: t.id, name: t.name, page: t.page, keys: t.keys, rows: t.rows.length, unused: t.unused, unknown: t.unknown })) };
  },
});

export const getManualTable = defineTool({
  name: 'get_manual_table',
  description: 'Get one table of a rate manual with all its rows and its manual page.',
  input: z.strictObject({ manualId, tableId: z.string().min(1).max(60) }),
  permission: 'rating:read',
  risk: 'read',
  run: async (i, api) => {
    const m = await api.get<{ document: { tables: { id: string }[] } }>(`/v1/rate-manuals/${i.manualId}`);
    return m.document.tables.find((t) => t.id === i.tableId) ?? { error: `The manual has no table ${i.tableId}.` };
  },
});

export const getParityRun = defineTool({
  name: 'get_parity_run',
  description:
    'Get the latest parity run of a rate manual: for each case, whether it matches, the expected and engine amounts, and every worksheet step where the engine’s value differs from the workbook’s expected value.',
  input: z.strictObject({ manualId }),
  permission: 'rating:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/rate-manuals/${i.manualId}/parity-runs/latest`),
});

export const getParityCases = defineTool({
  name: 'get_parity_cases',
  description:
    'Get the parity cases of a rate manual as imported from the workbook file: each case’s name, the row of the file it came from, its inputs and the expected value of each factor column.',
  input: z.strictObject({ manualId }),
  permission: 'rating:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/rate-manuals/${i.manualId}/parity-cases`),
});

export const submitVariableMap = defineTool({
  name: 'submit_variable_map_proposal',
  description:
    'Submit the proposed variable map for a form edition. Nothing is saved to the map: a product manager reviews every variable, corrects or rejects it, and saves the accepted ones. Each variable needs its exact offsets and excerpt (from list_text_brackets or find_text), a type with its range or options as filed, and a rationale. Submit once with everything; if the result lists failed checks, fix those variables and submit again.',
  input: z.strictObject({
    kind: z.literal('variable_map'),
    editionId,
    summary: z.string().min(5).max(1000).describe('What the form contains and what you propose, in two or three sentences.'),
    items: z.array(z.record(z.string(), z.unknown())).min(1).max(300).describe('Each item: { variable: { key, label, type, constraints fields as the type requires, textStart, textEnd, excerpt, notes? }, rationale }'),
  }),
  permission: 'proposals:create',
  risk: 'propose',
  run: (i, api) => api.post('/v1/agent-proposals', i),
});

export const submitRateManual = defineTool({
  name: 'submit_rate_manual_proposal',
  description:
    'Submit a drafted rate manual (its tables, bands, factors and formula, each table with the manual’s own page label). Nothing is loaded: a rating analyst reviews it against the filed pages and loads it as a draft. The platform checks that each table’s page exists in the document and that each factor is printed on that page; list anything you could not read in uncertainties. If the result lists tables whose factors were not found, re-read those pages and submit again.',
  input: z.strictObject({
    kind: z.literal('rate_manual'),
    editionId,
    summary: z.string().min(5).max(1000),
    manual: z.record(z.string(), z.unknown()).describe('{ code, state, benefit, effectiveFrom, document } where document follows the manual format in your instructions.'),
    uncertainties: z.array(z.string().min(3).max(500)).max(50).optional(),
  }),
  permission: 'proposals:create',
  risk: 'propose',
  run: (i, api) => api.post('/v1/agent-proposals', i),
});

export const submitParityExplanation = defineTool({
  name: 'submit_parity_explanation',
  description:
    'Submit explanations of the parity differences of a rate manual. Each item names a failed case, the worksheet step where the engine and the workbook diverge, why, the manual page of that step’s table and the workbook cell (row of the imported file and the factor column) that holds the expected value. The platform checks every citation against the latest run, the manual and the imported file.',
  input: z.strictObject({
    kind: z.literal('parity_explanation'),
    manualId,
    summary: z.string().min(5).max(1000),
    items: z.array(z.record(z.string(), z.unknown())).min(1).max(200).describe('Each item: { caseId, step, explanation, manualPage, workbookCell: { row, column } }'),
  }),
  permission: 'proposals:create',
  risk: 'propose',
  run: (i, api) => api.post('/v1/agent-proposals', i),
});
const templateId = z.uuid().describe('The document template UUID.');

export const getPlanVersion = defineTool({
  name: 'get_plan_version',
  description:
    'Get a plan version: its benefits, packaging, the values the plan gives to the variables of its schedule and policy form (keyed schedule:key or policy:key), its settings and its timing. This is the configuration a document must reflect.',
  input: z.strictObject({ planVersionId: z.uuid().describe('The plan version UUID.') }),
  permission: 'plans:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/plan-versions/${i.planVersionId}`),
});

export const getDocumentTemplate = defineTool({
  name: 'get_document_template',
  description:
    'Get a document template: the plan version, the filed form edition and approved variable map version it was assembled from, the assembled text, the problems and checks of the assembly, and any findings that already hold it.',
  input: z.strictObject({ templateId }),
  permission: 'documents:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/document-templates/${i.templateId}`),
});

export const listPolicyDocuments = defineTool({
  name: 'list_policy_documents',
  description: 'List the documents issued for a policy (kind, status, template, hash and delivery status). Use get_issued_document to read one.',
  input: z.strictObject({ policyId: z.uuid() }),
  permission: 'documents:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/policies/${i.policyId}/documents`),
});

export const getIssuedDocument = defineTool({
  name: 'get_issued_document',
  description: 'Get an issued document with its full text, the template or builder version that produced it and its delivery status.',
  input: z.strictObject({ documentId: z.uuid() }),
  permission: 'documents:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/documents/${i.documentId}`),
});

export const submitDocumentFindings = defineTool({
  name: 'submit_document_findings',
  description:
    'Submit what you found wrong in a document template or an issued document. Each finding quotes the exact text it is about (the platform checks the quote is in the document) and says what is wrong and why, with severity "hold" for a defect that must stop the template being released and "note" for something a person should know. Submit once, with every finding; if nothing is wrong, submit an empty list so the check is on record. A person reviews every finding.',
  input: z.strictObject({
    kind: z.literal('document_quality'),
    subjectType: z.enum(['document_template', 'document']),
    subjectId: z.uuid(),
    summary: z.string().min(5).max(1000),
    findings: z.array(z.strictObject({ quote: z.string().min(3).max(500), issue: z.string().min(5).max(1000), severity: z.enum(['hold', 'note']).optional() })).max(100),
  }),
  permission: 'proposals:create',
  risk: 'propose',
  run: (i, api) => api.post('/v1/agent-proposals', i),
});

const servicingRequest = z.record(z.string(), z.unknown()).describe('The change: { type, reason, ... } where type is cancel, change_dates, change_cost, add_traveller, remove_traveller, change_destinations, add_benefits or correct, with the fields that type needs.');

export const findPolicy = defineTool({
  name: 'find_policy',
  description: 'Find policies by number or traveller name. Returns id, number, status, plan, cover dates, premium and traveller names.',
  input: z.strictObject({ query: z.string().min(2).max(100), limit }),
  permission: 'policies:read',
  risk: 'read',
  run: (i, api) => api.get('/v1/policies', { q: i.query, limit: i.limit ?? 10 }),
});

export const getPolicy = defineTool({
  name: 'get_policy',
  description: 'Get a policy: status, review period, travellers, trip, benefits with limits and cover dates, premium, and its history.',
  input: z.strictObject({ policyId: z.uuid() }),
  permission: 'policies:read',
  risk: 'read',
  run: (i, api) => api.get(`/v1/policies/${i.policyId}`),
});

export const previewPolicyChange = defineTool({
  name: 'preview_policy_change',
  description:
    'Preview a change, cancellation or correction without making it. Returns whether it is allowed (and why not), what would change, the premium before and after, what is charged or refunded and the rule behind it, whether the review period is running, and confirmAmount. Always preview first and tell the person the change and the price.',
  input: z.strictObject({ policyId: z.uuid(), request: servicingRequest }),
  permission: 'servicing:execute',
  risk: 'read',
  run: (i, api) => api.post(`/v1/policies/${i.policyId}/servicing/preview`, i.request),
});

export const applyPolicyChange = defineTool({
  name: 'apply_policy_change',
  description:
    'Make a change, cancellation or correction that you have previewed. Only after the person has confirmed the change and its price in their own words: put those words in agentConfirmation exactly as they wrote them, and pass the confirmAmount from the preview. The platform refuses if the person has not confirmed, if the price has moved, or if the request is outside your limits (it is then queued for a person).',
  input: z.strictObject({ policyId: z.uuid(), request: servicingRequest, confirmAmount: z.string().regex(/^-?\d+(\.\d{1,2})?$/), agentConfirmation: z.string().min(2).max(500) }),
  permission: 'servicing:execute',
  risk: 'write',
  run: (i, api) => api.post(`/v1/policies/${i.policyId}/servicing`, { request: i.request, confirmAmount: i.confirmAmount, agentConfirmation: i.agentConfirmation }, { 'idempotency-key': `agent-${api.correlationId}-${i.policyId}` }),
});

export const TOOL_CATALOGUE: Record<string, ToolDefinition> = Object.fromEntries(
  [
    listAccounts,
    getAccount,
    listEvents,
    listDeliveries,
    searchAudit,
    listFeatureFlags,
    getFormEdition,
    readDocument,
    findText,
    listTextBrackets,
    getVariableMaps,
    getManualOutline,
    getManualTable,
    getParityRun,
    getParityCases,
    submitVariableMap,
    submitRateManual,
    submitParityExplanation,
    getPlanVersion,
    getDocumentTemplate,
    listPolicyDocuments,
    getIssuedDocument,
    submitDocumentFindings,
    findPolicy,
    getPolicy,
    previewPolicyChange,
    applyPolicyChange,
  ].map((t) => [
    t.name,
    t as unknown as ToolDefinition,
  ]),
);

/** JSON Schema for a tool's input, in the form the Messages API expects. */
export function toolInputSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

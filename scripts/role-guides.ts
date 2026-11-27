/**
 * Writes a short guide for each staff role (E16-F02-S02) to docs/guides. The screens and permissions come from the
 * code the workbench and API use, so a guide cannot promise something the role cannot do; the "what you do here"
 * steps are written below and should be revised after training sessions.
 *
 *   node --import tsx scripts/role-guides.ts          write the guides
 *   node --import tsx scripts/role-guides.ts --check  fail if a guide is out of date
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, STAFF_ROLES, type StaffRole } from '../packages/contracts/src/rbac';
import { NAVIGATION } from '../apps/workbench/src/lib/navigation';

const TASKS: Record<StaffRole, { purpose: string; steps: { task: string; how: string }[] }> = {
  product_manager: {
    purpose: 'You turn filed forms into plans that can be sold.',
    steps: [
      { task: 'Load a form or schedule', how: 'Forms & schedules, then upload the filed file. Its variables are the bracketed items; propose a variable map or ask the agent, and have someone else approve it.' },
      { task: 'Build a plan', how: 'Plans, then create a base, state or account plan from a benefit catalogue. Add test cases and run them; a plan publishes only when approved by someone who did not write it and every check passes.' },
      { task: 'Release documents', how: 'Documents, Templates: assemble the schedule or policy form for a plan version; compliance releases it.' },
    ],
  },
  rating_analyst: {
    purpose: 'You load filed rate manuals and prove they rate to the cent.',
    steps: [
      { task: 'Load a manual', how: 'Rate manuals, then enter or import its tables and formula, or ask the agent to draft them from the filed document and check every table.' },
      { task: 'Prove parity', how: 'Add the workbook cases and run parity. A manual publishes only at 100% parity and after a second person approves it.' },
      { task: 'Load reference data', how: 'Reference data: load premium tax rates and prohibited destinations; another person approves each version.' },
    ],
  },
  underwriter: {
    purpose: 'You set eligibility rules and decide the cases they send to a person.',
    steps: [
      { task: 'Work your queue', how: 'Work queue, filter “Held by: me” or take a referral. The timer shows how long is left.' },
      { task: 'Decide a referral', how: 'Open it, read the rules that fired, ask the Underwriting Referral agent for a summary if you want one, then accept, correct or reject the summary, and approve or decline with a reason. A decline is always your decision; the reason goes back to the seller.' },
      { task: 'Clear a sanctions hold', how: 'Check the traveller against the entry shown. Clear it or confirm it; a cleared refund hold releases the refund to billing.' },
      { task: 'Maintain rules and lists', how: 'Underwriting rules and Sanctions lists: draft, test, and have a second person approve and publish.' },
    ],
  },
  account_manager: {
    purpose: 'You onboard accounts and look after what they sell.',
    steps: [
      { task: 'Onboard an account', how: 'Accounts, register it, then complete the onboarding checklist: contract, segment, licences, plans, integration test. Make a sandbox to test safely.' },
      { task: 'Set up sales channels', how: 'The account’s Sales channels: branding, widget origins, hosted journey. Preview the widget from a quote.' },
      { task: 'Review results', how: 'Account reports: sales, premium, take-up, cancellations and refunds, with CSV download.' },
    ],
  },
  service_rep: {
    purpose: 'You help travellers with their policies.',
    steps: [
      { task: 'Find a policy', how: 'Find a policy: search by number, traveller, account, destination or trip date.' },
      { task: 'Change or cancel', how: 'Open the policy and preview the change. Tell the traveller the price or refund shown, and confirm only what they agreed.' },
      { task: 'Check card cover', how: 'Cover check: whether a cardholder was covered for a trip.' },
    ],
  },
  finance_analyst: {
    purpose: 'You make sure every premium reaches billing, correctly.',
    steps: [
      { task: 'Clear held records', how: 'Premium records, filter held. Each shows why: a missing tax rate, commission rule or a sanctions review. Fix the cause and recalculate.' },
      { task: 'Send and reconcile batches', how: 'Billing batches: control totals and the billing system’s confirmations; investigate mismatches.' },
      { task: 'Report', how: 'Statutory data reconciles to the premium records; Account reports show sales and refunds.' },
    ],
  },
  card_programme_manager: {
    purpose: 'You set up card programmes and keep eligibility correct.',
    steps: [
      { task: 'Set up a programme', how: 'Master policies, then Card programmes. Send test feeds until one passes, then take the programme live.' },
      { task: 'Map an issuer’s file', how: 'The programme’s Issuer file mapping: keep a sample, ask the agent to draft the mapping or write it, check the sample records, and approve.' },
      { task: 'Watch feeds', how: 'Open a feed to see what it changed and what it rejected; ask the agent to explain rejections and approve each fix.' },
    ],
  },
  compliance_officer: {
    purpose: 'You make sure what is sold is filed, released and traceable.',
    steps: [
      { task: 'Filings and licences', how: 'Filing register and Licences: what may be sold, where, and when licences expire.' },
      { task: 'Release documents', how: 'Documents, Templates: check an assembled template and release it, and resolve document quality findings.' },
      { task: 'Answer a regulator', how: 'Open the premium record or document and download its audit trace; Statutory data for premium by state, entity and benefit; Audit trail with integrity check.' },
    ],
  },
  ops_supervisor: {
    purpose: 'You see that nothing waits too long.',
    steps: [
      { task: 'Run the queue', how: 'Work queue: overdue and unassigned first. Give work to a person (they must have signed in once) and set the timers.' },
      { task: 'Fix failures', how: 'Delivery failures and Events & deliveries: retry or replay once the cause is fixed.' },
      { task: 'Oversee agents', how: 'AI agents and Agent reviews: pause an agent if needed; review the sample of changes the servicing agent made.' },
    ],
  },
  ai_governance_lead: {
    purpose: 'You decide what the AI agents may do.',
    steps: [
      { task: 'Approve a version', how: 'AI agents: set the warrant and budget, run the evaluation, and approve a version only when it passes.' },
      { task: 'Watch quality', how: 'Agent reviews and each run’s record; what people accepted, corrected or rejected is kept for evaluation.' },
      { task: 'Stop an agent', how: 'Pause it from its page; runs stop at once.' },
    ],
  },
  platform_admin: {
    purpose: 'You administer the platform. Use a business role for business work.',
    steps: [
      { task: 'Feature flags', how: 'Feature flags: switch capabilities by account.' },
      { task: 'Operations', how: 'Events & deliveries, Audit trail verification, and the data platform loads through the API.' },
    ],
  },
};

export function roleGuide(role: StaffRole): string {
  const can = new Set(ROLE_PERMISSIONS[role]);
  const t = TASKS[role];
  const screens = NAVIGATION.flatMap((s) => s.items.filter((i) => i.permission === null || can.has(i.permission)).map((i) => ({ section: s.label, ...i })));
  return [
    `# ${ROLE_LABELS[role]}`,
    '',
    '<!-- Generated by scripts/role-guides.ts. Edit the script, not this file. -->',
    '',
    t.purpose,
    '',
    '## Signing in',
    '',
    'Open the workbench and sign in with your work account. The menu shows only what your role may use. If something you need is missing, ask your administrator about your role rather than borrowing another account: everything is recorded against the person signed in.',
    '',
    '## What you do here',
    '',
    ...t.steps.flatMap((s) => [`### ${s.task}`, '', s.how, '']),
    '## Your screens',
    '',
    '| Menu | Screen | What it is for |',
    '|---|---|---|',
    ...screens.map((s) => `| ${s.section} | ${s.label} | ${s.description} |`),
    '',
    '## What your role may do',
    '',
    ...[...can].sort().map((p) => `- ${PERMISSIONS[p]}`),
    '',
    '## Rules everyone follows',
    '',
    '- Where the platform asks for a second person, it will not accept your own approval.',
    '- AI agents propose; people decide. Read what an agent shows before accepting it.',
    '- Do not paste card numbers or social security numbers anywhere.',
    '',
  ].join('\n');
}

const dir = resolve(import.meta.dirname, '../docs/guides');
const files: [string, string][] = [
  ...STAFF_ROLES.map((r): [string, string] => [`${r.replace(/_/g, '-')}.md`, roleGuide(r)]),
  ['README.md', ['# Role guides', '', '<!-- Generated by scripts/role-guides.ts. -->', '', 'One short guide for each staff role. Training sessions are still to be arranged with Assurant.', '', ...STAFF_ROLES.map((r) => `- [${ROLE_LABELS[r]}](${r.replace(/_/g, '-')}.md)`), ''].join('\n')],
];

if (process.argv.includes('--check')) {
  const stale = files.filter(([name, body]) => {
    try {
      return readFileSync(resolve(dir, name), 'utf8').replace(/\r\n/g, '\n') !== body;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`Out of date: ${stale.map(([n]) => n).join(', ')}. Run: node --import tsx scripts/role-guides.ts`);
    process.exit(1);
  }
  console.log(`${files.length} guides are up to date.`);
} else {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of files) writeFileSync(resolve(dir, name), body, 'utf8');
  console.log(`Wrote ${files.length} files to docs/guides.`);
}

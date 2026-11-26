-- Increment 15: the workbench (E11-F01-S01, E11-F02-S01, E11-F02-S02, E03-F05-S01). Design: docs/adr/0016.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA workbench;
GRANT USAGE ON SCHEMA workbench TO astra_app;

-- ---------------------------------------------------------------- Search
-- Policy search reads these; the account's row-level security still decides what a person can see.
CREATE INDEX policies_number_trgm ON policies.policies USING gin (lower(number) gin_trgm_ops);
CREATE INDEX policy_travellers_name_trgm ON policies.policy_travellers
  USING gin (lower(first_name || ' ' || last_name) gin_trgm_ops);
CREATE INDEX accounts_name_trgm ON platform.accounts USING gin (lower(name) gin_trgm_ops);
CREATE INDEX accounts_code_trgm ON platform.accounts USING gin (lower(code) gin_trgm_ops);
-- A trip is found by where it goes (country code or region) or by its dates.
CREATE INDEX quotes_destinations_trgm ON policies.quotes USING gin (lower((request->'trip'->'destinations')::text) gin_trgm_ops);
CREATE INDEX quotes_departure ON policies.quotes ((request->'trip'->>'departureDate'));
CREATE INDEX quotes_return ON policies.quotes ((request->'trip'->>'returnDate'));

-- ---------------------------------------------------------------- Task queue
-- How long each kind of work may wait. The specification gives no response times, so these are settings an
-- operations supervisor changes; the values seeded here are placeholders to be agreed with Assurant.
CREATE TABLE workbench.sla_policies (
  source_type   text PRIMARY KEY CHECK (source_type IN ('referral', 'sanctions_hold', 'agent_proposal', 'agent_review', 'delivery_failure')),
  priority      text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  target_hours  integer NOT NULL CHECK (target_hours BETWEEN 1 AND 720),
  updated_by    text NOT NULL DEFAULT 'system',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workbench.sla_policies (source_type, priority, target_hours) VALUES
  ('sanctions_hold', 'urgent', 4),
  ('referral', 'high', 24),
  ('agent_review', 'normal', 24),
  ('delivery_failure', 'normal', 24),
  ('agent_proposal', 'normal', 72);

-- Who holds a piece of work. The work itself stays in its own table; closing it there closes it here.
CREATE TABLE workbench.assignments (
  source_type   text NOT NULL CHECK (source_type IN ('referral', 'sanctions_hold', 'agent_proposal', 'agent_review', 'delivery_failure')),
  source_id     uuid NOT NULL,
  owner         text NOT NULL,
  owner_name    text NULL,
  assigned_by   text NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_id)
);
CREATE INDEX assignments_by_owner ON workbench.assignments (owner);

-- Everything that waits for a person, in one place. A view, so nothing is copied and nothing can be lost.
CREATE VIEW workbench.queue WITH (security_invoker = true) AS
  SELECT w.source_type, w.source_id, w.title, w.summary, w.account_id, w.created_at, w.link,
         s.priority, w.created_at + make_interval(hours => s.target_hours) AS due_at, s.target_hours,
         a.owner, a.owner_name, a.assigned_at
    FROM (
      SELECT CASE WHEN r.kind = 'sanctions' THEN 'sanctions_hold' ELSE 'referral' END AS source_type,
             r.id AS source_id,
             CASE WHEN r.kind = 'sanctions' THEN 'Sanctions hold: ' ELSE 'Referral: ' END || r.case_ref AS title,
             r.summary, NULL::uuid AS account_id, r.created_at, '/underwriting/referrals/' || r.id AS link
        FROM underwriting.referrals r WHERE r.status = 'open'
      UNION ALL
      SELECT 'agent_proposal', p.id, 'Agent proposal: ' || replace(p.kind, '_', ' '), p.summary, NULL, p.created_at, '/proposals/' || p.id
        FROM agents.proposals p WHERE p.status = 'open'
      UNION ALL
      SELECT 'agent_review', v.id, 'Agent needs review: ' || replace(v.kind, '_', ' '), v.summary, NULL, v.created_at, '/agents/reviews'
        FROM agents.reviews v WHERE v.status = 'open'
      UNION ALL
      SELECT 'delivery_failure', d.id, 'Not delivered: ' || doc.title, coalesce(d.last_error, 'Delivery failed'), d.account_id, d.updated_at, '/documents/' || doc.id
        FROM documents.deliveries d JOIN documents.documents doc ON doc.id = d.document_id WHERE d.status = 'failed'
    ) w
    JOIN workbench.sla_policies s ON s.source_type = w.source_type
    LEFT JOIN workbench.assignments a ON a.source_type = w.source_type AND a.source_id = w.source_id;

-- ---------------------------------------------------------------- What a person decided about an agent's output
-- Accepted, edited or rejected, with the person's reason: the record evaluation learns from. Never changed.
CREATE TABLE agents.output_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES agents.runs (id),
  agent_id       text NOT NULL REFERENCES agents.agents (id),
  subject_type   text NOT NULL CHECK (subject_type IN ('referral_summary')),
  subject_id     uuid NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('accepted', 'edited', 'rejected')),
  original       jsonb NOT NULL,
  edited         jsonb NULL,
  reason         text NULL CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 1000),
  decided_by     text NOT NULL,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id),
  CHECK ((decision = 'edited') = (edited IS NOT NULL)),
  CHECK (decision = 'accepted' OR reason IS NOT NULL)
);
CREATE INDEX output_decisions_by_agent ON agents.output_decisions (agent_id, decided_at DESC);
CREATE TRIGGER output_decisions_immutable BEFORE UPDATE OR DELETE ON agents.output_decisions
  FOR EACH ROW EXECUTE FUNCTION audit.prevent_change();

-- ---------------------------------------------------------------- AG-04 referral summaries
-- What the Underwriting Referral agent wrote about a referral. The agent proposes; an underwriter reads it, and
-- may accept, edit or reject it. It never decides the referral.
CREATE TABLE underwriting.referral_summaries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id   uuid NOT NULL REFERENCES underwriting.referrals (id),
  run_id        uuid NULL REFERENCES agents.runs (id),
  summary       text NOT NULL CHECK (char_length(summary) BETWEEN 20 AND 4000),
  rules_cited   text[] NOT NULL DEFAULT '{}',
  suggested     text NOT NULL CHECK (suggested IN ('approve', 'decline', 'needs_information')),
  verification  jsonb NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_summaries_by_referral ON underwriting.referral_summaries (referral_id, created_at DESC);
CREATE TRIGGER referral_summaries_immutable BEFORE UPDATE OR DELETE ON underwriting.referral_summaries
  FOR EACH ROW EXECUTE FUNCTION audit.prevent_change();

GRANT SELECT ON workbench.queue TO astra_app;
GRANT SELECT ON workbench.sla_policies TO astra_app;
GRANT UPDATE (priority, target_hours, updated_by, updated_at) ON workbench.sla_policies TO astra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workbench.assignments TO astra_app;
GRANT SELECT, INSERT ON agents.output_decisions TO astra_app;
GRANT SELECT, INSERT ON underwriting.referral_summaries TO astra_app;

-- People who have signed in to the workbench, so work can be handed to them. The identity provider stays the
-- source of truth for who they are and what they may do; this is only what was last seen.
CREATE TABLE workbench.staff (
  subject      text PRIMARY KEY,
  name         text NULL,
  email        text NULL,
  roles        text[] NOT NULL DEFAULT '{}',
  permissions  text[] NOT NULL DEFAULT '{}',
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON workbench.staff TO astra_app;

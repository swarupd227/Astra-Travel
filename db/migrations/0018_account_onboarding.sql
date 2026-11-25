-- Increment 13: account onboarding and configuration (E07). Design: docs/adr/0014.

CREATE SCHEMA onboarding;
GRANT USAGE ON SCHEMA onboarding TO astra_app;

-- A sandbox twin is a separate account that can quote and bind with synthetic data; it is never billed.
ALTER TABLE platform.accounts ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
ALTER TABLE platform.accounts ADD COLUMN sandbox_of uuid NULL REFERENCES platform.accounts (id);
ALTER TABLE platform.accounts ADD COLUMN licences_enforced boolean NOT NULL DEFAULT false;
ALTER TABLE platform.accounts ADD COLUMN live_at timestamptz NULL;
CREATE UNIQUE INDEX one_sandbox_twin ON platform.accounts (sandbox_of) WHERE sandbox_of IS NOT NULL;
ALTER TABLE platform.accounts ADD CONSTRAINT sandbox_twin_is_sandbox CHECK (sandbox_of IS NULL OR sandbox);

CREATE TABLE onboarding.profiles (
  account_id          uuid PRIMARY KEY REFERENCES platform.accounts (id),
  contract_reference  text NULL,
  contract_signed_on  date NULL,
  states              text[] NOT NULL DEFAULT '{}',
  plans               text[] NOT NULL DEFAULT '{}',
  integration_method  text NULL CHECK (integration_method IN ('api', 'files', 'mulesoft', 'widget')),
  rate_basis          jsonb NULL,
  settlement          jsonb NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          text NOT NULL
);

-- Segment changes: an underwriter other than the requester decides; the one in force is the latest approved on the date.
CREATE TABLE onboarding.segment_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES platform.accounts (id),
  segment         text NOT NULL,
  effective_from  date NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  reason          text NOT NULL,
  requested_by    text NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  decided_by      text NULL,
  decided_at      timestamptz NULL,
  decision_note   text NULL,
  CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX segment_changes_by_account ON onboarding.segment_changes (account_id, effective_from DESC);

CREATE TABLE onboarding.collected_variables (
  account_id    uuid PRIMARY KEY REFERENCES platform.accounts (id),
  not_collected text[] NOT NULL,
  reason        text NOT NULL,
  decided_by    text NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE onboarding.licences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES platform.accounts (id),
  kind        text NOT NULL CHECK (kind IN ('retailer_registration', 'producer_licence')),
  state       char(2) NOT NULL,
  number      text NOT NULL,
  holder      text NOT NULL,
  valid_from  date NOT NULL,
  expires_on  date NOT NULL CHECK (expires_on > valid_from),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, state, number)
);
CREATE INDEX licences_by_account_state ON onboarding.licences (account_id, state);
CREATE INDEX licences_expiring ON onboarding.licences (expires_on) WHERE status = 'active';

CREATE TABLE onboarding.licence_alerts (
  licence_id  uuid NOT NULL REFERENCES onboarding.licences (id),
  account_id  uuid NOT NULL REFERENCES platform.accounts (id),
  days        integer NOT NULL CHECK (days IN (60, 30)),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (licence_id, days)
);

-- The contract and term sheet the Account Onboarding agent reads.
CREATE TABLE onboarding.documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES platform.accounts (id),
  kind          text NOT NULL CHECK (kind IN ('contract', 'term_sheet')),
  file_name     text NOT NULL,
  storage_key   text NOT NULL,
  sha256        text NOT NULL,
  size_bytes    bigint NOT NULL,
  text          text NOT NULL,
  page_starts   integer[] NOT NULL,
  uploaded_by   text NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, sha256)
);

-- Sandbox credentials: only who has them and when, never the secret.
CREATE TABLE onboarding.credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES platform.accounts (id),
  client_id   text NOT NULL UNIQUE,
  issued_by   text NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz NULL
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'segment_changes', 'collected_variables', 'licences', 'licence_alerts', 'documents', 'credentials'] LOOP
    EXECUTE format('ALTER TABLE onboarding.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE onboarding.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON onboarding.%I FOR ALL USING (platform.account_visible(account_id)) WITH CHECK (platform.account_visible(account_id))', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON onboarding.profiles, onboarding.segment_changes, onboarding.collected_variables, onboarding.licences, onboarding.credentials TO astra_app;
GRANT SELECT, INSERT ON onboarding.licence_alerts, onboarding.documents TO astra_app;

-- The agent proposes onboarding fields for a person to approve.
ALTER TABLE agents.proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE agents.proposals ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('variable_map', 'rate_manual', 'parity_explanation', 'document_quality', 'account_onboarding'));
ALTER TABLE agents.proposals DROP CONSTRAINT proposals_subject_type_check;
ALTER TABLE agents.proposals ADD CONSTRAINT proposals_subject_type_check
  CHECK (subject_type IN ('form_edition', 'rate_manual', 'document_template', 'document', 'account'));

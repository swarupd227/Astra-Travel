-- Increment 10: policy documents (E09, E04-F02-S03, E21-F05-S01). Design: docs/adr/0011.

CREATE SCHEMA documents;
GRANT USAGE ON SCHEMA documents TO astra_app;

-- A plan version's schedule or policy, assembled from the filed form and the plan's values.
-- Its content never changes; only its status moves (draft, then released, then superseded).
CREATE TABLE documents.templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES plans.plan_versions (id),
  kind             text NOT NULL CHECK (kind IN ('schedule', 'policy')),
  version          integer NOT NULL CHECK (version >= 1),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released', 'superseded')),
  edition_id       uuid NOT NULL REFERENCES studio.form_editions (id),
  map_id           uuid NOT NULL REFERENCES studio.variable_maps (id),
  text             text NOT NULL,
  problems         jsonb NOT NULL DEFAULT '[]',
  inserted         integer NOT NULL DEFAULT 0,
  removed          text[] NOT NULL DEFAULT '{}',
  checks           jsonb NOT NULL DEFAULT '[]',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_by      text NULL,
  released_at      timestamptz NULL,
  release_note     text NULL,
  UNIQUE (plan_version_id, kind, version),
  CHECK (status = 'draft' OR released_by IS NOT NULL OR status = 'superseded'),
  CHECK (released_by IS NULL OR released_by <> created_by)
);
CREATE UNIQUE INDEX one_released_template ON documents.templates (plan_version_id, kind) WHERE status = 'released';

CREATE FUNCTION documents.templates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'templates are records and cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'released_by', 'released_at', 'release_note']) <>
     (to_jsonb(OLD) - ARRAY['status', 'released_by', 'released_at', 'release_note']) THEN
    RAISE EXCEPTION 'the content of a template cannot change';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status IN ('released', 'superseded')) OR (OLD.status = 'released' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'a % template cannot become %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'released' AND (NEW.released_by IS DISTINCT FROM OLD.released_by OR NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION 'who released a template cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER templates_guard BEFORE UPDATE OR DELETE ON documents.templates
  FOR EACH ROW EXECUTE FUNCTION documents.templates_guard();

-- An issued document: immutable, with the text, the PDF's hash and where the PDF is kept.
-- A document that could not be produced is recorded with its reason (status failed).
CREATE TABLE documents.documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES platform.accounts (id),
  kind          text NOT NULL CHECK (kind IN ('schedule', 'policy', 'purchase_confirmation', 'change_notice', 'cancellation_notice', 'guide_to_benefits')),
  title         text NOT NULL,
  policy_id     uuid NULL REFERENCES policies.policies (id),
  programme_id  uuid NULL REFERENCES card.programmes (id),
  template_id   uuid NULL REFERENCES documents.templates (id),
  event_seq     bigint NULL,
  source        text NULL,
  version       integer NULL,
  status        text NOT NULL CHECK (status IN ('issued', 'failed')),
  failure       text NULL,
  text          text NULL,
  file_key      text NULL,
  sha256        text NULL,
  size_bytes    bigint NULL,
  created_by    text NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'failed' OR (text IS NOT NULL AND file_key IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)),
  CHECK (status = 'issued' OR failure IS NOT NULL),
  CHECK (policy_id IS NOT NULL OR programme_id IS NOT NULL)
);
CREATE INDEX documents_by_policy ON documents.documents (policy_id, issued_at);
CREATE INDEX documents_by_programme ON documents.documents (programme_id, version);
-- One notice per policy event, and one guide per programme and version.
CREATE UNIQUE INDEX one_notice_per_event ON documents.documents (policy_id, kind, event_seq) WHERE event_seq IS NOT NULL AND status = 'issued';
CREATE UNIQUE INDEX one_guide_version ON documents.documents (programme_id, version) WHERE kind = 'guide_to_benefits';
-- A failed bind-time document is replaced when it is issued later: only one issued copy per policy and kind for the filed forms and the confirmation.
CREATE UNIQUE INDEX one_issued_policy_document ON documents.documents (policy_id, kind) WHERE status = 'issued' AND kind IN ('schedule', 'policy', 'purchase_confirmation');

CREATE FUNCTION documents.documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'issued documents are records and cannot be deleted'; END IF;
  -- A failed record may be settled once, when the document is issued after all.
  IF OLD.status = 'failed' AND NEW.status = 'issued' AND NEW.kind = OLD.kind AND NEW.policy_id IS NOT DISTINCT FROM OLD.policy_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'issued documents cannot change';
END $$;
CREATE TRIGGER documents_guard BEFORE UPDATE OR DELETE ON documents.documents
  FOR EACH ROW EXECUTE FUNCTION documents.documents_guard();

-- How each document reaches its reader. The account channel is available at once; email is sent by the worker.
CREATE TABLE documents.deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL REFERENCES documents.documents (id),
  account_id       uuid NOT NULL REFERENCES platform.accounts (id),
  channel          text NOT NULL CHECK (channel IN ('email', 'account')),
  recipient        text NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'available', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NULL,
  last_error       text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz NULL,
  CHECK (channel <> 'email' OR recipient IS NOT NULL),
  UNIQUE (document_id, channel)
);
CREATE INDEX deliveries_due ON documents.deliveries (next_attempt_at) WHERE status = 'queued';
CREATE INDEX deliveries_failed ON documents.deliveries (updated_at DESC) WHERE status = 'failed';

CREATE TABLE documents.delivery_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id   uuid NOT NULL REFERENCES documents.deliveries (id),
  account_id    uuid NOT NULL REFERENCES platform.accounts (id),
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  ok            boolean NOT NULL,
  detail        text NOT NULL
);
CREATE INDEX delivery_attempts_by_delivery ON documents.delivery_attempts (delivery_id, id);
CREATE FUNCTION documents.attempts_no_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'delivery attempts are append-only'; END $$;
CREATE TRIGGER delivery_attempts_no_change BEFORE UPDATE OR DELETE ON documents.delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION documents.attempts_no_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents', 'deliveries', 'delivery_attempts'] LOOP
    EXECUTE format('ALTER TABLE documents.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE documents.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON documents.%I FOR ALL USING (platform.account_visible(account_id)) '
                   'WITH CHECK (platform.account_visible(account_id))', t || '_tenant', t);
  END LOOP;
END $$;

-- The Document Quality agent proposes findings about templates and documents.
ALTER TABLE agents.proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE agents.proposals ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('variable_map', 'rate_manual', 'parity_explanation', 'document_quality'));
ALTER TABLE agents.proposals DROP CONSTRAINT proposals_subject_type_check;
ALTER TABLE agents.proposals ADD CONSTRAINT proposals_subject_type_check
  CHECK (subject_type IN ('form_edition', 'rate_manual', 'document_template', 'document'));

GRANT SELECT, INSERT, UPDATE ON documents.templates TO astra_app;
GRANT SELECT, INSERT, UPDATE ON documents.documents, documents.deliveries TO astra_app;
GRANT SELECT, INSERT ON documents.delivery_attempts TO astra_app;

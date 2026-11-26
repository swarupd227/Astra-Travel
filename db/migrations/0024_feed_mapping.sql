-- Increment 16e: issuer file mappings and the Eligibility Feed agent (E21-F04-S01). Design: docs/adr/0021.

-- The first lines of an issuer's own file, kept to draft and check a mapping. Card numbers are removed before storing.
CREATE TABLE card.feed_samples (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id          uuid NOT NULL REFERENCES card.programmes (id),
  account_id            uuid NOT NULL REFERENCES platform.accounts (id),
  file_name             text NOT NULL,
  text                  text NOT NULL CHECK (octet_length(text) <= 262144),
  lines                 integer NOT NULL CHECK (lines >= 2),
  card_numbers_removed  integer NOT NULL DEFAULT 0,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_samples_by_programme ON card.feed_samples (programme_id, created_at DESC);

-- Mappings a person approved. A new version supersedes the last; the content of a version never changes.
CREATE TABLE card.feed_mappings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id  uuid NOT NULL REFERENCES card.programmes (id),
  account_id    uuid NOT NULL REFERENCES platform.accounts (id),
  version       integer NOT NULL CHECK (version >= 1),
  status        text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'superseded')),
  document      jsonb NOT NULL,
  sample_id     uuid NULL REFERENCES card.feed_samples (id),
  proposal_id   uuid NULL REFERENCES agents.proposals (id),
  approved_by   text NOT NULL,
  approved_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (programme_id, version)
);
CREATE UNIQUE INDEX one_approved_mapping ON card.feed_mappings (programme_id) WHERE status = 'approved';

CREATE FUNCTION card.feed_mappings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'feed mappings are records and cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') OR (OLD.status = 'superseded' AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'an approved feed mapping cannot change; approve a new version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feed_mappings_guard BEFORE UPDATE OR DELETE ON card.feed_mappings
  FOR EACH ROW EXECUTE FUNCTION card.feed_mappings_guard();

-- The mapping a converted feed was made with.
ALTER TABLE card.feeds ADD COLUMN mapping_id uuid NULL REFERENCES card.feed_mappings (id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feed_samples', 'feed_mappings'] LOOP
    EXECUTE format('ALTER TABLE card.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE card.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON card.%I FOR ALL USING (platform.account_visible(account_id)) WITH CHECK (platform.account_visible(account_id))', t || '_tenant', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON card.feed_samples TO astra_app;
GRANT SELECT, INSERT, UPDATE ON card.feed_mappings TO astra_app;

ALTER TABLE agents.proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE agents.proposals ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('variable_map', 'rate_manual', 'parity_explanation', 'document_quality', 'account_onboarding', 'feed_mapping', 'feed_rejections'));
ALTER TABLE agents.proposals DROP CONSTRAINT proposals_subject_type_check;
ALTER TABLE agents.proposals ADD CONSTRAINT proposals_subject_type_check
  CHECK (subject_type IN ('form_edition', 'rate_manual', 'document_template', 'document', 'account', 'card_programme', 'card_feed'));

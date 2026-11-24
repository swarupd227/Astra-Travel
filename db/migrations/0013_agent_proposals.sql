-- Increment 8: configuration agents (E01-F01-S03, E02-F01-S02, E02-F07-S03). Design: docs/adr/0009.

-- Filed rate manuals are loaded into the form library so agents read them page by page.
ALTER TABLE studio.form_editions DROP CONSTRAINT form_editions_kind_check;
ALTER TABLE studio.form_editions ADD CONSTRAINT form_editions_kind_check
  CHECK (kind IN ('policy', 'schedule', 'certificate', 'endorsement', 'application', 'rate_manual'));

-- The row of the imported workbook file a parity case came from, so an explanation can cite its cell.
ALTER TABLE rating.parity_cases ADD COLUMN source_row integer NULL CHECK (source_row IS NULL OR source_row >= 2);

-- What agents propose. Content never changes; only the resolution is recorded, once.
CREATE TABLE agents.proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('variable_map', 'rate_manual', 'parity_explanation')),
  agent_id      text NOT NULL REFERENCES agents.agents (id),
  run_id        uuid NULL REFERENCES agents.runs (id),
  requested_by  text NOT NULL,
  subject_type  text NOT NULL CHECK (subject_type IN ('form_edition', 'rate_manual')),
  subject_id    uuid NOT NULL,
  summary       text NOT NULL,
  content       jsonb NOT NULL,
  verification  jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'withdrawn')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_by   text NULL,
  resolved_at   timestamptz NULL,
  resolution    jsonb NULL,
  CHECK (status = 'open' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX proposals_by_subject ON agents.proposals (subject_id, created_at DESC);
CREATE INDEX proposals_open ON agents.proposals (status, created_at DESC);

CREATE FUNCTION agents.proposals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'proposals are records and cannot be deleted'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'proposal % is % and cannot change', OLD.id, OLD.status; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'resolved_by', 'resolved_at', 'resolution']) <>
     (to_jsonb(OLD) - ARRAY['status', 'resolved_by', 'resolved_at', 'resolution']) THEN
    RAISE EXCEPTION 'the content of a proposal cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposals_guard BEFORE UPDATE OR DELETE ON agents.proposals
  FOR EACH ROW EXECUTE FUNCTION agents.proposals_guard();

GRANT SELECT, INSERT, UPDATE ON agents.proposals TO astra_app;
GRANT UPDATE (source_row) ON rating.parity_cases TO astra_app;

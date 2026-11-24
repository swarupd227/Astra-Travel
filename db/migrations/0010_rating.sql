-- Increment 5a: rate manual library, parity and stored worksheets (E02). Design: docs/adr/0006.

CREATE SCHEMA rating;
GRANT USAGE ON SCHEMA rating TO astra_app;

CREATE TABLE rating.manuals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The filed manual, as in the filing register (item type rate_manual), for example RETR-SP-VU-DE-0426.
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{3,39}$'),
  state           char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  benefit         text NOT NULL CHECK (benefit ~ '^[A-Z]{2,8}$'),
  version         integer NOT NULL CHECK (version >= 1),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'withdrawn')),
  effective_from  date NOT NULL,
  effective_to    date NULL CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- Estimated loadings for demonstration and sandbox only; never publishable (E02-F09-S02).
  illustrative    boolean NOT NULL DEFAULT false,
  source          text NOT NULL,
  document        jsonb NOT NULL,
  sha256          text NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     text NULL,
  approved_at     timestamptz NULL,
  approval_note   text NULL,
  published_by    text NULL,
  published_at    timestamptz NULL,
  UNIQUE (code, version),
  CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_by <> created_by)),
  CHECK (status <> 'published' OR (published_by IS NOT NULL AND NOT illustrative)),
  -- One published manual per state and benefit at any date.
  EXCLUDE USING gist (state WITH =, benefit WITH =, daterange(effective_from, effective_to) WITH &&)
    WHERE (status = 'published')
);
CREATE INDEX manuals_lookup ON rating.manuals (state, benefit, status, effective_from DESC);

-- Approved and published manuals never change, except their status and end date moving forward.
CREATE FUNCTION rating.manuals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'manual % is %, and cannot be deleted', OLD.id, OLD.status; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF OLD.status = 'withdrawn' THEN RAISE EXCEPTION 'manual % was withdrawn and cannot change', OLD.id; END IF;
  -- Only status, publication and end-date fields may change once approved.
  allowed := '["status", "effective_to", "published_by", "published_at"]';
  IF (to_jsonb(NEW) - ARRAY(SELECT jsonb_array_elements_text(allowed))) <>
     (to_jsonb(OLD) - ARRAY(SELECT jsonb_array_elements_text(allowed))) THEN
    RAISE EXCEPTION 'manual % is %: its content cannot change', OLD.id, OLD.status;
  END IF;
  IF NOT ((OLD.status = 'approved' AND NEW.status IN ('approved', 'published', 'withdrawn'))
       OR (OLD.status = 'published' AND NEW.status IN ('published', 'withdrawn'))) THEN
    RAISE EXCEPTION 'manual % cannot move from % to %', OLD.id, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manuals_guard BEFORE UPDATE OR DELETE ON rating.manuals
  FOR EACH ROW EXECUTE FUNCTION rating.manuals_guard();

-- Parity cases belong to the filed manual (every version is checked against them).
CREATE TABLE rating.parity_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manual_code       text NOT NULL,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Filed manual or Assurant workbook only; the prototype rater is never a parity source (E02-F09-S01).
  source            text NOT NULL CHECK (char_length(source) BETWEEN 3 AND 300),
  request           jsonb NOT NULL,
  expected_amount   text NOT NULL,
  expected_factors  jsonb NOT NULL DEFAULT '{}',
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manual_code, name)
);

CREATE TABLE rating.parity_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manual_id   uuid NOT NULL REFERENCES rating.manuals (id),
  ran_at      timestamptz NOT NULL DEFAULT now(),
  ran_by      text NOT NULL,
  total       integer NOT NULL,
  passed      integer NOT NULL,
  -- Hash of the cases run, so a later change to the cases makes the run stale.
  cases_hash  text NOT NULL,
  results     jsonb NOT NULL
);
CREATE INDEX parity_runs_by_manual ON rating.parity_runs (manual_id, ran_at DESC);

-- Worksheets kept for reproduction (E02-F07-S01). Quotes and policies refer to them from Increment 9.
CREATE TABLE rating.worksheets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manual_id    uuid NOT NULL REFERENCES rating.manuals (id),
  inputs_hash  text NOT NULL,
  request      jsonb NOT NULL,
  result       jsonb NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worksheets_by_hash ON rating.worksheets (inputs_hash);

GRANT SELECT, INSERT, UPDATE, DELETE ON rating.manuals TO astra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rating.parity_cases TO astra_app;
GRANT SELECT, INSERT ON rating.parity_runs, rating.worksheets TO astra_app;

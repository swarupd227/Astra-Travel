-- Increment 3: filing register (E10-F01-S01), versioned reference data (E16-F01-S02) and the form library
-- with variable maps (E01-F01-S01/S02). Platform configuration owned by Assurant: no account rows, so no
-- row-level security; the API restricts these routes to staff. Design: docs/adr/0004.

-- Trusted extension (PostgreSQL 13+): lets exclusion constraints combine equality with date ranges.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA refdata;
CREATE SCHEMA compliance;
CREATE SCHEMA studio;
GRANT USAGE ON SCHEMA refdata, compliance, studio TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Reference data. A version is a complete, validated snapshot of one dataset. Approved versions of a
-- dataset form a timeline that never overlaps; approved versions and their entries never change.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE refdata.versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset          text NOT NULL CHECK (dataset ~ '^[a-z][a-z0-9_]{2,40}$'),
  version          integer NOT NULL CHECK (version >= 1),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  effective_from   date NOT NULL,
  effective_to     date NULL CHECK (effective_to IS NULL OR effective_to > effective_from),
  source           text NOT NULL CHECK (char_length(source) BETWEEN 3 AND 500),
  notes            text NULL,
  entry_count      integer NOT NULL,
  sha256           text NOT NULL,
  loaded_by        text NOT NULL,
  loaded_at        timestamptz NOT NULL DEFAULT now(),
  decided_by       text NULL,
  decided_at       timestamptz NULL,
  decision_reason  text NULL,
  UNIQUE (dataset, version),
  CHECK (status = 'draft' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  -- Maker-checker: the person who loads a version cannot approve it.
  CHECK (status <> 'approved' OR decided_by <> loaded_by),
  EXCLUDE USING gist (dataset WITH =, daterange(effective_from, effective_to) WITH &&)
    WHERE (status = 'approved')
);
CREATE INDEX versions_by_dataset ON refdata.versions (dataset, version DESC);

CREATE TABLE refdata.entries (
  version_id  uuid NOT NULL REFERENCES refdata.versions (id) ON DELETE CASCADE,
  key         text NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (version_id, key)
);

-- Approved and rejected versions are records: only the end date of an approved version may be set
-- (when its successor is approved), and only once.
CREATE FUNCTION refdata.versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'refdata version % is %, and cannot be deleted', OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'refdata version % was rejected and cannot change', OLD.id;
  END IF;
  IF OLD.status = 'approved' AND (
       NEW.status <> 'approved' OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL
       OR (to_jsonb(NEW) - 'effective_to') <> (to_jsonb(OLD) - 'effective_to')) THEN
    RAISE EXCEPTION 'refdata version % is approved: only its end date can be set, once', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER versions_guard BEFORE UPDATE OR DELETE ON refdata.versions
  FOR EACH ROW EXECUTE FUNCTION refdata.versions_guard();

CREATE FUNCTION refdata.entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM refdata.versions WHERE id = coalesce(NEW.version_id, OLD.version_id);
  -- A cascade from deleting a draft version finds no version row; that is allowed.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'entries of a % refdata version cannot change', v_status;
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER entries_guard BEFORE INSERT OR UPDATE OR DELETE ON refdata.entries
  FOR EACH ROW EXECUTE FUNCTION refdata.entries_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON refdata.versions, refdata.entries TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Filing register. One row per filed item per state; status history in filing_events.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE compliance.filings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state           char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  insurer         text NOT NULL CHECK (insurer IN ('VSC', 'ABIC')),
  item_type       text NOT NULL CHECK (item_type IN ('form_edition', 'rate_manual', 'rule_set')),
  -- The platform record, once the item exists here (form editions now; manuals and rule sets later).
  item_id         uuid NULL,
  -- The filed identifier, for example "trvl_indv_pol_cw ed. 2026-05" or "RETR-SP-VU-DE-0426".
  item_reference  text NOT NULL CHECK (char_length(item_reference) BETWEEN 2 AND 200),
  serff_tracking  text NULL CHECK (serff_tracking IS NULL OR serff_tracking ~ '^[A-Z0-9][A-Z0-9-]{3,39}$'),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'approved', 'disapproved', 'withdrawn')),
  submitted_on    date NULL,
  decided_on      date NULL,
  effective_from  date NULL,
  effective_to    date NULL CHECK (effective_to IS NULL OR effective_to > effective_from),
  notes           text NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (effective_from IS NOT NULL AND decided_on IS NOT NULL)),
  CHECK (status NOT IN ('submitted', 'approved', 'disapproved') OR submitted_on IS NOT NULL),
  CHECK (item_type <> 'form_edition' OR item_id IS NOT NULL),
  -- Never two approvals for the same item and state over the same dates. A withdrawn approval keeps the
  -- period it was in force (ending on the withdrawal date), so it still takes part.
  EXCLUDE USING gist (item_type WITH =, item_reference WITH =, state WITH =,
                      daterange(effective_from, effective_to) WITH &&)
    WHERE (status IN ('approved', 'withdrawn') AND effective_from IS NOT NULL)
);
CREATE INDEX filings_by_item ON compliance.filings (item_type, item_id, state);
CREATE INDEX filings_by_state ON compliance.filings (state, status);

CREATE TABLE compliance.filing_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filing_id    uuid NOT NULL REFERENCES compliance.filings (id),
  at           timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,
  from_status  text NULL,
  to_status    text NOT NULL,
  reason       text NULL,
  data         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX filing_events_by_filing ON compliance.filing_events (filing_id, id);

GRANT SELECT, INSERT, UPDATE ON compliance.filings TO astra_app;
GRANT SELECT, INSERT ON compliance.filing_events TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Form library and variable maps.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE studio.form_editions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_number   text NOT NULL CHECK (form_number ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,59}$'),
  edition       text NOT NULL CHECK (edition ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 200),
  kind          text NOT NULL CHECK (kind IN ('policy', 'schedule', 'certificate', 'endorsement', 'application')),
  insurer       text NOT NULL CHECK (insurer IN ('VSC', 'ABIC')),
  file_name     text NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('application/pdf', 'text/plain')),
  storage_key   text NOT NULL,
  sha256        text NOT NULL,
  size_bytes    bigint NOT NULL,
  -- Extracted text; pages are separated at page_starts (offsets into text).
  text          text NOT NULL,
  page_starts   integer[] NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_number, edition),
  UNIQUE (sha256)
);

CREATE TABLE studio.variable_maps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id   uuid NOT NULL REFERENCES studio.form_editions (id),
  version      integer NOT NULL CHECK (version >= 1),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  text NULL,
  approved_at  timestamptz NULL,
  approval_note text NULL,
  -- Everyone who created or edited the draft. Maker-checker: none of them may approve it.
  contributors  text[] NOT NULL,
  UNIQUE (edition_id, version),
  CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (approved_by IS NULL OR NOT (approved_by = ANY (contributors)))
);
CREATE UNIQUE INDEX one_draft_map ON studio.variable_maps (edition_id) WHERE status = 'draft';
CREATE UNIQUE INDEX one_current_map ON studio.variable_maps (edition_id) WHERE status = 'approved';

CREATE TABLE studio.form_variables (
  map_id       uuid NOT NULL REFERENCES studio.variable_maps (id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label        text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 200),
  type         text NOT NULL CHECK (type IN ('optional_benefit', 'numeric_range', 'percentage_range',
                                             'wording_choice', 'time_period', 'limit_basis',
                                             'insert_placeholder')),
  constraints  jsonb NOT NULL,
  text_start   integer NOT NULL CHECK (text_start >= 0),
  text_end     integer NOT NULL,
  excerpt      text NOT NULL,
  position     integer NOT NULL,
  notes        text NULL,
  PRIMARY KEY (map_id, key),
  CHECK (text_end > text_start)
);

CREATE FUNCTION studio.variables_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM studio.variable_maps WHERE id = coalesce(NEW.map_id, OLD.map_id);
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'variables of a % variable map cannot change', v_status;
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER variables_guard BEFORE INSERT OR UPDATE OR DELETE ON studio.form_variables
  FOR EACH ROW EXECUTE FUNCTION studio.variables_guard();

CREATE FUNCTION studio.maps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'an approved variable map cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'superseded' OR (OLD.status = 'approved' AND NEW.status <> 'superseded') THEN
    RAISE EXCEPTION 'variable map % is %: it can only be superseded', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER maps_guard BEFORE UPDATE OR DELETE ON studio.variable_maps
  FOR EACH ROW EXECUTE FUNCTION studio.maps_guard();

GRANT SELECT, INSERT ON studio.form_editions TO astra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON studio.variable_maps, studio.form_variables TO astra_app;

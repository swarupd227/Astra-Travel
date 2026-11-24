-- Increment 4: benefit catalogue (E01-F02-S01/S02/S03). One catalogue per schedule edition, versioned and
-- approved by a second person; approved versions never change. Design: docs/adr/0005.

CREATE TABLE studio.benefit_catalogues (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_edition_id  uuid NOT NULL REFERENCES studio.form_editions (id),
  policy_edition_id    uuid NULL REFERENCES studio.form_editions (id),
  version              integer NOT NULL CHECK (version >= 1),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  document             jsonb NOT NULL,
  -- The variable maps the catalogue was approved against.
  schedule_map_id      uuid NULL REFERENCES studio.variable_maps (id),
  policy_map_id        uuid NULL REFERENCES studio.variable_maps (id),
  sha256               text NULL,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  contributors         text[] NOT NULL,
  approved_by          text NULL,
  approved_at          timestamptz NULL,
  approval_note        text NULL,
  UNIQUE (schedule_edition_id, version),
  CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND sha256 IS NOT NULL
                              AND schedule_map_id IS NOT NULL)),
  CHECK (approved_by IS NULL OR NOT (approved_by = ANY (contributors))),
  CHECK (policy_edition_id IS NULL OR policy_edition_id <> schedule_edition_id)
);
CREATE UNIQUE INDEX one_draft_catalogue ON studio.benefit_catalogues (schedule_edition_id) WHERE status = 'draft';
CREATE UNIQUE INDEX one_current_catalogue ON studio.benefit_catalogues (schedule_edition_id) WHERE status = 'approved';

-- Approved catalogues are records: they can only be superseded.
CREATE FUNCTION studio.catalogues_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'an approved benefit catalogue cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'superseded'
     OR (OLD.status = 'approved' AND (NEW.status <> 'superseded'
         OR (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status'))) THEN
    RAISE EXCEPTION 'benefit catalogue % is %: it can only be superseded', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalogues_guard BEFORE UPDATE OR DELETE ON studio.benefit_catalogues
  FOR EACH ROW EXECUTE FUNCTION studio.catalogues_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON studio.benefit_catalogues TO astra_app;

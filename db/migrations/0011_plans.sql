-- Increment 6: plan builder and publishing (E01-F03, E01-F04, E10-F01-S02). Design: docs/adr/0007.

CREATE SCHEMA plans;
GRANT USAGE ON SCHEMA plans TO astra_app;

CREATE TABLE plans.plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 200),
  kind                 text NOT NULL CHECK (kind IN ('base', 'state', 'account')),
  term                 text NOT NULL CHECK (term IN ('single_trip', 'annual')),
  parent_plan_id       uuid NULL REFERENCES plans.plans (id),
  state                char(2) NULL CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  account_id           uuid NULL REFERENCES platform.accounts (id),
  schedule_edition_id  uuid NOT NULL REFERENCES studio.form_editions (id),
  policy_edition_id    uuid NULL REFERENCES studio.form_editions (id),
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'base') = (parent_plan_id IS NULL)),
  CHECK (kind = 'base' OR state IS NOT NULL),
  CHECK ((kind = 'account') = (account_id IS NOT NULL))
);

CREATE TABLE plans.plan_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES plans.plans (id),
  version         integer NOT NULL CHECK (version >= 1),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'approved', 'published', 'superseded', 'withdrawn')),
  effective_from  date NOT NULL,
  effective_to    date NULL CHECK (effective_to IS NULL OR effective_to > effective_from),
  catalogue_id    uuid NOT NULL REFERENCES studio.benefit_catalogues (id),
  document        jsonb NOT NULL,
  -- The form editions and rate manuals the version was published with (E01-F04-S02 compares them).
  links           jsonb NOT NULL DEFAULT '{}',
  sha256          text NULL,
  contributors    text[] NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     text NULL,
  approved_at     timestamptz NULL,
  approval_note   text NULL,
  published_by    text NULL,
  published_at    timestamptz NULL,
  UNIQUE (plan_id, version),
  CHECK (status = 'draft' OR (approved_by IS NOT NULL AND sha256 IS NOT NULL)),
  CHECK (approved_by IS NULL OR NOT (approved_by = ANY (contributors))),
  CHECK (status NOT IN ('published', 'superseded') OR published_by IS NOT NULL),
  EXCLUDE USING gist (plan_id WITH =, daterange(effective_from, effective_to) WITH &&) WHERE (status = 'published')
);
CREATE UNIQUE INDEX one_draft_plan_version ON plans.plan_versions (plan_id) WHERE status = 'draft';

-- Approved and published versions never change: only status, publication fields, links and the end date
-- moving forward.
CREATE FUNCTION plans.versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'plan version % is %, and cannot be deleted', OLD.id, OLD.status; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF OLD.status IN ('superseded', 'withdrawn') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'plan version % is % and cannot change', OLD.id, OLD.status;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'effective_to', 'published_by', 'published_at', 'links']) <>
     (to_jsonb(OLD) - ARRAY['status', 'effective_to', 'published_by', 'published_at', 'links']) THEN
    RAISE EXCEPTION 'plan version % is %: its content cannot change', OLD.id, OLD.status;
  END IF;
  IF OLD.status = 'published' AND OLD.links <> NEW.links THEN
    RAISE EXCEPTION 'plan version % is published: its links cannot change', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER versions_guard BEFORE UPDATE OR DELETE ON plans.plan_versions
  FOR EACH ROW EXECUTE FUNCTION plans.versions_guard();

CREATE TABLE plans.test_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES plans.plans (id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  input       jsonb NOT NULL,
  expected    jsonb NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, name)
);

CREATE TABLE plans.test_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES plans.plan_versions (id),
  ran_at      timestamptz NOT NULL DEFAULT now(),
  ran_by      text NOT NULL,
  total       integer NOT NULL,
  passed      integer NOT NULL,
  cases_hash  text NOT NULL,
  results     jsonb NOT NULL
);
CREATE INDEX test_runs_by_version ON plans.test_runs (version_id, ran_at DESC);

GRANT SELECT, INSERT ON plans.plans TO astra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON plans.plan_versions, plans.test_cases TO astra_app;
-- Runs of a discarded draft go with it.
GRANT SELECT, INSERT, DELETE ON plans.test_runs TO astra_app;

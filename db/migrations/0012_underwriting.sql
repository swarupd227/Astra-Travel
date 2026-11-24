-- Increment 7: underwriting and eligibility rules (E03). Design: docs/adr/0008.

CREATE SCHEMA underwriting;
GRANT USAGE ON SCHEMA underwriting TO astra_app;

-- Rule sets: versioned per plan, approved by a second person, published only with passing tests.
CREATE TABLE underwriting.rule_sets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES plans.plans (id),
  version         integer NOT NULL CHECK (version >= 1),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'superseded')),
  effective_from  date NOT NULL,
  effective_to    date NULL CHECK (effective_to IS NULL OR effective_to > effective_from),
  document        jsonb NOT NULL,
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
CREATE UNIQUE INDEX one_draft_rule_set ON underwriting.rule_sets (plan_id) WHERE status = 'draft';

CREATE FUNCTION underwriting.rule_sets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'rule set % is %, and cannot be deleted', OLD.id, OLD.status; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF OLD.status = 'superseded' THEN RAISE EXCEPTION 'rule set % is superseded and cannot change', OLD.id; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'effective_to', 'published_by', 'published_at']) <>
     (to_jsonb(OLD) - ARRAY['status', 'effective_to', 'published_by', 'published_at']) THEN
    RAISE EXCEPTION 'rule set % is %: its content cannot change', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rule_sets_guard BEFORE UPDATE OR DELETE ON underwriting.rule_sets
  FOR EACH ROW EXECUTE FUNCTION underwriting.rule_sets_guard();

CREATE TABLE underwriting.test_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES plans.plans (id),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  input           jsonb NOT NULL,
  expected        jsonb NOT NULL,
  existing_covers jsonb NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, name)
);

CREATE TABLE underwriting.test_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id   uuid NOT NULL REFERENCES underwriting.rule_sets (id) ON DELETE CASCADE,
  ran_at        timestamptz NOT NULL DEFAULT now(),
  ran_by        text NOT NULL,
  total         integer NOT NULL,
  passed        integer NOT NULL,
  cases_hash    text NOT NULL,
  results       jsonb NOT NULL
);
CREATE INDEX rule_test_runs_by_set ON underwriting.test_runs (rule_set_id, ran_at DESC);

-- Sanctions lists: the OFAC SDN list as uploaded, approved by a second person. One approved list at a time.
CREATE TABLE underwriting.sanctions_lists (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text NOT NULL CHECK (char_length(source) BETWEEN 3 AND 300),
  published_on     date NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
  entries          integer NOT NULL,
  aliases          integer NOT NULL,
  sha256           text NOT NULL UNIQUE,
  loaded_by        text NOT NULL,
  loaded_at        timestamptz NOT NULL DEFAULT now(),
  decided_by       text NULL,
  decided_at       timestamptz NULL,
  decision_reason  text NULL,
  CHECK (status IN ('draft') OR decided_by IS NOT NULL OR status = 'superseded'),
  CHECK (decided_by IS NULL OR decided_by <> loaded_by)
);
CREATE UNIQUE INDEX one_approved_sanctions_list ON underwriting.sanctions_lists ((true)) WHERE status = 'approved';

CREATE TABLE underwriting.sanctions_entries (
  list_id   uuid NOT NULL REFERENCES underwriting.sanctions_lists (id) ON DELETE CASCADE,
  uid       text NOT NULL,
  name      text NOT NULL,
  program   text NULL,
  aliases   text[] NOT NULL DEFAULT '{}',
  births    jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (list_id, uid)
);

CREATE FUNCTION underwriting.sanctions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_TABLE_NAME = 'sanctions_entries' THEN
    SELECT status INTO v_status FROM underwriting.sanctions_lists WHERE id = coalesce(NEW.list_id, OLD.list_id);
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'entries of a % sanctions list cannot change', v_status;
    END IF;
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a % sanctions list cannot be deleted', OLD.status; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('rejected', 'superseded')
     OR (OLD.status = 'approved' AND NEW.status <> 'superseded')
     OR (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'decision_reason']) <>
        (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'decision_reason']) THEN
    RAISE EXCEPTION 'sanctions list % is %: it can only be decided once or superseded', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sanctions_lists_guard BEFORE UPDATE OR DELETE ON underwriting.sanctions_lists
  FOR EACH ROW EXECUTE FUNCTION underwriting.sanctions_guard();
CREATE TRIGGER sanctions_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON underwriting.sanctions_entries
  FOR EACH ROW EXECUTE FUNCTION underwriting.sanctions_guard();

-- Referrals and sanctions holds, with the evaluation that raised them.
CREATE TABLE underwriting.referrals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref         text NOT NULL CHECK (char_length(case_ref) BETWEEN 1 AND 100),
  kind             text NOT NULL CHECK (kind IN ('underwriting', 'sanctions')),
  stage            text NOT NULL CHECK (stage IN ('quote', 'bind', 'change')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined')),
  recommendation   text NOT NULL CHECK (recommendation IN ('refer', 'recommend_decline')),
  rule_set_id      uuid NOT NULL REFERENCES underwriting.rule_sets (id),
  plan_version_id  uuid NOT NULL REFERENCES plans.plan_versions (id),
  summary          text NOT NULL,
  evaluation       jsonb NOT NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_by       text NULL,
  decided_at       timestamptz NULL,
  decision_reason  text NULL,
  CHECK (status = 'open' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL))
);
-- Evaluating the same case again does not raise a second open referral.
CREATE UNIQUE INDEX one_open_referral ON underwriting.referrals (case_ref, kind) WHERE status = 'open';
CREATE INDEX referrals_by_status ON underwriting.referrals (status, created_at DESC);

CREATE FUNCTION underwriting.referrals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'referrals are records and cannot be deleted'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'referral % is % and cannot change', OLD.id, OLD.status; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'decision_reason']) <>
     (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'decision_reason']) THEN
    RAISE EXCEPTION 'only the decision of a referral can be recorded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referrals_guard BEFORE UPDATE OR DELETE ON underwriting.referrals
  FOR EACH ROW EXECUTE FUNCTION underwriting.referrals_guard();

-- Able-to-travel confirmations (E03-F01-S01): records, never changed.
CREATE TABLE underwriting.declarations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES plans.plan_versions (id),
  subject_ref      text NOT NULL,
  confirmed        boolean NOT NULL,
  notice_text      text NOT NULL,
  form_edition_id  uuid NOT NULL REFERENCES studio.form_editions (id),
  text_sha256      text NOT NULL,
  recorded_by      text NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX declarations_by_subject ON underwriting.declarations (subject_ref, recorded_at DESC);

CREATE FUNCTION underwriting.no_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% records cannot be changed or deleted', TG_TABLE_NAME; END $$;
CREATE TRIGGER declarations_no_change BEFORE UPDATE OR DELETE ON underwriting.declarations
  FOR EACH ROW EXECUTE FUNCTION underwriting.no_change();

-- Existing cover, for the duplicate check. Written when a policy is bound (Increment 9); empty until then.
CREATE TABLE underwriting.cover_register (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  date_of_birth  date NOT NULL,
  policy_ref     text NOT NULL,
  trip_start     date NOT NULL,
  trip_end       date NOT NULL CHECK (trip_end >= trip_start),
  term           text NOT NULL CHECK (term IN ('single_trip', 'annual')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cover_register_by_person ON underwriting.cover_register (date_of_birth, trip_start, trip_end) WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE, DELETE ON underwriting.rule_sets, underwriting.test_cases TO astra_app;
GRANT SELECT, INSERT, DELETE ON underwriting.test_runs TO astra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON underwriting.sanctions_lists, underwriting.sanctions_entries TO astra_app;
GRANT SELECT, INSERT, UPDATE ON underwriting.referrals TO astra_app;
GRANT SELECT, INSERT ON underwriting.declarations TO astra_app;
GRANT SELECT, INSERT, UPDATE ON underwriting.cover_register TO astra_app;

-- Increment 9: quotes, bind and the policy record (E04, E05). Design: docs/adr/0010.

CREATE SCHEMA policies;
GRANT USAGE ON SCHEMA policies TO astra_app;

CREATE SEQUENCE policies.policy_number_seq;
GRANT USAGE ON SEQUENCE policies.policy_number_seq TO astra_app;

-- A quote: the request, the priced and decided result, and the versions used. Re-rating by selection changes
-- the same row (revision counts them).
CREATE TABLE policies.quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES platform.accounts (id),
  plan_id          uuid NOT NULL REFERENCES plans.plans (id),
  plan_version_id  uuid NOT NULL REFERENCES plans.plan_versions (id),
  rule_set_id      uuid NOT NULL REFERENCES underwriting.rule_sets (id),
  state            char(2) NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'bound', 'expired')),
  revision         integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  request          jsonb NOT NULL,
  selection        text[] NOT NULL DEFAULT '{}',
  result           jsonb NOT NULL,
  manuals          jsonb NOT NULL DEFAULT '{}',
  disclosure       jsonb NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX quotes_by_account ON policies.quotes (account_id, created_at DESC);

-- A policy: one row per policy, with status changing only along the lifecycle's edges.
CREATE TABLE policies.policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE,
  account_id         uuid NOT NULL REFERENCES platform.accounts (id),
  quote_id           uuid NOT NULL UNIQUE REFERENCES policies.quotes (id),
  plan_id            uuid NOT NULL REFERENCES plans.plans (id),
  plan_version_id    uuid NOT NULL REFERENCES plans.plan_versions (id),
  rule_set_id        uuid NOT NULL REFERENCES underwriting.rule_sets (id),
  state              char(2) NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
  purchased_on       date NOT NULL,
  term_start         timestamp NOT NULL,
  term_end           timestamp NOT NULL CHECK (term_end > term_start),
  premium_total      numeric(14, 2) NOT NULL CHECK (premium_total >= 0),
  payment_reference  text NOT NULL,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, payment_reference)
);
CREATE INDEX policies_by_account ON policies.policies (account_id, created_at DESC);

ALTER TABLE policies.quotes ADD COLUMN bound_policy_id uuid NULL REFERENCES policies.policies (id);

CREATE FUNCTION policies.policies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'policies are records and cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'a policy''s record changes through events; only its status is held on the row';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status IN ('cancelled', 'expired')) THEN
    RAISE EXCEPTION 'a % policy cannot become %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policies_guard BEFORE UPDATE OR DELETE ON policies.policies
  FOR EACH ROW EXECUTE FUNCTION policies.policies_guard();

-- Every change to a policy, append-only. The record at any moment is the fold of these.
CREATE TABLE policies.policy_events (
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  policy_id    uuid NOT NULL REFERENCES policies.policies (id),
  account_id   uuid NOT NULL REFERENCES platform.accounts (id),
  type         text NOT NULL CHECK (type IN ('bound', 'status_changed', 'details_changed')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,
  actor_name   text NULL,
  reason       text NULL,
  data         jsonb NOT NULL
);
CREATE INDEX policy_events_by_policy ON policies.policy_events (policy_id, seq);
CREATE UNIQUE INDEX one_bound_event ON policies.policy_events (policy_id) WHERE type = 'bound';

CREATE FUNCTION policies.events_no_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'policy events are append-only'; END $$;
CREATE TRIGGER policy_events_no_change BEFORE UPDATE OR DELETE ON policies.policy_events
  FOR EACH ROW EXECUTE FUNCTION policies.events_no_change();

-- What searches and cover verification read: the travellers and benefits as bound.
CREATE TABLE policies.policy_travellers (
  policy_id      uuid NOT NULL REFERENCES policies.policies (id),
  account_id     uuid NOT NULL REFERENCES platform.accounts (id),
  traveller_id   text NOT NULL,
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  date_of_birth  date NULL,
  PRIMARY KEY (policy_id, traveller_id)
);
CREATE INDEX policy_travellers_by_name ON policies.policy_travellers (lower(last_name), lower(first_name));

CREATE TABLE policies.policy_benefits (
  policy_id       uuid NOT NULL REFERENCES policies.policies (id),
  account_id      uuid NOT NULL REFERENCES platform.accounts (id),
  code            text NOT NULL,
  name            text NOT NULL,
  benefit_group   text NOT NULL,
  underwriter     text NULL CHECK (underwriter IN ('VSC', 'ABIC', 'VSC_CLIP')),
  limits          jsonb NOT NULL,
  premium         numeric(14, 2) NULL,
  coverage_start  timestamp NOT NULL,
  coverage_end    timestamp NOT NULL CHECK (coverage_end > coverage_start),
  PRIMARY KEY (policy_id, code)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotes', 'policies', 'policy_events', 'policy_travellers', 'policy_benefits'] LOOP
    EXECUTE format('ALTER TABLE policies.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE policies.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON policies.%I FOR ALL USING (platform.account_visible(account_id)) '
                   'WITH CHECK (platform.account_visible(account_id))', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON policies.quotes, policies.policies TO astra_app;
GRANT SELECT, INSERT ON policies.policy_events TO astra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON policies.policy_travellers, policies.policy_benefits TO astra_app;

-- Increment 12: premium records and the billing interface (E08, E14-F03-S01). Design: docs/adr/0013.

CREATE SCHEMA billing;
GRANT USAGE ON SCHEMA billing TO astra_app;

CREATE SEQUENCE billing.record_seq;
GRANT USAGE ON SEQUENCE billing.record_seq TO astra_app;

-- How an account's commission is calculated. Needs a second person's approval; none is assumed for an account.
CREATE TABLE billing.commission_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES platform.accounts (id),
  version         integer NOT NULL CHECK (version >= 1),
  effective_from  date NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  document        jsonb NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     text NULL,
  approved_at     timestamptz NULL,
  UNIQUE (account_id, version),
  CHECK (status = 'draft' OR approved_by IS NOT NULL),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

-- A card programme's premium basis: a rate per eligible account per month.
CREATE TABLE billing.programme_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id    uuid NOT NULL REFERENCES card.programmes (id),
  account_id      uuid NOT NULL REFERENCES platform.accounts (id),
  version         integer NOT NULL CHECK (version >= 1),
  effective_from  date NOT NULL,
  basis           text NOT NULL DEFAULT 'per_account_per_month' CHECK (basis = 'per_account_per_month'),
  rate            numeric(12, 4) NOT NULL CHECK (rate >= 0),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     text NULL,
  approved_at     timestamptz NULL,
  UNIQUE (programme_id, version),
  CHECK (status = 'draft' OR approved_by IS NOT NULL),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

-- A batch of records sent to billing together, with the control totals both systems check.
CREATE TABLE billing.batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  status           text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sent', 'confirmed', 'mismatch', 'unconfirmed', 'rejected')),
  totals           jsonb NOT NULL,
  file_key         text NOT NULL,
  sha256           text NOT NULL,
  size_bytes       bigint NOT NULL,
  channel          text NULL CHECK (channel IN ('file', 'http')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz NULL,
  next_attempt_at  timestamptz NULL,
  confirmed_at     timestamptz NULL,
  confirmation     jsonb NULL
);
CREATE INDEX batches_due ON billing.batches (next_attempt_at) WHERE status IN ('ready', 'sent');

-- One record for every policy transaction (and one per programme month). Money columns are whole cents.
CREATE TABLE billing.premium_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  type             text NOT NULL CHECK (type IN ('bind', 'change', 'cancellation', 'programme')),
  account_id       uuid NOT NULL REFERENCES platform.accounts (id),
  policy_id        uuid NULL REFERENCES policies.policies (id),
  policy_event_seq bigint NULL,
  programme_id     uuid NULL REFERENCES card.programmes (id),
  period           text NULL,
  state            char(2) NULL,
  status           text NOT NULL DEFAULT 'ready' CHECK (status IN ('held', 'ready', 'batched', 'sent', 'confirmed', 'rejected')),
  issues           text[] NOT NULL DEFAULT '{}',
  premium_cents    bigint NOT NULL,
  charge_cents     bigint NOT NULL CHECK (charge_cents >= 0),
  refund_cents     bigint NOT NULL CHECK (refund_cents >= 0),
  retained_cents   bigint NOT NULL CHECK (retained_cents >= 0),
  commission_cents bigint NULL,
  tax_cents        bigint NULL,
  per_benefit      jsonb NOT NULL DEFAULT '[]',
  per_traveller    jsonb NOT NULL DEFAULT '[]',
  allocation       jsonb NOT NULL DEFAULT '[]',
  commission       jsonb NULL,
  basis            jsonb NULL,
  worksheet_ids    uuid[] NOT NULL DEFAULT '{}',
  inputs           jsonb NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  batch_id         uuid NULL REFERENCES billing.batches (id),
  billing_reference text NULL,
  billing_reason   text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (premium_cents = charge_cents - refund_cents),
  CHECK (type = 'programme' OR policy_id IS NOT NULL),
  CHECK (type <> 'programme' OR (programme_id IS NOT NULL AND period IS NOT NULL)),
  CHECK (status <> 'ready' OR (cardinality(issues) = 0 AND batch_id IS NULL)),
  CHECK (status NOT IN ('batched', 'sent', 'confirmed') OR batch_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_record_per_transaction ON billing.premium_records (policy_id, policy_event_seq) WHERE policy_event_seq IS NOT NULL;
CREATE UNIQUE INDEX one_bind_record ON billing.premium_records (policy_id) WHERE type = 'bind';
CREATE UNIQUE INDEX one_programme_month ON billing.premium_records (programme_id, period) WHERE type = 'programme';
CREATE INDEX records_ready ON billing.premium_records (created_at) WHERE status = 'ready';
CREATE INDEX records_by_account_month ON billing.premium_records (account_id, occurred_at);
CREATE INDEX records_by_batch ON billing.premium_records (batch_id);

-- Records are history. What they say of the transaction never changes; while held, the calculated parts may be
-- recalculated; status moves forward only; and a record belongs to one batch for good, so nothing is sent twice.
CREATE FUNCTION billing.records_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moving text[] := ARRAY['status', 'issues', 'per_benefit', 'per_traveller', 'allocation', 'commission', 'commission_cents', 'tax_cents', 'batch_id', 'billing_reference', 'billing_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'premium records are history and cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - moving) <> (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'what a premium record says of its transaction cannot change';
  END IF;
  IF OLD.status <> 'held' AND (NEW.issues IS DISTINCT FROM OLD.issues OR NEW.per_benefit IS DISTINCT FROM OLD.per_benefit OR NEW.per_traveller IS DISTINCT FROM OLD.per_traveller
       OR NEW.allocation IS DISTINCT FROM OLD.allocation OR NEW.commission IS DISTINCT FROM OLD.commission OR NEW.commission_cents IS DISTINCT FROM OLD.commission_cents OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents) THEN
    RAISE EXCEPTION 'a premium record that is not held cannot be recalculated';
  END IF;
  IF OLD.batch_id IS NOT NULL AND NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    RAISE EXCEPTION 'a premium record belongs to one batch for good';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'held' AND NEW.status = 'ready') OR (OLD.status = 'ready' AND NEW.status = 'batched') OR
       (OLD.status = 'batched' AND NEW.status = 'sent') OR (OLD.status = 'sent' AND NEW.status IN ('confirmed', 'rejected')) OR
       (OLD.status = 'batched' AND NEW.status IN ('confirmed', 'rejected'))) THEN
    RAISE EXCEPTION 'a % premium record cannot become %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER records_guard BEFORE UPDATE OR DELETE ON billing.premium_records
  FOR EACH ROW EXECUTE FUNCTION billing.records_guard();

ALTER TABLE billing.premium_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.premium_records FORCE ROW LEVEL SECURITY;
CREATE POLICY premium_records_tenant ON billing.premium_records FOR ALL
  USING (platform.account_visible(account_id)) WITH CHECK (platform.account_visible(account_id));
ALTER TABLE billing.commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.commission_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_rules_tenant ON billing.commission_rules FOR ALL
  USING (platform.account_visible(account_id)) WITH CHECK (platform.account_visible(account_id));
ALTER TABLE billing.programme_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.programme_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY programme_rules_tenant ON billing.programme_rules FOR ALL
  USING (platform.account_visible(account_id)) WITH CHECK (platform.account_visible(account_id));

GRANT SELECT, INSERT, UPDATE ON billing.commission_rules, billing.programme_rules, billing.batches, billing.premium_records TO astra_app;

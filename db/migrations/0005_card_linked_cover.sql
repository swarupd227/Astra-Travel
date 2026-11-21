-- Increment 2: card-linked cover (epic E21, specification M18).
-- Master policies, card programmes, issuer eligibility feeds, the eligibility ledger and certificates.
-- Everything is owned by the issuer's account and isolated by row-level security; cardholders are
-- identified only by the issuer's opaque account reference.

CREATE SCHEMA card;
GRANT USAGE ON SCHEMA card TO astra_app;

CREATE TABLE card.master_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES platform.accounts (id),
  policy_number   text NOT NULL UNIQUE,
  underwriter     text NOT NULL CHECK (underwriter IN ('VSC', 'ABIC')),
  states          text[] NOT NULL CHECK (cardinality(states) >= 1),
  effective_from  date NOT NULL,
  effective_to    date NULL CHECK (effective_to IS NULL OR effective_to > effective_from),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL
);

CREATE TABLE card.programmes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES platform.accounts (id),
  master_policy_id       uuid NOT NULL REFERENCES card.master_policies (id),
  code                   text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
  name                   text NOT NULL,
  card_product           text NOT NULL,
  states                 text[] NOT NULL CHECK (cardinality(states) >= 1),
  effective_from         date NOT NULL,
  effective_to           date NULL CHECK (effective_to IS NULL OR effective_to > effective_from),
  payment_condition      jsonb NOT NULL,
  eligibility_rule       text NOT NULL CHECK (eligibility_rule IN ('purchase_date', 'purchase_and_loss_date')),
  max_reject_percent     numeric(5, 2) NOT NULL CHECK (max_reject_percent BETWEEN 0 AND 50),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'suspended', 'closed')),
  status_reason          text NULL,
  last_applied_sequence  integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             text NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX programmes_by_account ON card.programmes (account_id);

CREATE TABLE card.feeds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id    uuid NOT NULL REFERENCES card.programmes (id),
  account_id      uuid NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('live', 'test')),
  sequence        integer NULL,
  kind            text NULL CHECK (kind IN ('FULL', 'CHANGE')),
  as_of_date      date NULL,
  file_name       text NOT NULL,
  storage_key     text NOT NULL,
  sha256          text NOT NULL,
  size_bytes      bigint NOT NULL,
  status          text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'waiting', 'applied', 'held', 'rejected', 'passed', 'failed')),
  status_reason   text NULL,
  stats           jsonb NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  received_by     text NOT NULL,
  processed_at    timestamptz NULL,
  duration_ms     integer NULL,
  locked_until    timestamptz NULL,
  UNIQUE (programme_id, mode, sha256)
);
-- One live feed per sequence while it is pending, applied or held. A rejected feed frees its sequence so
-- the issuer can resend it.
CREATE UNIQUE INDEX feeds_live_sequence ON card.feeds (programme_id, sequence)
  WHERE mode = 'live' AND status IN ('waiting', 'applied', 'held');
CREATE INDEX feeds_to_process ON card.feeds (received_at) WHERE status IN ('received', 'waiting');
CREATE INDEX feeds_by_programme ON card.feeds (programme_id, received_at DESC);

-- Parsed records of a feed being processed. Re-creatable from the stored file, so not WAL-logged.
CREATE UNLOGGED TABLE card.feed_records (
  feed_id        uuid NOT NULL,
  line_no        integer NOT NULL,
  account_ref    text NOT NULL,
  product_code   text NOT NULL,
  action         char(1) NOT NULL CHECK (action IN ('A', 'U', 'D')),
  eligible_from  date NOT NULL,
  eligible_to    date NULL,
  PRIMARY KEY (feed_id, line_no)
);
CREATE INDEX feed_records_by_account ON card.feed_records (feed_id, account_ref);

-- The apply plan for a feed being applied: each record classified against the ledger. Rows exist only
-- inside the applying transaction.
CREATE UNLOGGED TABLE card.feed_plan (
  feed_id        uuid NOT NULL,
  account_ref    text NOT NULL,
  op             text NOT NULL CHECK (op IN ('add', 'update', 'remove', 'unchanged')),
  product_code   text NULL,
  start_from     date NULL,
  new_to         date NULL,
  period_id      bigint NULL,
  old_from       date NULL,
  remove_end     date NULL
);
CREATE INDEX feed_plan_by_op ON card.feed_plan (feed_id, op);

CREATE TABLE card.feed_rejections (
  feed_id      uuid NOT NULL REFERENCES card.feeds (id),
  account_id   uuid NOT NULL,
  line_no      integer NOT NULL,
  account_ref  text NULL,
  code         text NOT NULL,
  message      text NOT NULL,
  PRIMARY KEY (feed_id, line_no)
);

-- One row per cardholder account per programme, created on first eligibility, kept for life.
-- The ledger tables (certificates, eligibility_periods) are written in bulk only by the feed processor,
-- inside the transaction that locks the programme and applies the feed, so they carry no foreign keys:
-- per-row key checks were about 80% of apply time for large feeds. The referenced programmes and feeds
-- cannot be deleted by the application role, and card.verify_ledger() checks the references.
CREATE SEQUENCE card.certificate_numbers AS bigint START 100000001;
CREATE TABLE card.certificates (
  programme_id        uuid NOT NULL,
  account_ref         text NOT NULL,
  account_id          uuid NOT NULL,
  certificate_number  text NOT NULL UNIQUE,
  issued_by_feed      uuid NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (programme_id, account_ref)
);

-- The eligibility ledger. Periods are never overwritten: a change ends the current period (ended_by)
-- and starts a new one, so the answer for any past date can be reproduced with the feed behind it.
CREATE TABLE card.eligibility_periods (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  programme_id    uuid NOT NULL,
  account_id      uuid NOT NULL,
  account_ref     text NOT NULL,
  product_code    text NOT NULL,
  valid_from      date NOT NULL,
  valid_to        date NULL,
  established_by  uuid NOT NULL,
  ended_by        uuid NULL,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX eligibility_current ON card.eligibility_periods (programme_id, account_ref)
  WHERE ended_by IS NULL;
CREATE INDEX eligibility_by_account ON card.eligibility_periods (programme_id, account_ref, valid_from);

-- Row-level security: the issuer's account owns everything.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['master_policies', 'programmes', 'feeds', 'feed_rejections', 'certificates',
                           'eligibility_periods'] LOOP
    EXECUTE format('ALTER TABLE card.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE card.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON card.%I FOR ALL USING (platform.account_visible(account_id)) '
                   'WITH CHECK (platform.account_visible(account_id))', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON card.master_policies, card.programmes, card.feeds TO astra_app;
GRANT SELECT, INSERT, DELETE ON card.feed_rejections TO astra_app;
GRANT SELECT, INSERT ON card.certificates TO astra_app;
GRANT SELECT, INSERT, UPDATE ON card.eligibility_periods TO astra_app;
GRANT SELECT, INSERT, DELETE ON card.feed_records, card.feed_plan TO astra_app;
-- Fresh statistics on staging and the ledger keep set-based plans for million-row feeds sensible.
GRANT MAINTAIN ON card.feed_records, card.feed_plan, card.eligibility_periods, card.certificates TO astra_app;
GRANT USAGE ON SEQUENCE card.certificate_numbers TO astra_app;

-- Reference check for the ledger tables (see above). Returns one row per dangling reference; none is healthy.
CREATE FUNCTION card.verify_ledger()
  RETURNS TABLE (table_name text, column_name text, dangling bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = card, pg_temp
  AS $$
    SELECT 'certificates', 'programme_id', count(*) FROM certificates c
      WHERE NOT EXISTS (SELECT 1 FROM programmes p WHERE p.id = c.programme_id) HAVING count(*) > 0
    UNION ALL
    SELECT 'certificates', 'issued_by_feed', count(*) FROM certificates c
      WHERE NOT EXISTS (SELECT 1 FROM feeds f WHERE f.id = c.issued_by_feed) HAVING count(*) > 0
    UNION ALL
    SELECT 'eligibility_periods', 'programme_id', count(*) FROM eligibility_periods e
      WHERE NOT EXISTS (SELECT 1 FROM programmes p WHERE p.id = e.programme_id) HAVING count(*) > 0
    UNION ALL
    SELECT 'eligibility_periods', 'established_by', count(*) FROM eligibility_periods e
      WHERE NOT EXISTS (SELECT 1 FROM feeds f WHERE f.id = e.established_by) HAVING count(*) > 0
    UNION ALL
    SELECT 'eligibility_periods', 'ended_by', count(*) FROM eligibility_periods e
      WHERE e.ended_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.id = e.ended_by) HAVING count(*) > 0
  $$;
REVOKE ALL ON FUNCTION card.verify_ledger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION card.verify_ledger() TO astra_app;
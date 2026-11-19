-- Increment 0: platform foundation.
-- Tenancy (row-level security), transactional outbox and event deliveries (with dead-lettering),
-- idempotency keys, feature flags, webhook subscriptions and the tamper-evident audit trail.
-- Runs as astra_owner. The runtime role astra_app has no BYPASSRLS, so every policy below applies.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA platform;
CREATE SCHEMA integration;
CREATE SCHEMA audit;
GRANT USAGE ON SCHEMA platform, integration, audit TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Tenancy. The API sets `app.account_ids` per transaction: '*' for platform-wide staff and system
-- work, or a comma-separated list of account IDs for account-scoped principals. Unset means no access.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION platform.is_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT coalesce(current_setting('app.account_ids', true), '') = '*' $$;

CREATE FUNCTION platform.account_visible(acc uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT CASE
      WHEN coalesce(current_setting('app.account_ids', true), '') = '*' THEN true
      WHEN acc IS NULL THEN false
      ELSE coalesce(
        acc = ANY (string_to_array(nullif(current_setting('app.account_ids', true), ''), ',')::uuid[]),
        false)
    END
  $$;

GRANT EXECUTE ON FUNCTION platform.is_platform_scope(), platform.account_visible(uuid) TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Accounts: the tenant registry. Accounts (travel sellers, card issuers, banks) are logical tenants.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE platform.accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 200),
  kind        text NOT NULL CHECK (kind IN ('travel_account', 'card_issuer', 'bank')),
  status      text NOT NULL DEFAULT 'onboarding'
              CHECK (status IN ('onboarding', 'active', 'suspended', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_select ON platform.accounts FOR SELECT USING (platform.account_visible(id));
CREATE POLICY accounts_insert ON platform.accounts FOR INSERT WITH CHECK (platform.is_platform_scope());
CREATE POLICY accounts_update ON platform.accounts FOR UPDATE
  USING (platform.is_platform_scope()) WITH CHECK (platform.is_platform_scope());
GRANT SELECT, INSERT, UPDATE ON platform.accounts TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Transactional outbox. Business changes and their events commit in one transaction.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE platform.outbox (
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id              uuid PRIMARY KEY,
  type            text NOT NULL,
  version         integer NOT NULL CHECK (version >= 1),
  occurred_at     timestamptz NOT NULL,
  source          text NOT NULL,
  correlation_id  text NOT NULL,
  account_id      uuid NULL,
  state           char(2) NULL,
  data            jsonb NOT NULL,
  published_at    timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_unpublished ON platform.outbox (seq) WHERE published_at IS NULL;
CREATE INDEX outbox_by_time ON platform.outbox (occurred_at DESC);
CREATE INDEX outbox_by_type ON platform.outbox (type, occurred_at DESC);
CREATE INDEX outbox_by_account ON platform.outbox (account_id, occurred_at DESC);
CREATE INDEX outbox_by_correlation ON platform.outbox (correlation_id);

ALTER TABLE platform.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_select ON platform.outbox FOR SELECT USING (platform.account_visible(account_id));
CREATE POLICY outbox_insert ON platform.outbox FOR INSERT
  WITH CHECK (account_id IS NULL OR platform.account_visible(account_id));
CREATE POLICY outbox_update ON platform.outbox FOR UPDATE
  USING (platform.is_platform_scope()) WITH CHECK (platform.is_platform_scope());
GRANT SELECT, INSERT ON platform.outbox TO astra_app;
GRANT UPDATE (published_at) ON platform.outbox TO astra_app;

CREATE FUNCTION platform.notify_outbox() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM pg_notify('astra_outbox', '');
    RETURN NULL;
  END $$;

CREATE TRIGGER outbox_notify AFTER INSERT ON platform.outbox
  FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_outbox();

-- One row per (event, subscriber). Failed deliveries back off and are dead-lettered after the
-- subscriber's maximum attempts; dead deliveries can be replayed.
CREATE TABLE platform.event_deliveries (
  event_id         uuid NOT NULL REFERENCES platform.outbox (id),
  subscriber       text NOT NULL,
  event_type       text NOT NULL,
  account_id       uuid NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NULL DEFAULT now(),
  locked_until     timestamptz NULL,
  last_error       text NULL,
  delivered_at     timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, subscriber)
);

CREATE INDEX event_deliveries_due ON platform.event_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX event_deliveries_dead ON platform.event_deliveries (updated_at DESC) WHERE status = 'dead';
CREATE INDEX event_deliveries_by_account ON platform.event_deliveries (account_id, updated_at DESC);

ALTER TABLE platform.event_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.event_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY deliveries_select ON platform.event_deliveries FOR SELECT
  USING (platform.account_visible(account_id));
CREATE POLICY deliveries_write ON platform.event_deliveries FOR INSERT
  WITH CHECK (platform.is_platform_scope());
CREATE POLICY deliveries_update ON platform.event_deliveries FOR UPDATE
  USING (platform.is_platform_scope()) WITH CHECK (platform.is_platform_scope());
GRANT SELECT, INSERT, UPDATE ON platform.event_deliveries TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Idempotency keys. The key row and the business change commit in the same transaction, so a
-- repeated request returns the stored response and never repeats the change.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE platform.idempotency_keys (
  principal        text NOT NULL,
  key              text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 200),
  account_id       uuid NULL,
  method           text NOT NULL,
  path             text NOT NULL,
  request_hash     text NOT NULL,
  response_status  integer NULL,
  response_body    jsonb NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (principal, key)
);

CREATE INDEX idempotency_keys_expiry ON platform.idempotency_keys (expires_at);

ALTER TABLE platform.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_all ON platform.idempotency_keys FOR ALL
  USING (platform.account_visible(account_id) OR (account_id IS NULL AND platform.is_platform_scope()))
  WITH CHECK (platform.account_visible(account_id) OR (account_id IS NULL AND platform.is_platform_scope()));
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.idempotency_keys TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Feature flags: global value plus optional per-account override.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE platform.feature_flags (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$'),
  description  text NOT NULL,
  enabled      boolean NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text NULL
);
GRANT SELECT, UPDATE (enabled, updated_at, updated_by) ON platform.feature_flags TO astra_app;

CREATE TABLE platform.feature_flag_overrides (
  flag_key    text NOT NULL REFERENCES platform.feature_flags (key),
  account_id  uuid NOT NULL REFERENCES platform.accounts (id),
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL,
  PRIMARY KEY (flag_key, account_id)
);

ALTER TABLE platform.feature_flag_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.feature_flag_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY flag_overrides_select ON platform.feature_flag_overrides FOR SELECT
  USING (platform.account_visible(account_id));
CREATE POLICY flag_overrides_write ON platform.feature_flag_overrides FOR ALL
  USING (platform.is_platform_scope()) WITH CHECK (platform.is_platform_scope());
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.feature_flag_overrides TO astra_app;

INSERT INTO platform.feature_flags (key, description, enabled, updated_by) VALUES
  ('integration.webhooks-delivery',
   'Deliver events to partner webhook endpoints. When off, deliveries wait and are not dead-lettered.',
   true, 'migration:0001'),
  ('api.partner-access',
   'Allow account API clients to call the platform. Override for one account to suspend that partner''s API access.',
   true, 'migration:0001');

-- ---------------------------------------------------------------------------------------------
-- Webhook subscriptions (integration pattern: signed, retried, monitored outbound events).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE integration.webhook_subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES platform.accounts (id),
  url                   text NOT NULL CHECK (url ~ '^https?://'),
  event_types           text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 50),
  description           text NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  secret_ciphertext     text NOT NULL,
  secret_key_id         text NOT NULL,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_subscriptions_active ON integration.webhook_subscriptions (account_id)
  WHERE status = 'active';

ALTER TABLE integration.webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.webhook_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_subscriptions_all ON integration.webhook_subscriptions FOR ALL
  USING (platform.account_visible(account_id)) WITH CHECK (platform.account_visible(account_id));
GRANT SELECT, INSERT, UPDATE ON integration.webhook_subscriptions TO astra_app;

-- ---------------------------------------------------------------------------------------------
-- Audit trail. Append-only; every row carries a SHA-256 hash of its content, and a sealing job
-- chains rows into seals so any later change or deletion is detectable by audit.verify().
-- ---------------------------------------------------------------------------------------------

CREATE TABLE audit.audit_log (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'partner', 'agent', 'system')),
  actor_id        text NOT NULL,
  actor_name      text NULL,
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     text NULL,
  account_id      uuid NULL,
  correlation_id  text NOT NULL,
  reason          text NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_hash        bytea NOT NULL
);

CREATE INDEX audit_log_by_time ON audit.audit_log (occurred_at DESC);
CREATE INDEX audit_log_by_resource ON audit.audit_log (resource_type, resource_id);
CREATE INDEX audit_log_by_account ON audit.audit_log (account_id, seq DESC);
CREATE INDEX audit_log_by_actor ON audit.audit_log (actor_id, seq DESC);
CREATE INDEX audit_log_by_correlation ON audit.audit_log (correlation_id);

CREATE FUNCTION audit.compute_row_hash(r audit.audit_log) RETURNS bytea
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT digest(convert_to(concat_ws(chr(31),
      r.seq::text,
      r.id::text,
      to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      r.actor_type, r.actor_id, coalesce(r.actor_name, ''),
      r.action, r.resource_type, coalesce(r.resource_id, ''),
      coalesce(r.account_id::text, ''), r.correlation_id, coalesce(r.reason, ''),
      r.data::text), 'UTF8'), 'sha256')
  $$;

CREATE FUNCTION audit.set_row_hash() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    NEW.row_hash := audit.compute_row_hash(NEW);
    RETURN NEW;
  END $$;

CREATE FUNCTION audit.prevent_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'audit records are append-only' USING ERRCODE = 'insufficient_privilege';
  END $$;

CREATE TRIGGER audit_log_hash BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.set_row_hash();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.prevent_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.prevent_change();

ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
-- Not FORCEd: the owner-defined seal and verify functions must read every row without changing the
-- caller's tenancy scope. astra_app is not the owner, so RLS always applies to it.
CREATE POLICY audit_select ON audit.audit_log FOR SELECT USING (platform.account_visible(account_id));
CREATE POLICY audit_insert ON audit.audit_log FOR INSERT
  WITH CHECK (account_id IS NULL OR platform.account_visible(account_id));
GRANT SELECT, INSERT ON audit.audit_log TO astra_app;

CREATE TABLE audit.audit_seals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_seq    bigint NOT NULL,
  to_seq      bigint NOT NULL,
  row_count   integer NOT NULL,
  prev_hash   bytea NOT NULL,
  seal_hash   bytea NOT NULL,
  sealed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (to_seq >= from_seq)
);

CREATE TRIGGER audit_seals_immutable BEFORE UPDATE OR DELETE ON audit.audit_seals
  FOR EACH ROW EXECUTE FUNCTION audit.prevent_change();
CREATE TRIGGER audit_seals_no_truncate BEFORE TRUNCATE ON audit.audit_seals
  FOR EACH STATEMENT EXECUTE FUNCTION audit.prevent_change();
GRANT SELECT ON audit.audit_seals TO astra_app;

-- Seals every row older than min_age that follows the last seal. Rows are only sealed once every
-- lower sequence number is old enough to be committed (astra_app has a 60-second transaction
-- timeout), so no row can be skipped.
CREATE FUNCTION audit.seal_pending(min_age interval DEFAULT '2 minutes', max_rows integer DEFAULT 50000)
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_last_to bigint;
    v_prev bytea;
    v_cutoff bigint;
    v_from bigint;
    v_to bigint;
    v_count integer;
    v_hash bytea;
    v_id bigint;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('astra.audit.seal'));

    SELECT to_seq, seal_hash INTO v_last_to, v_prev FROM audit.audit_seals ORDER BY id DESC LIMIT 1;
    v_last_to := coalesce(v_last_to, 0);
    v_prev := coalesce(v_prev, '\x'::bytea);

    SELECT min(seq) - 1 INTO v_cutoff FROM audit.audit_log
      WHERE seq > v_last_to AND occurred_at >= clock_timestamp() - min_age;
    IF v_cutoff IS NULL THEN
      SELECT max(seq) INTO v_cutoff FROM audit.audit_log;
    END IF;
    IF v_cutoff IS NULL OR v_cutoff <= v_last_to THEN
      RETURN NULL;
    END IF;

    SELECT min(seq), max(seq), count(*),
           digest(v_prev || string_agg(row_hash, ''::bytea ORDER BY seq), 'sha256')
      INTO v_from, v_to, v_count, v_hash
      FROM (SELECT seq, row_hash FROM audit.audit_log
             WHERE seq > v_last_to AND seq <= v_cutoff ORDER BY seq LIMIT max_rows) s;

    IF v_count = 0 THEN
      RETURN NULL;
    END IF;

    INSERT INTO audit.audit_seals (from_seq, to_seq, row_count, prev_hash, seal_hash)
      VALUES (v_from, v_to, v_count, v_prev, v_hash)
      RETURNING id INTO v_id;
    RETURN v_id;
  END $$;

-- Recomputes every row hash and every seal. Returns the first mismatch, if any.
CREATE FUNCTION audit.verify()
  RETURNS TABLE (ok boolean, rows_checked bigint, seals_checked bigint, last_sealed_seq bigint,
                 mismatch_kind text, mismatch_ref text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    s audit.audit_seals%ROWTYPE;
    v_prev bytea := '\x'::bytea;
    v_hash bytea;
    v_count integer;
    v_expected_from bigint := 1;
    v_bad_seq bigint;
  BEGIN
    seals_checked := 0;
    last_sealed_seq := NULL;
    SELECT count(*) INTO rows_checked FROM audit.audit_log;

    SELECT a.seq INTO v_bad_seq FROM audit.audit_log a
      WHERE a.row_hash <> audit.compute_row_hash(a) ORDER BY a.seq LIMIT 1;
    IF v_bad_seq IS NOT NULL THEN
      ok := false; mismatch_kind := 'row'; mismatch_ref := v_bad_seq::text;
      RETURN NEXT; RETURN;
    END IF;

    FOR s IN SELECT * FROM audit.audit_seals ORDER BY id LOOP
      SELECT count(*), digest(v_prev || string_agg(row_hash, ''::bytea ORDER BY seq), 'sha256')
        INTO v_count, v_hash
        FROM audit.audit_log WHERE seq BETWEEN s.from_seq AND s.to_seq;
      IF s.prev_hash <> v_prev OR v_count <> s.row_count OR v_hash IS DISTINCT FROM s.seal_hash
         OR s.from_seq < v_expected_from THEN
        ok := false; mismatch_kind := 'seal'; mismatch_ref := s.id::text;
        RETURN NEXT; RETURN;
      END IF;
      v_prev := s.seal_hash;
      v_expected_from := s.to_seq + 1;
      seals_checked := seals_checked + 1;
      last_sealed_seq := s.to_seq;
    END LOOP;

    -- Rows deleted from a gap before the last seal would also change the seal; rows that exist below
    -- the first seal's start but were never sealed indicate tampering with seal history.
    ok := true; mismatch_kind := NULL; mismatch_ref := NULL;
    RETURN NEXT;
  END $$;

REVOKE ALL ON FUNCTION audit.seal_pending(interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.verify() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.seal_pending(interval, integer) TO astra_app;
GRANT EXECUTE ON FUNCTION audit.verify() TO astra_app;

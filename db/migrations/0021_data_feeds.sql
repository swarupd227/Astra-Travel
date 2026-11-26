-- Increment 16b: the reporting data model, loads to the data platform and the claims feed (E12-F01, E14-F03-S04).
-- Design: docs/adr/0018.

-- ---------------------------------------------------------------- The trip as it stands now
-- A policy's trip is the one quoted until a change replaces it. Searches, feeds and reports read this, so a changed
-- trip is never answered with the old one.
CREATE INDEX policy_events_trip_changes ON policies.policy_events (policy_id, seq DESC)
  WHERE type = 'details_changed' AND (data->'patch') ? 'trip';
CREATE INDEX policy_events_trip_destinations ON policies.policy_events USING gin (lower((data->'patch'->'trip'->'destinations')::text) gin_trgm_ops)
  WHERE type = 'details_changed' AND (data->'patch') ? 'trip';

CREATE VIEW policies.current_trips WITH (security_invoker = true) AS
  SELECT p.id AS policy_id, p.account_id, coalesce(e.trip, q.request->'trip') AS trip, e.trip IS NOT NULL AS changed
    FROM policies.policies p
    JOIN policies.quotes q ON q.id = p.quote_id
    LEFT JOIN LATERAL (
      SELECT ev.data->'patch'->'trip' AS trip FROM policies.policy_events ev
       WHERE ev.policy_id = p.id AND ev.type = 'details_changed' AND (ev.data->'patch') ? 'trip'
       ORDER BY ev.seq DESC LIMIT 1
    ) e ON true;
GRANT SELECT ON policies.current_trips TO astra_app;

-- ---------------------------------------------------------------- Reporting data model
-- One view per entity of the data catalogue (packages/contracts/src/data.ts defines every column; a test keeps the two
-- in step). Row-level security of the underlying tables still applies.
CREATE SCHEMA analytics;
GRANT USAGE ON SCHEMA analytics TO astra_app;

CREATE VIEW analytics.plans WITH (security_invoker = true) AS
  SELECT id AS plan_id, code, name, kind, term, state::text AS state, account_id FROM plans.plans;
CREATE VIEW analytics.accounts WITH (security_invoker = true) AS
  SELECT id AS account_id, code, name, kind, status, sandbox FROM platform.accounts;
CREATE VIEW analytics.policies WITH (security_invoker = true) AS
  SELECT p.id AS policy_id, p.number AS policy_number, p.account_id, p.plan_id, v.version AS plan_version, p.state::text AS state,
         p.status, p.purchased_on, p.term_start, p.term_end, p.premium_total
    FROM policies.policies p JOIN plans.plan_versions v ON v.id = p.plan_version_id;
CREATE VIEW analytics.travellers WITH (security_invoker = true) AS
  SELECT policy_id, traveller_id, account_id, first_name, last_name, date_of_birth FROM policies.policy_travellers;
CREATE VIEW analytics.trips WITH (security_invoker = true) AS
  SELECT policy_id, account_id, (trip->>'departureDate')::date AS departure_date, (trip->>'returnDate')::date AS return_date,
         (trip->>'initialDepositDate')::date AS initial_deposit_date, coalesce(trip->'destinations', '[]'::jsonb) AS destinations
    FROM policies.current_trips;
CREATE VIEW analytics.benefits WITH (security_invoker = true) AS
  SELECT policy_id, code AS benefit_code, account_id, name, benefit_group, underwriter, limits, premium, coverage_start, coverage_end
    FROM policies.policy_benefits;
CREATE VIEW analytics.premiums WITH (security_invoker = true) AS
  SELECT id AS premium_id, number AS record_number, type, account_id, policy_id, policy_event_seq AS transaction_id, state::text AS state, status,
         (premium_cents / 100.0)::numeric(14, 2) AS premium, (charge_cents / 100.0)::numeric(14, 2) AS charge, (refund_cents / 100.0)::numeric(14, 2) AS refund,
         (tax_cents / 100.0)::numeric(14, 2) AS tax, (commission_cents / 100.0)::numeric(14, 2) AS commission, per_benefit, allocation, occurred_at
    FROM billing.premium_records;
CREATE VIEW analytics.transactions WITH (security_invoker = true) AS
  SELECT seq AS transaction_id, policy_id, account_id,
         CASE WHEN type = 'bound' THEN 'bind' ELSE coalesce(data->>'transaction', type) END AS transaction_type,
         occurred_at
    FROM policies.policy_events;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO astra_app;

-- ---------------------------------------------------------------- Loads to the data platform
CREATE TABLE integration.data_loads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  started_at       timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL CHECK (status IN ('delivered', 'with_rejects')),
  trigger          text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  requested_by     text NOT NULL,
  items            integer NOT NULL CHECK (items >= 1),
  rejected         integer NOT NULL CHECK (rejected >= 0),
  -- The longest any change in the load had waited: the story's target is 15 minutes.
  max_lag_seconds  integer NOT NULL CHECK (max_lag_seconds >= 0),
  checks           jsonb NOT NULL,
  files            jsonb NOT NULL
);
CREATE TRIGGER data_loads_immutable BEFORE UPDATE OR DELETE ON integration.data_loads
  FOR EACH ROW EXECUTE FUNCTION audit.prevent_change();

-- Which changes have been loaded. A change is loaded once; rejected rows are listed in their load's reject file.
CREATE TABLE integration.data_load_items (
  item_key  text PRIMARY KEY,
  load_id   uuid NOT NULL REFERENCES integration.data_loads (id)
);
GRANT SELECT, INSERT ON integration.data_loads, integration.data_load_items TO astra_app;

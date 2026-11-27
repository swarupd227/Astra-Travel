-- The model API key a platform administrator saves in the application, and its connection tests (docs/adr/0024).

CREATE TABLE platform.model_credentials (
  id             uuid PRIMARY KEY,
  provider       text NOT NULL DEFAULT 'anthropic' CHECK (provider = 'anthropic'),
  -- Encrypted with the platform's key-encryption key; erased when the key is replaced or removed.
  ciphertext     text NULL,
  key_id         text NOT NULL,
  hint           text NOT NULL CHECK (length(hint) = 4),
  set_by         text NOT NULL,
  set_by_name    text NULL,
  set_reason     text NOT NULL,
  set_at         timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz NULL,
  removed_by     text NULL,
  removed_reason text NULL,
  CHECK ((removed_at IS NULL) = (ciphertext IS NOT NULL)),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
-- One key in force at a time.
CREATE UNIQUE INDEX model_credentials_one_active ON platform.model_credentials ((true)) WHERE removed_at IS NULL;

ALTER TABLE platform.model_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY model_credentials_platform ON platform.model_credentials FOR ALL
  USING (platform.is_platform_scope()) WITH CHECK (platform.is_platform_scope());
-- A saved record changes only when its key is erased.
GRANT SELECT, INSERT, UPDATE (ciphertext, removed_at, removed_by, removed_reason)
  ON platform.model_credentials TO astra_app;

CREATE TABLE platform.model_connection_tests (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credential_id  uuid NOT NULL REFERENCES platform.model_credentials (id),
  ok             boolean NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN
                   ('connected', 'invalid_key', 'no_access', 'model_unavailable', 'rate_limited', 'rejected',
                    'unreachable', 'service_error')),
  message        text NOT NULL,
  models         jsonb NOT NULL,
  latency_ms     integer NOT NULL CHECK (latency_ms >= 0),
  tested_at      timestamptz NOT NULL,
  tested_by      text NOT NULL,
  tested_by_name text NULL
);
CREATE INDEX model_connection_tests_latest ON platform.model_connection_tests (credential_id, tested_at DESC);

ALTER TABLE platform.model_connection_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_connection_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY model_connection_tests_platform ON platform.model_connection_tests FOR ALL
  USING (platform.is_platform_scope()) WITH CHECK (platform.is_platform_scope());
GRANT SELECT, INSERT ON platform.model_connection_tests TO astra_app;

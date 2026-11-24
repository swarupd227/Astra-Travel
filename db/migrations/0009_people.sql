-- Display names for the principals the platform records by identity-provider subject (who loaded,
-- approved, received...). Filled in from the signed-in token as people use the API, so screens can show
-- "Casey Compliance" instead of a subject ID. Names only: no other personal data is kept here.

CREATE TABLE platform.people (
  subject     text PRIMARY KEY CHECK (char_length(subject) BETWEEN 1 AND 255),
  name        text NULL CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 200),
  kind        text NOT NULL CHECK (kind IN ('user', 'partner', 'system', 'agent')),
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON platform.people TO astra_app;

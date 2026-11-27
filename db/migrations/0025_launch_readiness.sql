-- Increment 18: launch readiness and go-live sign-off (E16-F01-S01, E16-F02-S01). Design: docs/adr/0023.

CREATE SCHEMA launch;
GRANT USAGE ON SCHEMA launch TO astra_app;

-- A person's sign-off (or its withdrawal) for one area, of the readiness report exactly as it stood. A record: a
-- change of mind is a new row, and a changed report leaves earlier sign-offs behind.
CREATE TABLE launch.signoffs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area         text NOT NULL CHECK (area IN ('product', 'actuarial', 'compliance', 'finance')),
  decision     text NOT NULL CHECK (decision IN ('signed', 'withdrawn')),
  states       text[] NOT NULL CHECK (cardinality(states) >= 1),
  report_hash  text NOT NULL CHECK (report_hash ~ '^[0-9a-f]{64}$'),
  report       jsonb NOT NULL,
  note         text NOT NULL CHECK (char_length(note) BETWEEN 3 AND 2000),
  signed_by    text NOT NULL,
  signed_name  text NULL,
  signed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signoffs_by_hash ON launch.signoffs (report_hash, signed_at DESC);
CREATE TRIGGER signoffs_immutable BEFORE UPDATE OR DELETE ON launch.signoffs
  FOR EACH ROW EXECUTE FUNCTION audit.prevent_change();
GRANT SELECT, INSERT ON launch.signoffs TO astra_app;

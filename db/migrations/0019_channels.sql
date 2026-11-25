-- Increment 14: sales channels (E04-F03). Design: docs/adr/0015.

CREATE SCHEMA channels;
GRANT USAGE ON SCHEMA channels TO astra_app;

-- Per account: branding, whether its widget and hosted journey are on, and what they offer.
CREATE TABLE channels.settings (
  account_id    uuid PRIMARY KEY REFERENCES platform.accounts (id),
  branding      jsonb NULL,
  widget        jsonb NOT NULL DEFAULT '{"enabled": false, "allowedOrigins": []}',
  journey       jsonb NOT NULL DEFAULT '{"enabled": false, "slug": null, "planCodes": [], "headline": ""}',
  journey_slug  text NULL UNIQUE CHECK (journey_slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  updated_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Bookings sent in a file. The file's hash is unique per account, so the same file cannot be loaded twice.
CREATE TABLE channels.booking_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES platform.accounts (id),
  file_name     text NOT NULL,
  sha256        text NOT NULL,
  status        text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'rejected')),
  bookings      integer NOT NULL DEFAULT 0,
  accepted      integer NOT NULL DEFAULT 0,
  rejected      integer NOT NULL DEFAULT 0,
  reason        text NULL,
  storage_key   text NOT NULL,
  result_key    text NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, sha256)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['settings', 'booking_files'] LOOP
    EXECUTE format('ALTER TABLE channels.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE channels.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON channels.%I FOR ALL USING (platform.account_visible(account_id)) WITH CHECK (platform.account_visible(account_id))', t || '_tenant', t);
  END LOOP;
END $$;

-- The public journey and the widget's CORS check read settings by slug or origin without an account scope. Row-level
-- security still applies to the function's owner, so each function widens the scope for its own query and puts it back.
CREATE FUNCTION channels.journey_by_slug(p_slug text)
  RETURNS TABLE (account_id uuid, account_name text, sandbox boolean, status text, branding jsonb, journey jsonb)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = channels, platform, pg_temp
  AS $$
DECLARE prev text := coalesce(current_setting('app.account_ids', true), '');
BEGIN
  PERFORM set_config('app.account_ids', '*', true);
  RETURN QUERY
    SELECT s.account_id, a.name, a.sandbox, a.status, s.branding, s.journey
      FROM channels.settings s JOIN platform.accounts a ON a.id = s.account_id
     WHERE s.journey_slug = p_slug AND (s.journey ->> 'enabled')::boolean;
  PERFORM set_config('app.account_ids', prev, true);
END $$;

CREATE FUNCTION channels.widget_origins()
  RETURNS TABLE (origin text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = channels, pg_temp
  AS $$
DECLARE prev text := coalesce(current_setting('app.account_ids', true), '');
BEGIN
  PERFORM set_config('app.account_ids', '*', true);
  RETURN QUERY
    SELECT DISTINCT jsonb_array_elements_text(s.widget -> 'allowedOrigins') FROM channels.settings s WHERE (s.widget ->> 'enabled')::boolean;
  PERFORM set_config('app.account_ids', prev, true);
END $$;
GRANT EXECUTE ON FUNCTION channels.journey_by_slug(text), channels.widget_origins() TO astra_app;

GRANT SELECT, INSERT, UPDATE ON channels.settings, channels.booking_files TO astra_app;

-- Increment 11: policy servicing (E06). Design: docs/adr/0012.

-- A change to the trip or the premium moves the policy's term and premium with its record; the lists and
-- searches read them from the row. Every other column still cannot change, and status still follows the lifecycle.
CREATE OR REPLACE FUNCTION policies.policies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'policies are records and cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'term_start', 'term_end', 'premium_total']) <> (to_jsonb(OLD) - ARRAY['status', 'term_start', 'term_end', 'premium_total']) THEN
    RAISE EXCEPTION 'a policy''s record changes through events; only its status, term and premium are held on the row';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status IN ('cancelled', 'expired')) THEN
    RAISE EXCEPTION 'a % policy cannot become %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'active' AND (NEW.term_start <> OLD.term_start OR NEW.term_end <> OLD.term_end OR NEW.premium_total <> OLD.premium_total) THEN
    RAISE EXCEPTION 'a % policy cannot change', OLD.status;
  END IF;
  RETURN NEW;
END $$;

-- A servicing request the agent may not handle goes to the review queue as a review of its own kind.
ALTER TABLE agents.reviews DROP CONSTRAINT reviews_kind_check;
ALTER TABLE agents.reviews ADD CONSTRAINT reviews_kind_check
  CHECK (kind IN ('warrant_refusal', 'guardrail', 'agent_paused', 'budget', 'run_failed', 'model_refusal', 'servicing_request'));

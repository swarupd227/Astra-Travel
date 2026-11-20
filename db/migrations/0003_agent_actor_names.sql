-- Display names for the people who govern agents, so screens show "Sage Governance" rather than an
-- identity-provider subject ID. The subject columns remain the authoritative identity.
ALTER TABLE agents.agents ADD COLUMN status_changed_by_name text NULL;
ALTER TABLE agents.agent_versions ADD COLUMN approved_by_name text NULL;
ALTER TABLE agents.warrants ADD COLUMN created_by_name text NULL;
ALTER TABLE agents.budgets ADD COLUMN updated_by_name text NULL;
ALTER TABLE agents.reviews ADD COLUMN resolved_by_name text NULL;

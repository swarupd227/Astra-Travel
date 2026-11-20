-- Backfills the display names added in 0003 from the audit trail, which recorded each actor's name.
UPDATE agents.agent_versions v
   SET approved_by_name = (
         SELECT a.actor_name FROM audit.audit_log a
          WHERE a.resource_type = 'agent' AND a.resource_id = v.agent_id
            AND a.action IN ('agent_version.approved', 'agent_version.rejected')
            AND a.actor_id = v.approved_by
            AND (a.data ->> 'version')::int = v.version
          ORDER BY a.seq DESC LIMIT 1)
 WHERE v.approved_by IS NOT NULL AND v.approved_by_name IS NULL;

UPDATE agents.warrants w
   SET created_by_name = (
         SELECT a.actor_name FROM audit.audit_log a
          WHERE a.resource_type = 'agent' AND a.resource_id = w.agent_id
            AND a.action = 'agent_warrant.set' AND a.actor_id = w.created_by
            AND (a.data ->> 'version')::int = w.version
          ORDER BY a.seq DESC LIMIT 1)
 WHERE w.created_by_name IS NULL;

UPDATE agents.budgets b
   SET updated_by_name = (
         SELECT a.actor_name FROM audit.audit_log a
          WHERE a.resource_type = 'agent' AND a.resource_id = b.agent_id
            AND a.action = 'agent_budget.set' AND a.actor_id = b.updated_by
          ORDER BY a.seq DESC LIMIT 1)
 WHERE b.updated_by_name IS NULL;

UPDATE agents.agents g
   SET status_changed_by_name = (
         SELECT a.actor_name FROM audit.audit_log a
          WHERE a.resource_type = 'agent' AND a.resource_id = g.id
            AND a.action IN ('agent.paused', 'agent.resumed') AND a.actor_id = g.status_changed_by
          ORDER BY a.seq DESC LIMIT 1)
 WHERE g.status_changed_by_name IS NULL AND g.status_changed_by NOT LIKE 'system:%';

UPDATE agents.reviews r
   SET resolved_by_name = (
         SELECT a.actor_name FROM audit.audit_log a
          WHERE a.resource_type = 'agent_review' AND a.resource_id = r.id::text
            AND a.action = 'agent_review.resolved'
          ORDER BY a.seq DESC LIMIT 1)
 WHERE r.resolved_by IS NOT NULL AND r.resolved_by_name IS NULL;

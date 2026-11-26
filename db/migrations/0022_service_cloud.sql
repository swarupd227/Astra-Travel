-- Increment 16c: Salesforce Service Cloud (E14-F02). Design: docs/adr/0019.

-- An event that could not be delivered to a subscriber (Service Cloud's webhook among them) after every retry is
-- work for a person, so it joins the queue. That is the alert the story asks for.
ALTER TABLE workbench.sla_policies DROP CONSTRAINT sla_policies_source_type_check;
ALTER TABLE workbench.sla_policies ADD CONSTRAINT sla_policies_source_type_check
  CHECK (source_type IN ('referral', 'sanctions_hold', 'agent_proposal', 'agent_review', 'delivery_failure', 'event_delivery'));
ALTER TABLE workbench.assignments DROP CONSTRAINT assignments_source_type_check;
ALTER TABLE workbench.assignments ADD CONSTRAINT assignments_source_type_check
  CHECK (source_type IN ('referral', 'sanctions_hold', 'agent_proposal', 'agent_review', 'delivery_failure', 'event_delivery'));
INSERT INTO workbench.sla_policies (source_type, priority, target_hours) VALUES ('event_delivery', 'high', 4);

CREATE OR REPLACE VIEW workbench.queue WITH (security_invoker = true) AS
  SELECT w.source_type, w.source_id, w.title, w.summary, w.account_id, w.created_at, w.link,
         s.priority, w.created_at + make_interval(hours => s.target_hours) AS due_at, s.target_hours,
         a.owner, a.owner_name, a.assigned_at
    FROM (
      SELECT CASE WHEN r.kind = 'sanctions' THEN 'sanctions_hold' ELSE 'referral' END AS source_type,
             r.id AS source_id,
             CASE WHEN r.kind = 'sanctions' THEN 'Sanctions hold: ' ELSE 'Referral: ' END || r.case_ref AS title,
             r.summary, NULL::uuid AS account_id, r.created_at, '/underwriting/referrals/' || r.id AS link
        FROM underwriting.referrals r WHERE r.status = 'open'
      UNION ALL
      SELECT 'agent_proposal', p.id, 'Agent proposal: ' || replace(p.kind, '_', ' '), p.summary, NULL, p.created_at, '/proposals/' || p.id
        FROM agents.proposals p WHERE p.status = 'open'
      UNION ALL
      SELECT 'agent_review', v.id, 'Agent needs review: ' || replace(v.kind, '_', ' '), v.summary, NULL, v.created_at, '/agents/reviews'
        FROM agents.reviews v WHERE v.status = 'open'
      UNION ALL
      SELECT 'delivery_failure', d.id, 'Not delivered: ' || doc.title, coalesce(d.last_error, 'Delivery failed'), d.account_id, d.updated_at, '/documents/' || doc.id
        FROM documents.deliveries d JOIN documents.documents doc ON doc.id = d.document_id WHERE d.status = 'failed'
      UNION ALL
      -- An event delivery has no single identifier: one is made from the event and the subscriber, with the version
      -- and variant digits a well-formed identifier carries.
      SELECT 'event_delivery', overlay(overlay(md5(e.event_id::text || ':' || e.subscriber) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid, 'Event not delivered: ' || e.event_type,
             'To ' || e.subscriber || ' after ' || e.attempts || ' attempts. ' || coalesce(e.last_error, ''), e.account_id, e.updated_at, '/operations/events'
        FROM platform.event_deliveries e WHERE e.status = 'dead'
    ) w
    JOIN workbench.sla_policies s ON s.source_type = w.source_type
    LEFT JOIN workbench.assignments a ON a.source_type = w.source_type AND a.source_id = w.source_id;

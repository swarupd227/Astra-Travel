-- Increment 1: agent platform and governance (epic E15, specification section 10).
-- Registry, versions with approval, warrants, runs with an append-only step record, review tasks routed
-- to people, monthly budgets, and evaluation sets and runs. Agent data is platform-level: only staff
-- routes read it, and agents themselves never touch these tables.

CREATE SCHEMA agents;
GRANT USAGE ON SCHEMA agents TO astra_app;

CREATE TABLE agents.agents (
  id                 text PRIMARY KEY CHECK (id ~ '^AG-[0-9]{2}$'),
  name               text NOT NULL,
  purpose            text NOT NULL,
  owner_role         text NOT NULL,
  autonomy           text NOT NULL CHECK (autonomy IN ('L0', 'L1', 'L2', 'L3')),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  status_reason      text NULL,
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  status_changed_by  text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per distinct manifest (prompt, model, tools, data access). The hash ties the running code to
-- what was approved.
CREATE TABLE agents.agent_versions (
  agent_id         text NOT NULL REFERENCES agents.agents (id),
  version          integer NOT NULL CHECK (version >= 1),
  config_hash      text NOT NULL,
  model            text NOT NULL,
  prompt_version   text NOT NULL,
  system_prompt    text NOT NULL,
  tools            text[] NOT NULL,
  data_access      text[] NOT NULL,
  effort           text NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  max_tokens       integer NOT NULL CHECK (max_tokens BETWEEN 256 AND 128000),
  registered_at    timestamptz NOT NULL DEFAULT now(),
  registered_by    text NOT NULL,
  approval_status  text NOT NULL DEFAULT 'pending'
                   CHECK (approval_status IN ('pending', 'approved', 'rejected', 'retired')),
  approved_by      text NULL,
  approved_at      timestamptz NULL,
  approval_reason  text NULL,
  PRIMARY KEY (agent_id, version),
  UNIQUE (agent_id, config_hash)
);

CREATE TABLE agents.warrants (
  agent_id    text NOT NULL REFERENCES agents.agents (id),
  version     integer NOT NULL CHECK (version >= 1),
  document    jsonb NOT NULL,
  status      text NOT NULL CHECK (status IN ('active', 'superseded')),
  reason      text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version)
);
CREATE UNIQUE INDEX warrants_one_active ON agents.warrants (agent_id) WHERE status = 'active';

CREATE TABLE agents.budgets (
  agent_id             text PRIMARY KEY REFERENCES agents.agents (id),
  monthly_limit_usd    numeric(12, 2) NOT NULL CHECK (monthly_limit_usd >= 0),
  alert_threshold_pct  integer NOT NULL CHECK (alert_threshold_pct BETWEEN 1 AND 100),
  last_alerted_period  text NULL,
  updated_by           text NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents.eval_sets (
  agent_id    text NOT NULL REFERENCES agents.agents (id),
  name        text NOT NULL,
  version     integer NOT NULL,
  threshold   numeric(4, 3) NOT NULL CHECK (threshold > 0 AND threshold <= 1),
  cases       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, name, version)
);

CREATE TABLE agents.eval_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          text NOT NULL,
  agent_version     integer NOT NULL,
  eval_set          text NOT NULL,
  eval_set_version  integer NOT NULL,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  score             numeric(4, 3) NULL,
  passed            boolean NULL,
  results           jsonb NULL,
  error             text NULL,
  cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
  started_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz NULL,
  locked_until      timestamptz NULL,
  FOREIGN KEY (agent_id, agent_version) REFERENCES agents.agent_versions (agent_id, version),
  FOREIGN KEY (agent_id, eval_set, eval_set_version) REFERENCES agents.eval_sets (agent_id, name, version)
);
CREATE INDEX eval_runs_queued ON agents.eval_runs (created_at) WHERE status = 'queued';
CREATE INDEX eval_runs_by_version ON agents.eval_runs (agent_id, agent_version, created_at DESC);

CREATE TABLE agents.runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            text NOT NULL,
  agent_version       integer NOT NULL,
  warrant_version     integer NULL,
  purpose             text NOT NULL CHECK (purpose IN ('request', 'evaluation')),
  eval_run_id         uuid NULL REFERENCES agents.eval_runs (id),
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'stopped', 'escalated')),
  stop_reason         text NULL,
  requested_by        text NOT NULL,
  requested_by_name   text NULL,
  account_scope       text NOT NULL,
  permissions         text[] NOT NULL,
  input               jsonb NOT NULL,
  output              jsonb NULL,
  error               text NULL,
  model_requested     text NULL,
  models_served       text[] NOT NULL DEFAULT '{}',
  prompt_version      text NULL,
  turns               integer NOT NULL DEFAULT 0,
  tool_calls          integer NOT NULL DEFAULT 0,
  input_tokens        bigint NOT NULL DEFAULT 0,
  output_tokens       bigint NOT NULL DEFAULT 0,
  cache_read_tokens   bigint NOT NULL DEFAULT 0,
  cache_write_tokens  bigint NOT NULL DEFAULT 0,
  cost_usd            numeric(12, 6) NOT NULL DEFAULT 0,
  correlation_id      text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz NULL,
  finished_at         timestamptz NULL,
  locked_until        timestamptz NULL,
  FOREIGN KEY (agent_id, agent_version) REFERENCES agents.agent_versions (agent_id, version)
);
CREATE INDEX runs_queued ON agents.runs (created_at) WHERE status = 'queued';
CREATE INDEX runs_by_agent ON agents.runs (agent_id, created_at DESC);
CREATE INDEX runs_by_requester ON agents.runs (requested_by, created_at DESC);
CREATE INDEX runs_by_month ON agents.runs (agent_id, created_at) INCLUDE (cost_usd);

-- Append-only record of everything a run did: guardrail decisions, warrant checks, model calls, tool
-- calls and results, escalations.
CREATE TABLE agents.run_steps (
  run_id    uuid NOT NULL REFERENCES agents.runs (id),
  seq       integer NOT NULL,
  at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind      text NOT NULL CHECK (kind IN ('input', 'guardrail', 'warrant', 'model_call', 'tool_call',
                                          'tool_result', 'kill_switch', 'budget', 'escalation', 'output')),
  name      text NULL,
  decision  text NULL CHECK (decision IN ('allowed', 'refused', 'redacted', 'stopped', 'error')),
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, seq)
);

CREATE TRIGGER run_steps_immutable BEFORE UPDATE OR DELETE ON agents.run_steps
  FOR EACH ROW EXECUTE FUNCTION audit.prevent_change();
CREATE TRIGGER run_steps_no_truncate BEFORE TRUNCATE ON agents.run_steps
  FOR EACH STATEMENT EXECUTE FUNCTION audit.prevent_change();

CREATE TABLE agents.reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         text NOT NULL REFERENCES agents.agents (id),
  run_id           uuid NULL REFERENCES agents.runs (id),
  kind             text NOT NULL CHECK (kind IN ('warrant_refusal', 'guardrail', 'agent_paused',
                                                 'budget', 'run_failed', 'model_refusal')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  summary          text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_by      text NULL,
  resolved_at      timestamptz NULL,
  resolution       text NULL CHECK (resolution IN ('accepted', 'rejected', 'handled')),
  resolution_note  text NULL
);
CREATE INDEX reviews_open ON agents.reviews (created_at) WHERE status = 'open';

GRANT SELECT, INSERT, UPDATE ON agents.agents, agents.agent_versions, agents.warrants, agents.budgets,
  agents.eval_sets, agents.eval_runs, agents.runs, agents.reviews TO astra_app;
GRANT SELECT, INSERT ON agents.run_steps TO astra_app;

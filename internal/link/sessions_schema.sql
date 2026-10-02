-- Project/channel-scoped execution presence is independent of legacy leases.
-- Deleting an explicitly selected project/channel removes only its presence.
CREATE TABLE IF NOT EXISTS execution_sessions (
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 session_id text NOT NULL,
 channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 run_id text NOT NULL,
 task_role text NOT NULL CHECK(task_role IN ('listener','writer','tester','reviewer')),
 runtime text NOT NULL, model text NOT NULL DEFAULT '', activity text NOT NULL DEFAULT '',
 ttl_seconds integer NOT NULL CHECK(ttl_seconds BETWEEN 10 AND 120),
 max_duration_seconds integer NOT NULL CHECK(max_duration_seconds BETWEEN 30 AND 3600),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 deadline_at timestamptz NOT NULL,
 closed_at timestamptz,
 payload_hash bytea NOT NULL,
 PRIMARY KEY(project_id,agent_id,session_id),
 CHECK(ttl_seconds <= max_duration_seconds), CHECK(expires_at <= deadline_at)
);
CREATE INDEX IF NOT EXISTS execution_sessions_visible ON execution_sessions(project_id,channel_id,created_at DESC);
CREATE INDEX IF NOT EXISTS execution_sessions_agent ON execution_sessions(agent_id,expires_at) WHERE closed_at IS NULL;

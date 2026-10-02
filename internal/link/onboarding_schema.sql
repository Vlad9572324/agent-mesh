-- One-time onboarding capabilities. Raw invitations and personal keys never persist.
CREATE TABLE IF NOT EXISTS onboarding_invitations (
 id text PRIMARY KEY,
 agent_id text NOT NULL REFERENCES principals(id),
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 channel_ids jsonb NOT NULL CHECK(jsonb_typeof(channel_ids)='array' AND jsonb_array_length(channel_ids) BETWEEN 1 AND 8),
 runtime text NOT NULL CHECK(runtime IN ('auto','codex','claude')),
 token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 created_by text NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 claimed_at timestamptz,
 revoked_at timestamptz,
 CHECK(expires_at > created_at),
 CHECK(claimed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS onboarding_invitations_agent ON onboarding_invitations(agent_id);
CREATE INDEX IF NOT EXISTS onboarding_invitations_project ON onboarding_invitations(project_id);

-- Declared expectations about how an agent is reached and how often it makes contact.
-- A profile is an untrusted, bounded statement (never a command or a verified runtime
-- fact); it only tunes how observed contact is interpreted. Missing row = unconfigured.
CREATE TABLE IF NOT EXISTS agent_wake_profiles (
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK(mode IN ('loop','tmux','on_demand','unknown')),
 expected_response_seconds integer CHECK(expected_response_seconds BETWEEN 30 AND 86400),
 expected_contact_seconds integer CHECK(expected_contact_seconds BETWEEN 15 AND 86400),
 version bigint NOT NULL DEFAULT 1 CHECK(version >= 1),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by text NOT NULL,
 set_by text NOT NULL CHECK(set_by IN ('self','owner')),
 PRIMARY KEY(project_id,agent_id),
 CHECK((mode='unknown') = (expected_response_seconds IS NULL)),
 CHECK(expected_contact_seconds IS NULL OR mode IN ('loop','tmux')),
 CHECK(mode <> 'loop' OR expected_contact_seconds IS NOT NULL)
);
-- Latest-contact lookups per (channel, actor) must not scan history (10k rows/channel).
CREATE INDEX IF NOT EXISTS native_activity_actor_latest ON native_activity(channel_id,actor_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS messages_author_latest ON messages(channel_id,author_id,created_at DESC,id DESC);

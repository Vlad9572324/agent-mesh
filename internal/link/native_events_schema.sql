-- Sanitized client-observed CLI events. No arbitrary text/payload columns.
CREATE TABLE IF NOT EXISTS native_activity (
 id text PRIMARY KEY,
 channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 seq bigint NOT NULL CHECK(seq > 0),
 actor_id text NOT NULL REFERENCES principals(id),
 client_id text NOT NULL,
 session_id text NOT NULL,
 runtime text NOT NULL CHECK(runtime IN ('codex','claude')),
 event_type text NOT NULL CHECK(event_type IN ('session.started','session.ended','turn.started','turn.completed','tool.started','tool.completed','tool.failed','agent.waiting','inbox.offered','inbox.accepted')),
 tool_name text,
 message_id text REFERENCES messages(id) ON DELETE CASCADE,
 request_hash bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(channel_id,seq),
 UNIQUE(channel_id,actor_id,client_id),
 CHECK(client_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 CHECK(session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 CHECK(tool_name IS NULL OR (event_type IN ('tool.started','tool.completed','tool.failed') AND tool_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')),
 CHECK((event_type IN ('inbox.offered','inbox.accepted')) = (message_id IS NOT NULL))
);

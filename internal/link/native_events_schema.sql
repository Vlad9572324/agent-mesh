-- Sanitized client-observed CLI events. No arbitrary text/payload columns.
CREATE TABLE IF NOT EXISTS native_activity (
 id text PRIMARY KEY,
 channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 seq bigint NOT NULL CHECK(seq > 0),
 actor_id text NOT NULL REFERENCES principals(id),
 client_id text NOT NULL,
 session_id text NOT NULL,
 runtime text NOT NULL CHECK(runtime IN ('codex','claude')),
 event_type text NOT NULL CHECK(event_type IN ('session.started','session.ended','turn.started','turn.completed','tool.started','tool.completed','tool.failed','agent.waiting','inbox.offered','inbox.seen','inbox.accepted')),
 tool_name text,
 message_id text REFERENCES messages(id) ON DELETE CASCADE,
 request_hash bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(channel_id,seq),
 UNIQUE(channel_id,actor_id,client_id),
 CHECK(client_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 CHECK(session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
 CHECK(tool_name IS NULL OR (event_type IN ('tool.started','tool.completed','tool.failed') AND tool_name ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')),
 CHECK((event_type IN ('inbox.offered','inbox.seen','inbox.accepted')) = (message_id IS NOT NULL))
);
-- Upgrade both original unnamed CHECK constraints in place. PostgreSQL may
-- choose their names differently; identify only the old inbox-related checks.
-- Existing activity rows remain immutable, and repeated migrations are no-ops.
DO $$ DECLARE constraint_row record; BEGIN
 FOR constraint_row IN
  SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
  WHERE conrelid='native_activity'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%inbox.offered%'
    AND pg_get_constraintdef(oid) NOT LIKE '%inbox.seen%'
 LOOP
  EXECUTE format('ALTER TABLE native_activity DROP CONSTRAINT %I', constraint_row.conname);
  EXECUTE format('ALTER TABLE native_activity ADD CONSTRAINT %I %s', constraint_row.conname,
   replace(constraint_row.definition, '''inbox.offered''::text', '''inbox.offered''::text, ''inbox.seen''::text'));
 END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS principals (
 id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('agent','viewer','owner')),
 key_hash bytea UNIQUE, session_id text NOT NULL DEFAULT '', last_seen_at timestamptz,
 activity text NOT NULL DEFAULT '', runtime text NOT NULL DEFAULT ''
);
-- Upgrade the original constraint without rewriting principals or their keys.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='principals'::regclass
            AND conname='principals_kind_check' AND pg_get_constraintdef(oid) NOT LIKE '%owner%') THEN
  ALTER TABLE principals DROP CONSTRAINT principals_kind_check;
  ALTER TABLE principals ADD CONSTRAINT principals_kind_check CHECK(kind IN ('agent','viewer','owner'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY, name text NOT NULL);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lifecycle_version bigint NOT NULL DEFAULT 0 CHECK(lifecycle_version >= 0);
-- Content-free ID reservations prevent delayed adapter outboxes from targeting
-- an unrelated replacement project/channel after explicit hard deletion.
CREATE TABLE IF NOT EXISTS retired_project_ids (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS retired_channel_ids (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS project_members (
 project_id text REFERENCES projects(id), agent_id text REFERENCES principals(id), can_write boolean NOT NULL DEFAULT false,
 PRIMARY KEY(project_id,agent_id)
);
CREATE TABLE IF NOT EXISTS channels (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), name text NOT NULL, cursor bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channel_members (
 channel_id text REFERENCES channels(id), agent_id text REFERENCES principals(id), can_write boolean NOT NULL DEFAULT false,
 PRIMARY KEY(channel_id,agent_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id text PRIMARY KEY, channel_id text NOT NULL REFERENCES channels(id), seq bigint NOT NULL,
 author_id text NOT NULL REFERENCES principals(id), client_id text NOT NULL, body text NOT NULL,
 recipient_ids jsonb NOT NULL, reply_to text REFERENCES messages(id), payload_hash bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(channel_id,seq), UNIQUE(channel_id,author_id,client_id)
);
CREATE TABLE IF NOT EXISTS receipts (
 message_id text REFERENCES messages(id), agent_id text REFERENCES principals(id),
 delivered_at timestamptz, accepted_at timestamptz, uncertain_at timestamptz, session_id text NOT NULL DEFAULT '',
 PRIMARY KEY(message_id,agent_id)
);
CREATE TABLE IF NOT EXISTS events (
 channel_id text REFERENCES channels(id), seq bigint NOT NULL, kind text NOT NULL, entity_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(channel_id,seq)
);
CREATE TABLE IF NOT EXISTS notes (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), author_id text NOT NULL REFERENCES principals(id),
 client_id text NOT NULL, title text NOT NULL, body text NOT NULL, source_message_id text REFERENCES messages(id),
 version integer NOT NULL DEFAULT 1, payload_hash bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(project_id,author_id,client_id)
);
CREATE TABLE IF NOT EXISTS admin_audit (
 id bigserial PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL,
 target_type text NOT NULL, target_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

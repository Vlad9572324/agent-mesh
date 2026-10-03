-- Small immutable authenticated handoff objects, not an execution/upload service.
CREATE TABLE IF NOT EXISTS link_artifacts (
 id text PRIMARY KEY, seq bigint NOT NULL,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 author_id text NOT NULL REFERENCES principals(id), client_id text NOT NULL,
 role text NOT NULL CHECK(role IN ('baseline','implementation','test','evidence','bundle','document')),
 base_revision text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 2097152),
 payload bytea NOT NULL CHECK(octet_length(payload)=size_bytes),
 request_hash bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,author_id,client_id)
);
-- Old rows retain their bytes, identity and request hash. Untitled requests
-- retain the original canonical hash, including after a migration/restart.
ALTER TABLE link_artifacts ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT ''
 CHECK(octet_length(title) <= 200);
-- Extend only the exact legacy role enum, including if it was renamed.
-- Other custom checks remain intact; do not broaden arbitrary role predicates.
DO $$ DECLARE constraint_row record; BEGIN
 FOR constraint_row IN
  SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
  WHERE conrelid='link_artifacts'::regclass AND contype='c'
    AND conkey=ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid='link_artifacts'::regclass AND attname='role' AND NOT attisdropped)]
    AND pg_get_constraintdef(oid)=$legacy$CHECK ((role = ANY (ARRAY['baseline'::text, 'implementation'::text, 'test'::text, 'evidence'::text, 'bundle'::text])))$legacy$
 LOOP
  EXECUTE format('ALTER TABLE link_artifacts DROP CONSTRAINT %I', constraint_row.conname);
  EXECUTE format('ALTER TABLE link_artifacts ADD CONSTRAINT %I %s', constraint_row.conname,
   replace(constraint_row.definition, '''bundle''::text', '''bundle''::text, ''document''::text'));
 END LOOP;
END $$;
-- A project-local cursor does not disclose publication counts in other projects.
-- These two ALTERs also upgrade pre-release test databases safely.
ALTER TABLE link_artifacts ALTER COLUMN seq DROP DEFAULT;
ALTER TABLE link_artifacts DROP CONSTRAINT IF EXISTS link_artifacts_seq_key;
CREATE UNIQUE INDEX IF NOT EXISTS link_artifacts_project_cursor ON link_artifacts(project_id,seq);

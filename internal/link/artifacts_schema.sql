-- Small immutable authenticated handoff objects, not an execution/upload service.
CREATE TABLE IF NOT EXISTS link_artifacts (
 id text PRIMARY KEY, seq bigint NOT NULL,
 project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 author_id text NOT NULL REFERENCES principals(id), client_id text NOT NULL,
 role text NOT NULL CHECK(role IN ('baseline','implementation','test','evidence','bundle')),
 base_revision text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 2097152),
 payload bytea NOT NULL CHECK(octet_length(payload)=size_bytes),
 request_hash bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,author_id,client_id)
);
-- A project-local cursor does not disclose publication counts in other projects.
-- These two ALTERs also upgrade pre-release test databases safely.
ALTER TABLE link_artifacts ALTER COLUMN seq DROP DEFAULT;
ALTER TABLE link_artifacts DROP CONSTRAINT IF EXISTS link_artifacts_seq_key;
CREATE UNIQUE INDEX IF NOT EXISTS link_artifacts_project_cursor ON link_artifacts(project_id,seq);

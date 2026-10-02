CREATE TABLE IF NOT EXISTS link_memory (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author_id text NOT NULL REFERENCES principals(id),
    updated_by text NOT NULL REFERENCES principals(id),
    title text NOT NULL,
    body text NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS link_memory_project ON link_memory(project_id, updated_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS link_memory_id_project_scope ON link_memory(id, project_id);
CREATE TABLE IF NOT EXISTS link_memory_versions (
    memory_id text NOT NULL REFERENCES link_memory(id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version bigint NOT NULL CHECK(version > 0),
    author_id text NOT NULL REFERENCES principals(id),
    client_id text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    payload_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(memory_id, version),
    UNIQUE(project_id, author_id, client_id)
);
DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='link_memory_versions'::regclass AND conname='link_memory_versions_project_scope') THEN
        ALTER TABLE link_memory_versions ADD CONSTRAINT link_memory_versions_project_scope
            FOREIGN KEY(memory_id,project_id) REFERENCES link_memory(id,project_id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS link_tasks (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title text NOT NULL,
    owner_id text NOT NULL REFERENCES principals(id),
    reviewer_id text NOT NULL REFERENCES principals(id),
    scope jsonb NOT NULL,
    acceptance jsonb NOT NULL,
    created_by text NOT NULL REFERENCES principals(id),
    client_id text NOT NULL,
    payload_hash bytea NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
    state text NOT NULL DEFAULT 'ready',
    current_run_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(owner_id <> reviewer_id),
    UNIQUE(project_id, created_by, client_id)
);
CREATE INDEX IF NOT EXISTS link_tasks_project ON link_tasks(project_id, created_at, id);
CREATE TABLE IF NOT EXISTS link_task_runs (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES link_tasks(id) ON DELETE CASCADE,
    state text NOT NULL,
    version bigint NOT NULL CHECK(version > 0),
    artifacts jsonb NOT NULL DEFAULT '[]',
    review_request_id text,
    verification_status text CHECK(verification_status IN ('passed','failed','inconclusive')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS link_task_runs_task ON link_task_runs(task_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS link_task_runs_id_task_scope ON link_task_runs(id, task_id);
CREATE TABLE IF NOT EXISTS link_task_events (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES link_tasks(id) ON DELETE CASCADE,
    run_id text NOT NULL REFERENCES link_task_runs(id) ON DELETE CASCADE,
    actor_id text NOT NULL REFERENCES principals(id),
    client_id text NOT NULL,
    version bigint NOT NULL CHECK(version > 1),
    type text NOT NULL,
    payload jsonb NOT NULL,
    payload_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(task_id, actor_id, client_id),
    UNIQUE(task_id, version)
);
-- Additive scope constraints also protect an already initialized deployment
-- against accidental cross-task references outside the HTTP implementation.
DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='link_task_events'::regclass AND conname='link_task_events_run_scope') THEN
        ALTER TABLE link_task_events ADD CONSTRAINT link_task_events_run_scope
            FOREIGN KEY(run_id,task_id) REFERENCES link_task_runs(id,task_id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='link_tasks'::regclass AND conname='link_tasks_current_run_scope') THEN
        ALTER TABLE link_tasks ADD CONSTRAINT link_tasks_current_run_scope
            FOREIGN KEY(current_run_id,id) REFERENCES link_task_runs(id,task_id) DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

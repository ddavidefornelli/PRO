DROP TRIGGER max_three_tasks_insert;
DROP TRIGGER max_three_tasks_move;
DROP INDEX tasks_planned_for;
DROP INDEX tasks_completed_on;
DROP INDEX one_active_task;
ALTER TABLE tasks RENAME TO tasks_v1;
CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    outcome TEXT NOT NULL CHECK(length(trim(outcome)) BETWEEN 1 AND 500),
    planned_for TEXT NOT NULL CHECK(length(planned_for) = 10),
    estimated_minutes INTEGER NOT NULL CHECK(estimated_minutes BETWEEN 1 AND 1440),
    actual_seconds INTEGER NOT NULL DEFAULT 0 CHECK(actual_seconds >= 0),
    status TEXT NOT NULL CHECK(status IN ('planned', 'active', 'completed')),
    started_at INTEGER,
    completed_on TEXT,
    created_at INTEGER NOT NULL,
    CHECK(status = 'active' OR started_at IS NULL),
    CHECK((status = 'completed' AND completed_on IS NOT NULL) OR (status != 'completed' AND completed_on IS NULL))
);

CREATE INDEX tasks_planned_for ON tasks(planned_for, created_at, id);
CREATE INDEX tasks_completed_on ON tasks(completed_on) WHERE status = 'completed';
CREATE UNIQUE INDEX one_active_task ON tasks(status) WHERE status = 'active';

CREATE TRIGGER max_three_tasks_insert BEFORE INSERT ON tasks
WHEN (SELECT count(*) FROM tasks WHERE planned_for = NEW.planned_for) >= 3
BEGIN
    SELECT RAISE(ABORT, 'A day can contain at most three tasks');
END;

CREATE TRIGGER max_three_tasks_move BEFORE UPDATE OF planned_for ON tasks
WHEN NEW.planned_for != OLD.planned_for
    AND (SELECT count(*) FROM tasks WHERE planned_for = NEW.planned_for) >= 3
BEGIN
    SELECT RAISE(ABORT, 'A day can contain at most three tasks');
END;

INSERT INTO tasks SELECT * FROM tasks_v1;
DROP TABLE tasks_v1;

CREATE TABLE timer_pauses (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
    paused_at INTEGER NOT NULL
);
CREATE INDEX timer_pauses_task ON timer_pauses(task_id, paused_at);

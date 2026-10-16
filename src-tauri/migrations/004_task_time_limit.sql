-- Keep existing estimates intact, but cap new or explicitly changed estimates.
CREATE TRIGGER max_task_estimate_insert BEFORE INSERT ON tasks
WHEN NEW.estimated_minutes > 60
BEGIN
    SELECT RAISE(ABORT, 'A task can take at most 60 minutes');
END;

CREATE TRIGGER max_task_estimate_update BEFORE UPDATE OF estimated_minutes ON tasks
WHEN NEW.estimated_minutes > 60
BEGIN
    SELECT RAISE(ABORT, 'A task can take at most 60 minutes');
END;

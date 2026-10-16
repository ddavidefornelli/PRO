ALTER TABLE tasks ADD COLUMN is_priority INTEGER NOT NULL DEFAULT 0 CHECK (is_priority IN (0, 1));
UPDATE tasks SET is_priority = 1 WHERE id IN (
    SELECT (SELECT first.id FROM tasks AS first WHERE first.planned_for = days.planned_for ORDER BY first.created_at, first.id LIMIT 1)
    FROM tasks AS days GROUP BY days.planned_for
);
CREATE UNIQUE INDEX one_priority_per_day ON tasks(planned_for) WHERE is_priority = 1;

use crate::{
    application::{CompletionCount, TaskRepository},
    domain::{AppError, Result, Task, TaskStatus},
};
use chrono::NaiveDate;
use rusqlite::{params, types::Type, Connection, OptionalExtension, Row, TransactionBehavior};
use std::{path::Path, time::Duration};

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(Box::new(error))
    }
}

pub struct SqliteTaskRepository {
    connection: Connection,
}

impl SqliteTaskRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    pub fn in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut connection: Connection) -> Result<Self> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
        )?;
        // Take the write lock before checking the version so concurrent opens cannot race migrations.
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        match version {
            0 => {
                transaction.execute_batch(include_str!("../../migrations/001_initial.sql"))?;
            }
            1 | 2 | 3 | 4 | 5 => {}
            _ => {
                return Err(AppError::Validation(
                    "This database was created by a newer app version.".into(),
                ))
            }
        }
        if version < 2 {
            transaction.execute_batch(include_str!("../../migrations/002_timer_pauses.sql"))?;
            transaction.pragma_update(None, "user_version", 2)?;
        }
        if version < 3 {
            transaction.execute_batch(include_str!("../../migrations/003_task_resources.sql"))?;
            transaction.pragma_update(None, "user_version", 3)?;
        }
        if version < 4 {
            transaction.execute_batch(include_str!("../../migrations/004_task_time_limit.sql"))?;
            transaction.pragma_update(None, "user_version", 4)?;
        }
        if version < 5 {
            transaction.execute_batch(include_str!("../../migrations/005_task_priority.sql"))?;
            transaction.pragma_update(None, "user_version", 5)?;
        }
        transaction.commit()?;
        Ok(Self { connection })
    }

    fn row_to_task(row: &Row<'_>) -> rusqlite::Result<Task> {
        let status: String = row.get("status")?;
        let status = match status.as_str() {
            "planned" => TaskStatus::Planned,
            "active" => TaskStatus::Active,
            "completed" => TaskStatus::Completed,
            _ => return Err(rusqlite::Error::InvalidQuery),
        };
        Ok(Task {
            id: row.get("id")?,
            outcome: row.get("outcome")?,
            is_priority: row.get("is_priority")?,
            planned_for: Self::date(row, "planned_for")?,
            estimated_minutes: row.get("estimated_minutes")?,
            actual_seconds: row.get("actual_seconds")?,
            status,
            started_at: row.get("started_at")?,
            completed_on: row
                .get::<_, Option<String>>("completed_on")?
                .map(|text| Self::parse_date(&text))
                .transpose()?,
            created_at: row.get("created_at")?,
            resources: serde_json::from_str(&row.get::<_, String>("resources")?).map_err(
                |error| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error)),
            )?,
        })
    }

    fn parse_date(value: &str) -> rusqlite::Result<NaiveDate> {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error))
        })
    }

    fn date(row: &Row<'_>, column: &str) -> rusqlite::Result<NaiveDate> {
        Self::parse_date(&row.get::<_, String>(column)?)
    }
}

impl TaskRepository for SqliteTaskRepository {
    fn list(&self, day: NaiveDate) -> Result<Vec<Task>> {
        let mut query = self
            .connection
            .prepare("SELECT * FROM tasks WHERE planned_for = ?1 ORDER BY created_at, id")?;
        let tasks = query
            .query_map([day.to_string()], Self::row_to_task)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tasks)
    }

    fn find(&self, id: &str) -> Result<Task> {
        self.connection
            .query_row("SELECT * FROM tasks WHERE id = ?1", [id], Self::row_to_task)
            .optional()?
            .ok_or(AppError::NotFound)
    }

    fn active(&self) -> Result<Option<Task>> {
        Ok(self
            .connection
            .query_row(
                "SELECT * FROM tasks WHERE status = 'active'",
                [],
                Self::row_to_task,
            )
            .optional()?)
    }

    fn insert(&mut self, task: &Task) -> Result<()> {
        self.connection.execute(
            "INSERT INTO tasks (id, outcome, planned_for, estimated_minutes, actual_seconds, status, started_at, completed_on, created_at, is_priority)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![task.id, task.outcome, task.planned_for.to_string(), task.estimated_minutes,
                task.actual_seconds, task.status.as_str(), task.started_at,
                task.completed_on.map(|day| day.to_string()), task.created_at, task.is_priority],
        )?;
        Ok(())
    }

    fn set_priority(&mut self, task: &Task) -> Result<()> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("UPDATE tasks SET is_priority = 0 WHERE planned_for = ?1", [task.planned_for.to_string()])?;
        transaction.execute("UPDATE tasks SET is_priority = 1 WHERE id = ?1", [&task.id])?;
        transaction.commit()?;
        Ok(())
    }

    fn update(&mut self, task: &Task) -> Result<()> {
        // Status, timer and completion date are committed as one atomic statement.
        let changed = self.connection.execute(
            "UPDATE tasks SET status = ?1, started_at = ?2, actual_seconds = ?3, completed_on = ?4, resources = ?6, outcome = ?7, estimated_minutes = ?8 WHERE id = ?5",
            params![task.status.as_str(), task.started_at, task.actual_seconds,
                task.completed_on.map(|day| day.to_string()), task.id,
                serde_json::to_string(&task.resources).map_err(|error| AppError::Storage(Box::new(error)))?, task.outcome, task.estimated_minutes],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound);
        }
        Ok(())
    }

    fn save_pause(&mut self, task: &Task, reason: &str, paused_at: i64) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE tasks SET started_at = NULL, actual_seconds = ?1
             WHERE id = ?2 AND status = 'active' AND started_at IS NOT NULL",
            params![task.actual_seconds, task.id],
        )?;
        if changed != 1 {
            return Err(AppError::Conflict("The timer is no longer running.".into()));
        }
        transaction.execute(
            "INSERT INTO timer_pauses (task_id, reason, paused_at) VALUES (?1, ?2, ?3)",
            params![task.id, reason, paused_at],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn update_pause_reason(&mut self, task_id: &str, reason: &str) -> Result<()> {
        let changed = self.connection.execute(
            "UPDATE timer_pauses SET reason = ?1 WHERE id =
             (SELECT id FROM timer_pauses WHERE task_id = ?2 ORDER BY id DESC LIMIT 1)",
            params![reason, task_id],
        )?;
        if changed != 1 {
            return Err(AppError::NotFound);
        }
        Ok(())
    }

    fn completions(&self, since: NaiveDate, until: NaiveDate) -> Result<Vec<CompletionCount>> {
        let mut query = self.connection.prepare(
            "SELECT completed_on, count(*) AS count FROM tasks
             WHERE status = 'completed' AND completed_on BETWEEN ?1 AND ?2
             GROUP BY completed_on ORDER BY completed_on",
        )?;
        let counts = query
            .query_map(params![since.to_string(), until.to_string()], |row| {
                Ok(CompletionCount {
                    day: Self::date(row, "completed_on")?,
                    count: row.get("count")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(counts)
    }
}

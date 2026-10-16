use super::{Clock, CompletionCount, TaskRepository};
use crate::domain::{AppError, Result, Task, TaskStatus};
use chrono::{Days, NaiveDate};
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    today: NaiveDate,
    tomorrow: NaiveDate,
    today_tasks: Vec<Task>,
    tomorrow_tasks: Vec<Task>,
    active_task: Option<Task>,
    can_plan_tomorrow: bool,
    completions: Vec<CompletionCount>,
    server_now: i64,
}

/// Serializes complete use cases, not just individual database calls.
/// SQLite constraints additionally protect invariants against other connections.
pub struct PlanningService {
    repository: Mutex<Box<dyn TaskRepository>>,
    clock: Box<dyn Clock>,
}

impl PlanningService {
    pub fn new(repository: Box<dyn TaskRepository>, clock: Box<dyn Clock>) -> Self {
        Self {
            repository: Mutex::new(repository),
            clock,
        }
    }

    fn repository(&self) -> Result<MutexGuard<'_, Box<dyn TaskRepository>>> {
        self.repository
            .lock()
            .map_err(|_| AppError::StateUnavailable)
    }

    pub fn dashboard(&self) -> Result<Dashboard> {
        let repo = self.repository()?;
        let now = self.clock.now();
        let tomorrow = now.day + Days::new(1);
        let today_tasks = repo.list(now.day)?;
        let can_plan_tomorrow = Self::day_finished(&today_tasks);
        Ok(Dashboard {
            today: now.day,
            tomorrow,
            tomorrow_tasks: repo.list(tomorrow)?,
            active_task: repo.active()?,
            can_plan_tomorrow,
            completions: repo.completions(now.day - Days::new(363), now.day)?,
            today_tasks,
            server_now: now.unix_seconds,
        })
    }

    pub fn create_task(
        &self,
        outcome: &str,
        day: NaiveDate,
        estimated_minutes: u32,
    ) -> Result<Task> {
        let mut repo = self.repository()?;
        let now = self.clock.now();
        if day != now.day && day != now.day + Days::new(1) {
            return Err(AppError::Validation(
                "Plan tasks for today or tomorrow.".into(),
            ));
        }
        if day != now.day && !Self::day_finished(&repo.list(now.day)?) {
            return Err(AppError::Conflict(
                "Finish today's tasks before planning tomorrow.".into(),
            ));
        }
        if repo.list(day)?.len() >= 3 {
            return Err(AppError::Conflict(
                "Plan no more than three important tasks per day.".into(),
            ));
        }
        let task = Task::new(outcome, day, estimated_minutes, now.unix_seconds)?;
        repo.insert(&task)?;
        Ok(task)
    }

    pub fn start_task(&self, id: &str) -> Result<Task> {
        let mut repo = self.repository()?;
        let now = self.clock.now();
        if repo.active()?.is_some() {
            return Err(AppError::Conflict(
                "Finish the current focus session first.".into(),
            ));
        }
        let mut task = repo.find(id)?;
        if task.planned_for() != now.day {
            return Err(AppError::Conflict(
                "Only today's tasks can be started.".into(),
            ));
        }
        task.start(now.unix_seconds)?;
        repo.update(&task)?;
        Ok(task)
    }

    pub fn complete_task(&self, id: &str) -> Result<Task> {
        let mut repo = self.repository()?;
        let now = self.clock.now();
        let mut task = repo.find(id)?;
        task.complete(now.unix_seconds, now.day)?;
        repo.update(&task)?;
        Ok(task)
    }

    fn day_finished(tasks: &[Task]) -> bool {
        !tasks.is_empty()
            && tasks
                .iter()
                .all(|task| task.status() == TaskStatus::Completed)
    }
}

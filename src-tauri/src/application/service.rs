use super::{Clock, CompletionCount, TaskRepository};
use crate::domain::{AppError, Result, Task, TaskResource, TaskStatus};
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
        let mut task = Task::new(outcome, day, estimated_minutes, now.unix_seconds)?;
        task.is_priority = repo.list(day)?.is_empty();
        repo.insert(&task)?;
        Ok(task)
    }

    pub fn rename_task(&self, id: &str, outcome: &str) -> Result<Task> {
        let mut repo = self.repository()?;
        let mut task = repo.find(id)?;
        task.rename(outcome)?;
        repo.update(&task)?;
        Ok(task)
    }

    pub fn prioritize_task(&self, id: &str) -> Result<Task> {
        let mut repo = self.repository()?;
        let task = repo.find(id)?;
        let today = self.clock.now().day;
        if task.planned_for() != today && task.planned_for() != today + Days::new(1) {
            return Err(AppError::Validation("Choose a task for today or tomorrow.".into()));
        }
        if repo.list(task.planned_for())?.iter().any(|entry| entry.status() != TaskStatus::Planned) {
            return Err(AppError::Conflict("Choose the most important task before starting the day's work.".into()));
        }
        repo.set_priority(&task)?;
        repo.find(id)
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
        let tasks = repo.list(now.day)?;
        if !task.is_priority && !tasks.iter().any(|entry| entry.is_priority && entry.status() == TaskStatus::Completed) {
            return Err(AppError::Conflict("Complete the most important task first.".into()));
        }
        task.start(now.unix_seconds)?;
        repo.update(&task)?;
        Ok(task)
    }

    pub fn pause_task(&self, id: &str, reason: &str) -> Result<Task> {
        let reason = reason.trim();
        if reason.is_empty() || reason.chars().count() > 1000 {
            return Err(AppError::Validation(
                "A pause reason must contain 1–1000 characters.".into(),
            ));
        }
        let mut repo = self.repository()?;
        let now = self.clock.now();
        let mut task = repo.find(id)?;
        task.pause(now.unix_seconds)?;
        repo.save_pause(&task, reason, now.unix_seconds)?;
        Ok(task)
    }

    pub fn stop_timer(&self, id: &str) -> Result<Task> {
        self.pause_task(id, "Reason not provided")
    }

    pub fn save_pause_reason(&self, id: &str, reason: &str) -> Result<()> {
        let reason = reason.trim();
        if reason.is_empty() || reason.chars().count() > 1000 {
            return Err(AppError::Validation(
                "A pause reason must contain 1–1000 characters.".into(),
            ));
        }
        let mut repo = self.repository()?;
        let task = repo.find(id)?;
        if task.status() != TaskStatus::Active || task.started_at.is_some() {
            return Err(AppError::Conflict("The timer must be paused to save a reason.".into()));
        }
        repo.update_pause_reason(id, reason)
    }

    pub fn resume_task(&self, id: &str) -> Result<Task> {
        let mut repo = self.repository()?;
        let mut task = repo.find(id)?;
        task.resume(self.clock.now().unix_seconds)?;
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

    pub fn add_resource(&self, id: &str, label: &str, target: &str, kind: &str) -> Result<Task> {
        let target = target.trim();
        let label = label.trim();
        if label.is_empty() || label.chars().count() > 200 || target.len() > 8192 {
            return Err(AppError::Validation(
                "Use a name of 1–200 characters and a valid link or file.".into(),
            ));
        }
        match kind {
            "link" => {
                let url = url::Url::parse(target).map_err(|_| {
                    AppError::Validation("Enter a complete https:// or http:// link.".into())
                })?;
                if !matches!(url.scheme(), "https" | "http")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err(AppError::Validation(
                        "Only http:// and https:// links without credentials are supported.".into(),
                    ));
                }
            }
            "file" => {
                let path = std::path::Path::new(target);
                if !path.is_absolute() || !path.is_file() {
                    return Err(AppError::Validation(
                        "The selected file is no longer available.".into(),
                    ));
                }
            }
            _ => return Err(AppError::Validation("Unsupported resource type.".into())),
        }
        let mut repo = self.repository()?;
        let mut task = repo.find(id)?;
        if task.resources.len() >= 50 {
            return Err(AppError::Validation(
                "A task can have up to 50 resources.".into(),
            ));
        }
        task.resources.push(TaskResource {
            id: uuid::Uuid::new_v4().to_string(),
            label: label.into(),
            target: target.into(),
            kind: kind.into(),
        });
        repo.update(&task)?;
        Ok(task)
    }

    pub fn remove_resource(&self, id: &str, resource_id: &str) -> Result<Task> {
        let mut repo = self.repository()?;
        let mut task = repo.find(id)?;
        task.resources.retain(|resource| resource.id != resource_id);
        repo.update(&task)?;
        Ok(task)
    }

    pub fn resource(&self, id: &str, resource_id: &str) -> Result<TaskResource> {
        self.repository()?
            .find(id)?
            .resources
            .into_iter()
            .find(|resource| resource.id == resource_id)
            .ok_or(AppError::NotFound)
    }

    fn day_finished(tasks: &[Task]) -> bool {
        !tasks.is_empty()
            && tasks
                .iter()
                .all(|task| task.status() == TaskStatus::Completed)
    }
}

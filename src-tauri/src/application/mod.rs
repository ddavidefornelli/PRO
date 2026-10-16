mod service;
pub use service::{Dashboard, PlanningService};

use crate::domain::{Result, Task};
use chrono::{Local, NaiveDate};
use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub struct Moment {
    pub day: NaiveDate,
    pub unix_seconds: i64,
}

pub trait Clock: Send + Sync {
    fn now(&self) -> Moment;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> Moment {
        let now = Local::now();
        Moment {
            day: now.date_naive(),
            unix_seconds: now.timestamp(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCount {
    pub day: NaiveDate,
    pub count: u32,
}

/// Persistence boundary; neither the domain nor the service knows SQLite details.
pub trait TaskRepository: Send {
    fn list(&self, day: NaiveDate) -> Result<Vec<Task>>;
    fn find(&self, id: &str) -> Result<Task>;
    fn active(&self) -> Result<Option<Task>>;
    fn insert(&mut self, task: &Task) -> Result<()>;
    fn update(&mut self, task: &Task) -> Result<()>;
    fn completions(&self, since: NaiveDate, until: NaiveDate) -> Result<Vec<CompletionCount>>;
}

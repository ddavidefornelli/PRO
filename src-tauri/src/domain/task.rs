use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Planned,
    Active,
    Completed,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Active => "active",
            Self::Completed => "completed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResource {
    pub id: String,
    pub label: String,
    pub target: String,
    pub kind: String,
}

/// Encapsulates task state; mutations must go through validated transitions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub(crate) id: String,
    pub(crate) outcome: String,
    pub(crate) planned_for: NaiveDate,
    pub(crate) estimated_minutes: u32,
    pub(crate) actual_seconds: i64,
    pub(crate) status: TaskStatus,
    pub(crate) started_at: Option<i64>,
    pub(crate) completed_on: Option<NaiveDate>,
    pub(crate) created_at: i64,
    pub resources: Vec<TaskResource>,
    pub is_priority: bool,
}

impl Task {
    pub fn new(outcome: &str, day: NaiveDate, estimated_minutes: u32, now: i64) -> Result<Self> {
        let outcome = outcome.trim();
        if outcome.is_empty() || outcome.chars().count() > 500 {
            return Err(AppError::Validation(
                "An outcome must contain 1–500 characters.".into(),
            ));
        }
        if !(1..=60).contains(&estimated_minutes) {
            return Err(AppError::Validation(
                "Estimate must be between 1 and 60 minutes.".into(),
            ));
        }
        Ok(Self {
            id: Uuid::new_v4().to_string(),
            outcome: outcome.to_owned(),
            planned_for: day,
            estimated_minutes,
            actual_seconds: 0,
            status: TaskStatus::Planned,
            started_at: None,
            completed_on: None,
            created_at: now,
            resources: Vec::new(),
            is_priority: false,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn outcome(&self) -> &str {
        &self.outcome
    }
    pub fn rename(&mut self, outcome: &str) -> Result<()> {
        let outcome = outcome.trim();
        if outcome.is_empty() || outcome.chars().count() > 500 {
            return Err(AppError::Validation("An outcome must contain 1–500 characters.".into()));
        }
        self.outcome = outcome.to_owned();
        Ok(())
    }

    pub fn change_estimate(&mut self, minutes: u32) -> Result<()> {
        if self.status != TaskStatus::Planned {
            return Err(AppError::Conflict("Only unstarted tasks can change their estimate.".into()));
        }
        if !(1..=60).contains(&minutes) {
            return Err(AppError::Validation("Estimate must be between 1 and 60 minutes.".into()));
        }
        self.estimated_minutes = minutes;
        Ok(())
    }

    pub fn planned_for(&self) -> NaiveDate {
        self.planned_for
    }
    pub fn status(&self) -> TaskStatus {
        self.status
    }
    pub fn actual_seconds(&self) -> i64 {
        self.actual_seconds
    }

    pub fn start(&mut self, now: i64) -> Result<()> {
        if self.status != TaskStatus::Planned {
            return Err(AppError::Conflict(
                "Only planned tasks can be started.".into(),
            ));
        }
        self.status = TaskStatus::Active;
        self.started_at = Some(now);
        Ok(())
    }

    pub fn pause(&mut self, now: i64) -> Result<()> {
        if self.status != TaskStatus::Active || self.started_at.is_none() {
            return Err(AppError::Conflict(
                "Only a running timer can be paused.".into(),
            ));
        }
        self.accumulate(now);
        Ok(())
    }

    pub fn resume(&mut self, now: i64) -> Result<()> {
        if self.status != TaskStatus::Active || self.started_at.is_some() {
            return Err(AppError::Conflict(
                "Only a paused timer can be resumed.".into(),
            ));
        }
        self.started_at = Some(now);
        Ok(())
    }

    fn accumulate(&mut self, now: i64) {
        if let Some(started_at) = self.started_at.take() {
            self.actual_seconds = self
                .actual_seconds
                .saturating_add(now.saturating_sub(started_at).max(0));
        }
    }

    pub fn complete(&mut self, now: i64, day: NaiveDate) -> Result<()> {
        if self.status != TaskStatus::Active {
            return Err(AppError::Conflict(
                "Only active tasks can be completed.".into(),
            ));
        }
        // Wall-clock timestamps include sleep and downtime. Clamp clock rollback to zero.
        self.accumulate(now);
        self.status = TaskStatus::Completed;
        self.completed_on = Some(day);
        Ok(())
    }
}

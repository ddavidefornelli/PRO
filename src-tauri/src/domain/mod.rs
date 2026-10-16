mod task;

pub use task::{Task, TaskResource, TaskStatus};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("Task not found.")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("Storage error: {0}")]
    Storage(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("The application state is unavailable. Please restart the app.")]
    StateUnavailable,
}

pub type Result<T> = std::result::Result<T, AppError>;

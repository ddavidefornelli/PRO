use crate::{
    application::{PlanningService, SystemClock},
    domain::{AppError, Task},
    infrastructure::SqliteTaskRepository,
};
use chrono::NaiveDate;
use tauri::{Manager, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: &'static str,
    message: String,
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        let code = match &error {
            AppError::Validation(_) => "validation",
            AppError::NotFound => "not_found",
            AppError::Conflict(_) => "conflict",
            AppError::Storage(_) | AppError::StateUnavailable => "internal",
        };
        let message = if code == "internal" {
            eprintln!("{error}");
            "Could not save or load your data. Please restart the app and try again.".into()
        } else {
            error.to_string()
        };
        Self { code, message }
    }
}

#[tauri::command]
fn dashboard(
    service: State<'_, PlanningService>,
) -> Result<crate::application::Dashboard, CommandError> {
    service.dashboard().map_err(Into::into)
}

#[tauri::command]
fn create_task(
    service: State<'_, PlanningService>,
    outcome: String,
    day: String,
    estimated_minutes: u32,
) -> Result<Task, CommandError> {
    let day = NaiveDate::parse_from_str(&day, "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Use a valid date (YYYY-MM-DD).".into()))?;
    service
        .create_task(&outcome, day, estimated_minutes)
        .map_err(Into::into)
}

#[tauri::command]
fn start_task(service: State<'_, PlanningService>, id: String) -> Result<Task, CommandError> {
    service.start_task(&id).map_err(Into::into)
}

#[tauri::command]
fn complete_task(service: State<'_, PlanningService>, id: String) -> Result<Task, CommandError> {
    service.complete_task(&id).map_err(Into::into)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let repository = SqliteTaskRepository::open(directory.join("pro.sqlite3"))?;
            app.manage(PlanningService::new(
                Box::new(repository),
                Box::new(SystemClock),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dashboard,
            create_task,
            start_task,
            complete_task
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start PRO");
}

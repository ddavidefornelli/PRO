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
fn rename_task(service: State<'_, PlanningService>, id: String, outcome: String) -> Result<Task, CommandError> {
    service.rename_task(&id, &outcome).map_err(Into::into)
}

#[tauri::command]
fn change_estimate(service: State<'_, PlanningService>, id: String, minutes: u32) -> Result<Task, CommandError> {
    service.change_estimate(&id, minutes).map_err(Into::into)
}

#[tauri::command]
fn prioritize_task(service: State<'_, PlanningService>, id: String) -> Result<Task, CommandError> {
    service.prioritize_task(&id).map_err(Into::into)
}

#[tauri::command]
fn start_task(service: State<'_, PlanningService>, id: String) -> Result<Task, CommandError> {
    service.start_task(&id).map_err(Into::into)
}

#[tauri::command]
fn pause_task(
    service: State<'_, PlanningService>,
    id: String,
    reason: String,
) -> Result<Task, CommandError> {
    service.pause_task(&id, &reason).map_err(Into::into)
}

#[tauri::command]
fn stop_timer(service: State<'_, PlanningService>, id: String) -> Result<Task, CommandError> {
    service.stop_timer(&id).map_err(Into::into)
}

#[tauri::command]
fn save_pause_reason(service: State<'_, PlanningService>, id: String, reason: String) -> Result<(), CommandError> {
    service.save_pause_reason(&id, &reason).map_err(Into::into)
}

#[tauri::command]
fn resume_task(service: State<'_, PlanningService>, id: String) -> Result<Task, CommandError> {
    service.resume_task(&id).map_err(Into::into)
}

#[tauri::command]
fn complete_task(service: State<'_, PlanningService>, id: String) -> Result<Task, CommandError> {
    service.complete_task(&id).map_err(Into::into)
}

#[tauri::command]
fn add_task_link(
    service: State<'_, PlanningService>,
    id: String,
    label: String,
    url: String,
) -> Result<Task, CommandError> {
    service
        .add_resource(&id, &label, &url, "link")
        .map_err(Into::into)
}

#[tauri::command]
async fn attach_task_file(
    service: State<'_, PlanningService>,
    id: String,
) -> Result<(), CommandError> {
    if let Some(file) = rfd::AsyncFileDialog::new().pick_file().await {
        let path = file
            .path()
            .to_str()
            .ok_or_else(|| AppError::Validation("This file path is not supported.".into()))?;
        service.add_resource(&id, &file.file_name(), path, "file")?;
    }
    Ok(())
}

#[tauri::command]
fn remove_task_resource(
    service: State<'_, PlanningService>,
    id: String,
    resource_id: String,
) -> Result<Task, CommandError> {
    service
        .remove_resource(&id, &resource_id)
        .map_err(Into::into)
}

#[tauri::command]
fn open_task_resource(
    service: State<'_, PlanningService>,
    id: String,
    resource_id: String,
) -> Result<(), CommandError> {
    let resource = service.resource(&id, &resource_id)?;
    if resource.kind == "file" && !std::path::Path::new(&resource.target).is_file() {
        return Err(AppError::Validation(
            "File not found. It may have been moved or deleted; remove it and attach it again."
                .into(),
        )
        .into());
    }
    open::that_detached(&resource.target).map_err(|_| {
        AppError::Validation("Could not open this resource with its default app.".into())
    })?;
    Ok(())
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
            prioritize_task,
            rename_task,
            change_estimate,
            start_task,
            pause_task,
            stop_timer,
            save_pause_reason,
            resume_task,
            complete_task,
            add_task_link,
            attach_task_file,
            remove_task_resource,
            open_task_resource
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start PRO");
}

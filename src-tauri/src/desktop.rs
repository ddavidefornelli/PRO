use crate::{
    cloud::{AuthStatus, Cloud, CommandError, Result},
    resources::{safe_file, safe_link},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, State};

struct DesktopState {
    cloud: Arc<Mutex<Option<Arc<Cloud>>>>,
    generating: Arc<AtomicBool>,
}
impl DesktopState {
    async fn cloud(&self) -> Result<Arc<Cloud>> {
        self.initialize(Cloud::from_environment).await
    }

    async fn initialize(
        &self,
        create: impl FnOnce() -> Result<Cloud> + Send + 'static,
    ) -> Result<Arc<Cloud>> {
        let state = Arc::clone(&self.cloud);
        blocking(move || {
            let mut saved = state.lock().map_err(|_| {
                CommandError::new(
                    "internal",
                    "Could not initialize your session. Restart prune.",
                )
            })?;
            if let Some(cloud) = saved.as_ref() {
                return Ok(Arc::clone(cloud));
            }
            // Keychain calls and reqwest's blocking client must never initialize
            // on an async executor thread. Failed attempts remain retryable.
            let cloud = Arc::new(create()?);
            *saved = Some(Arc::clone(&cloud));
            Ok(cloud)
        })
        .await
    }
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| {
            CommandError::new(
                "internal",
                "The request could not finish. Refresh before retrying.",
            )
        })?
}
#[tauri::command]
async fn auth_status(state: State<'_, DesktopState>) -> Result<AuthStatus> {
    let cloud = state.cloud().await?;
    blocking(move || cloud.auth_status()).await
}
#[tauri::command]
async fn request_sign_in_code(state: State<'_, DesktopState>, email: String) -> Result<()> {
    let cloud = state.cloud().await?;
    blocking(move || cloud.request_code(&email)).await
}
#[tauri::command]
async fn verify_sign_in_code(
    state: State<'_, DesktopState>,
    email: String,
    code: String,
) -> Result<AuthStatus> {
    let cloud = state.cloud().await?;
    blocking(move || cloud.verify_code(&email, &code)).await
}
#[tauri::command]
async fn sign_out(state: State<'_, DesktopState>) -> Result<()> {
    let cloud = state.cloud().await?;
    blocking(move || cloud.sign_out()).await
}
#[tauri::command]
async fn planner_call(
    state: State<'_, DesktopState>,
    action: String,
    args: Value,
    timezone: String,
) -> Result<Value> {
    if !matches!(
        action.as_str(),
        "dashboard"
            | "queue_protocol"
            | "create_task"
            | "rename_task"
            | "change_estimate"
            | "prioritize_task"
            | "start_task"
            | "pause_task"
            | "stop_timer"
            | "save_pause_reason"
            | "resume_task"
            | "complete_task"
            | "add_task_link"
            | "remove_task_resource"
            | "weekly_overview"
            | "set_weekly_ai_enabled"
    ) {
        return Err(CommandError::new(
            "validation",
            "Unsupported planner command.",
        ));
    }
    if action == "add_task_link" {
        safe_link(args["target"].as_str().unwrap_or(""))?;
    }
    let cloud = state.cloud().await?;
    blocking(move || cloud.planner(&action, args, &timezone)).await
}
#[tauri::command]
async fn attach_task_file(
    state: State<'_, DesktopState>,
    id: String,
    timezone: String,
) -> Result<()> {
    let cloud = state.cloud().await?;
    if let Some(file) = rfd::AsyncFileDialog::new().pick_file().await {
        let path = safe_file(&file.path().to_string_lossy())?;
        let label = file.file_name();
        blocking(move || {
            cloud.planner(
                "attach_task_file",
                json!({"id": id, "label": label, "target": path.to_string_lossy()}),
                &timezone,
            )
        })
        .await?;
    }
    Ok(())
}
#[tauri::command]
async fn open_task_resource(
    state: State<'_, DesktopState>,
    id: String,
    resource_id: String,
    timezone: String,
) -> Result<()> {
    let cloud = state.cloud().await?;
    let resource = blocking(move || {
        cloud.planner(
            "get_task_resource",
            json!({"id": id, "resourceId": resource_id}),
            &timezone,
        )
    })
    .await?;
    let target = resource["target"]
        .as_str()
        .ok_or_else(|| CommandError::new("not_found", "Resource not found."))?;
    let target = match resource["kind"].as_str() {
        Some("link") => safe_link(target)?,
        Some("file") => {
            let path = safe_file(target)?;
            let confirmed = rfd::AsyncMessageDialog::new().set_title("Open local file?")
                .set_description(format!("This path is synced through your account, but its contents are local to this device:\n\n{}\n\nOpen only files you trust.", path.display()))
                .set_buttons(rfd::MessageButtons::YesNo).show().await;
            if confirmed != rfd::MessageDialogResult::Yes {
                return Ok(());
            }
            safe_file(&path.to_string_lossy())?
                .to_string_lossy()
                .into_owned()
        }
        _ => {
            return Err(CommandError::new(
                "validation",
                "Unsupported resource type.",
            ))
        }
    };
    blocking(move || {
        open::that_detached(target).map_err(|_| {
            CommandError::new(
                "validation",
                "Could not open this resource with its default app.",
            )
        })
    })
    .await
}
#[tauri::command]
async fn open_support_email() -> Result<()> {
    blocking(|| {
        // Wait for the launcher result on this worker so a missing mail handler
        // can be reported, without blocking the webview or requiring cloud auth.
        open::that("mailto:fornelli.dv@gmail.com").map_err(|_| {
            CommandError::new(
                "validation",
                "Could not open your email app. Contact fornelli.dv@gmail.com.",
            )
        })
    })
    .await
}
#[tauri::command]
async fn generate_weekly_review(
    state: State<'_, DesktopState>,
    timezone: String,
    preview: Option<bool>,
) -> Result<serde_json::Value> {
    let cloud = state.cloud().await?;
    let flag = Arc::clone(&state.generating);
    if flag.swap(true, Ordering::AcqRel) {
        return Err(CommandError::new(
            "running",
            "An AI review is already being generated. Please try again shortly.",
        ));
    }
    // Reset on errors and panics as well; only one AI request per process can be in flight.
    struct Reset(Arc<AtomicBool>);
    impl Drop for Reset {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    blocking(move || {
        let _reset = Reset(flag);
        cloud.generate_review(&timezone, preview.unwrap_or(false))
    })
    .await
}
pub fn run() {
    tauri::Builder::default()
        // Register before setup so a second launch never reads or rotates credentials.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            app.manage(DesktopState {
                // Let the webview render its loading indicator before Keychain access.
                cloud: Arc::new(Mutex::new(None)),
                generating: Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            request_sign_in_code,
            verify_sign_in_code,
            sign_out,
            planner_call,
            attach_task_file,
            open_task_resource,
            open_support_email,
            generate_weekly_review
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start prune");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::CredentialStore;

    struct EmptyStore;
    impl CredentialStore for EmptyStore {
        fn load(&self) -> Result<Option<String>> {
            Ok(None)
        }
        fn save(&self, _: &str) -> Result<()> {
            Ok(())
        }
        fn clear(&self) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn async_startup_initializes_blocking_client_safely_and_retries_errors() {
        tauri::async_runtime::block_on(async {
            let state = DesktopState {
                cloud: Arc::new(Mutex::new(None)),
                generating: Arc::new(AtomicBool::new(false)),
            };
            let failed = state
                .initialize(|| Err(CommandError::new("credentials", "Fixture locked store")))
                .await;
            assert!(matches!(failed, Err(error) if error.code == "credentials"));
            let cloud = state
                .initialize(|| {
                    Cloud::new(
                        "https://fixture.invalid".into(),
                        "sb_publishable_fixture".into(),
                        Box::new(EmptyStore),
                    )
                })
                .await
                .unwrap();
            let cached = state
                .initialize(|| panic!("must not initialize twice"))
                .await
                .unwrap();
            assert!(Arc::ptr_eq(&cloud, &cached));
            assert!(cloud.auth_status().unwrap().email.is_none());
            // Dropping reqwest's blocking runtime also belongs on a blocking worker.
            blocking(move || {
                drop(cloud);
                drop(cached);
                drop(state);
                Ok(())
            })
            .await
            .unwrap();
        });
    }
}

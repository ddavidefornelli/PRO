//! The only desktop persistence is a refresh token in the OS credential store.
//! All planner state and all business-rule transactions live in Supabase.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{blocking::Client, redirect::Policy, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use std::{io::Read, sync::Mutex, time::Duration};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOKEN_BYTES: usize = 8192;
const OTP_ROUTE: &str = "/auth/v1/otp";
const PUBLISHABLE_KEY_PREFIX: &str = "sb_publishable_";

#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}
impl CommandError {
    pub fn new(code: &'static str, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, CommandError>;
fn network() -> CommandError {
    CommandError::new(
        "network",
        "Could not reach Supabase. Queued planner changes remain on this device and will retry.",
    )
}
fn credentials() -> CommandError {
    CommandError::new("credentials", "Could not access the OS credential store. Unlock it and try again; PRO never stores tokens in plaintext.")
}
fn unauthorized() -> CommandError {
    CommandError::new(
        "unauthorized",
        "Your session has expired. Please sign in again.",
    )
}

fn auth_server_error(
    route: &str,
    status: StatusCode,
    value: &Value,
    request_id: Option<&str>,
) -> CommandError {
    // Recognize only fixed Auth messages. Never expose raw SMTP/provider errors,
    // which may contain credentials, email addresses or other account details.
    let upstream_message = value["msg"].as_str().or_else(|| value["message"].as_str());
    let (code, message) = if route == OTP_ROUTE
        && matches!(
            upstream_message,
            Some("Error sending confirmation email" | "Error sending magic link email")
        ) {
        (
            "email_delivery",
            "Supabase could not send the sign-in email. Check the project's email delivery settings (SMTP/email hook) and Auth logs. Reloading PRO will not fix email delivery.",
        )
    } else {
        (
            "server",
            "Supabase sign-in is temporarily unavailable. Check the project's Auth logs or try again later.",
        )
    };
    let mut error = CommandError::new(code, message);
    // Hosted Supabase request IDs are UUIDs. Discard arbitrary header contents.
    let request_id = request_id.filter(|id| {
        id.len() == 36
            && id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
    });
    error
        .message
        .push_str(&format!(" (HTTP {}", status.as_u16()));
    if let Some(id) = request_id {
        error.message.push_str(&format!("; request ID: {id}"));
    }
    error.message.push(')');
    error
}

pub trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<String>>;
    fn save(&self, refresh_token: &str) -> Result<()>;
    fn clear(&self) -> Result<()>;
}
#[cfg(target_os = "windows")]
struct OsCredentials(keyring::Entry);
#[cfg(target_os = "windows")]
impl CredentialStore for OsCredentials {
    fn load(&self) -> Result<Option<String>> {
        match self.0.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(credentials()),
        }
    }
    fn save(&self, token: &str) -> Result<()> {
        self.0.set_password(token).map_err(|_| credentials())
    }
    fn clear(&self) -> Result<()> {
        match self.0.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(credentials()),
        }
    }
}
// Use SecItem operations on macOS: the legacy keyring backend reads the secret
// again before every update/delete, which can cause redundant permission prompts.
// Keep the same service/account so existing saved logins continue to work.
#[cfg(target_os = "macos")]
struct MacCredentials {
    account: String,
}
#[cfg(target_os = "macos")]
impl MacCredentials {
    const SERVICE: &'static str = "com.pro.desktop.supabase";
    const NOT_FOUND: i32 = -25300; // errSecItemNotFound
}
#[cfg(target_os = "macos")]
impl CredentialStore for MacCredentials {
    fn load(&self) -> Result<Option<String>> {
        use security_framework::passwords::{generic_password, PasswordOptions};
        match generic_password(PasswordOptions::new_generic_password(
            Self::SERVICE,
            &self.account,
        )) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| credentials()),
            Err(error) if error.code() == Self::NOT_FOUND => Ok(None),
            Err(_) => Err(credentials()),
        }
    }
    fn save(&self, token: &str) -> Result<()> {
        security_framework::passwords::set_generic_password(
            Self::SERVICE,
            &self.account,
            token.as_bytes(),
        )
        .map_err(|_| credentials())
    }
    fn clear(&self) -> Result<()> {
        match security_framework::passwords::delete_generic_password(Self::SERVICE, &self.account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == Self::NOT_FOUND => Ok(()),
            Err(_) => Err(credentials()),
        }
    }
}
struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    email: Option<String>,
    user_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub configured: bool,
    pub email: Option<String>,
    pub account_key: Option<String>,
}

pub struct Cloud {
    url: String,
    public_key: String,
    http: Client,
    // Held across refresh/credential writes, never across planner or AI requests.
    session: Mutex<Option<Session>>,
    store: Box<dyn CredentialStore>,
}
impl Cloud {
    pub fn from_environment() -> Result<Self> {
        let url = std::env::var("PRO_SUPABASE_URL")
            .ok()
            .or_else(|| option_env!("PRO_SUPABASE_URL").map(str::to_owned));
        let key = std::env::var("PRO_SUPABASE_ANON_KEY")
            .ok()
            .or_else(|| option_env!("PRO_SUPABASE_ANON_KEY").map(str::to_owned));
        let (Some(url), Some(key)) = (url, key) else {
            return Err(CommandError::new("configuration", "Configure PRO_SUPABASE_URL and PRO_SUPABASE_ANON_KEY before building or launching PRO. Use only the public project key."));
        };
        validate_url(&url)?;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        return Err(CommandError::new(
            "credentials",
            "This build requires a native credential-store implementation for this platform.",
        ));
        #[cfg(target_os = "macos")]
        {
            let store = MacCredentials {
                account: url.trim_end_matches('/').to_owned(),
            };
            Self::new(url, key, Box::new(store))
        }
        #[cfg(target_os = "windows")]
        {
            let entry = keyring::Entry::new("com.pro.desktop.supabase", url.trim_end_matches('/'))
                .map_err(|_| credentials())?;
            Self::new(url, key, Box::new(OsCredentials(entry)))
        }
    }

    pub fn new(url: String, public_key: String, store: Box<dyn CredentialStore>) -> Result<Self> {
        validate_url(&url)?;
        if !is_public_key(&public_key) {
            return Err(CommandError::new(
                "configuration",
                "Use a Supabase publishable/anon key, never a service-role or secret key.",
            ));
        }
        let saved = store.load()?.map(|refresh_token| Session {
            access_token: String::new(),
            refresh_token,
            expires_at: 0,
            email: None,
            user_id: None,
        });
        let http = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| network())?;
        Ok(Self {
            url: url.trim_end_matches('/').to_owned(),
            public_key,
            http,
            session: Mutex::new(saved),
            store,
        })
    }
    fn post(&self, route: &str, token: Option<&str>, body: Value) -> Result<Value> {
        let mut request = self
            .http
            .post(format!("{}{route}", self.url))
            .header("apikey", &self.public_key)
            .json(&body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if route.starts_with("/functions/") {
            request = request.timeout(Duration::from_secs(110));
        } else if route.starts_with("/auth/v1/logout") {
            request = request.timeout(Duration::from_secs(5));
        }
        let response = request.send().map_err(|_| network())?;
        let status = response.status();
        let request_id = response
            .headers()
            .get("sb-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if status == StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let mut bytes = Vec::new();
        response
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| network())?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CommandError::new(
                "size",
                "The server response is too large. Please contact support.",
            ));
        }
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) if !status.is_success() => Value::Null,
            Err(_) => {
                return Err(CommandError::new(
                    "server",
                    "The server returned an incomplete response. Refresh before retrying.",
                ))
            }
        };
        if !status.is_success() {
            if status == StatusCode::UNAUTHORIZED {
                return Err(unauthorized());
            }
            if status == StatusCode::TOO_MANY_REQUESTS {
                return Err(CommandError::new(
                    "rate_limited",
                    if route == OTP_ROUTE {
                        "Too many sign-in attempts or emails. Wait before requesting another code; check the project's Auth rate limits if this continues."
                    } else {
                        "Too many requests or review allowance reached. Please try later."
                    },
                ));
            }
            // Only explicitly authored Postgres errors are safe to expose; never raw Auth/provider errors.
            let code = value["code"].as_str().unwrap_or("");
            if route.starts_with("/rest/") && matches!(code, "PT400" | "PT401" | "PT404" | "PT409")
            {
                let message = value["message"].as_str().unwrap_or("Request rejected.");
                if message.len() < 300 {
                    return Err(CommandError::new("validation", message));
                }
            }
            if route.starts_with("/auth/") && status.is_server_error() {
                return Err(auth_server_error(
                    route,
                    status,
                    &value,
                    request_id.as_deref(),
                ));
            }
            if route.starts_with("/auth/") {
                return Err(CommandError::new("auth", "Sign-in could not be completed. Check your email/code, or request a new code after waiting a minute."));
            }
            if route.starts_with("/functions/")
                && (status == StatusCode::PAYLOAD_TOO_LARGE
                    || value["error"]["code"] == "invalid_request")
            {
                return Err(CommandError::new("ai", "The week's activity exceeds the review limits. No AI call was made. Your planner and previous reviews are unchanged."));
            }
            if route.starts_with("/functions/") {
                return Err(CommandError::new("ai", "Weekly AI is unavailable, already running, or its allowance has been reached. Your planner is unaffected; try later."));
            }
            return Err(CommandError::new(
                "server",
                "Supabase could not complete the request. Refresh your data before retrying.",
            ));
        }
        Ok(value)
    }
    pub fn request_code(&self, email: &str) -> Result<()> {
        let email = validate_email(email)?;
        self.post(
            OTP_ROUTE,
            None,
            json!({"email": email, "create_user": true}),
        )?;
        Ok(())
    }
    fn parse_session(value: &Value) -> Result<Session> {
        let access = value["access_token"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= MAX_TOKEN_BYTES)
            .ok_or_else(unauthorized)?;
        let refresh = value["refresh_token"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= MAX_TOKEN_BYTES)
            .ok_or_else(unauthorized)?;
        let email = value["user"]["email"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(unauthorized)?;
        if value["user"]["is_anonymous"].as_bool() == Some(true) {
            return Err(unauthorized());
        }
        Ok(Session {
            access_token: access.into(),
            refresh_token: refresh.into(),
            expires_at: chrono::Utc::now().timestamp()
                + value["expires_in"]
                    .as_i64()
                    .unwrap_or(3600)
                    .clamp(60, 86400),
            email: Some(email.into()),
            user_id: Some(
                value["user"]["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(unauthorized)?
                    .into(),
            ),
        })
    }
    pub fn verify_code(&self, email: &str, code: &str) -> Result<AuthStatus> {
        let email = validate_email(email)?;
        if !(6..=10).contains(&code.len()) || !code.bytes().all(|v| v.is_ascii_digit()) {
            return Err(CommandError::new(
                "validation",
                "Enter the numeric code from your email.",
            ));
        }
        let mut guard = self.session.lock().map_err(|_| credentials())?;
        let value = self.post(
            "/auth/v1/verify",
            None,
            json!({"email": email, "token": code, "type": "email"}),
        )?;
        let session = Self::parse_session(&value)?;
        self.store.save(&session.refresh_token)?;
        let status = self.status(Some(&session));
        *guard = Some(session);
        Ok(status)
    }
    fn access_token(&self) -> Result<String> {
        let mut guard = self.session.lock().map_err(|_| credentials())?;
        let session = guard.as_ref().ok_or_else(unauthorized)?;
        if session.expires_at > chrono::Utc::now().timestamp() + 60 {
            return Ok(session.access_token.clone());
        }
        // The desktop enforces a single instance. Restore credentials once at startup;
        // subsequent refreshes use memory, not another potentially interactive Keychain read.
        let refresh_token = session.refresh_token.clone();
        let result = self.post(
            "/auth/v1/token?grant_type=refresh_token",
            None,
            json!({"refresh_token": refresh_token}),
        );
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                if matches!(error.code, "auth" | "unauthorized") {
                    self.store.clear()?;
                    *guard = None;
                    return Err(unauthorized());
                }
                return Err(error);
            }
        };
        let session = Self::parse_session(&value)?;
        // Persist rotated credentials before publishing the new session. Some providers
        // reuse refresh tokens; don't touch the OS store when nothing changed.
        if session.refresh_token != refresh_token {
            self.store.save(&session.refresh_token)?;
        }
        let token = session.access_token.clone();
        *guard = Some(session);
        Ok(token)
    }
    pub fn auth_status(&self) -> Result<AuthStatus> {
        let signed_in = self.session.lock().map_err(|_| credentials())?.is_some();
        if signed_in {
            match self.access_token() {
                Ok(_) => {}
                Err(error) if error.code == "unauthorized" => {}
                Err(error) => return Err(error),
            }
        }
        let guard = self.session.lock().map_err(|_| credentials())?;
        Ok(self.status(guard.as_ref()))
    }
    fn status(&self, session: Option<&Session>) -> AuthStatus {
        AuthStatus {
            configured: true,
            email: session.and_then(|s| s.email.clone()),
            account_key: session
                .and_then(|s| s.user_id.as_ref())
                .map(|id| format!("{}:{id}", self.url)),
        }
    }
    pub fn sign_out(&self) -> Result<()> {
        // Delete durable credentials before reporting success, even when the network is down.
        let token = {
            let mut guard = self.session.lock().map_err(|_| credentials())?;
            self.store.clear()?;
            guard.take().map(|v| v.access_token)
        };
        if let Some(token) = token.filter(|v| !v.is_empty()) {
            let _ = self.post("/auth/v1/logout?scope=local", Some(&token), json!({}));
        }
        Ok(())
    }
    fn authenticated_post(&self, route: &str, body: Value) -> Result<Value> {
        let token = self.access_token()?;
        // A persisted outbox must never replay into a different signed-in account.
        if let Some(expected) = body["p_args"]["_accountKey"].as_str() {
            let guard = self.session.lock().map_err(|_| credentials())?;
            let actual = guard
                .as_ref()
                .and_then(|s| s.user_id.as_ref())
                .map(|id| format!("{}:{id}", self.url));
            if actual.as_deref() != Some(expected) {
                return Err(CommandError::new(
                    "account_changed",
                    "The account changed. Reload before accessing planner data.",
                ));
            }
        }
        // The outbox, not this HTTP adapter, owns retrying idempotent requests.
        let result = self.post(route, Some(&token), body);
        if result.as_ref().is_err_and(|e| e.code == "unauthorized") {
            let mut guard = self.session.lock().map_err(|_| credentials())?;
            // A delayed response from an older session must not erase a newly signed-in account.
            if guard.as_ref().is_some_and(|v| v.access_token == token) {
                self.store.clear()?;
                *guard = None;
            }
        }
        result
    }
    pub fn planner(&self, action: &str, args: Value, timezone: &str) -> Result<Value> {
        self.authenticated_post(
            "/rest/v1/rpc/planner_call",
            json!({"p_action": action, "p_args": args, "p_timezone": timezone}),
        )
    }
    pub fn generate_review(&self, timezone: &str, preview: bool) -> Result<Value> {
        self.authenticated_post(
            "/functions/v1/weekly-review",
            json!({"timezone": timezone, "preview": preview}),
        )
    }
}

fn is_public_key(key: &str) -> bool {
    if key.len() > MAX_TOKEN_BYTES || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    if key.starts_with(PUBLISHABLE_KEY_PREFIX) {
        return key.len() > PUBLISHABLE_KEY_PREFIX.len();
    }
    // Legacy anon JWTs are public too. Decode only to reject misconfigured privileged keys;
    // this is NOT user authentication or JWT signature verification.
    let parts: Vec<_> = key.split('.').collect();
    parts.len() == 3
        && URL_SAFE_NO_PAD
            .decode(parts[1])
            .ok()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
            .is_some_and(|v| v["role"] == "anon")
}

fn validate_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value)
        .map_err(|_| CommandError::new("configuration", "Invalid Supabase URL."))?;
    let local = cfg!(debug_assertions)
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || local && url.scheme() == "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(CommandError::new(
            "configuration",
            "Use your HTTPS Supabase project URL (local HTTP is allowed only in debug builds).",
        ));
    }
    Ok(())
}
fn validate_email(value: &str) -> Result<&str> {
    let email = value.trim();
    let valid_parts = email.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty() && !domain.is_empty() && !domain.contains('@')
    });
    if email.len() > 254
        || !valid_parts
        || email.chars().any(|v| v.is_control() || v.is_whitespace())
    {
        return Err(CommandError::new(
            "validation",
            "Enter a valid email address.",
        ));
    }
    Ok(email)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_rejects_credentials_redirect_paths_and_insecure_hosts() {
        for url in [
            "http://project.supabase.co",
            "https://user:password@project.supabase.co",
            "https://project.supabase.co/rest",
            "https://project.supabase.co?key=secret",
            "file:///tmp/data",
        ] {
            assert!(validate_url(url).is_err());
        }
        assert!(validate_url("https://project.supabase.co").is_ok());
    }
    #[test]
    fn session_requires_real_email_identity_and_never_serializes_tokens_to_ui() {
        assert!(Cloud::parse_session(&json!({"access_token": "a", "refresh_token": "r", "user": {"email": "a@example.com", "is_anonymous": true}})).is_err());
        let status = serde_json::to_string(&AuthStatus {
            configured: true,
            email: Some("a@example.com".into()),
            account_key: Some("https://example.supabase.co:user".into()),
        })
        .unwrap();
        assert!(!status.contains("token"));
        assert!(Cloud::parse_session(&json!({"access_token": "a"})).is_err());
    }
}

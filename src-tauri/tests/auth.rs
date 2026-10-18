//! Local HTTP fixtures only: no real accounts, keychain writes, or cloud requests.
//! Release builds intentionally prohibit these insecure localhost fixtures.
#![cfg(debug_assertions)]
use pro_lib::cloud::{Cloud, CommandError, CredentialStore, Result};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Clone, Default)]
struct Store(Arc<Mutex<Option<String>>>);
impl CredentialStore for Store {
    fn load(&self) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, token: &str) -> Result<()> {
        *self.0.lock().unwrap() = Some(token.into());
        Ok(())
    }
    fn clear(&self) -> Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}
fn session() -> Value {
    json!({"access_token": "private-access", "refresh_token": "rotated-refresh", "expires_in": 3600,
        "user": {"id": "user", "email": "user@example.com", "is_anonymous": false}})
}
fn server(responses: Vec<(&'static str, u16, Value)>) -> (String, thread::JoinHandle<Vec<String>>) {
    server_with_headers(
        responses
            .into_iter()
            .map(|(route, status, body)| (route, status, body, ""))
            .collect(),
    )
}
fn server_with_headers(
    responses: Vec<(&'static str, u16, Value, &'static str)>,
) -> (String, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        for (route, status, body, headers) in responses {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let (mut socket, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "Expected HTTP request to {route} never arrived"
                        );
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("Fixture accept failed: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let size = socket.read(&mut buffer).unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&buffer[..size]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::parse)
                        })
                        .unwrap()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(
                request.starts_with(&format!("POST {route} HTTP/1.1")),
                "{request}"
            );
            requests.push(request);
            let body = body.to_string();
            write!(socket, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{}", body.len(), body).unwrap();
        }
        requests
    });
    (url, handle)
}
fn cloud(url: String, store: Store) -> Cloud {
    Cloud::new(url, "sb_publishable_fixture".into(), Box::new(store)).unwrap()
}

#[test]
fn otp_session_keeps_tokens_native_and_sign_out_clears_credentials() {
    let (url, server) = server(vec![
        ("/auth/v1/otp", 200, json!({})),
        ("/auth/v1/verify", 200, session()),
        ("/rest/v1/rpc/planner_call", 200, json!({"todayTasks": []})),
        ("/auth/v1/logout?scope=local", 200, json!({})),
    ]);
    let store = Store::default();
    let client = cloud(url, store.clone());
    assert!(client.auth_status().unwrap().email.is_none());
    client.request_code("user@example.com").unwrap();
    let status = client.verify_code("user@example.com", "123456").unwrap();
    assert_eq!(status.email.as_deref(), Some("user@example.com"));
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("private-access"));
    assert_eq!(store.load().unwrap().as_deref(), Some("rotated-refresh"));
    client
        .planner("dashboard", json!({}), "Europe/Rome")
        .unwrap();
    client.sign_out().unwrap();
    assert!(store.load().unwrap().is_none());
    assert_eq!(
        client
            .planner("dashboard", json!({}), "UTC")
            .unwrap_err()
            .code,
        "unauthorized"
    );
    let requests = server.join().unwrap();
    assert!(requests[2].contains("Bearer private-access"));
    assert!(requests[2].contains("\"p_timezone\":\"Europe/Rome\""));
    assert!(!requests[2].contains("refresh"));
}

#[test]
fn restart_refreshes_and_rotates_the_os_credential_once_for_concurrent_requests() {
    let (url, server) = server(vec![
        ("/auth/v1/token?grant_type=refresh_token", 200, session()),
        ("/rest/v1/rpc/planner_call", 200, json!({})),
        ("/rest/v1/rpc/planner_call", 200, json!({})),
    ]);
    let store = Store::default();
    store.save("original-refresh").unwrap();
    let client = Arc::new(cloud(url, store.clone()));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let client = Arc::clone(&client);
            thread::spawn(move || client.planner("dashboard", json!({}), "UTC").unwrap())
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(store.load().unwrap().as_deref(), Some("rotated-refresh"));
    let requests = server.join().unwrap();
    assert!(requests[0].contains("original-refresh"));
    assert_eq!(
        requests
            .iter()
            .filter(|v| v.starts_with("POST /auth/"))
            .count(),
        1
    );
}

#[test]
fn session_restore_reads_credentials_once_and_only_persists_rotated_tokens() {
    #[derive(Clone)]
    struct CountingStore {
        token: Store,
        counts: Arc<Mutex<(usize, usize)>>,
    }
    impl CredentialStore for CountingStore {
        fn load(&self) -> Result<Option<String>> {
            self.counts.lock().unwrap().0 += 1;
            self.token.load()
        }
        fn save(&self, token: &str) -> Result<()> {
            self.counts.lock().unwrap().1 += 1;
            self.token.save(token)
        }
        fn clear(&self) -> Result<()> {
            self.token.clear()
        }
    }
    for original in ["original-refresh", "rotated-refresh"] {
        let (url, server) = server(vec![
            ("/auth/v1/token?grant_type=refresh_token", 200, session()),
            ("/rest/v1/rpc/planner_call", 200, json!({})),
            ("/auth/v1/token?grant_type=refresh_token", 200, session()),
        ]);
        let token = Store::default();
        token.save(original).unwrap();
        let counts = Arc::new(Mutex::new((0, 0)));
        let client = Cloud::new(
            url.clone(),
            "sb_publishable_fixture".into(),
            Box::new(CountingStore {
                token: token.clone(),
                counts: counts.clone(),
            }),
        )
        .unwrap();
        assert!(client.auth_status().unwrap().email.is_some());
        assert!(client.auth_status().unwrap().email.is_some());
        client.planner("dashboard", json!({}), "UTC").unwrap();
        assert_eq!(
            *counts.lock().unwrap(),
            (1, usize::from(original != "rotated-refresh"))
        );
        assert_eq!(token.load().unwrap().as_deref(), Some("rotated-refresh"));
        // A fresh process restores the durable credential, not a logged-in flag.
        drop(client);
        let restarted = cloud(url, token);
        assert!(restarted.auth_status().unwrap().email.is_some());
        let requests = server.join().unwrap();
        assert!(requests[0].contains(original));
        assert!(requests[2].contains("rotated-refresh"));
    }
}

#[test]
fn invalid_refresh_clears_credentials_but_transient_auth_outages_do_not() {
    for (status, cleared) in [(400, true), (503, false), (429, false)] {
        let (url, server) = server(vec![(
            "/auth/v1/token?grant_type=refresh_token",
            status,
            json!({"message": "sensitive upstream contents"}),
        )]);
        let store = Store::default();
        store.save("refresh").unwrap();
        let client = cloud(url, store.clone());
        let result = client.auth_status();
        if cleared {
            assert!(result.unwrap().email.is_none());
        } else {
            assert!(!result.err().unwrap().message.contains("sensitive"));
        }
        assert_eq!(store.load().unwrap().is_none(), cleared);
        server.join().unwrap();
    }
}

#[test]
fn queued_writes_are_bound_to_the_verified_project_and_user() {
    let (url, server) = server(vec![(
        "/auth/v1/token?grant_type=refresh_token",
        200,
        session(),
    )]);
    let expected = format!("{url}:user");
    let store = Store::default();
    store.save("refresh").unwrap();
    let client = cloud(url, store);
    assert_eq!(
        client.auth_status().unwrap().account_key.as_deref(),
        Some(expected.as_str())
    );
    let error = client
        .planner(
            "rename_task",
            json!({"_accountKey": "https://other.supabase.co:someone"}),
            "UTC",
        )
        .unwrap_err();
    assert_eq!(error.code, "account_changed");
    assert_eq!(server.join().unwrap().len(), 1); // No planner HTTP request was sent.
}

#[test]
fn rejected_access_token_is_cleared_without_replaying_the_mutation() {
    let (url, server) = server(vec![
        ("/auth/v1/token?grant_type=refresh_token", 200, session()),
        (
            "/rest/v1/rpc/planner_call",
            401,
            json!({"message": "private error"}),
        ),
    ]);
    let store = Store::default();
    store.save("refresh").unwrap();
    let client = cloud(url, store.clone());
    let error = client.planner("create_task", json!({}), "UTC").unwrap_err();
    assert_eq!(error.code, "unauthorized");
    assert!(!error.message.contains("private error"));
    assert!(store.load().unwrap().is_none());
    assert!(client.auth_status().unwrap().email.is_none());
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn otp_email_delivery_failures_identify_hosted_configuration_and_safe_request_id() {
    // The first fixture is the actual response shape from hosted GoTrue v2.197.0.
    for body in [
        json!({"code": 500, "error_code": "unexpected_failure", "msg": "Error sending confirmation email"}),
        json!({"code": "unexpected_failure", "message": "Error sending magic link email"}),
    ] {
        let (url, server) = server_with_headers(vec![(
            "/auth/v1/otp",
            500,
            body,
            "sb-request-id: 01a14977-1549-743c-aeee-9853838b258d\r\n",
        )]);
        let store = Store::default();
        store.save("existing-refresh").unwrap();
        let client = cloud(url, store.clone());
        let error = client.request_code("user@example.com").unwrap_err();
        assert_eq!(error.code, "email_delivery");
        assert!(error.message.contains("SMTP/email hook"));
        assert!(error.message.contains("HTTP 500"));
        assert!(error
            .message
            .contains("request ID: 01a14977-1549-743c-aeee-9853838b258d"));
        assert_eq!(store.load().unwrap().as_deref(), Some("existing-refresh"));
        // A failed email request must never be automatically replayed.
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[test]
fn unknown_auth_failures_and_untrusted_request_headers_stay_private() {
    for body in [
        json!({"msg": "SMTP password=private-smtp-secret user=private@example.com"}),
        json!({"code": "PT400", "message": "private provider contents"}),
        json!("private non-object response"),
    ] {
        let (url, server) = server_with_headers(vec![(
            "/auth/v1/otp",
            502,
            body,
            "sb-request-id: private-header-contents\r\n",
        )]);
        let error = cloud(url, Store::default())
            .request_code("user@example.com")
            .unwrap_err();
        assert_eq!(error.code, "server");
        assert!(error.message.contains("HTTP 502"));
        assert!(!error.message.contains("private"));
        assert!(!error.message.contains("request ID"));
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[test]
fn otp_rate_limits_do_not_blame_review_allowance_or_clear_credentials() {
    let (url, server) = server(vec![(
        "/auth/v1/otp",
        429,
        json!({"code": "over_email_send_rate_limit", "msg": "private rate limit contents"}),
    )]);
    let store = Store::default();
    store.save("existing-refresh").unwrap();
    let error = cloud(url, store.clone())
        .request_code("user@example.com")
        .unwrap_err();
    assert_eq!(error.code, "rate_limited");
    assert!(error.message.contains("Auth rate limits"));
    assert!(!error.message.contains("review"));
    assert!(!error.message.contains("private"));
    assert_eq!(store.load().unwrap().as_deref(), Some("existing-refresh"));
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn credential_store_failure_has_no_plaintext_fallback_and_privileged_keys_are_rejected() {
    struct Locked;
    impl CredentialStore for Locked {
        fn load(&self) -> Result<Option<String>> {
            Err(CommandError::new("credentials", "Locked"))
        }
        fn save(&self, _: &str) -> Result<()> {
            unreachable!()
        }
        fn clear(&self) -> Result<()> {
            unreachable!()
        }
    }
    assert!(Cloud::new(
        "https://project.supabase.co".into(),
        "sb_publishable_fixture".into(),
        Box::new(Locked)
    )
    .is_err());
    for key in [
        "sb_secret_never-ship",
        "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature",
    ] {
        assert!(Cloud::new(
            "https://project.supabase.co".into(),
            key.into(),
            Box::new(Store::default())
        )
        .is_err());
    }
}

#[test]
fn invalid_email_and_code_matrix_is_rejected_before_any_http_request() {
    let client = cloud("http://127.0.0.1:9".into(), Store::default());
    for email in [
        "",
        " ",
        "missing-at",
        "@",
        "user@",
        "@example.com",
        "a@@example.com",
        "a b@example.com",
        "a\n@example.com",
        "a\0@example.com",
    ] {
        assert_eq!(
            client.request_code(email).unwrap_err().code,
            "validation",
            "{email:?}"
        );
    }
    assert_eq!(
        client
            .request_code(&format!("{}@example.com", "a".repeat(255)))
            .unwrap_err()
            .code,
        "validation"
    );
    for code in [
        "",
        "12345",
        "12345678901",
        "123 45",
        "abcdef",
        "１２３４５６",
        "123456\n",
    ] {
        assert_eq!(
            client
                .verify_code("user@example.com", code)
                .err()
                .unwrap()
                .code,
            "validation",
            "{code:?}"
        );
    }
}

#[test]
fn valid_email_is_trimmed_and_codes_at_both_length_boundaries_are_accepted() {
    let (url, server) = server(vec![
        ("/auth/v1/otp", 200, json!({})),
        ("/auth/v1/verify", 200, session()),
        ("/auth/v1/verify", 200, session()),
    ]);
    let client = cloud(url, Store::default());
    client.request_code("  user+test@example.com  ").unwrap();
    client.verify_code("user@example.com", "123456").unwrap();
    client
        .verify_code("user@example.com", "1234567890")
        .unwrap();
    let requests = server.join().unwrap();
    assert!(requests[0].contains("\"email\":\"user+test@example.com\""));
    assert!(!requests[0].contains("Bearer"));
}

#[test]
fn malformed_and_anonymous_sessions_never_replace_saved_credentials() {
    let mut values = vec![Value::Null, json!({}), json!({"access_token":"a"})];
    for field in ["access_token", "refresh_token"] {
        for value in [Value::Null, json!(""), json!("x".repeat(8193)), json!(42)] {
            let mut body = session();
            body[field] = value;
            values.push(body);
        }
    }
    for (field, value) in [
        ("id", json!("")),
        ("id", Value::Null),
        ("email", json!("")),
        ("email", Value::Null),
        ("is_anonymous", json!(true)),
    ] {
        let mut body = session();
        body["user"][field] = value;
        values.push(body);
    }
    for body in values {
        let (url, server) = server(vec![("/auth/v1/verify", 200, body)]);
        let store = Store::default();
        store.save("previous-refresh").unwrap();
        assert_eq!(
            cloud(url, store.clone())
                .verify_code("user@example.com", "123456")
                .err()
                .unwrap()
                .code,
            "unauthorized"
        );
        assert_eq!(store.load().unwrap().as_deref(), Some("previous-refresh"));
        server.join().unwrap();
    }
}

#[test]
fn credential_save_failure_does_not_report_success_or_fall_back_to_memory() {
    struct SaveLocked;
    impl CredentialStore for SaveLocked {
        fn load(&self) -> Result<Option<String>> {
            Ok(None)
        }
        fn save(&self, _: &str) -> Result<()> {
            Err(CommandError::new("credentials", "Locked"))
        }
        fn clear(&self) -> Result<()> {
            Ok(())
        }
    }
    let (url, server) = server(vec![("/auth/v1/verify", 200, session())]);
    let client = Cloud::new(url, "sb_publishable_fixture".into(), Box::new(SaveLocked)).unwrap();
    assert_eq!(
        client
            .verify_code("user@example.com", "123456")
            .err()
            .unwrap()
            .code,
        "credentials"
    );
    assert!(client.auth_status().unwrap().email.is_none());
    server.join().unwrap();
}

#[test]
fn credential_delete_failure_keeps_the_local_session_and_reports_signout_failure() {
    struct DeleteLocked(Store);
    impl CredentialStore for DeleteLocked {
        fn load(&self) -> Result<Option<String>> {
            self.0.load()
        }
        fn save(&self, value: &str) -> Result<()> {
            self.0.save(value)
        }
        fn clear(&self) -> Result<()> {
            Err(CommandError::new("credentials", "Locked"))
        }
    }
    let (url, server) = server(vec![("/auth/v1/verify", 200, session())]);
    let store = Store::default();
    let client = Cloud::new(
        url,
        "sb_publishable_fixture".into(),
        Box::new(DeleteLocked(store.clone())),
    )
    .unwrap();
    client.verify_code("user@example.com", "123456").unwrap();
    assert_eq!(client.sign_out().unwrap_err().code, "credentials");
    assert!(store.load().unwrap().is_some());
    assert!(client.auth_status().unwrap().email.is_some());
    server.join().unwrap();
}

#[test]
fn remote_logout_failure_cannot_keep_a_refresh_token_on_the_device() {
    let (url, server) = server(vec![
        ("/auth/v1/verify", 200, session()),
        (
            "/auth/v1/logout?scope=local",
            503,
            json!({"message":"private"}),
        ),
    ]);
    let store = Store::default();
    let client = cloud(url, store.clone());
    client.verify_code("user@example.com", "123456").unwrap();
    client.sign_out().unwrap();
    assert!(store.load().unwrap().is_none());
    assert!(client.auth_status().unwrap().email.is_none());
    server.join().unwrap();
}

#[test]
fn many_concurrent_planner_reads_rotate_the_refresh_token_exactly_once() {
    let mut replies = vec![("/auth/v1/token?grant_type=refresh_token", 200, session())];
    replies.extend((0..16).map(|_| ("/rest/v1/rpc/planner_call", 200, json!({}))));
    let (url, server) = server(replies);
    let store = Store::default();
    store.save("original").unwrap();
    let client = Arc::new(cloud(url, store));
    let workers: Vec<_> = (0..16)
        .map(|_| {
            let client = Arc::clone(&client);
            thread::spawn(move || client.planner("dashboard", json!({}), "UTC").unwrap())
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(
        server
            .join()
            .unwrap()
            .iter()
            .filter(|request| request.contains("POST /auth/"))
            .count(),
        1
    );
}

#[test]
fn only_short_authored_postgres_errors_are_exposed_and_never_automatically_retried() {
    for (body, expected) in [
        (
            json!({"code":"PT400", "message":"Check the title."}),
            "validation",
        ),
        (json!({"code":"PT409", "message":"Conflict."}), "validation"),
        (json!({"code":"23505", "message":"private-table"}), "server"),
        (
            json!({"code":"PT400", "message":"private".repeat(100)}),
            "server",
        ),
    ] {
        let (url, server) = server(vec![
            ("/auth/v1/verify", 200, session()),
            ("/rest/v1/rpc/planner_call", 400, body),
        ]);
        let client = cloud(url, Store::default());
        client.verify_code("user@example.com", "123456").unwrap();
        let error = client.planner("create_task", json!({}), "UTC").unwrap_err();
        assert_eq!(error.code, expected);
        assert!(!error.message.contains("private"));
        assert_eq!(server.join().unwrap().len(), 2);
    }
}

#[test]
fn privileged_malformed_and_header_injection_public_keys_are_rejected() {
    for key in [
        "",
        "sb_publishable_",
        "sb_secret_secret",
        "sb_publishable_bad\nkey",
        "sb_publishable_ bad",
        "a.b.c",
        "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.signature",
    ] {
        assert!(
            Cloud::new(
                "https://project.supabase.co".into(),
                key.into(),
                Box::new(Store::default())
            )
            .is_err(),
            "{key:?}"
        );
    }
    assert!(Cloud::new(
        "https://project.supabase.co".into(),
        "x".repeat(8193),
        Box::new(Store::default())
    )
    .is_err());
}

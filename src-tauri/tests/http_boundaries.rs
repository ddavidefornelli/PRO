//! Transport-level malformed HTTP fixtures. No hosted endpoints, tokens or keychain.
#![cfg(debug_assertions)]
use pro_lib::cloud::{Cloud, CredentialStore, Result};
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};

struct NoCredentials;
impl CredentialStore for NoCredentials {
    fn load(&self) -> Result<Option<String>> {
        Ok(None)
    }
    fn save(&self, _: &str) -> Result<()> {
        unreachable!()
    }
    fn clear(&self) -> Result<()> {
        Ok(())
    }
}
fn response(
    status: u16,
    body: Vec<u8>,
    headers: &str,
    declared: Option<usize>,
) -> (Cloud, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let headers = headers.to_owned();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "Fixture was never contacted");
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("{error}"),
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let size = socket.read(&mut chunk).unwrap();
            assert!(size > 0);
            request.extend_from_slice(&chunk[..size]);
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                let length: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        write!(socket, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n", declared.unwrap_or(body.len())).unwrap();
        // A size-limited client is allowed to close before all fixture bytes are sent.
        let _ = socket.write_all(&body);
    });
    (
        Cloud::new(
            url,
            "sb_publishable_fixture".into(),
            Box::new(NoCredentials),
        )
        .unwrap(),
        handle,
    )
}

#[test]
fn successful_invalid_json_does_not_report_a_saved_operation() {
    for body in [
        b"{".to_vec(),
        vec![0xff, 0xfe],
        b"".to_vec(),
        b"<html>private upstream error</html>".to_vec(),
    ] {
        let (client, server) = response(200, body, "", None);
        let error = client.request_code("user@example.com").unwrap_err();
        assert_eq!(error.code, "server");
        assert!(!error.message.contains("private"));
        server.join().unwrap();
    }
}
#[test]
fn non_json_auth_failures_are_sanitized_with_the_http_status() {
    for status in [500, 502, 503] {
        let (client, server) = response(status, b"private SMTP password".to_vec(), "", None);
        let error = client.request_code("user@example.com").unwrap_err();
        assert_eq!(error.code, "server");
        assert!(error.message.contains(&format!("HTTP {status}")));
        assert!(!error.message.contains("password"));
        server.join().unwrap();
    }
}
#[test]
fn redirect_responses_are_not_followed() {
    for status in [301, 302, 303, 307, 308] {
        let (client, server) = response(
            status,
            b"{}".to_vec(),
            "Location: http://127.0.0.1:9/never-send-credentials\r\n",
            None,
        );
        assert_eq!(
            client.request_code("user@example.com").unwrap_err().code,
            "auth"
        );
        server.join().unwrap();
    }
}
#[test]
fn response_size_boundary_allows_exactly_eight_mib_but_not_one_byte_more() {
    for extra in [0, 1] {
        let mut body = b"{}".to_vec();
        body.resize(8 * 1024 * 1024 + extra, b' ');
        let (client, server) = response(200, body, "", None);
        let result = client.request_code("user@example.com");
        if extra == 0 {
            assert!(result.is_ok());
        } else {
            assert_eq!(result.unwrap_err().code, "size");
        }
        server.join().unwrap();
    }
}
#[test]
fn truncated_http_body_remains_an_ambiguous_network_failure() {
    let (client, server) = response(200, b"{}".to_vec(), "", Some(100));
    assert_eq!(
        client.request_code("user@example.com").unwrap_err().code,
        "network"
    );
    server.join().unwrap();
}
#[test]
fn no_content_success_does_not_require_a_json_body() {
    let (client, server) = response(204, vec![], "", None);
    client.request_code("user@example.com").unwrap();
    server.join().unwrap();
}

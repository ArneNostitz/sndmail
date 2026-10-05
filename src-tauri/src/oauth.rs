use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

#[derive(Serialize, Debug)]
pub struct OAuthResult {
    pub code: String,
    pub state: String,
}

/// Providers are told to redirect to a fixed port, so the deadline has to cover
/// a full interactive sign-in: account picker, password, 2FA, consent screen.
const OAUTH_DEADLINE_SECS: u64 = 600;
/// A previous flow holds the port until it is cancelled; give it time to let go.
const BIND_ATTEMPTS: u32 = 20;
const BIND_RETRY_MS: u64 = 100;
const MAX_REQUEST_BYTES: usize = 16 * 1024;

/// Signals an in-flight callback server to release the port so a new sign-in
/// can bind it. Without this an abandoned attempt keeps the port for its whole
/// deadline, and the next attempt would have nowhere to listen.
fn cancel_signal() -> &'static Arc<Notify> {
    static CANCEL: OnceLock<Arc<Notify>> = OnceLock::new();
    CANCEL.get_or_init(|| Arc::new(Notify::new()))
}

fn page(title: &str, message: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html>
<head><title>snd</title><meta charset="utf-8"></head>
<body style="font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0;">
<div style="text-align: center; max-width: 30rem; padding: 0 1.5rem;">
<h1 style="margin-bottom: 8px;">{title}</h1>
<p style="opacity: 0.7;">{message}</p>
</div>
</body>
</html>"#
    )
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

/// Read until the end of the HTTP headers. A single read can return a partial
/// request, which would drop the redirect on the floor.
async fn read_request(stream: &mut TcpStream) -> Result<String, String> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("Failed to read: {}", e))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..n]);
        if data.windows(4).any(|w| w == b"\r\n\r\n") || data.len() >= MAX_REQUEST_BYTES {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&data).into_owned())
}

/// Accept from an optional listener, or pend forever when there isn't one.
async fn accept_maybe(listener: &Option<TcpListener>) -> std::io::Result<(TcpStream, SocketAddr)> {
    match listener {
        Some(l) => l.accept().await,
        None => std::future::pending().await,
    }
}

/// Bind the loopback address on the exact port named by the redirect URI.
///
/// Both stacks are bound: the Gmail flow redirects to `127.0.0.1`, but a
/// provider registration may still say `localhost`, which resolves to `::1`
/// first on macOS.
async fn bind_loopback(port: u16) -> Result<(TcpListener, Option<TcpListener>), String> {
    // Tell any earlier flow still holding the port to stand down.
    cancel_signal().notify_waiters();

    let mut last_err = String::new();
    for attempt in 0..BIND_ATTEMPTS {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
            Ok(v4) => {
                let v6 = TcpListener::bind((Ipv6Addr::LOCALHOST, port)).await.ok();
                if v6.is_none() {
                    log::warn!("OAuth callback server could not bind [::1]:{port}; localhost redirects over IPv6 will not arrive");
                }
                return Ok((v4, v6));
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt + 1 < BIND_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(BIND_RETRY_MS)).await;
                }
            }
        }
    }

    Err(format!(
        "Could not listen on 127.0.0.1:{port} for the sign-in redirect ({last_err}). Close whatever is using that port and try again."
    ))
}

/// Run the loopback callback server for one OAuth sign-in.
///
/// Listens on the exact port the redirect URI names — falling back to a nearby
/// port would leave the browser knocking on a port nobody is listening on,
/// which surfaces as "the page could not be opened" after a successful login.
///
/// Keeps accepting until a request actually carries the callback. Browsers open
/// speculative connections and ask for /favicon.ico, and treating the first
/// connection as the redirect meant a stray request could close the server
/// before the real one arrived.
#[tauri::command]
pub async fn start_oauth_server(port: u16, state: String) -> Result<OAuthResult, String> {
    let (v4, v6) = bind_loopback(port).await?;

    log::info!(
        "OAuth callback server listening on 127.0.0.1:{port}{}",
        if v6.is_some() { " and [::1]" } else { "" }
    );

    let cancel = cancel_signal().clone();
    let cancelled = cancel.notified();
    tokio::pin!(cancelled);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(OAUTH_DEADLINE_SECS);

    loop {
        let accepted = tokio::select! {
            r = v4.accept() => r,
            r = accept_maybe(&v6) => r,
            _ = &mut cancelled => {
                return Err("Sign-in was replaced by a newer attempt.".to_string());
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err("Sign-in timed out — please try again.".to_string());
            }
        };

        let (mut stream, _) = accepted.map_err(|e| format!("Failed to accept: {}", e))?;

        let request = match read_request(&mut stream).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("OAuth callback read failed: {e}");
                continue;
            }
        };

        match parse_callback(&request) {
            Callback::Success { code, state: returned_state } => {
                if returned_state != state {
                    respond(
                        &mut stream,
                        "400 Bad Request",
                        &page(
                            "Sign-in could not be verified",
                            "The response did not match this sign-in attempt. Close this tab and try again from snd.",
                        ),
                    )
                    .await;
                    return Err("OAuth state mismatch — possible CSRF attack".to_string());
                }

                respond(
                    &mut stream,
                    "200 OK",
                    &page("Account connected", "You can close this tab and return to snd."),
                )
                .await;

                return Ok(OAuthResult { code, state: returned_state });
            }
            Callback::Error(message) => {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    &page("Sign-in failed", &format!("{message}. Close this tab and try again from snd.")),
                )
                .await;
                return Err(format!("OAuth error: {message}"));
            }
            // Preconnects, favicon probes, anything that is not the redirect.
            Callback::NotTheCallback => {
                respond(&mut stream, "404 Not Found", &page("Waiting for sign-in", "snd is still waiting for the provider to redirect here.")).await;
                continue;
            }
        }
    }
}

enum Callback {
    Success { code: String, state: String },
    Error(String),
    NotTheCallback,
}

fn parse_callback(request: &str) -> Callback {
    let Some(first_line) = request.lines().next() else {
        return Callback::NotTheCallback;
    };
    let Some(path) = first_line.split_whitespace().nth(1) else {
        return Callback::NotTheCallback;
    };

    let params = parse_query_string(path);

    if let Some(error) = params.get("error") {
        return Callback::Error(error.clone());
    }

    match (params.get("code"), params.get("state")) {
        (Some(code), Some(state)) => Callback::Success {
            code: code.clone(),
            state: state.clone(),
        },
        _ => Callback::NotTheCallback,
    }
}

fn parse_query_string(path: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    if let Some(query) = path.split('?').nth(1) {
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            if let (Some(key), Some(value)) = (kv.next(), kv.next()) {
                params.insert(key.to_string(), urlencoding_decode(value));
            }
        }
    }
    params
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                &s[i + 1..i + 3],
                16,
            ) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            result.push(b' ');
        } else {
            result.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| s.to_string())
}

#[derive(Serialize, Deserialize)]
pub struct TokenExchangeResult {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub token_type: String,
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

/// Exchange an OAuth authorization code for tokens via Rust HTTP client (avoids CORS).
#[tauri::command]
pub async fn oauth_exchange_token(
    token_url: String,
    code: String,
    client_id: String,
    redirect_uri: String,
    code_verifier: Option<String>,
    client_secret: Option<String>,
    scope: Option<String>,
) -> Result<TokenExchangeResult, String> {
    let mut params = vec![
        ("code", code),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code".to_string()),
    ];
    if let Some(verifier) = code_verifier {
        params.push(("code_verifier", verifier));
    }
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            params.push(("client_secret", secret));
        }
    }
    if let Some(s) = scope {
        params.push(("scope", s));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;

    if !response.status().is_success() {
        let error = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token exchange failed: {}", error));
    }

    response
        .json::<TokenExchangeResult>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

/// Refresh an OAuth token via Rust HTTP client (avoids CORS).
#[tauri::command]
pub async fn oauth_refresh_token(
    token_url: String,
    refresh_token: String,
    client_id: String,
    client_secret: Option<String>,
    scope: Option<String>,
) -> Result<TokenExchangeResult, String> {
    let mut params = vec![
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            params.push(("client_secret", secret));
        }
    }
    if let Some(s) = scope {
        params.push(("scope", s));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !response.status().is_success() {
        let error = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token refresh failed: {}", error));
    }

    response
        .json::<TokenExchangeResult>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn callback_of(path: &str) -> Callback {
        parse_callback(&format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:17248\r\n\r\n"
        ))
    }

    #[test]
    fn parses_code_and_state_from_the_redirect() {
        match callback_of("/?code=abc123&state=xyz789&scope=mail") {
            Callback::Success { code, state } => {
                assert_eq!(code, "abc123");
                assert_eq!(state, "xyz789");
            }
            _ => panic!("expected the callback to be recognised"),
        }
    }

    #[test]
    fn url_decodes_the_code() {
        match callback_of("/?code=4%2F0Ab_c-d&state=s1") {
            Callback::Success { code, .. } => assert_eq!(code, "4/0Ab_c-d"),
            _ => panic!("expected success"),
        }
    }

    #[test]
    fn reports_provider_errors() {
        match callback_of("/?error=access_denied&state=s1") {
            Callback::Error(message) => assert_eq!(message, "access_denied"),
            _ => panic!("expected an error callback"),
        }
    }

    #[test]
    fn ignores_requests_that_are_not_the_redirect() {
        // Browsers probe the port before and alongside the real redirect;
        // treating these as the callback used to kill the server.
        assert!(matches!(callback_of("/favicon.ico"), Callback::NotTheCallback));
        assert!(matches!(callback_of("/"), Callback::NotTheCallback));
        assert!(matches!(callback_of("/?state=s1"), Callback::NotTheCallback));
        assert!(matches!(parse_callback(""), Callback::NotTheCallback));
    }

    async fn get(addr: &str, path: &str) -> String {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\n\r\n").as_bytes())
            .await
            .expect("write");
        let mut body = String::new();
        let mut chunk = [0u8; 1024];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => body.push_str(&String::from_utf8_lossy(&chunk[..n])),
            }
        }
        body
    }

    /// Pick a port unlikely to collide with a real snd instance or another test.
    fn test_port(offset: u16) -> u16 {
        18300 + offset
    }

    /// Cancellation is process-wide by design — the app only ever runs one
    /// sign-in at a time — so the server tests must not overlap either.
    fn serial() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    #[tokio::test]
    async fn survives_a_stray_request_before_the_redirect() {
        let _guard = serial().lock().await;
        let port = test_port(1);
        let server = tokio::spawn(start_oauth_server(port, "the-state".to_string()));
        tokio::time::sleep(Duration::from_millis(200)).await;

        let addr = format!("127.0.0.1:{port}");
        let stray = get(&addr, "/favicon.ico").await;
        assert!(stray.starts_with("HTTP/1.1 404"), "stray got: {stray}");

        let ok = get(&addr, "/?code=the-code&state=the-state").await;
        assert!(ok.starts_with("HTTP/1.1 200"), "callback got: {ok}");

        let result = server.await.expect("server task").expect("callback");
        assert_eq!(result.code, "the-code");
        assert_eq!(result.state, "the-state");
    }

    #[tokio::test]
    async fn accepts_the_redirect_over_ipv6_localhost() {
        let _guard = serial().lock().await;
        let port = test_port(2);
        let server = tokio::spawn(start_oauth_server(port, "s".to_string()));
        tokio::time::sleep(Duration::from_millis(200)).await;

        let body = get(&format!("[::1]:{port}"), "/?code=v6-code&state=s").await;
        assert!(body.starts_with("HTTP/1.1 200"), "got: {body}");

        let result = server.await.expect("server task").expect("callback");
        assert_eq!(result.code, "v6-code");
    }

    #[tokio::test]
    async fn rejects_a_mismatched_state() {
        let _guard = serial().lock().await;
        let port = test_port(3);
        let server = tokio::spawn(start_oauth_server(port, "expected".to_string()));
        tokio::time::sleep(Duration::from_millis(200)).await;

        let body = get(&format!("127.0.0.1:{port}"), "/?code=c&state=attacker").await;
        assert!(body.starts_with("HTTP/1.1 400"), "got: {body}");

        let err = server.await.expect("server task").expect_err("must reject");
        assert!(err.contains("state mismatch"), "got: {err}");
    }

    #[tokio::test]
    async fn a_new_flow_takes_the_port_from_an_abandoned_one() {
        let _guard = serial().lock().await;
        let port = test_port(4);
        let abandoned = tokio::spawn(start_oauth_server(port, "old".to_string()));
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Without cancellation the abandoned attempt would hold the port for its
        // whole deadline and this bind would fail.
        let fresh = tokio::spawn(start_oauth_server(port, "new".to_string()));
        tokio::time::sleep(Duration::from_millis(500)).await;

        assert!(abandoned.await.expect("task").is_err(), "old flow should give up the port");

        let body = get(&format!("127.0.0.1:{port}"), "/?code=c2&state=new").await;
        assert!(body.starts_with("HTTP/1.1 200"), "got: {body}");
        assert_eq!(fresh.await.expect("task").expect("callback").code, "c2");
    }
}

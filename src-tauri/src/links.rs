//! Native ownership of links clicked inside email message frames.
//!
//! Email HTML is deliberately rendered in a sandbox without scripts. WebKit
//! consequently does not run JavaScript event listeners in that document,
//! including listeners installed by the parent page. Navigation still reaches
//! Tauri's navigation delegate, so this plugin is the single boundary for mail
//! actions: cancel the frame navigation and emit it back to the trusted app UI.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime, Url, Webview,
};

pub const EMAIL_NAVIGATION_EVENT: &str = "sndmail-email-navigation";
const EMAIL_ACTION_PREFIX: &str = "/__sndmail_email_action__/";

fn is_external_scheme(url: &Url) -> bool {
    matches!(
        url.scheme(),
        "http"
            | "https"
            | "mailto"
            | "tel"
            | "sms"
            | "facetime"
            | "facetime-audio"
            | "maps"
            | "zoommtg"
            | "msteams"
            | "slack"
    )
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host() == b.host()
        && a.port_or_known_default() == b.port_or_known_default()
}

pub fn allows_navigation(own: Option<&Url>, url: &Url) -> bool {
    // Use an app-origin path rather than a custom scheme. WebKit rejects an
    // unknown scheme before its navigation delegate, while this path reaches
    // the delegate and is cancelled here before the app/router sees it.
    if url.path().starts_with(EMAIL_ACTION_PREFIX) {
        return false;
    }
    if !is_external_scheme(url) {
        return true;
    }
    if let Some(own) = own {
        if same_origin(own, url) {
            return true;
        }
    }
    own.is_none()
        && cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.port() == Some(1420)
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("email-links")
        .on_navigation(|webview: &Webview<R>, url: &Url| {
            let own = webview.url().ok();
            if allows_navigation(own.as_ref(), url) {
                return true;
            }

            log::info!(
                "mail navigation to {} handed to {}",
                url.host_str().unwrap_or(url.scheme()),
                webview.label()
            );
            let Ok(payload) = serde_json::to_string(url.as_str()) else {
                log::error!("could not serialize mail navigation");
                return false;
            };
            let script = format!(
                "window.dispatchEvent(new CustomEvent({:?}, {{ detail: {} }}));",
                EMAIL_NAVIGATION_EVENT, payload
            );
            if let Err(err) = webview.eval(&script) {
                log::error!("could not hand mail navigation to the trusted UI: {err}");
            }
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn hands_mail_actions_and_external_links_to_the_app() {
        let own = u("tauri://localhost/");
        for target in [
            "tauri://localhost/__sndmail_email_action__/renderer/action",
            "https://example.com/a?b=c",
            "mailto:someone@example.com",
            "tel:+43123",
            "sms:+43123",
            "zoommtg://zoom.us/join",
        ] {
            assert!(!allows_navigation(Some(&own), &u(target)), "{target}");
        }
    }

    #[test]
    fn keeps_app_and_frame_internal_navigation() {
        let own = u("tauri://localhost/");
        assert!(allows_navigation(
            Some(&own),
            &u("tauri://localhost/index.html#/inbox")
        ));
        assert!(allows_navigation(Some(&own), &u("about:blank")));
        assert!(allows_navigation(Some(&own), &u("data:text/html,hi")));
    }

    #[test]
    fn keeps_the_dev_server_but_not_other_hosts() {
        let own = u("http://localhost:1420/");
        assert!(allows_navigation(
            Some(&own),
            &u("http://localhost:1420/#/inbox")
        ));
        assert!(!allows_navigation(Some(&own), &u("https://example.com/")));
        assert!(!allows_navigation(Some(&own), &u("http://localhost:8080/")));
    }
}

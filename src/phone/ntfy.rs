use crate::config::PhoneNotifications;
use futures::future::BoxFuture;
use serde_json::{json, Value};
use std::time::Duration;

pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const ANSWER_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub server: String,
    pub topic: String,
    pub token: Option<String>,
}

impl Target {
    pub fn from_settings(p: &PhoneNotifications) -> Target {
        Target {
            server: p.server.clone(),
            topic: p.topic.clone(),
            token: (!p.token.is_empty()).then(|| p.token.clone()),
        }
    }

    pub fn redact(&self, text: &str) -> String {
        match self.token.as_deref() {
            Some(token) if !token.is_empty() => text.replace(token, "[token]"),
            _ => text.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Push {
    pub title: String,
    pub message: String,
    pub tags: Vec<String>,
    pub priority: u8,
    pub click: Option<String>,
}

pub fn body(to: &Target, push: &Push) -> Value {
    let mut payload = json!({
        "topic": to.topic,
        "title": push.title,
        "message": push.message,
        "tags": push.tags,
        "priority": push.priority,
    });
    if let Some(click) = &push.click {
        payload["click"] = json!(click);
    }
    payload
}

pub trait Sender: Send + Sync {
    fn send<'a>(&'a self, to: &'a Target, push: &'a Push) -> BoxFuture<'a, Result<(), String>>;
}

pub struct Ntfy {
    http: reqwest::Client,
}

impl Ntfy {
    pub fn new() -> Ntfy {
        let http = reqwest::Client::builder()
            .timeout(SEND_TIMEOUT)
            // A followed 301 becomes a GET that answers 200, and the push would look sent.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        Ntfy { http }
    }

    async fn publish(&self, to: &Target, push: &Push) -> Result<(), String> {
        let server = to.server.trim_end_matches('/');
        let mut request = self.http.post(format!("{server}/")).json(&body(to, push));
        if let Some(token) = &to.token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("can't reach {server}: {}", root_cause(&e)))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let answer = to.redact(&response.text().await.unwrap_or_default());
        let answer: String = answer.trim().chars().take(ANSWER_CHARS).collect();
        Err(format!("{server} answered {}: {answer}", status.as_u16()))
    }
}

impl Default for Ntfy {
    fn default() -> Self {
        Ntfy::new()
    }
}

impl Sender for Ntfy {
    fn send<'a>(&'a self, to: &'a Target, push: &'a Push) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(self.publish(to, push))
    }
}

fn root_cause(error: &dyn std::error::Error) -> String {
    let mut cause = error;
    while let Some(source) = cause.source() {
        cause = source;
    }
    cause.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::http::{header, HeaderMap, HeaderName, Method, StatusCode, Uri};
    use axum::routing::{get, post};
    use axum::Router;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, PartialEq)]
    struct Seen {
        method: Method,
        path: String,
        authorization: Option<String>,
        content_type: Option<String>,
        body: Value,
    }

    fn header_text(headers: &HeaderMap, name: HeaderName) -> Option<String> {
        headers
            .get(name)
            .map(|value| value.to_str().unwrap().to_string())
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    async fn stub(
        status: StatusCode,
        answer: impl Into<String>,
    ) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let answer = answer.into();
        let app = Router::new().fallback(
            move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| async move {
                record.lock().unwrap().push(Seen {
                    method,
                    path: uri.path().to_string(),
                    authorization: header_text(&headers, header::AUTHORIZATION),
                    content_type: header_text(&headers, header::CONTENT_TYPE),
                    body: serde_json::from_slice(&body).unwrap_or(Value::Null),
                });
                (status, answer)
            },
        );
        (serve(app).await, seen)
    }

    fn target(token: Option<&str>) -> Target {
        Target {
            server: "http://127.0.0.1:1".into(),
            topic: "t".into(),
            token: token.map(str::to_string),
        }
    }

    fn push() -> Push {
        Push {
            title: "T".into(),
            message: "M".into(),
            tags: vec!["warning".into()],
            priority: 4,
            click: Some("http://x/".into()),
        }
    }

    fn sender() -> Arc<dyn Sender> {
        Arc::new(Ntfy::new())
    }

    #[test]
    fn target_has_no_token_when_the_setting_is_empty() {
        let mut settings = PhoneNotifications {
            topic: "t".into(),
            ..PhoneNotifications::default()
        };
        assert_eq!(
            Target::from_settings(&settings),
            Target {
                server: "https://ntfy.sh".into(),
                topic: "t".into(),
                token: None,
            }
        );
        settings.token = "tk_1".into();
        assert_eq!(
            Target::from_settings(&settings).token.as_deref(),
            Some("tk_1")
        );
    }

    #[test]
    fn body_has_every_field() {
        assert_eq!(
            body(&target(None), &push()),
            json!({"topic":"t","title":"T","message":"M","tags":["warning"],"priority":4,"click":"http://x/"})
        );
    }

    #[test]
    fn body_leaves_out_click_without_a_link() {
        let no_link = Push {
            click: None,
            ..push()
        };
        assert_eq!(
            body(&target(None), &no_link),
            json!({"topic":"t","title":"T","message":"M","tags":["warning"],"priority":4})
        );
    }

    #[tokio::test]
    async fn ntfy_posts_json_to_the_root_with_a_bearer_token() {
        let (server, seen) = stub(StatusCode::OK, "").await;
        let to = Target {
            server: format!("{server}/"),
            ..target(Some("tk_1"))
        };

        sender().send(&to, &push()).await.unwrap();

        assert_eq!(
            *seen.lock().unwrap(),
            vec![Seen {
                method: Method::POST,
                path: "/".into(),
                authorization: Some("Bearer tk_1".into()),
                content_type: Some("application/json".into()),
                body: body(&to, &push()),
            }]
        );
    }

    #[tokio::test]
    async fn ntfy_sends_no_authorization_without_a_token() {
        let (server, seen) = stub(StatusCode::OK, "").await;
        let to = Target {
            server,
            ..target(None)
        };

        sender().send(&to, &push()).await.unwrap();

        assert_eq!(
            *seen.lock().unwrap(),
            vec![Seen {
                method: Method::POST,
                path: "/".into(),
                authorization: None,
                content_type: Some("application/json".into()),
                body: body(&to, &push()),
            }]
        );
    }

    #[tokio::test]
    async fn ntfy_reports_an_error_answer() {
        let (server, _) = stub(StatusCode::TOO_MANY_REQUESTS, "limit reached\n").await;
        let to = Target {
            server: format!("{server}/"),
            ..target(None)
        };

        let err = sender().send(&to, &push()).await.unwrap_err();

        assert_eq!(err, format!("{server} answered 429: limit reached"));
    }

    #[tokio::test]
    async fn ntfy_cuts_a_long_answer_to_200_characters() {
        let (server, _) = stub(StatusCode::INTERNAL_SERVER_ERROR, "€".repeat(300)).await;
        let to = Target {
            server: server.clone(),
            ..target(None)
        };

        let err = sender().send(&to, &push()).await.unwrap_err();

        assert_eq!(err, format!("{server} answered 500: {}", "€".repeat(200)));
    }

    #[tokio::test]
    async fn ntfy_hides_a_token_that_straddles_the_200_character_cut() {
        let token = "tk_qwertyuiopasdfghjklzxcvbnmqwe";
        let echoed = format!("{}{token}", "x".repeat(190));
        let (server, _) = stub(StatusCode::TOO_MANY_REQUESTS, echoed).await;
        let to = Target {
            server,
            ..target(Some(token))
        };

        let err = sender().send(&to, &push()).await.unwrap_err();

        assert!(!err.contains(&token[..8]), "{err}");
        assert!(err.contains("[token]"), "{err}");
    }

    #[tokio::test]
    async fn ntfy_reports_a_redirect_instead_of_following_it() {
        let app = Router::new()
            .route(
                "/",
                post(|| async {
                    (
                        StatusCode::MOVED_PERMANENTLY,
                        [(header::LOCATION, "/moved")],
                    )
                }),
            )
            .route("/moved", get(|| async { StatusCode::OK }));
        let server = serve(app).await;
        let to = Target {
            server: server.clone(),
            ..target(None)
        };

        let err = sender().send(&to, &push()).await.unwrap_err();

        assert!(err.starts_with(&format!("{server} answered 301")), "{err}");
    }

    #[tokio::test]
    async fn ntfy_reports_an_unreachable_server() {
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let to = Target {
            server: server.clone(),
            ..target(None)
        };

        let err = sender().send(&to, &push()).await.unwrap_err();

        assert!(err.starts_with(&format!("can't reach {server}: ")), "{err}");
        assert!(err.to_lowercase().contains("refused"), "{err}");
        assert!(!err.contains("error sending request"), "{err}");
    }
}

use yardbell::state::StateView;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum AddressError {
    #[error("enter the server address, like 100.1.2.3:4100")]
    Empty,
    #[error("use an http or https address")]
    Scheme,
    #[error("that address isn't valid")]
    Invalid,
    #[error("leave the path off, like http://100.1.2.3:4100")]
    Path,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ClientError {
    #[error("wrong passcode")]
    WrongPasscode,
    #[error("too many tries, try again in 5 minutes")]
    Locked,
    #[error("signed out")]
    SignedOut,
    #[error("can't reach {0}")]
    Unreachable(String),
    #[error("{0}")]
    Other(String),
}

pub fn normalize_address(input: &str) -> Result<String, AddressError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(AddressError::Empty);
    }
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("http://{input}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| AddressError::Invalid)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AddressError::Scheme);
    }
    let host = url.host_str().ok_or(AddressError::Invalid)?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(AddressError::Path);
    }
    Ok(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

const COOKIE_NAME: &str = "yardbell_session";

#[derive(Clone)]
pub struct Client {
    server: String,
    cookie: Option<String>,
    http: reqwest::Client,
}

impl Client {
    pub fn new(server: &str, cookie: Option<&str>) -> Client {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("http client");
        Client {
            server: server.to_string(),
            cookie: cookie.map(str::to_string),
            http,
        }
    }

    pub async fn login(&self, passcode: &str) -> Result<String, ClientError> {
        let response = self
            .send(self.post("/login").form(&[("passcode", passcode)]))
            .await?;
        match response.status() {
            status if status.is_success() => response
                .headers()
                .get_all(reqwest::header::SET_COOKIE)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .find_map(session_cookie)
                .ok_or_else(|| ClientError::Other("the server sent no session".to_string())),
            reqwest::StatusCode::UNAUTHORIZED => Err(ClientError::WrongPasscode),
            reqwest::StatusCode::TOO_MANY_REQUESTS => Err(ClientError::Locked),
            status => Err(unexpected(status)),
        }
    }

    pub async fn state(&self) -> Result<StateView, ClientError> {
        let response = self.send(self.get("/state")).await?;
        self.parse(response).await
    }

    pub async fn handoff(&self) -> Result<String, ClientError> {
        #[derive(serde::Deserialize)]
        struct Handoff {
            code: String,
        }
        let response = self.send(self.post("/app/handoff")).await?;
        Ok(self.parse::<Handoff>(response).await?.code)
    }

    pub fn server(&self) -> &str {
        &self.server
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.with_cookie(self.http.get(format!("{}{path}", self.server)))
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.with_cookie(
            self.http
                .post(format!("{}{path}", self.server))
                .header(reqwest::header::ORIGIN, &self.server),
        )
    }

    fn with_cookie(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.cookie {
            Some(cookie) => {
                request.header(reqwest::header::COOKIE, format!("{COOKIE_NAME}={cookie}"))
            }
            None => request,
        }
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ClientError> {
        request
            .send()
            .await
            .map_err(|_| ClientError::Unreachable(self.server.clone()))
    }

    async fn parse<T: serde::de::DeserializeOwned>(
        &self,
        response: reqwest::Response,
    ) -> Result<T, ClientError> {
        match response.status() {
            reqwest::StatusCode::UNAUTHORIZED => Err(ClientError::SignedOut),
            status if status.is_success() => response.json::<T>().await.map_err(|e| {
                ClientError::Other(format!("unexpected response from the server: {e}"))
            }),
            status => Err(unexpected(status)),
        }
    }
}

fn session_cookie(header: &str) -> Option<String> {
    let pair = header.split(';').next()?.trim();
    let value = pair.strip_prefix(COOKIE_NAME)?.strip_prefix('=')?;
    (!value.is_empty()).then(|| value.to_string())
}

fn unexpected(status: reqwest::StatusCode) -> ClientError {
    ClientError::Other(format!("the server answered {status}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, HeaderMap, StatusCode};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::{json, Value};

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[test]
    fn normalize_address_cases() {
        for input in [
            "100.1.2.3:4100",
            "http://100.1.2.3:4100/",
            "HTTP://100.1.2.3:4100",
            "  100.1.2.3:4100  ",
        ] {
            assert_eq!(normalize_address(input).unwrap(), "http://100.1.2.3:4100");
        }
        assert_eq!(
            normalize_address("https://box.ts.net").unwrap(),
            "https://box.ts.net"
        );
        for input in ["http://h/x", "ftp://h", "", "http://"] {
            assert!(normalize_address(input).is_err(), "{input:?}");
        }
    }

    #[tokio::test]
    async fn login_returns_cookie() {
        let app = Router::new().route(
            "/login",
            post(|headers: HeaderMap, body: String| async move {
                assert!(headers.contains_key(header::ORIGIN));
                assert_eq!(body, "passcode=p%2Fw");
                (
                    StatusCode::OK,
                    [(
                        header::SET_COOKIE,
                        "yardbell_session=ab:c/d+e=; HttpOnly; SameSite=Strict; Path=/; Max-Age=60",
                    )],
                    Json(json!({"ok": true})),
                )
            }),
        );
        let server = serve(app).await;
        let client = Client::new(&server, None);
        assert_eq!(client.login("p/w").await.unwrap(), "ab:c/d+e=");
    }

    #[tokio::test]
    async fn login_without_cookie_is_an_error() {
        let app = Router::new().route("/login", post(|| async { Json(json!({"ok": true})) }));
        let server = serve(app).await;
        assert!(matches!(
            Client::new(&server, None).login("pw").await,
            Err(ClientError::Other(_))
        ));
    }

    #[tokio::test]
    async fn login_errors() {
        let app = Router::new().route(
            "/login",
            post(|body: String| async move {
                if body.contains("locked") {
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        Json(json!({"error": "locked"})),
                    )
                } else {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"error": "wrong passcode"})),
                    )
                }
            }),
        );
        let server = serve(app).await;
        let client = Client::new(&server, None);
        assert_eq!(client.login("no").await, Err(ClientError::WrongPasscode));
        assert_eq!(client.login("locked").await, Err(ClientError::Locked));

        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        assert_eq!(
            Client::new(&dead, None).login("pw").await,
            Err(ClientError::Unreachable(dead.clone()))
        );
    }

    #[tokio::test]
    async fn state_401_is_signed_out() {
        let app = Router::new().route("/state", get(|| async { StatusCode::UNAUTHORIZED }));
        let server = serve(app).await;
        assert_eq!(
            Client::new(&server, None).state().await.err(),
            Some(ClientError::SignedOut)
        );
    }

    #[tokio::test]
    async fn state_parses_view() {
        let app = Router::new().route(
            "/state",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers[header::COOKIE], "yardbell_session=abc");
                Json(json!({
                    "agents": [],
                    "default_agent": "claude",
                    "machines": [],
                    "folders": [],
                    "sessions": [],
                    "ended": [],
                    "host_terminal": "none",
                    "mesh": null
                }))
            }),
        );
        let server = serve(app).await;
        let view = Client::new(&server, Some("abc")).state().await.unwrap();
        assert_eq!(view.default_agent, "claude");
    }

    #[tokio::test]
    async fn handoff_sends_cookie_and_origin() {
        let app = Router::new().route(
            "/app/handoff",
            post(|headers: HeaderMap| async move {
                assert_eq!(headers[header::COOKIE], "yardbell_session=abc");
                let origin = headers[header::ORIGIN].to_str().unwrap().to_string();
                assert_eq!(
                    origin,
                    format!("http://{}", headers[header::HOST].to_str().unwrap())
                );
                Json::<Value>(json!({"code": "x"}))
            }),
        );
        let server = serve(app).await;
        let client = Client::new(&server, Some("abc"));
        assert_eq!(client.handoff().await.unwrap(), "x");
    }
}

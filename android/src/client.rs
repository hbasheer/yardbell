const COOKIE_NAME: &str = "yardbell_session";

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ClientError {
    #[error("wrong passcode")]
    WrongPasscode,
    #[error("too many tries, try again in 5 minutes")]
    Locked,
    #[error("this pairing code is used or expired, show a new one in the server's Settings")]
    BadPairingCode,
    #[error("signed out, pair again or enter the passcode")]
    SignedOut,
    #[error("can't reach {0}. Is this phone on the same mesh VPN?")]
    Unreachable(String),
    #[error("{0}")]
    Other(String),
}

pub fn normalize_address(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("enter the server address, like 100.64.0.10:4000".into());
    }
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("http://{input}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| "that address isn't valid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("use an http or https address".into());
    }
    let host = url.host_str().ok_or("that address isn't valid")?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("leave the path off, like http://100.64.0.10:4000".into());
    }
    Ok(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

#[derive(Debug, PartialEq)]
pub struct Pairing {
    pub server: String,
    pub code: String,
}

pub fn parse_pairing(link: &str) -> Result<Pairing, String> {
    let not_ours = || "that is not a Yardbell pairing code".to_string();
    let url = url::Url::parse(link.trim()).map_err(|_| not_ours())?;
    if url.scheme() != "yardbell" || url.host_str() != Some("pair") {
        return Err(not_ours());
    }
    let get = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    };
    let server = normalize_address(&get("server").ok_or_else(not_ours)?)?;
    let code = get("code").ok_or_else(not_ours)?;
    if code.is_empty() || code.len() > 64 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(not_ours());
    }
    Ok(Pairing { server, code })
}

pub fn handoff_url(server: &str, code: &str) -> String {
    format!("{server}/app/handoff/{code}")
}

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
            s if s.is_success() => session(&response),
            reqwest::StatusCode::UNAUTHORIZED => Err(ClientError::WrongPasscode),
            reqwest::StatusCode::TOO_MANY_REQUESTS => Err(ClientError::Locked),
            s => Err(unexpected(s)),
        }
    }

    pub async fn pair(&self, code: &str) -> Result<String, ClientError> {
        let response = self.send(self.post(&format!("/app/pair/{code}"))).await?;
        match response.status() {
            s if s.is_success() => session(&response),
            reqwest::StatusCode::UNAUTHORIZED => Err(ClientError::BadPairingCode),
            s => Err(unexpected(s)),
        }
    }

    pub async fn handoff(&self) -> Result<String, ClientError> {
        let response = self.send(self.post("/app/handoff")).await?;
        match response.status() {
            s if s.is_success() => {
                let body: serde_json::Value = response
                    .json()
                    .await
                    .map_err(|e| ClientError::Other(e.to_string()))?;
                let code = body["code"]
                    .as_str()
                    .ok_or_else(|| ClientError::Other("the server sent no sign-in code".into()))?;
                Ok(handoff_url(&self.server, code))
            }
            reqwest::StatusCode::UNAUTHORIZED => Err(ClientError::SignedOut),
            s => Err(unexpected(s)),
        }
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        let request = self
            .http
            .post(format!("{}{path}", self.server))
            .header(reqwest::header::ORIGIN, &self.server);
        match &self.cookie {
            Some(c) => request.header(reqwest::header::COOKIE, format!("{COOKIE_NAME}={c}")),
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
}

fn session(response: &reqwest::Response) -> Result<String, ClientError> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| {
            v.split(';')
                .next()?
                .trim()
                .strip_prefix(&format!("{COOKIE_NAME}="))
                .map(str::to_string)
        })
        .ok_or_else(|| ClientError::Other("the server sent no session".into()))
}

fn unexpected(status: reqwest::StatusCode) -> ClientError {
    ClientError::Other(format!("the server answered {status}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_links_are_read_and_checked() {
        assert_eq!(
            parse_pairing("yardbell://pair?server=http%3A%2F%2F100.64.0.10%3A4000&code=Ab12")
                .unwrap(),
            Pairing {
                server: "http://100.64.0.10:4000".into(),
                code: "Ab12".into()
            }
        );
        for bad in [
            "https://example.com/?server=x&code=y",
            "yardbell://other?server=http%3A%2F%2F1.2.3.4&code=y",
            "yardbell://pair?code=abc",
            "yardbell://pair?server=http%3A%2F%2F1.2.3.4&code=../x",
            "yardbell://pair?server=ftp%3A%2F%2F1.2.3.4&code=abc",
        ] {
            assert!(parse_pairing(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn addresses_are_normalized() {
        assert_eq!(
            normalize_address("100.64.0.10:4000").unwrap(),
            "http://100.64.0.10:4000"
        );
        assert_eq!(
            normalize_address(" https://box.ts.net/ ").unwrap(),
            "https://box.ts.net"
        );
        assert!(normalize_address("http://x/path").is_err());
        assert!(normalize_address("").is_err());
    }

    async fn fake_server() -> String {
        use axum::extract::Path;
        use axum::http::{header, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::post;
        let app = axum::Router::new().route(
            "/app/pair/{code}",
            post(|Path(code): Path<String>| async move {
                if code == "good" {
                    (
                        [(
                            header::SET_COOKIE,
                            "yardbell_session=s3cret; Path=/; HttpOnly",
                        )],
                        "{}",
                    )
                        .into_response()
                } else {
                    StatusCode::UNAUTHORIZED.into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn pairing_returns_the_session_or_says_the_code_is_bad() {
        let server = fake_server().await;
        let client = Client::new(&server, None);
        assert_eq!(client.pair("good").await.unwrap(), "s3cret");
        assert_eq!(
            client.pair("bad").await.unwrap_err(),
            ClientError::BadPairingCode
        );
        let gone = Client::new("http://127.0.0.1:1", None);
        assert!(matches!(
            gone.pair("good").await.unwrap_err(),
            ClientError::Unreachable(_)
        ));
    }
}

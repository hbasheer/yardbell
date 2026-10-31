use super::{
    reply_of, tool_of, Challenge, Failure, Tool, ToolReply, PROTOCOLS_KNOWN, PROTOCOL_OFFERED,
    REPLY_MAX, TOOL_PAGES_MAX,
};
use crate::connectors::net::{is_private, PublicOnly};
use reqwest::header::{HeaderMap, ACCEPT, AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::{Method, Response, StatusCode, Url};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const ACCEPTS: &str = "application/json, text/event-stream";
const SNIPPET: usize = 200;
const METHOD_NOT_FOUND: i64 = -32601;

pub struct HttpOptions {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub bearer: Option<String>,
    pub allow_private: bool,
    pub saved: Vec<String>,
    pub timeout: Duration,
}

pub struct HttpClient {
    url: Url,
    options: HttpOptions,
    http: reqwest::Client,
    session: Option<String>,
    version: Option<String>,
    next_id: u64,
}

fn other(text: impl Into<String>) -> Failure {
    Failure::Other(text.into())
}

fn quoted_or_bare(header: &str, name: &str) -> Option<String> {
    let at = header.find(&format!("{name}="))? + name.len() + 1;
    let rest = &header[at..];
    let value = match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next()?,
        None => rest.split([',', ' ']).next()?,
    };
    Some(value.to_string())
}

fn challenge_of(headers: &HeaderMap) -> Challenge {
    let header = headers
        .get(WWW_AUTHENTICATE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    Challenge {
        resource_metadata: quoted_or_bare(header, "resource_metadata"),
        scope: quoted_or_bare(header, "scope"),
    }
}

fn insufficient_scope(headers: &HeaderMap) -> bool {
    headers
        .get(WWW_AUTHENTICATE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| h.contains("insufficient_scope"))
}

fn chain(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(e) = source {
        text = format!("{text}: {e}");
        source = e.source();
    }
    text
}

impl HttpClient {
    pub fn new(options: HttpOptions) -> Result<HttpClient, String> {
        let url = Url::parse(&options.url).map_err(|e| format!("{}: {e}", options.url))?;
        let allowed = url.scheme() == "https" || (url.scheme() == "http" && options.allow_private);
        if !allowed {
            return Err(format!("{} must be an https address", options.url));
        }
        let mut http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        if !options.allow_private {
            http = http.dns_resolver(Arc::new(PublicOnly));
        }
        Ok(HttpClient {
            url,
            http: http.build().map_err(|e| e.to_string())?,
            options,
            session: None,
            version: None,
            next_id: 0,
        })
    }

    fn refuse_literal_private(&self) -> Result<(), Failure> {
        let literal: Option<std::net::IpAddr> = self
            .url
            .host_str()
            .map(|h| h.trim_matches(['[', ']']))
            .and_then(|h| h.parse().ok());
        if !self.options.allow_private && literal.is_some_and(is_private) {
            return Err(other(format!(
                "{} is a private address",
                self.url.host_str().unwrap_or_default()
            )));
        }
        Ok(())
    }

    fn scrub(&self, text: &str) -> String {
        crate::mcp_read::scrubbed(text, &self.options.saved)
    }

    async fn send(&self, method: Method, body: Option<&Value>) -> Result<Response, Failure> {
        self.refuse_literal_private()?;
        let mut req = self
            .http
            .request(method, self.url.clone())
            .header(ACCEPT, ACCEPTS);
        for (k, v) in &self.options.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(token) = &self.options.bearer {
            req = req.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(session) = &self.session {
            req = req.header("MCP-Session-Id", session.as_str());
        }
        if let Some(version) = &self.version {
            req = req.header("MCP-Protocol-Version", version.as_str());
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        req.send().await.map_err(|e| {
            other(self.scrub(&format!(
                "could not reach {}: {}",
                self.url.host_str().unwrap_or_default(),
                chain(&e.without_url())
            )))
        })
    }

    async fn check(&self, res: Response) -> Result<Response, Failure> {
        let status = res.status();
        if status.is_redirection() {
            return Err(other(format!(
                "the server answered a redirect ({}), which Yardbell does not follow",
                status.as_u16()
            )));
        }
        if status == StatusCode::UNAUTHORIZED {
            return Err(Failure::NeedsSignIn(challenge_of(res.headers())));
        }
        if status == StatusCode::FORBIDDEN && insufficient_scope(res.headers()) {
            return Err(Failure::NeedsScope(challenge_of(res.headers())));
        }
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            let said: String = self.scrub(&text).chars().take(SNIPPET).collect();
            return Err(other(format!(
                "the server answered {}: {said}",
                status.as_u16()
            )));
        }
        Ok(res)
    }

    // A server may ask things of its client over the stream. Yardbell offers it nothing to ask.
    async fn refuse(&self, id: &Value) {
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": METHOD_NOT_FOUND, "message": "Yardbell does not accept requests from a server" },
        });
        let _ = self.send(Method::POST, Some(&body)).await;
    }

    async fn read_stream(&self, mut res: Response, id: u64) -> Result<Value, Failure> {
        let mut buffer = String::new();
        let mut total = 0;
        while let Some(chunk) = res.chunk().await.map_err(|e| {
            other(format!(
                "the server stopped answering: {}",
                chain(&e.without_url())
            ))
        })? {
            total += chunk.len();
            if total > REPLY_MAX {
                return Err(other("the server's reply is too large"));
            }
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(end) = buffer.find("\n\n") {
                let event: String = buffer.drain(..end + 2).collect();
                let data: String = event
                    .lines()
                    .filter_map(|l| l.strip_prefix("data:"))
                    .map(str::trim_start)
                    .collect::<Vec<_>>()
                    .join("\n");
                if data.is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(&self.scrub(&data)) else {
                    continue;
                };
                if message.get("method").is_some() {
                    if message.get("id").is_some() {
                        self.refuse(&message["id"]).await;
                    }
                    continue;
                }
                if message["id"] == id {
                    return Ok(message);
                }
            }
        }
        Err(other("the server ended its stream without an answer"))
    }

    async fn read_json(&self, mut res: Response) -> Result<Value, Failure> {
        let mut bytes = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| {
            other(format!(
                "the server stopped answering: {}",
                chain(&e.without_url())
            ))
        })? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > REPLY_MAX {
                return Err(other("the server's reply is too large"));
            }
        }
        let text = self.scrub(&String::from_utf8_lossy(&bytes));
        serde_json::from_str(&text).map_err(|_| other("the server's reply is not JSON"))
    }

    async fn once(&mut self, method: &str, params: &Value) -> Result<(Value, HeaderMap), Failure> {
        self.next_id += 1;
        let id = self.next_id;
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let limit = self.options.timeout;
        let this = &*self;
        let exchange = async move {
            let res = this.send(Method::POST, Some(&body)).await?;
            let res = this.check(res).await?;
            let headers = res.headers().clone();
            let stream = headers
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|t| t.contains("text/event-stream"));
            let message = if stream {
                this.read_stream(res, id).await?
            } else {
                this.read_json(res).await?
            };
            Ok::<_, Failure>((message, headers))
        };
        let (message, headers) = tokio::time::timeout(limit, exchange).await.map_err(|_| {
            other(format!(
                "the server did not answer in time, within {}s",
                limit.as_secs_f32()
            ))
        })??;
        if let Some(error) = message.get("error") {
            let said = error["message"].as_str().unwrap_or("no reason given");
            return Err(other(format!("the server refused {method}: {said}")));
        }
        Ok((message["result"].clone(), headers))
    }

    pub async fn connect(&mut self) -> Result<String, Failure> {
        self.session = None;
        self.version = None;
        let params = json!({
            "protocolVersion": PROTOCOL_OFFERED,
            "capabilities": {},
            "clientInfo": { "name": "yardbell", "version": env!("CARGO_PKG_VERSION") },
        });
        let (result, headers) = self.once("initialize", &params).await?;
        let version = result["protocolVersion"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if !PROTOCOLS_KNOWN.contains(&version.as_str()) {
            return Err(other(format!(
                "the server speaks MCP version {version:?}, which Yardbell does not know"
            )));
        }
        self.session = headers
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        self.version = Some(version.clone());
        let done = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let res = self.send(Method::POST, Some(&done)).await?;
        self.check(res).await?;
        Ok(version)
    }

    fn is_lost_session(&self, failure: &Failure) -> bool {
        self.session.is_some()
            && matches!(failure, Failure::Other(e) if e.starts_with("the server answered 404"))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        match self.once(method, &params).await {
            Err(e) if self.is_lost_session(&e) => {
                self.connect().await?;
                self.once(method, &params).await.map(|(result, _)| result)
            }
            other => other.map(|(result, _)| result),
        }
    }

    pub async fn list_tools(&mut self) -> Result<Vec<Tool>, Failure> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..TOOL_PAGES_MAX {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let result = self.request("tools/list", params).await?;
            tools.extend(
                result["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(tool_of),
            );
            cursor = result["nextCursor"].as_str().map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<ToolReply, Failure> {
        let params = json!({ "name": name, "arguments": arguments });
        self.request("tools/call", params)
            .await
            .map(|r| reply_of(&r))
    }

    pub async fn close(&mut self) {
        if self.session.is_some() {
            let _ = self.send(Method::DELETE, None).await;
        }
        self.session = None;
    }
}

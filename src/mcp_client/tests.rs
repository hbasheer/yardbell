use super::http::{HttpClient, HttpOptions};
use super::{Challenge, Failure};
use axum::body::Bytes;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(crate) type Heard = (String, HeaderMap, Value);
type Reply = Arc<dyn Fn(&Value, usize) -> Option<Response> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Fake {
    pub base: String,
    pub heard: Arc<Mutex<Vec<Heard>>>,
    pub reply: Reply,
}

pub(crate) fn ok(id: &Value, result: Value) -> Response {
    (
        StatusCode::OK,
        axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
    )
        .into_response()
}

fn init(id: &Value, session: bool) -> Response {
    let mut res = ok(
        id,
        json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": { "name": "fake", "version": "1" } }),
    );
    if session {
        res.headers_mut()
            .insert("mcp-session-id", "s1".parse().unwrap());
    }
    res
}

async fn answer(
    axum::extract::State(f): axum::extract::State<Fake>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let count = {
        let mut heard = f.heard.lock().unwrap();
        heard.push((method.to_string(), headers, value.clone()));
        heard.len()
    };
    if let Some(res) = (f.reply)(&value, count) {
        return res;
    }
    if method == Method::DELETE {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    match value["method"].as_str() {
        Some("initialize") => init(&value["id"], true),
        Some("notifications/initialized") => StatusCode::ACCEPTED.into_response(),
        Some("tools/list") => ok(
            &value["id"],
            json!({ "tools": [{ "name": "one", "description": "d", "inputSchema": { "type": "object" }, "annotations": { "readOnlyHint": true } }] }),
        ),
        Some("tools/call") => ok(
            &value["id"],
            json!({ "content": [{ "type": "text", "text": "done" }] }),
        ),
        _ => StatusCode::ACCEPTED.into_response(),
    }
}

pub(crate) async fn fake_with(reply: Reply) -> Fake {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fake {
        base: format!("http://{}/mcp", listener.local_addr().unwrap()),
        heard: Default::default(),
        reply,
    };
    let app = axum::Router::new().fallback(answer).with_state(f.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    f
}

pub(crate) async fn fake() -> Fake {
    fake_with(Arc::new(|_, _| None)).await
}

pub(crate) fn options(url: &str) -> HttpOptions {
    HttpOptions {
        url: url.to_string(),
        headers: vec![],
        bearer: None,
        allow_private: true,
        saved: vec![],
        timeout: Duration::from_secs(5),
    }
}

fn sse(events: &[Value]) -> Response {
    let body: String = events
        .iter()
        .map(|e| format!("event: message\ndata: {e}\n\n"))
        .collect();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/event-stream")],
        body,
    )
        .into_response()
}

#[tokio::test]
async fn the_handshake_comes_first() {
    let f = fake().await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    assert_eq!(c.connect().await.unwrap(), "2025-06-18");
    let reply = c.call_tool("one", json!({ "a": 1 })).await.unwrap();
    assert_eq!(reply.text, "done");
    assert!(!reply.is_error);
    let heard = f.heard.lock().unwrap();
    let methods: Vec<&str> = heard
        .iter()
        .map(|h| h.2["method"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        methods,
        ["initialize", "notifications/initialized", "tools/call"]
    );
    assert_eq!(heard[0].2["params"]["protocolVersion"], "2025-11-25");
    let accept = heard[0].1["accept"].to_str().unwrap();
    assert!(
        accept.contains("application/json") && accept.contains("text/event-stream"),
        "{accept}"
    );
    assert_eq!(heard[2].2["params"]["arguments"]["a"], 1);
}

#[tokio::test]
async fn a_session_id_is_kept_and_the_version_is_sent() {
    let f = fake().await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    c.list_tools().await.unwrap();
    let heard = f.heard.lock().unwrap();
    let last = &heard.last().unwrap().1;
    assert_eq!(last["mcp-session-id"], "s1");
    assert_eq!(last["mcp-protocol-version"], "2025-06-18");
    assert!(heard[0].1.get("mcp-session-id").is_none());
}

#[tokio::test]
async fn an_unknown_version_is_refused() {
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "initialize")
            .then(|| ok(&v["id"], json!({ "protocolVersion": "1999-01-01" })))
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    assert!(matches!(c.connect().await, Err(Failure::Other(e)) if e.contains("1999-01-01")));
}

#[tokio::test]
async fn a_reply_can_be_an_event_stream() {
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "tools/call").then(|| {
            sse(&[
                json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": {} }),
                json!({ "jsonrpc": "2.0", "id": 999, "result": { "content": [] } }),
                json!({ "jsonrpc": "2.0", "id": v["id"], "result": { "content": [{ "type": "text", "text": "streamed" }] } }),
            ])
        })
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    assert_eq!(
        c.call_tool("one", json!({})).await.unwrap().text,
        "streamed"
    );
}

#[tokio::test]
async fn a_404_starts_one_new_session() {
    let f = fake_with(Arc::new(|v, n| {
        (v["method"] == "tools/call" && n == 3).then(|| StatusCode::NOT_FOUND.into_response())
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    assert_eq!(c.call_tool("one", json!({})).await.unwrap().text, "done");
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "tools/call").then(|| StatusCode::NOT_FOUND.into_response())
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    assert!(matches!(
        c.call_tool("one", json!({})).await,
        Err(Failure::Other(_))
    ));
    let calls = f
        .heard
        .lock()
        .unwrap()
        .iter()
        .filter(|h| h.2["method"] == "tools/call")
        .count();
    assert_eq!(calls, 2);
}

fn challenge(status: StatusCode, value: &'static str) -> Reply {
    Arc::new(move |_, _| Some((status, [(header::WWW_AUTHENTICATE, value)]).into_response()))
}

#[tokio::test]
async fn a_401_asks_for_sign_in() {
    for (header, meta, scope) in [
        (
            "Bearer resource_metadata=\"https://x/.well-known/p\", scope=\"a b\"",
            Some("https://x/.well-known/p"),
            Some("a b"),
        ),
        (
            "Bearer resource_metadata=https://x/m",
            Some("https://x/m"),
            None,
        ),
        ("Bearer", None, None),
    ] {
        let f = fake_with(challenge(StatusCode::UNAUTHORIZED, header)).await;
        let mut c = HttpClient::new(options(&f.base)).unwrap();
        assert_eq!(
            c.connect().await.unwrap_err(),
            Failure::NeedsSignIn(Challenge {
                resource_metadata: meta.map(str::to_string),
                scope: scope.map(str::to_string),
            })
        );
    }
}

#[tokio::test]
async fn a_403_names_the_scope() {
    let f = fake_with(challenge(
        StatusCode::FORBIDDEN,
        "Bearer error=\"insufficient_scope\", scope=\"w\"",
    ))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    assert!(
        matches!(c.connect().await, Err(Failure::NeedsScope(ch)) if ch.scope.as_deref() == Some("w"))
    );
    let f = fake_with(Arc::new(|_, _| Some(StatusCode::FORBIDDEN.into_response()))).await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    assert!(matches!(c.connect().await, Err(Failure::Other(e)) if e.contains("403")));
}

#[tokio::test]
async fn a_server_request_is_refused() {
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "tools/call").then(|| {
            sse(&[
                json!({ "jsonrpc": "2.0", "id": "ask", "method": "sampling/createMessage", "params": {} }),
                json!({ "jsonrpc": "2.0", "id": v["id"], "result": { "content": [{ "type": "text", "text": "ok" }] } }),
            ])
        })
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    assert_eq!(c.call_tool("one", json!({})).await.unwrap().text, "ok");
    let heard = f.heard.lock().unwrap();
    let refusal = heard
        .iter()
        .find(|h| h.2["id"] == "ask")
        .expect("a reply to the server");
    assert_eq!(refusal.2["error"]["code"], -32601);
}

#[tokio::test]
async fn tools_follow_their_pages() {
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "tools/list").then(|| {
            ok(
                &v["id"],
                json!({ "tools": [{ "name": "t", "inputSchema": {} }], "nextCursor": "more" }),
            )
        })
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    let tools = c.list_tools().await.unwrap();
    assert_eq!(tools.len(), 20);
    let heard = f.heard.lock().unwrap();
    assert_eq!(heard.last().unwrap().2["params"]["cursor"], "more");
}

#[tokio::test]
async fn a_tool_is_read_whole() {
    let f = fake().await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    let tools = c.list_tools().await.unwrap();
    assert_eq!(
        (
            tools[0].name.as_str(),
            tools[0].description.as_str(),
            tools[0].read_only_hint
        ),
        ("one", "d", true)
    );
    assert_eq!(tools[0].input_schema["type"], "object");
}

#[tokio::test]
async fn is_error_comes_back_as_a_reply() {
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "tools/call").then(|| {
            ok(&v["id"], json!({ "isError": true, "content": [{ "type": "text", "text": "no" }], "structuredContent": { "a": 1 } }))
        })
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    let reply = c.call_tool("one", json!({})).await.unwrap();
    assert!(reply.is_error);
    assert_eq!(reply.text, "no");
    assert_eq!(reply.structured, Some(json!({ "a": 1 })));
}

#[tokio::test]
async fn a_protocol_error_says_why() {
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "tools/call").then(|| {
            (StatusCode::OK, axum::Json(json!({ "jsonrpc": "2.0", "id": v["id"], "error": { "code": -32602, "message": "bad args" } }))).into_response()
        })
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    assert!(
        matches!(c.call_tool("one", json!({})).await, Err(Failure::Other(e)) if e.contains("bad args"))
    );
}

#[tokio::test]
async fn a_hanging_server_hits_the_time_limit() {
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "tools/call").then(|| {
            let stream = futures::stream::pending::<Result<Bytes, std::io::Error>>();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/event-stream")],
                axum::body::Body::from_stream(stream),
            )
                .into_response()
        })
    }))
    .await;
    let mut o = options(&f.base);
    o.timeout = Duration::from_millis(200);
    let mut c = HttpClient::new(o).unwrap();
    c.connect().await.unwrap();
    let out = tokio::time::timeout(Duration::from_secs(3), c.call_tool("one", json!({}))).await;
    assert!(matches!(out, Ok(Err(Failure::Other(e))) if e.contains("did not answer in time")));
}

#[tokio::test]
async fn html_says_it_is_not_json() {
    let f = fake_with(Arc::new(|_, _| {
        Some((StatusCode::OK, "<html>").into_response())
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    assert!(matches!(c.connect().await, Err(Failure::Other(e)) if e.contains("not JSON")));
}

#[tokio::test]
async fn a_reply_over_the_limit_fails() {
    let f = fake_with(Arc::new(|_, _| {
        Some((StatusCode::OK, "x".repeat(super::REPLY_MAX + 1)).into_response())
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    assert!(matches!(c.connect().await, Err(Failure::Other(e)) if e.contains("too large")));
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let f = fake_with(Arc::new(|_, _| {
        Some(
            (
                StatusCode::FOUND,
                [(header::LOCATION, "http://127.0.0.1:1/x")],
            )
                .into_response(),
        )
    }))
    .await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    assert!(matches!(c.connect().await, Err(Failure::Other(e)) if e.contains("redirect")));
    assert_eq!(f.heard.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_private_address_is_refused() {
    for url in ["https://127.0.0.1:9/mcp", "https://localhost:9/mcp"] {
        let mut o = options(url);
        o.allow_private = false;
        let mut c = HttpClient::new(o).unwrap();
        assert!(
            matches!(c.connect().await, Err(Failure::Other(e)) if e.contains("private address")),
            "{url}"
        );
    }
    let mut o = options("http://example.com/mcp");
    o.allow_private = false;
    assert!(HttpClient::new(o).err().unwrap().contains("https"));
}

#[tokio::test]
async fn the_bearer_goes_in_the_header_only() {
    let f = fake().await;
    let mut o = options(&f.base);
    o.bearer = Some("tok-value".into());
    let mut c = HttpClient::new(o).unwrap();
    c.connect().await.unwrap();
    let heard = f.heard.lock().unwrap();
    assert_eq!(heard[0].1["authorization"], "Bearer tok-value");
    assert!(!heard[0].2.to_string().contains("tok-value"));
}

#[tokio::test]
async fn a_secret_in_a_reply_is_scrubbed() {
    let f = fake_with(Arc::new(|v, _| {
        (v["method"] == "tools/call").then(|| {
            ok(
                &v["id"],
                json!({ "content": [{ "type": "text", "text": "tok-value-1" }] }),
            )
        })
    }))
    .await;
    let mut o = options(&f.base);
    o.saved = vec!["tok-value-1".to_string()];
    let mut c = HttpClient::new(o).unwrap();
    c.connect().await.unwrap();
    assert!(!c
        .call_tool("one", json!({}))
        .await
        .unwrap()
        .text
        .contains("tok-value-1"));
}

#[tokio::test]
async fn close_sends_delete() {
    let f = fake().await;
    let mut c = HttpClient::new(options(&f.base)).unwrap();
    c.connect().await.unwrap();
    c.close().await;
    let heard = f.heard.lock().unwrap();
    assert_eq!(heard.last().unwrap().0, "DELETE");
    assert_eq!(heard.last().unwrap().1["mcp-session-id"], "s1");
}

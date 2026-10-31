use super::*;
use crate::mcp_client::oauth_tests::signing_in;

async fn call(
    r: &Rig,
    c: &str,
    method: &str,
    url: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(url)
        .header(header::ORIGIN, "http://localhost")
        .header(header::HOST, "localhost")
        .header(header::ACCEPT, "application/json");
    if !c.is_empty() {
        req = req.header(header::COOKIE, c);
    }
    if body.is_some() {
        req = req.header(header::CONTENT_TYPE, "application/json");
    }
    let req = req
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (status, serde_json::from_str(&text).unwrap_or(json!(text)))
}

fn add_server(r: &Rig, url: &str) {
    let server = crate::config::McpServer {
        name: "tool".into(),
        command: String::new(),
        url: url.into(),
        env: Default::default(),
        headers: Default::default(),
        machines: vec![],
        allow_private: true,
    };
    r.app.settings.set_mcp_servers(vec![server]).unwrap();
}

const ROOT: &str = "/api/settings/mcp/servers/tool";

#[tokio::test]
async fn sign_in_names_the_host_and_stores_nothing_yet() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = signing_in(true).await;
    add_server(&r, &format!("{}/mcp", s.base));
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-in"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["needs_client"], false);
    assert_eq!(out["sign_in_host"], "127.0.0.1");
    let port = r.app.config().unwrap().port;
    let redirect = format!("http://127.0.0.1:{port}/oauth/mcp/callback");
    assert_eq!(out["redirect"], redirect);
    assert!(out["url"].as_str().unwrap().contains("code_challenge="));
    assert!(r
        .app
        .secrets()
        .unwrap()
        .get("mcp_oauth_tool_access")
        .is_none());
    let (_, shown) = call(&r, &c, "GET", "/api/settings", None).await;
    assert_eq!(shown["mcp_auth"]["tool"], "not_signed_in");
}

#[tokio::test]
async fn sign_in_can_need_a_client() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = signing_in(false).await;
    add_server(&r, &format!("{}/mcp", s.base));
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-in"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["needs_client"], true);
    assert!(out["redirect"]
        .as_str()
        .unwrap()
        .ends_with("/oauth/mcp/callback"));
    let body = json!({ "client_id": "mine", "client_secret": "shh-secret-1" });
    let (_, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-in"), Some(body)).await;
    assert_eq!(out["needs_client"], false);
    assert!(out["url"].as_str().unwrap().contains("client_id=mine"));
    assert!(!out.to_string().contains("shh-secret-1"));
}

fn state_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned()
}

#[tokio::test]
async fn the_callback_needs_no_login_and_checks_state() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = signing_in(true).await;
    add_server(&r, &format!("{}/mcp", s.base));
    let (_, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-in"), Some(json!({}))).await;
    let state = state_of(out["url"].as_str().unwrap());
    let (status, _) = call(
        &r,
        "",
        "GET",
        "/oauth/mcp/callback?code=c&state=wrong",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(r
        .app
        .secrets()
        .unwrap()
        .get("mcp_oauth_tool_access")
        .is_none());
    let (status, page) = call(
        &r,
        "",
        "GET",
        &format!("/oauth/mcp/callback?code=c&state={state}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.as_str().unwrap().contains("Signed in to tool"));
    assert!(!page.as_str().unwrap().contains("acc-one"));
    let (_, shown) = call(&r, &c, "GET", "/api/settings", None).await;
    assert_eq!(shown["mcp_auth"]["tool"], "signed_in");
    assert!(!shown.to_string().contains("acc-one"));
}

#[tokio::test]
async fn the_callback_escapes_what_it_shows() {
    let r = rig();
    let (status, page) = call(
        &r,
        "",
        "GET",
        "/oauth/mcp/callback?error=x&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let text = page.as_str().unwrap();
    assert!(!text.contains("<script>"), "{text}");
    assert!(text.contains("&lt;script&gt;"), "{text}");
}

#[tokio::test]
async fn finish_needs_a_login() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = signing_in(true).await;
    add_server(&r, &format!("{}/mcp", s.base));
    let (_, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-in"), Some(json!({}))).await;
    let state = state_of(out["url"].as_str().unwrap());
    let address = format!("http://127.0.0.1:4000/oauth/mcp/callback?code=c&state={state}");
    let path = format!("{ROOT}/finish");
    let path = path.as_str();
    let (status, _) = call(&r, "", "POST", path, Some(json!({ "address": address }))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, out) = call(&r, &c, "POST", path, Some(json!({ "address": address }))).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["server"], "tool");
}

#[tokio::test]
async fn sign_out_needs_a_login() {
    let r = rig();
    let s = signing_in(true).await;
    add_server(&r, &format!("{}/mcp", s.base));
    let (status, _) = call(&r, "", "POST", &format!("{ROOT}/sign-out"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let c = cookie(&r.app).await;
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-out"), None).await;
    assert_eq!(status, StatusCode::OK, "{out}");
}

#[tokio::test]
async fn only_the_callback_is_exempt() {
    let r = rig();
    let (status, _) = call(&r, "", "GET", "/oauth/mcp/other", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&r, "", "POST", "/oauth/mcp/callback", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_lists_tools_and_calls_none() {
    let r = rig();
    let c = cookie(&r.app).await;
    let f = crate::mcp_client::tests::fake().await;
    add_server(&r, &f.base);
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/test"), None).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["version"], "2025-06-18");
    assert_eq!(out["tools"][0]["name"], "one");
    assert!(f
        .heard
        .lock()
        .unwrap()
        .iter()
        .all(|h| h.2["method"] != "tools/call"));
}

#[tokio::test]
async fn test_says_when_a_sign_in_is_needed() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = signing_in(true).await;
    add_server(&r, &format!("{}/mcp", s.base));
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/test"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(out["error"].as_str().unwrap().contains("Sign in"), "{out}");
}

#[tokio::test]
async fn a_changed_address_loses_the_sign_in() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = signing_in(true).await;
    let url = format!("{}/mcp", s.base);
    add_server(&r, &url);
    let (_, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-in"), Some(json!({}))).await;
    let state = state_of(out["url"].as_str().unwrap());
    call(
        &r,
        "",
        "GET",
        &format!("/oauth/mcp/callback?code=c&state={state}"),
        None,
    )
    .await;
    let elsewhere = json!({ "servers": [{ "name": "tool", "url": "https://other.example/mcp" }] });
    let (status, _) = call(&r, &c, "POST", "/api/settings/mcp/servers", Some(elsewhere)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(r
        .app
        .secrets()
        .unwrap()
        .get("mcp_oauth_tool_access")
        .is_none());
    let (_, shown) = call(&r, &c, "GET", "/api/settings", None).await;
    assert_eq!(shown["mcp_auth"]["tool"], "not_signed_in");
}

#[tokio::test]
async fn a_token_never_goes_to_another_address() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = signing_in(true).await;
    add_server(&r, &format!("{}/mcp", s.base));
    let (_, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-in"), Some(json!({}))).await;
    let state = state_of(out["url"].as_str().unwrap());
    call(
        &r,
        "",
        "GET",
        &format!("/oauth/mcp/callback?code=c&state={state}"),
        None,
    )
    .await;
    let f = crate::mcp_client::tests::fake().await;
    add_server(&r, &f.base);
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/test"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{out}");
    assert!(out["error"].as_str().unwrap().contains("Sign in"), "{out}");
    assert!(f.heard.lock().unwrap().is_empty());
}

#[tokio::test]
async fn removing_a_server_forgets_its_sign_in() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = signing_in(true).await;
    add_server(&r, &format!("{}/mcp", s.base));
    let (_, out) = call(&r, &c, "POST", &format!("{ROOT}/sign-in"), Some(json!({}))).await;
    let state = state_of(out["url"].as_str().unwrap());
    call(
        &r,
        "",
        "GET",
        &format!("/oauth/mcp/callback?code=c&state={state}"),
        None,
    )
    .await;
    assert!(r
        .app
        .secrets()
        .unwrap()
        .get("mcp_oauth_tool_access")
        .is_some());
    let (status, _) = call(
        &r,
        &c,
        "POST",
        "/api/settings/mcp/servers",
        Some(json!({ "servers": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(r
        .app
        .secrets()
        .unwrap()
        .get("mcp_oauth_tool_access")
        .is_none());
}

#[tokio::test]
async fn own_server_is_refused_by_its_token() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (_, made) = call(&r, &c, "POST", "/api/settings/mcp/on", None).await;
    let token = made["token"].as_str().expect("a token").to_string();
    let server = json!([{ "name": "self", "url": "https://elsewhere.example/mcp", "headers": { "Authorization": format!("Bearer {token}") } }]);
    let (status, out) = call(
        &r,
        &c,
        "POST",
        "/api/settings/mcp/servers",
        Some(json!({ "servers": server })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{out}");
    assert!(!out.to_string().contains(&token));
}

#[tokio::test]
async fn test_refuses_the_own_server() {
    let r = rig();
    let c = cookie(&r.app).await;
    let port = r.app.config().unwrap().port;
    add_server(&r, &format!("http://127.0.0.1:{port}/mcp"));
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/test"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        out["error"].as_str().unwrap().contains("Yardbell itself"),
        "{out}"
    );
}

#[tokio::test]
async fn own_server_is_refused() {
    let r = rig();
    let c = cookie(&r.app).await;
    let cfg = r.app.config().unwrap();
    for host in ["127.0.0.1", "localhost", "[::1]"] {
        let url = format!("http://{host}:{}/mcp", cfg.port);
        assert!(crate::mcp_client::is_own_server(&url, &cfg), "{url}");
        let server = json!([{ "name": "self", "url": url }]);
        let (status, out) = call(
            &r,
            &c,
            "POST",
            "/api/settings/mcp/servers",
            Some(json!({ "servers": server })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{out}");
        assert!(
            out["error"].as_str().unwrap().contains("Yardbell itself"),
            "{out}"
        );
    }
    assert!(!crate::mcp_client::is_own_server(
        "https://mcp.trello.com/v1",
        &cfg
    ));
    assert!(!crate::mcp_client::is_own_server(
        &format!("http://127.0.0.1:{}/mcp", cfg.port + 1),
        &cfg
    ));
}

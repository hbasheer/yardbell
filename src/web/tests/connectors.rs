use super::*;
use crate::connectors::tests::stub;

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
        .header(header::COOKIE, c);
    if body.is_some() {
        req = req.header(header::CONTENT_TYPE, "application/json");
    }
    let req = req
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (status, serde_json::from_str(&text).unwrap_or(json!(text)))
}

const ROOT: &str = "/api/settings/connectors";

fn entry(base: &str) -> serde_json::Value {
    json!({
        "id": "t",
        "name": "Tool",
        "enabled": true,
        "base_url": base,
        "allow_private": true,
        "headers": {},
        "params_yaml": "",
        "calls_yaml": "list:\n  request: { method: GET, path: /l }\n  map: { item_id: id, title: name }\n",
    })
}

#[tokio::test]
async fn connectors_save_and_refuse_a_literal_token() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut bad = entry("https://x.example");
    bad["headers"] = json!({ "Authorization": "Bearer abc123" });
    let (status, body) = call(&r, &c, "POST", ROOT, Some(bad)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("${secret:NAME}"),
        "{body}"
    );
    assert!(!std::fs::read_to_string(&r.app.cfg_path)
        .unwrap()
        .contains("abc123"));

    let (status, body) = call(&r, &c, "POST", ROOT, Some(entry("https://x.example"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, list) = call(&r, &c, "GET", ROOT, None).await;
    assert_eq!(list["list"][0]["id"], "t");
    assert_eq!(list["list"][0]["host"], "x.example");
    assert!(list["list"][0]["calls_yaml"]
        .as_str()
        .unwrap()
        .contains("/l"));
    assert_eq!(list["templates"], json!(["trello"]));

    let (status, _) = call(&r, &c, "DELETE", &format!("{ROOT}/t"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = call(&r, &c, "GET", ROOT, None).await;
    assert_eq!(list["list"], json!([]));
    let (status, _) = call(&r, &c, "DELETE", &format!("{ROOT}/t"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn broken_calls_say_why() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut bad = entry("https://x.example");
    bad["calls_yaml"] = json!("list: [not, a, call");
    let (status, body) = call(&r, &c, "POST", ROOT, Some(bad)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("calls"), "{body}");
}

#[tokio::test]
async fn a_missing_secret_is_named_in_the_list() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut e = entry("https://x.example");
    e["headers"] = json!({ "Authorization": "Bearer ${secret:tool_token}" });
    call(&r, &c, "POST", ROOT, Some(e)).await;
    let (_, list) = call(&r, &c, "GET", ROOT, None).await;
    assert_eq!(list["list"][0]["missing"], json!(["tool_token"]));
}

#[tokio::test]
async fn test_lists_paths_and_items() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = stub().await;
    s.answer("/l", 200, r#"[{"id":"1","name":"One","extra":{"deep":2}}]"#);
    call(&r, &c, "POST", ROOT, Some(entry(&s.base))).await;
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/t/test"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["items"][0]["title"], "One");
    assert!(
        out["paths"]
            .as_array()
            .unwrap()
            .contains(&json!("extra.deep")),
        "{out}"
    );
    let (_, list) = call(&r, &c, "GET", ROOT, None).await;
    assert_eq!(list["status"]["t"]["ok"], true);
}

#[tokio::test]
async fn test_changes_nothing() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = stub().await;
    let mut e = entry(&s.base);
    e["calls_yaml"] = json!(
        "list:\n  request: { method: POST, path: /l }\n  map: { item_id: id, title: name }\n"
    );
    call(&r, &c, "POST", ROOT, Some(e)).await;
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/t/test"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{out}");
    assert!(
        out["error"].as_str().unwrap().contains("kind: lookup"),
        "{out}"
    );
    assert!(s.urls().is_empty());
}

#[tokio::test]
async fn share_holds_references_but_no_values() {
    let r = rig();
    let c = cookie(&r.app).await;
    std::fs::write(
        r.app.cfg_path.with_file_name("secrets.yml"),
        "tool_token: sekret-value\n",
    )
    .unwrap();
    let mut e = entry("https://x.example");
    e["headers"] = json!({ "Authorization": "Bearer ${secret:tool_token}" });
    call(&r, &c, "POST", ROOT, Some(e)).await;
    let (status, out) = call(&r, &c, "GET", &format!("{ROOT}/t/share"), None).await;
    assert_eq!(status, StatusCode::OK);
    let text = out["text"].as_str().unwrap();
    assert!(text.contains("${secret:tool_token}"), "{text}");
    assert!(!text.contains("sekret-value"), "{text}");
    assert!(!text.contains("allow_private"), "{text}");
}

#[tokio::test]
async fn import_arrives_off_and_private_off() {
    let r = rig();
    let c = cookie(&r.app).await;
    let text = "id: tool\nname: Tool\nenabled: true\nallow_private: true\nbase_url: https://x.example\nheaders:\n  Authorization: 'Bearer ${secret:tool_token}'\ncalls: {}\n";
    let (status, out) = call(
        &r,
        &c,
        "POST",
        &format!("{ROOT}/import"),
        Some(json!({ "text": text })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["host"], "x.example");
    assert_eq!(out["secrets"], json!(["tool_token"]));
    let cfg = r.app.config().unwrap();
    assert!(!cfg.connectors[0].enabled);
    assert!(!cfg.connectors[0].allow_private);
    let (_, again) = call(
        &r,
        &c,
        "POST",
        &format!("{ROOT}/import"),
        Some(json!({ "text": text })),
    )
    .await;
    assert_eq!(again["id"], "tool-2", "{again}");
    let (status, out) = call(
        &r,
        &c,
        "POST",
        &format!("{ROOT}/import"),
        Some(json!({ "text": "not: [yaml" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{out}");
}

#[tokio::test]
async fn read_settings_shows_connectors_without_secrets() {
    let r = rig();
    let c = cookie(&r.app).await;
    std::fs::write(
        r.app.cfg_path.with_file_name("secrets.yml"),
        "tool_token: sekret-value\n",
    )
    .unwrap();
    let mut e = entry("https://x.example");
    e["headers"] = json!({ "Authorization": "Bearer ${secret:tool_token}" });
    call(&r, &c, "POST", ROOT, Some(e)).await;
    let cfg = r.app.config().unwrap();
    let shown = crate::mcp_read::shown_area(&r.app, &cfg, "connectors");
    assert_eq!(shown[0]["id"], "t");
    assert!(
        shown.to_string().contains("${secret:tool_token}"),
        "{shown}"
    );
    assert!(!shown.to_string().contains("sekret-value"));
}

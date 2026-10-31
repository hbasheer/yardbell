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

fn tool(base: &str) -> serde_json::Value {
    let mut e = entry(base);
    e["params_yaml"] = json!("- { name: board, label: Board, options: boards }\n");
    e["calls_yaml"] = json!("boards:\n  request: { method: GET, path: /boards }\n  map: { id: id, name: title }\nstates:\n  request: { method: GET, path: '/boards/{{board}}/lists' }\n  items: rows\n  map: { id: id, name: name }\nlist:\n  request: { method: GET, path: /l }\n  map: { item_id: id, title: name }\nmove:\n  kind: change\n  request: { method: PUT, path: '/c/{{item_id}}', query: { to: '{{value}}' } }\n");
    e
}

#[tokio::test]
async fn options_refuse_a_change_call() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = stub().await;
    s.answer(
        "/boards/B/lists",
        200,
        r#"{"rows":[{"id":"L1","name":"Todo","extra":1}]}"#,
    );
    s.answer("/boards", 200, r#"[{"id":"B","title":"Main"}]"#);
    call(&r, &c, "POST", ROOT, Some(tool(&s.base))).await;
    let (status, out) = call(&r, &c, "GET", &format!("{ROOT}/t/options/move"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{out}");
    let (status, out) = call(&r, &c, "GET", &format!("{ROOT}/t/options/list"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "only option calls: {out}");
    assert!(!s.urls().iter().any(|u| u.starts_with("/c/")));
    let (status, out) = call(
        &r,
        &c,
        "GET",
        &format!("{ROOT}/t/options/states?board=B"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out, json!([{ "id": "L1", "name": "Todo" }]));
    let (_, out) = call(&r, &c, "GET", &format!("{ROOT}/t/options/boards"), None).await;
    assert_eq!(out, json!([{ "id": "B", "name": "Main" }]));
    let (status, _) = call(&r, &c, "GET", &format!("{ROOT}/t/options/states"), None).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a value the path needs is missing"
    );
}

#[tokio::test]
async fn pipelines_list_names_connectors() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut e = tool("https://x.example");
    e["headers"] = json!({ "Authorization": "Bearer ${secret:tool_token}" });
    call(&r, &c, "POST", ROOT, Some(e)).await;
    let (_, out) = call(&r, &c, "GET", "/api/pipelines", None).await;
    let tool = &out["connectors"][0];
    assert_eq!(
        (tool["id"].as_str(), tool["name"].as_str()),
        (Some("t"), Some("Tool"))
    );
    assert_eq!(tool["params"][0]["options"], "boards");
    let calls = tool["calls"].as_array().unwrap();
    let moved = calls.iter().find(|c| c["name"] == "move").unwrap();
    assert_eq!(moved["kind"], "change");
    assert_eq!(moved["needs"], json!(["value"]));
    assert!(
        !out["connectors"].to_string().contains("tool_token"),
        "{out}"
    );
}

async fn approve_last(r: &Rig, c: &str, id: &str) -> (StatusCode, serde_json::Value) {
    let step = r.app.dispatch.pending(id)[0].clone();
    let url = format!("/dispatch/conversations/{id}/actions/{step}");
    call(r, c, "POST", &url, Some(json!({ "decision": "approve" }))).await
}

fn proposed(id: &str) -> serde_json::Value {
    json!({ "connector": {
        "id": id,
        "name": "Jira",
        "base_url": "https://jira.example.com",
        "headers": { "Authorization": "Bearer ${secret:jira}" },
        "calls": { "list": { "request": { "method": "GET", "path": "/l" }, "map": { "item_id": "id", "title": "name" } } },
    } })
}

fn result_text(result: &serde_json::Value) -> String {
    result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn save_connector_always_waits() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let result = dispatch_tool(&r, Some(&id), "save_connector", proposed("jira")).await;
    assert_eq!(result["isError"], false, "{result}");
    assert!(
        r.app.config().unwrap().connectors.is_empty(),
        "nothing saved yet"
    );
    let (status, body) = approve_last(&r, &c, &id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let saved = r.app.config().unwrap().connectors;
    assert_eq!(saved[0].id, "jira");
    assert!(!saved[0].enabled, "a new one arrives switched off");
}

#[tokio::test]
async fn save_connector_refuses_a_credential_and_allow_private() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let mut literal = proposed("jira");
    literal["connector"]["headers"]["Authorization"] = json!("Bearer abc123");
    let result = dispatch_tool(&r, Some(&id), "save_connector", literal).await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(result_text(&result).contains("Authorization"), "{result}");
    assert!(!result.to_string().contains("abc123"), "{result}");
    let mut private = proposed("jira");
    private["connector"]["allow_private"] = json!(true);
    let result = dispatch_tool(&r, Some(&id), "save_connector", private).await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        result_text(&result).contains("allow_private can only be set in Settings"),
        "{result}"
    );
}

#[tokio::test]
async fn a_saved_connector_loses_private_reach_when_its_host_changes() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut e = entry("https://mesh.example");
    e["id"] = json!("jira");
    call(&r, &c, "POST", ROOT, Some(e)).await;
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let mut same = proposed("jira");
    same["connector"]["base_url"] = json!("https://mesh.example/2");
    dispatch_tool(&r, Some(&id), "save_connector", same).await;
    approve_last(&r, &c, &id).await;
    let kept = r.app.config().unwrap().connectors;
    assert!(
        kept[0].allow_private && kept[0].enabled,
        "the person's choices stay"
    );
    dispatch_tool(&r, Some(&id), "save_connector", proposed("jira")).await;
    approve_last(&r, &c, &id).await;
    assert!(
        !r.app.config().unwrap().connectors[0].allow_private,
        "a new host loses it"
    );
}

#[tokio::test]
async fn change_settings_cannot_reach_connectors() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let args = json!({ "area": "connectors", "value": [] });
    let result = dispatch_tool(&r, Some(&id), "change_settings", args).await;
    assert_eq!(result["isError"], true, "{result}");
}

#[tokio::test]
async fn a_pipeline_run_turn_cannot_save_a_connector() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let def = {
        let cfg = r.app.config().unwrap();
        r.app
            .pipelines
            .library()
            .copy_template("Review my merge requests", &cfg)
            .unwrap()
    };
    let mut run = r
        .app
        .pipelines
        .start(&def.id, vec![Default::default()], "you")
        .unwrap()
        .remove(0);
    run.conversation = id.clone();
    r.app.pipelines.put(run);
    let result = dispatch_tool(&r, Some(&id), "save_connector", proposed("jira")).await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(result_text(&result).contains("cannot change"), "{result}");
}

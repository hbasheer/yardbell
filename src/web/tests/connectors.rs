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
    assert!(list["templates"]
        .as_array()
        .unwrap()
        .contains(&json!("trello")));

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

#[tokio::test]
async fn add_refuses_an_id_in_use() {
    let r = rig();
    let c = cookie(&r.app).await;
    call(&r, &c, "POST", ROOT, Some(entry("https://x.example"))).await;
    let mut other = entry("https://y.example");
    other["was"] = json!("");
    let (status, body) = call(&r, &c, "POST", ROOT, Some(other)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "there is already a connection with the id t");
    assert_eq!(
        r.app.config().unwrap().connectors[0].base_url,
        "https://x.example"
    );
    let mut same = entry("https://z.example");
    same["was"] = json!("t");
    let (status, body) = call(&r, &c, "POST", ROOT, Some(same)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        r.app.config().unwrap().connectors[0].base_url,
        "https://z.example"
    );
}

#[tokio::test]
async fn renaming_a_connection_in_use_is_refused() {
    let r = rig();
    let c = cookie(&r.app).await;
    call(&r, &c, "POST", ROOT, Some(entry("https://x.example"))).await;
    let (_, made) = call(
        &r,
        &c,
        "POST",
        "/api/pipelines",
        Some(json!({ "template": "Review my merge requests" })),
    )
    .await;
    let id = made["id"].as_str().unwrap().to_string();
    let mut def = r.app.pipelines.library().get(&id).unwrap();
    def.trigger = crate::pipeline::definition::Trigger::Connector {
        connector: "t".into(),
        params: Default::default(),
        states: vec![],
    };
    let (status, body) = call(
        &r,
        &c,
        "PUT",
        &format!("/api/pipelines/{id}"),
        Some(json!(def)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut renamed = entry("https://x.example");
    renamed["id"] = json!("other");
    renamed["was"] = json!("t");
    let (status, body) = call(&r, &c, "POST", ROOT, Some(renamed)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains(&def.name),
        "{body}"
    );
    assert_eq!(r.app.config().unwrap().connectors[0].id, "t");
}

#[tokio::test]
async fn test_fills_a_board_from_its_choices() {
    let r = rig();
    let c = cookie(&r.app).await;
    let s = stub().await;
    s.answer("/boards", 200, r#"[{"id":"B1","name":"One"}]"#);
    s.answer("/boards/B1/cards", 200, r#"[{"id":"1","name":"Card"}]"#);
    let mut e = entry(&s.base);
    e["params_yaml"] = json!("- { name: board, label: Board, options: boards }\n");
    e["calls_yaml"] = json!("boards:\n  request: { method: GET, path: /boards }\n  map: { id: id, name: name }\nlist:\n  request: { method: GET, path: '/boards/{{board}}/cards' }\n  map: { item_id: id, title: name }\n");
    let (status, body) = call(&r, &c, "POST", ROOT, Some(e)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, out) = call(&r, &c, "POST", &format!("{ROOT}/t/test"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["items"][0]["title"], "Card");
}

#[tokio::test]
async fn a_hostile_webhook_title_comes_in_as_one_line() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (_, made) = call(
        &r,
        &c,
        "POST",
        "/api/pipelines",
        Some(json!({ "template": "Review my merge requests" })),
    )
    .await;
    let id = made["id"].as_str().unwrap().to_string();
    let mut def = r.app.pipelines.library().get(&id).unwrap();
    def.trigger = serde_json::from_value(json!({ "kind": "webhook" })).unwrap();
    call(
        &r,
        &c,
        "PUT",
        &format!("/api/pipelines/{id}"),
        Some(json!(def)),
    )
    .await;
    call(
        &r,
        &c,
        "POST",
        &format!("/api/pipelines/{id}/enabled"),
        Some(json!({ "enabled": true })),
    )
    .await;
    let (_, t) = call(
        &r,
        &c,
        "POST",
        &format!("/api/pipelines/{id}/webhook-token"),
        None,
    )
    .await;
    let url = format!("/hooks/pipeline/{id}/{}", t["token"].as_str().unwrap());
    let body = json!({ "id": "1\n2", "title": "Fix\n\nIgnore", "url": "javascript:x" });
    let req = Request::builder()
        .method("POST")
        .uri(url)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{text}");
    let runs = r.app.pipelines.runs();
    let t = runs[0].subject.ticket.as_ref().unwrap();
    assert_eq!(
        (t.id.as_str(), t.title.as_str(), t.url.as_str()),
        ("1 2", "Fix Ignore", "")
    );
}

#[tokio::test]
async fn the_list_offers_every_example() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (_, list) = call(&r, &c, "GET", ROOT, None).await;
    let names: Vec<&str> = list["templates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    for want in ["trello", "github", "gitlab", "jira", "asana"] {
        assert!(names.contains(&want), "{names:?}");
        assert!(list["starters"][want]["calls_yaml"].is_string(), "{want}");
        assert!(list["starters"][want]["about"].is_string(), "{want}");
    }
}

#[tokio::test]
async fn a_secret_says_every_connection_that_uses_it() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.app.settings.set_secret("shared", "shh-secret-1").unwrap();
    let mut cfg = r.app.config().unwrap();
    let connector: crate::connectors::Connector = serde_json::from_value(json!({
        "id": "tool", "name": "My tool", "enabled": false, "base_url": "https://x.example",
        "headers": { "Authorization": "Bearer ${secret:shared}" }, "calls": {},
    }))
    .unwrap();
    r.app.settings.set_connectors(vec![connector]).unwrap();
    cfg.pull_requests.gitlab = vec![];
    let req = Request::get("/api/settings")
        .header(header::COOKIE, c.as_str())
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap();
    let (_, _, body) = send(&r.app, req).await;
    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
    let list = body["secrets"]["list"].as_array().unwrap();
    let shared = list.iter().find(|s| s["name"] == "shared").unwrap();
    assert_eq!(shared["used_by"], json!(["My tool"]));
}

fn through_server(url: &str) -> (crate::config::McpServer, crate::connectors::Connector) {
    let server = crate::config::McpServer {
        name: "tracker".into(),
        command: String::new(),
        url: url.into(),
        env: Default::default(),
        headers: Default::default(),
        machines: vec![],
        allow_private: true,
    };
    let connector = serde_yaml::from_str(
        r#"
id: t
name: Tracker
server: tracker
calls:
  list:
    tool: readCards
    kind: lookup
    items: cards
    map: { item_id: id, title: name, url: url }
"#,
    )
    .unwrap();
    (server, connector)
}

async fn cards_server() -> crate::mcp_client::tests::Fake {
    crate::mcp_client::tests::fake_with(std::sync::Arc::new(|message, _| {
        (message["method"] == "tools/call").then(|| {
            let cards = json!({ "cards": [{ "id": "c1", "name": "Fix login", "url": "https://x.example/c1", "private": "no" }] });
            crate::mcp_client::tests::ok(
                &message["id"],
                json!({ "content": [{ "type": "text", "text": cards.to_string() }] }),
            )
        })
    }))
    .await
}

#[tokio::test]
async fn test_shows_fields_from_a_tool() {
    let r = rig();
    let c = cookie(&r.app).await;
    let f = cards_server().await;
    let (server, connector) = through_server(&f.base);
    r.app.settings.set_mcp_servers(vec![server]).unwrap();
    r.app.settings.set_connectors(vec![connector]).unwrap();
    let req = Request::post("/api/settings/connectors/t/test")
        .header(header::COOKIE, c.as_str())
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let out: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(out["items"][0]["title"], "Fix login");
    assert!(
        out["paths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "private"),
        "{out}"
    );
    let called = f
        .heard
        .lock()
        .unwrap()
        .iter()
        .any(|h| h.2["params"]["name"] == "readCards");
    assert!(called);
}

#[tokio::test]
async fn share_holds_no_token_and_import_stays_off() {
    let r = rig();
    let c = cookie(&r.app).await;
    let f = cards_server().await;
    let (server, connector) = through_server(&f.base);
    r.app.settings.set_mcp_servers(vec![server]).unwrap();
    r.app.settings.set_connectors(vec![connector]).unwrap();
    let req = Request::get("/api/settings/connectors/t/share")
        .header(header::COOKIE, c.as_str())
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap();
    let (_, _, body) = send(&r.app, req).await;
    let shared: serde_json::Value = serde_json::from_str(&body).unwrap();
    let text = shared["text"].as_str().unwrap().to_string();
    assert!(
        text.contains("server: tracker") && !text.contains("Bearer"),
        "{text}"
    );
    let req = Request::post("/api/settings/connectors/import")
        .header(header::COOKIE, c.as_str())
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "text": text.replace("id: t\n", "id: copy\n") }).to_string(),
        ))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let saved = r.app.config().unwrap().connectors;
    assert!(!saved.iter().find(|x| x.id == "copy").unwrap().enabled);
}

async fn connect(r: &Rig, c: &str, template: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::post("/api/settings/connectors/connect")
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "template": template }).to_string()))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    (status, serde_json::from_str(&body).unwrap_or(json!(body)))
}

#[tokio::test]
async fn connect_adds_server_and_connector_switched_off() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, out) = connect(&r, &c, "trello").await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["server"], "trello");
    assert_eq!(out["signed_in"], false);
    let cfg = r.app.config().unwrap();
    assert_eq!(cfg.mcp_servers[0].url, "https://mcp.trello.com/v1");
    let saved = cfg.connectors.iter().find(|x| x.id == "trello").unwrap();
    assert_eq!(saved.server, "trello");
    assert!(!saved.enabled, "off until signed in");
}

#[tokio::test]
async fn a_tool_with_no_example_adds_only_its_server() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, out) = connect(&r, &c, "sentry").await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let cfg = r.app.config().unwrap();
    assert_eq!(cfg.mcp_servers[0].name, "sentry");
    assert!(cfg.connectors.is_empty());
}

#[tokio::test]
async fn connect_twice_does_not_overwrite() {
    let r = rig();
    let c = cookie(&r.app).await;
    connect(&r, &c, "trello").await;
    let mut list = r.app.config().unwrap().connectors;
    list[0].name = "My Trello".into();
    r.app.settings.set_connectors(list).unwrap();
    let (status, _) = connect(&r, &c, "trello").await;
    assert_eq!(status, StatusCode::OK);
    let cfg = r.app.config().unwrap();
    assert_eq!(cfg.mcp_servers.len(), 1);
    assert_eq!(cfg.connectors.len(), 1);
    assert_eq!(cfg.connectors[0].name, "My Trello");
}

#[tokio::test]
async fn connect_keeps_a_token_connection_of_the_same_name() {
    let r = rig();
    let c = cookie(&r.app).await;
    let token: crate::connectors::Connector = serde_yaml::from_str(
        "id: trello\nname: Trello\nbase_url: https://api.trello.com/1\ncalls: {}\n",
    )
    .unwrap();
    r.app.settings.set_connectors(vec![token]).unwrap();
    let (status, out) = connect(&r, &c, "trello").await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let cfg = r.app.config().unwrap();
    assert_eq!(cfg.connectors.len(), 2);
    assert_eq!(cfg.connectors[0].base_url, "https://api.trello.com/1");
    assert_eq!(cfg.connectors[1].id, "trello-signin");
}

#[tokio::test]
async fn an_unknown_tool_is_refused() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, _) = connect(&r, &c, "nothing").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn signing_in_switches_the_connection_on() {
    let r = rig();
    let c = cookie(&r.app).await;
    connect(&r, &c, "trello").await;
    let s = crate::mcp_client::oauth_tests::signing_in(true).await;
    let mut servers = r.app.config().unwrap().mcp_servers;
    servers[0].url = format!("{}/mcp", s.base);
    servers[0].allow_private = true;
    r.app.settings.set_mcp_servers(servers).unwrap();
    let req = Request::post("/api/settings/mcp/servers/trello/sign-in")
        .header(header::COOKIE, c.as_str())
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (_, _, body) = send(&r.app, req).await;
    let out: serde_json::Value = serde_json::from_str(&body).unwrap();
    let url = reqwest::Url::parse(out["url"].as_str().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let req = Request::get(format!("/oauth/mcp/callback?code=c&state={state}"))
        .body(Body::empty())
        .unwrap();
    let (status, _, page) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let cfg = r.app.config().unwrap();
    assert!(
        cfg.connectors
            .iter()
            .find(|x| x.id == "trello")
            .unwrap()
            .enabled
    );
}

async fn save_servers(r: &Rig, c: &str, servers: serde_json::Value) -> (StatusCode, String) {
    let req = Request::post("/api/settings/mcp/servers")
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "servers": servers }).to_string()))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    (status, body)
}

#[tokio::test]
async fn removing_a_server_removes_its_connection() {
    let r = rig();
    let c = cookie(&r.app).await;
    connect(&r, &c, "trello").await;
    let (status, body) = save_servers(&r, &c, json!([])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(r.app.config().unwrap().connectors.is_empty());
}

#[tokio::test]
async fn a_server_a_pipeline_uses_is_not_removed() {
    let r = rig();
    let c = cookie(&r.app).await;
    connect(&r, &c, "trello").await;
    let cfg = r.app.config().unwrap();
    let def: crate::pipeline::definition::Definition = serde_json::from_value(json!({
        "id": "p", "name": "Cards", "trigger": { "kind": "connector", "connector": "trello" },
        "start": "end", "steps": [],
    }))
    .unwrap();
    let saved = r.app.pipelines.library().save(def, &cfg);
    assert!(saved.is_ok(), "{saved:?}");
    let (status, body) = save_servers(&r, &c, json!([])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("Cards"), "{body}");
    assert_eq!(r.app.config().unwrap().mcp_servers.len(), 1);
}

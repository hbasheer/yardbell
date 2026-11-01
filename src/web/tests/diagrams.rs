use super::*;
use crate::shell::Output;

async fn get(r: &Rig, c: &str, url: &str) -> (StatusCode, axum::http::HeaderMap, String) {
    let req = Request::get(url)
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    send(&r.app, req).await
}

async fn post(r: &Rig, c: &str, url: &str, body: serde_json::Value) -> (StatusCode, String) {
    let req = Request::post(url)
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (status, text)
}

fn commands(r: &Rig) -> String {
    r.fake
        .calls()
        .iter()
        .map(|c| c.join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn installed(r: &Rig) {
    r.fake.stub(
        "yardbell-node=",
        Output::ok_with("yardbell-node=v22.11.0\nyardbell-installed=1\n"),
    );
}

#[tokio::test]
async fn the_page_lists_machines_and_their_diagrams() {
    let r = rig();
    let c = cookie(&r.app).await;
    installed(&r);
    r.fake.stub(
        "yardbell-diagram",
        Output::ok_with("yardbell-diagram\tslot2\tarchitecture-1\tout.html\t1700000000\t860000\n"),
    );
    let (status, _, body) = get(&r, &c, "/api/diagrams").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let hp = v["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "hp")
        .unwrap();
    assert_eq!(hp["state"], "installed");
    assert!(hp["folders"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "slot2"));
    let found = v["diagrams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["machine"] == "hp")
        .unwrap();
    assert_eq!(found["dir"], "architecture-1");
}

#[tokio::test]
async fn a_machine_that_does_not_answer_says_so() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake
        .stub("yardbell-node=", Output::failed(255, "no route to host"));
    let (_, _, body) = get(&r, &c, "/api/diagrams").await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let hp = v["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "hp")
        .unwrap();
    assert_eq!(hp["state"], "offline");
    assert!(hp["problem"].as_str().unwrap().contains("no route"));
}

#[tokio::test]
async fn a_diagram_is_served_locked_down() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake
        .stub("cat ", Output::ok_with("<html><script>evil()</script>"));
    let url = "/diagrams/view?machine=hp&folder=slot2&dir=architecture-1&file=out.html";
    let (status, headers, body) = get(&r, &c, url).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("evil()"));
    let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(csp.contains("sandbox allow-scripts"), "{csp}");
    assert!(!csp.contains("allow-same-origin"), "{csp}");
    assert!(csp.contains("default-src 'none'"), "{csp}");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
}

#[tokio::test]
async fn a_failed_read_is_not_served_as_a_page() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake.stub(
        "cat ",
        Output::failed(5, "that diagram is too large to show"),
    );
    let url = "/diagrams/view?machine=hp&folder=slot2&dir=architecture-1&file=out.html";
    let (status, _, body) = get(&r, &c, url).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(body.contains("too large"));
}

#[tokio::test]
async fn only_a_diagram_in_a_known_folder_can_be_read() {
    let r = rig();
    let c = cookie(&r.app).await;
    for query in [
        "machine=hp&folder=slot2&dir=..&file=out.html",
        "machine=hp&folder=slot2&dir=a%2Fb&file=out.html",
        "machine=hp&folder=slot2&dir=d&file=..%2F..%2Fsecret.html",
        "machine=hp&folder=slot2&dir=d&file=secrets.yml",
        "machine=hp&folder=nowhere&dir=d&file=out.html",
    ] {
        let (status, _, _) = get(&r, &c, &format!("/diagrams/view?{query}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
    }
    assert!(!commands(&r).contains("cat "), "nothing was read");
}

#[tokio::test]
async fn the_routes_need_a_login() {
    let r = rig();
    for url in [
        "/api/diagrams",
        "/diagrams/view?machine=hp&folder=slot2&dir=d&file=out.html",
    ] {
        let req = Request::get(url)
            .header(header::ACCEPT, "application/json")
            .body(Body::empty())
            .unwrap();
        let (status, _, _) = send(&r.app, req).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{url}");
    }
}

#[tokio::test]
async fn delete_refuses_a_path_and_removes_one_folder() {
    let r = rig();
    let c = cookie(&r.app).await;
    let bad = json!({ "machine": "hp", "folder": "slot2", "dir": "../.." });
    assert_eq!(
        post(&r, &c, "/api/diagrams/delete", bad).await.0,
        StatusCode::BAD_REQUEST
    );
    assert!(!commands(&r).contains("rm -rf"));
    r.fake.stub("rm -rf", Output::ok_with(""));
    let good = json!({ "machine": "hp", "folder": "slot2", "dir": "architecture-1" });
    let (status, body) = post(&r, &c, "/api/diagrams/delete", good).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(commands(&r).contains("architecture-1"));
}

#[tokio::test]
async fn drawing_keeps_diagrams_out_of_git_and_starts_a_session() {
    let r = rig();
    let c = cookie(&r.app).await;
    installed(&r);
    r.fake.stub("info/exclude", Output::ok_with(""));
    r.fake.stub("tmux new", Output::ok_with(""));
    let body = json!({ "machine": "hp", "folder": "slot2", "focus": "the inbox" });
    let (status, text) = post(&r, &c, "/api/diagrams/draw", body).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let all = commands(&r);
    assert!(all.contains("info/exclude"), "{all}");
    assert!(all.contains("archify/3.2.0/SKILL.md"), "{all}");
    assert!(all.contains("the inbox"), "{all}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(v["name"].is_string());
}

#[tokio::test]
async fn drawing_needs_archify_on_the_machine() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake
        .stub("yardbell-node=", Output::ok_with("yardbell-node=\n"));
    let body = json!({ "machine": "hp", "folder": "slot2" });
    let (status, text) = post(&r, &c, "/api/diagrams/draw", body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(text.contains("Node 18"), "{text}");
    assert!(!commands(&r).contains("tmux new"), "no session started");
}

#[tokio::test]
async fn install_and_remove_run_on_the_machine() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake.stub("archify.zip", Output::ok_with(""));
    r.fake.stub("rm -rf", Output::ok_with(""));
    let (status, text) = post(&r, &c, "/api/diagrams/install", json!({ "machine": "hp" })).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(commands(&r).contains("archify.zip"));
    let (status, _) = post(&r, &c, "/api/diagrams/remove", json!({ "machine": "hp" })).await;
    assert_eq!(status, StatusCode::OK);
    assert!(commands(&r).contains("rm -rf"));
}

fn save_secret(r: &Rig) {
    let mut secrets = r.app.secrets().unwrap();
    secrets
        .set("token", "shh-secret-1", chrono::Utc::now())
        .unwrap();
    secrets.save().unwrap();
}

fn source_of_diagram(r: &Rig, text: &str) {
    r.fake.stub("candidate.json", Output::ok_with(text));
}

fn no_rules_needed() -> serde_json::Value {
    json!({ "machine": "hp", "folder": "slot2", "dir": "architecture-billing-20261101-120000" })
}

#[tokio::test]
async fn dispatch_can_list_and_read_a_diagram() {
    let r = rig();
    installed(&r);
    r.fake.stub(
        "yardbell-diagram",
        Output::ok_with("yardbell-diagram\tslot2\tarchitecture-1\tout.html\t1700000000\t860000\n"),
    );
    source_of_diagram(&r, "{\"nodes\":[\"api\"]}");
    let listed = crate::mcp_read::read(&r.app, "list_diagrams", &json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(listed["diagrams"][0]["dir"], "architecture-1", "{listed}");
    let read = crate::mcp_read::read(&r.app, "read_diagram", &no_rules_needed())
        .await
        .unwrap()
        .unwrap();
    assert!(read["source"].as_str().unwrap().contains("api"), "{read}");
}

#[tokio::test]
async fn dispatch_cannot_read_outside_a_diagram() {
    let r = rig();
    let bad = json!({ "machine": "hp", "folder": "slot2", "dir": "../.." });
    assert!(crate::mcp_read::read(&r.app, "read_diagram", &bad)
        .await
        .unwrap()
        .is_err());
    assert!(!commands(&r).contains("candidate.json"));
}

#[tokio::test]
async fn saved_secrets_stay_out_of_what_dispatch_reads() {
    let r = rig();
    save_secret(&r);
    source_of_diagram(&r, "{\"note\":\"shh-secret-1\"}");
    let read = crate::mcp_read::read(&r.app, "read_diagram", &no_rules_needed())
        .await
        .unwrap()
        .unwrap();
    assert!(!read.to_string().contains("shh-secret-1"), "{read}");
}

#[tokio::test]
async fn a_run_keeps_its_own_copy_of_the_diagram() {
    let r = rig();
    let c = cookie(&r.app).await;
    save_secret(&r);
    source_of_diagram(&r, "{\"nodes\":[\"api\"],\"note\":\"shh-secret-1\"}");
    let (status, text) = post(
        &r,
        &c,
        "/api/pipelines",
        json!({ "template": "Implement from a diagram" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let def: serde_json::Value = serde_json::from_str(&text).unwrap();
    let id = def["id"].as_str().unwrap();
    let (status, text) = post(
        &r,
        &c,
        &format!("/api/pipelines/{id}/runs"),
        json!({ "diagram": no_rules_needed() }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        v["runs"].as_array().unwrap().len(),
        1,
        "one run, not an empty one as well: {v}"
    );
    let run_id = v["runs"][0]
        .as_str()
        .map(str::to_string)
        .or_else(|| v["runs"][0]["id"].as_str().map(str::to_string))
        .unwrap();
    let run = r.app.pipelines.run(&run_id).unwrap();
    let ticket = run.subject.ticket.unwrap();
    assert_eq!(ticket.source, "diagram");
    assert_eq!(ticket.id, "architecture-billing");
    let stored = ticket.description;
    assert!(
        stored.contains("api") && stored.contains("slot2"),
        "{stored}"
    );
    assert!(!stored.contains("shh-secret-1"), "{stored}");
}

#[tokio::test]
async fn a_run_refuses_a_diagram_that_is_not_one() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (_, text) = post(
        &r,
        &c,
        "/api/pipelines",
        json!({ "template": "Implement from a diagram" }),
    )
    .await;
    let def: serde_json::Value = serde_json::from_str(&text).unwrap();
    let id = def["id"].as_str().unwrap();
    let body = json!({ "diagram": { "machine": "hp", "folder": "slot2", "dir": "../x" } });
    let (status, _) = post(&r, &c, &format!("/api/pipelines/{id}/runs"), body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn dispatch_drawing_follows_the_rules_and_waits_by_default() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    installed(&r);
    r.fake.stub("info/exclude", Output::ok_with(""));
    r.fake.stub("tmux new", Output::ok_with(""));
    let bad = dispatch_tool(
        &r,
        Some(&id),
        "draw_diagram",
        json!({ "machine": "hp", "folder": "nowhere" }),
    )
    .await;
    assert_eq!(bad["isError"], true, "{bad}");
    let asked = dispatch_tool(
        &r,
        Some(&id),
        "draw_diagram",
        json!({ "machine": "hp", "folder": "slot2" }),
    )
    .await;
    assert!(
        !commands(&r).contains("tmux new"),
        "it waits for the person: {asked}"
    );
    assert!(
        asked.to_string().to_lowercase().contains("wait") || asked.to_string().contains("approv"),
        "{asked}"
    );
}

fn drawing_can_start(r: &Rig) {
    installed(r);
    r.fake.stub("info/exclude", Output::ok_with(""));
    r.fake.stub("tmux new", Output::ok_with(""));
}

#[tokio::test]
async fn a_description_is_drawn_in_an_existing_folder() {
    let r = rig();
    let c = cookie(&r.app).await;
    drawing_can_start(&r);
    let body = json!({ "machine": "hp", "folder": "slot2", "description": "A shop with a cart" });
    let (status, text) = post(&r, &c, "/api/diagrams/draw", body).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let all = commands(&r);
    assert!(all.contains("A shop with a cart"), "{all}");
    assert!(all.contains("not built yet"), "{all}");
    assert!(!all.contains("yardbell-path="), "{all}");
}

#[tokio::test]
async fn a_description_can_start_a_new_folder() {
    let r = rig();
    let c = cookie(&r.app).await;
    drawing_can_start(&r);
    r.fake.stub(
        "yardbell-path=",
        Output::ok_with("yardbell-path=/r/my-idea\n"),
    );
    let body = json!({ "machine": "hp", "new_folder": "my-idea", "description": "A shop" });
    let (status, text) = post(&r, &c, "/api/diagrams/draw", body).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["path"], "/r/my-idea", "{v}");
}

#[tokio::test]
async fn a_new_folder_needs_a_plain_name_and_a_description() {
    let r = rig();
    let c = cookie(&r.app).await;
    drawing_can_start(&r);
    for (body, says) in [
        (
            json!({ "machine": "hp", "new_folder": "../up", "description": "A shop" }),
            "folder name",
        ),
        (json!({ "machine": "hp", "new_folder": "idea" }), "Describe"),
        (
            json!({ "machine": "hp", "description": "A shop" }),
            "folder",
        ),
        (json!({ "machine": "hp" }), "folder"),
    ] {
        let (status, text) = post(&r, &c, "/api/diagrams/draw", body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {text}");
        assert!(text.contains(says), "{body}: {text}");
    }
    assert!(!commands(&r).contains("yardbell-path="));
    assert!(!commands(&r).contains("tmux new"));
}

#[tokio::test]
async fn mcp_clients_are_told_about_diagrams() {
    let r = rig();
    let req = Request::post("/mcp")
        .header(header::HOST, "localhost:4000")
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", r.app.dispatch.token()),
        )
        .body(Body::from(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }).to_string(),
        ))
        .unwrap();
    let (_, _, body) = send(&r.app, req).await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let said = v["result"]["instructions"].as_str().unwrap();
    for tool in ["list_diagrams", "read_diagram", "draw_diagram"] {
        assert!(said.contains(tool), "{tool}: {said}");
    }
}

#[tokio::test]
async fn dispatch_can_propose_drawing_a_new_project() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    drawing_can_start(&r);
    let args = json!({ "machine": "hp", "new_folder": "my-idea", "description": "A shop" });
    let asked = dispatch_tool(&r, Some(&id), "draw_diagram", args).await;
    assert_ne!(asked["isError"], true, "{asked}");
    assert!(
        !commands(&r).contains("yardbell-path="),
        "nothing is made before it is approved"
    );
}

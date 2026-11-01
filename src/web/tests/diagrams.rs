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

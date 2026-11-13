use super::*;

async fn get(r: &Rig, url: &str) -> (StatusCode, serde_json::Value) {
    let c = cookie(&r.app).await;
    let req = Request::get(url)
        .header(header::COOKIE, c)
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (status, serde_json::from_str(&text).unwrap_or(json!(text)))
}

async fn post(r: &Rig, url: &str, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
    let c = cookie(&r.app).await;
    let (status, _, text) = post_json(&r.app, &c, url, &body.to_string()).await;
    (status, serde_json::from_str(&text).unwrap_or(json!(text)))
}

fn saved(r: &Rig) -> Config {
    Config::load(&r._dir.path().join("yardbell.yml")).unwrap()
}

fn session(tmux: &str, cwd: &str) -> crate::snapshot::Session {
    crate::snapshot::Session {
        machine: "hp".into(),
        agent: "claude".into(),
        pid: 9,
        cwd: cwd.into(),
        folder: cwd.into(),
        branch: "main".into(),
        ticket: "-".into(),
        tmux: Some(tmux.into()),
        activity: crate::snapshot::Activity::Idle,
        stopped: None,
        resets: None,
    }
}

fn with_sessions(r: &Rig, sessions: Vec<crate::snapshot::Session>) {
    let snap = Snapshot {
        sessions,
        ..Snapshot::default()
    };
    r.app.state.update(MachineStatus {
        name: "hp".into(),
        up: true,
        reason: None,
        snapshot: Some(snap),
        checked_at: chrono::Local::now(),
    });
}

fn project<'a>(list: &'a serde_json::Value, id: &str) -> Option<&'a serde_json::Value> {
    list.as_array()?.iter().find(|p| p["id"] == id)
}

const APP: &str = "hp:/r/app";

#[tokio::test]
async fn an_added_project_is_saved_checked_and_lists_its_sessions() {
    let r = rig();
    with_sessions(
        &r,
        vec![
            session("hp-a", "/r/app/src"),
            session("hp-b", "/r/app-worktrees/eng-1"),
            session("hp-c", "/home/u/Desktop"),
        ],
    );
    let (status, body) = post(
        &r,
        "/api/projects/add",
        json!({ "machine": "hp", "path": "/r/app/" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"], "added");
    assert_eq!(body["id"], APP);
    assert_eq!(r.rechecked().await, [Some("hp".to_string())]);
    assert_eq!(
        saved(&r).projects.added,
        [crate::projects::Added {
            machine: "hp".into(),
            path: "/r/app".into(),
            name: String::new(),
        }]
    );
    let (_, again) = post(
        &r,
        "/api/projects/add",
        json!({ "machine": "hp", "path": "/r/app" }),
    )
    .await;
    assert_eq!(again["result"], "listed");
    assert_eq!(saved(&r).projects.added.len(), 1);

    let (status, state) = get(&r, "/state").await;
    assert_eq!(status, StatusCode::OK);
    assert!(state.get("hidden_projects").is_none());
    let app = project(&state["projects"], APP).expect("the app project");
    assert_eq!(app["name"], "app");
    assert_eq!(app["machine"], "hp");
    assert_eq!(app["sessions"], json!(["hp:hp-a", "hp:hp-b"]));
    let desktop = state["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "hp:hp-c")
        .unwrap();
    assert_eq!(desktop["cwd"], "/home/u/Desktop");
    let (_, list) = get(&r, "/api/projects").await;
    assert_eq!(list["projects"], state["projects"]);
}

#[tokio::test]
async fn deleting_takes_only_the_entry_and_its_sessions_leave_it() {
    let r = rig();
    with_sessions(&r, vec![session("hp-a", "/r/app")]);
    post(
        &r,
        "/api/projects/add",
        json!({ "machine": "hp", "path": "/r/app" }),
    )
    .await;
    let (status, body) = post(&r, "/api/projects/delete", json!({ "id": APP })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["deleted"], APP);
    assert!(saved(&r).projects.is_empty());
    let (_, state) = get(&r, "/state").await;
    assert_eq!(state["projects"], json!([]));
    assert!(state["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == "hp:hp-a"));
    let (status, _) = post(&r, "/api/projects/delete", json!({ "id": APP })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn renaming_names_the_project_and_its_own_name_clears_it() {
    let r = rig();
    post(
        &r,
        "/api/projects/add",
        json!({ "machine": "hp", "path": "/r/app" }),
    )
    .await;
    let (status, body) = post(
        &r,
        "/api/projects/rename",
        json!({ "id": APP, "name": " Shop " }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "Shop");
    assert_eq!(saved(&r).projects.added[0].name, "Shop");
    let (_, state) = get(&r, "/state").await;
    assert_eq!(project(&state["projects"], APP).unwrap()["name"], "Shop");
    let (_, body) = post(
        &r,
        "/api/projects/rename",
        json!({ "id": APP, "name": "app" }),
    )
    .await;
    assert_eq!(body["name"], "app");
    assert_eq!(saved(&r).projects.added[0].name, "");
}

#[tokio::test]
async fn import_takes_what_fits_once() {
    let r = rig();
    post(
        &r,
        "/api/projects/add",
        json!({ "machine": "hp", "path": "/r/app" }),
    )
    .await;
    let items = json!({ "items": [
        { "machine": "hp", "path": "/r/kept" },
        { "machine": "hp", "path": "/r/kept" },
        { "machine": "hp", "path": "/r/app" },
        { "machine": "gone", "path": "/x" },
        { "machine": "hp", "path": "relative" },
    ] });
    let (status, body) = post(&r, "/api/projects/import", items).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["added"], 1);
    let added = saved(&r).projects.added;
    assert_eq!(added.len(), 2);
    assert_eq!(added[1].path, "/r/kept");
}

#[tokio::test]
async fn bad_requests_say_why() {
    let r = rig();
    let (status, body) = post(
        &r,
        "/api/projects/add",
        json!({ "machine": "nope", "path": "/x" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = post(
        &r,
        "/api/projects/add",
        json!({ "machine": "hp", "path": "code/x" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"].as_str().unwrap().contains("full path"),
        "{body}"
    );
    let (status, _) = post(
        &r,
        "/api/projects/rename",
        json!({ "id": "hp:/nothing", "name": "x" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    post(
        &r,
        "/api/projects/add",
        json!({ "machine": "hp", "path": "/r/app" }),
    )
    .await;
    let (status, _) = post(
        &r,
        "/api/projects/rename",
        json!({ "id": APP, "name": "a\nb" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = post(&r, "/api/projects/show", json!({ "id": APP })).await;
    assert_ne!(status, StatusCode::OK, "the hidden list is gone");
}

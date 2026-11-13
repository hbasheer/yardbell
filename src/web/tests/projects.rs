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

fn checkout(machine: &str, label: &str, path: &str, remote: &str) -> MachineStatus {
    let mut snap = Snapshot::default();
    snap.folders.insert(label.into(), "main".into());
    snap.folder_paths.insert(label.into(), path.into());
    snap.remotes.insert(label.into(), remote.into());
    MachineStatus {
        name: machine.into(),
        up: true,
        reason: None,
        snapshot: Some(snap),
        checked_at: chrono::Local::now(),
    }
}

fn project<'a>(list: &'a serde_json::Value, id: &str) -> Option<&'a serde_json::Value> {
    list.as_array()?.iter().find(|p| p["id"] == id)
}

const APP: &str = "git:github.com/acme/app";

fn two_machines() -> Rig {
    let r = rig();
    r.app
        .state
        .update(checkout("hp", "app", "/r/app", "github.com/acme/app"));
    r.app.state.update(checkout(
        "mini",
        "acme/app",
        "/Users/u/acme/app",
        "github.com/acme/app",
    ));
    r
}

#[tokio::test]
async fn state_lists_one_repo_on_two_machines_once() {
    let r = two_machines();
    let (status, state) = get(&r, "/state").await;
    assert_eq!(status, StatusCode::OK);
    let app = project(&state["projects"], APP).expect("the app project");
    assert_eq!(app["name"], "acme/app");
    let machines: Vec<_> = app["checkouts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["machine"].as_str().unwrap())
        .collect();
    assert_eq!(machines, ["mini", "hp"]);
    assert_eq!(state["hidden_projects"], json!([]));
    let (_, list) = get(&r, "/api/projects").await;
    assert_eq!(list["projects"], state["projects"]);
}

#[tokio::test]
async fn an_added_project_is_saved_checked_and_deleted_on_remove() {
    let r = two_machines();
    let (status, body) = post(
        &r,
        "/api/projects/add",
        json!({ "machine": "pro", "path": "/p/lab/thing/" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"], "added");
    assert_eq!(body["project"], "dir:thing");
    assert_eq!(body["folder"], "/p/lab/thing");
    assert_eq!(r.rechecked().await, [Some("pro".to_string())]);
    assert_eq!(
        saved(&r).projects.added,
        [crate::projects::Added {
            machine: "pro".into(),
            path: "/p/lab/thing".into()
        }]
    );
    let (_, again) = post(
        &r,
        "/api/projects/add",
        json!({ "machine": "pro", "path": "/p/lab/thing" }),
    )
    .await;
    assert_eq!(again["result"], "listed");
    assert_eq!(saved(&r).projects.added.len(), 1);

    let (status, body) = post(&r, "/api/projects/remove", json!({ "id": "dir:thing" })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], "deleted");
    assert!(saved(&r).projects.is_empty());
}

#[tokio::test]
async fn a_found_project_hides_and_shows_again() {
    let r = two_machines();
    let (_, body) = post(&r, "/api/projects/remove", json!({ "id": APP })).await;
    assert_eq!(body["removed"], "hidden");
    assert_eq!(saved(&r).projects.hidden, [APP]);
    let (_, state) = get(&r, "/state").await;
    assert!(project(&state["projects"], APP).is_none());
    assert!(project(&state["hidden_projects"], APP).is_some());

    let (status, _) = post(&r, "/api/projects/show", json!({ "id": APP })).await;
    assert_eq!(status, StatusCode::OK);
    assert!(saved(&r).projects.hidden.is_empty());
    let (status, body) = post(&r, "/api/projects/show", json!({ "id": APP })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    post(&r, "/api/projects/remove", json!({ "id": APP })).await;
    let (_, body) = post(
        &r,
        "/api/projects/add",
        json!({ "machine": "hp", "path": "/r/app" }),
    )
    .await;
    assert_eq!(body["result"], "shown");
    assert_eq!(body["folder"], "app");
    assert!(
        saved(&r).projects.is_empty(),
        "adding a found folder shows it, not adds it"
    );
}

#[tokio::test]
async fn renaming_names_the_project_everywhere_and_its_own_name_clears_it() {
    let r = two_machines();
    let (status, body) = post(
        &r,
        "/api/projects/rename",
        json!({ "id": APP, "name": " Shop " }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "Shop");
    assert_eq!(saved(&r).projects.names.get(APP).unwrap(), "Shop");
    let (_, state) = get(&r, "/state").await;
    assert_eq!(project(&state["projects"], APP).unwrap()["name"], "Shop");
    let (_, body) = post(
        &r,
        "/api/projects/rename",
        json!({ "id": APP, "name": "acme/app" }),
    )
    .await;
    assert_eq!(body["name"], "acme/app");
    assert!(saved(&r).projects.is_empty());
}

#[tokio::test]
async fn import_takes_what_fits_once() {
    let r = two_machines();
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
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].path, "/r/kept");
}

#[tokio::test]
async fn bad_requests_say_why() {
    let r = two_machines();
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
    let (status, _) = post(&r, "/api/projects/remove", json!({ "id": "dir:nothing" })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = post(
        &r,
        "/api/projects/rename",
        json!({ "id": APP, "name": "a\nb" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

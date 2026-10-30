use super::*;
use crate::pipeline::record::{RunState, Subject, WaitKind, Waiting};

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

async fn fake_linear() -> String {
    let app = axum::Router::new().fallback(|| async {
        json!({"data":{"viewer":{"assignedIssues":{"nodes":[
            {"id":"u-1","identifier":"COM-1","title":"Fix login","url":"https://linear.app/c/issue/COM-1","state":{"name":"Todo"}},
            {"id":"u-2","identifier":"COM-2","title":"Docs","url":"https://linear.app/c/issue/COM-2","state":{"name":"In Progress"}}
        ]}}}})
        .to_string()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{addr}/graphql")
}

async fn with_linear(r: &Rig) {
    r.app
        .pipelines
        .use_linear(crate::pipeline::linear::Linear::with_url(
            &fake_linear().await,
        ));
    let mut secrets = r.app.secrets().unwrap();
    secrets
        .set("linear", "lin_api_test", chrono::Utc::now())
        .unwrap();
    secrets.save().unwrap();
}

async fn copy(r: &Rig, c: &str, template: &str) -> String {
    let (status, body) = call(
        r,
        c,
        "POST",
        "/api/pipelines",
        Some(json!({ "template": template })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["id"].as_str().unwrap().to_string()
}

const IMPLEMENT: &str = "Implement my Linear tickets";
const REVIEW: &str = "Review my merge requests";

#[tokio::test]
async fn pipelines_list_with_counts_and_templates() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let mut run = r
        .app
        .pipelines
        .start(&id, vec![Subject::default()], "you")
        .unwrap()
        .remove(0);
    run.state = RunState::Waiting;
    r.app.pipelines.put(run);
    let (status, body) = call(&r, &c, "GET", "/api/pipelines", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["templates"], json!([IMPLEMENT, REVIEW]));
    assert_eq!(body["pipelines"][0]["definition"]["id"], id);
    assert_eq!(
        body["pipelines"][0]["runs"],
        json!({ "running": 0, "waiting": 1, "done": 0 })
    );
    assert_eq!(body["settings"]["per_machine"], 2);
    assert_eq!(body["machines"], json!(["mini", "hp", "pro"]));
    assert!(
        body["gitlab_hosts"].is_array()
            && body["agents"].is_array()
            && body["mcp_servers"].is_array(),
        "{body}"
    );
    let (status, all) = call(&r, &c, "GET", "/api/runs", None).await;
    assert_eq!(status, StatusCode::OK, "{all}");
    assert_eq!(all["runs"][0]["pipeline"], id);
    assert_eq!(all["runs"][0]["state"], "waiting");
}

#[tokio::test]
async fn a_save_failing_its_checks_returns_the_problems() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let (status, mut def) = call(&r, &c, "GET", &format!("/api/pipelines/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    def["steps"][1]["next"]["pass"] = json!("nowhere");
    let (status, body) = call(&r, &c, "PUT", &format!("/api/pipelines/{id}"), Some(def)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["problems"][0],
        "Implement: its pass line goes to a step that does not exist"
    );
    assert!(body["problems"]
        .as_array()
        .unwrap()
        .contains(&json!("Review is never reached")));
    let (status, body) = call(
        &r,
        &c,
        "POST",
        "/api/pipelines",
        Some(json!({ "template": "Nope" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["problems"], json!(["there is no template named Nope"]));
}

#[tokio::test]
async fn a_definition_is_created_with_a_unique_id() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let (_, mut def) = call(&r, &c, "GET", &format!("/api/pipelines/{id}"), None).await;
    def["name"] = json!("My own");
    let (status, body) = call(
        &r,
        &c,
        "POST",
        "/api/pipelines",
        Some(json!({ "definition": def })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (body["id"].clone(), body["version"].clone()),
        (json!("my-own"), json!(1))
    );
    assert_eq!(r.app.pipelines.library().list().len(), 2);
}

#[tokio::test]
async fn history_and_restore() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let (_, mut def) = call(&r, &c, "GET", &format!("/api/pipelines/{id}"), None).await;
    def["steps"][1]["name"] = json!("Build it");
    let (status, saved) = call(&r, &c, "PUT", &format!("/api/pipelines/{id}"), Some(def)).await;
    assert_eq!(
        (status, saved["version"].clone()),
        (StatusCode::OK, json!(2))
    );
    let (_, history) = call(&r, &c, "GET", &format!("/api/pipelines/{id}/history"), None).await;
    let versions: Vec<_> = history["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["version"].clone())
        .collect();
    assert_eq!(versions, vec![json!(2), json!(1)]);
    let (status, restored) = call(
        &r,
        &c,
        "POST",
        &format!("/api/pipelines/{id}/restore"),
        Some(json!({ "version": 1 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(
        (
            restored["version"].clone(),
            restored["steps"][1]["name"].clone()
        ),
        (json!(3), json!("Implement"))
    );
}

#[tokio::test]
async fn switching_on_checks_the_trigger_and_delete_drops_runs() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, REVIEW).await;
    let (status, body) = call(
        &r,
        &c,
        "POST",
        &format!("/api/pipelines/{id}/enabled"),
        Some(json!({ "enabled": true })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["problems"], json!(["gitlab_reviewer needs a host"]));
    let mr = "https://git.commslayer.com/commslayer/app/-/merge_requests/87";
    let (status, body) = call(
        &r,
        &c,
        "POST",
        &format!("/api/pipelines/{id}/runs"),
        Some(json!({ "prs": [mr] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let pr = &body["runs"][0]["subject"]["pr"];
    assert_eq!(
        (
            pr["number"].clone(),
            pr["forge"].clone(),
            pr["project"].clone()
        ),
        (json!(87), json!("gitlab"), json!("commslayer/app"))
    );
    let (_, runs) = call(&r, &c, "GET", &format!("/api/pipelines/{id}/runs"), None).await;
    assert_eq!(runs["runs"].as_array().unwrap().len(), 1);
    let (status, _) = call(&r, &c, "DELETE", &format!("/api/pipelines/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(r.app.pipelines.runs().is_empty());
    let (status, _) = call(&r, &c, "GET", &format!("/api/pipelines/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_pull_request_url_that_is_not_one_is_400() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, REVIEW).await;
    let (status, body) = call(
        &r,
        &c,
        "POST",
        &format!("/api/pipelines/{id}/runs"),
        Some(json!({ "prs": ["https://example.com/nothing"] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("is not a GitHub pull request or GitLab merge request link"),
        "{body}"
    );
}

#[tokio::test]
async fn starting_by_tickets_and_a_ticket_already_running() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let (status, body) = call(&r, &c, "GET", "/api/pipelines/tickets", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("the secret linear is not set"),
        "{body}"
    );
    with_linear(&r).await;
    let runs_url = format!("/api/pipelines/{id}/runs");
    let start = |tickets: serde_json::Value| {
        call(
            &r,
            &c,
            "POST",
            &runs_url,
            Some(json!({ "tickets": tickets })),
        )
    };
    let (status, body) = start(json!(["COM-1"])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["runs"][0]["subject"]["ticket"]["linear_id"], "u-1");
    let (status, body) = start(json!(["COM-1"])).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("is already in a run of Implement my Linear tickets"),
        "{body}"
    );
    let (status, tickets) = call(&r, &c, "GET", "/api/pipelines/tickets", None).await;
    assert_eq!(status, StatusCode::OK, "{tickets}");
    assert_eq!(tickets["tickets"][0]["running_in"], json!([id]));
    assert_eq!(tickets["tickets"][1]["running_in"], json!([]));
    let (status, body) = start(json!(["COM-9"])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("COM-9 is not one of your open tickets"),
        "{body}"
    );
}

#[tokio::test]
async fn run_actions() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let mut run = r
        .app
        .pipelines
        .start(&id, vec![Subject::default()], "you")
        .unwrap()
        .remove(0);
    run.state = RunState::Waiting;
    run.step = "implement".into();
    run.waiting = Some(Waiting {
        kind: WaitKind::Stopped,
        step: "implement".into(),
        reason: "Implement failed".into(),
        screen: String::new(),
    });
    let run_id = run.id.clone();
    r.app.pipelines.put(run);
    let url = |action: &str| format!("/api/runs/{run_id}/{action}");
    let (status, body) = call(
        &r,
        &c,
        "POST",
        &url("answer"),
        Some(json!({ "text": "go" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("is not waiting for an answer"),
        "{body}"
    );
    let (status, body) = call(
        &r,
        &c,
        "POST",
        &url("continue"),
        Some(json!({ "outcome": "pass" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["step"], "review");
    let (status, body) = call(&r, &c, "POST", &url("drop"), None).await;
    assert_eq!(
        (status, body["state"].clone()),
        (StatusCode::OK, json!("dropped"))
    );
    let (status, _) = call(&r, &c, "POST", &url("retry"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&r, &c, "POST", "/api/runs/nope/retry", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn settings_are_saved_to_yardbell_yml() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, body) = call(
        &r,
        &c,
        "PUT",
        "/api/pipelines/settings",
        Some(json!({ "per_machine": 3, "minutes": 90, "qa_notes": { "acme/web": "bin/rspec" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let cfg = r.app.config().unwrap();
    assert_eq!((cfg.pipelines.per_machine, cfg.pipelines.minutes), (3, 90));
    assert_eq!(cfg.pipelines.qa_notes["acme/web"], "bin/rspec");
    let (status, body) = call(
        &r,
        &c,
        "PUT",
        "/api/pipelines/settings",
        Some(json!({ "per_machine": 9, "minutes": 90 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("pipelines.per_machine must be from 1 to 6"),
        "{body}"
    );
}

#[tokio::test]
async fn an_empty_pipeline_is_created_and_cannot_run() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, body) = call(
        &r,
        &c,
        "POST",
        "/api/pipelines",
        Some(json!({ "empty": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (body["name"].clone(), body["steps"].clone()),
        (json!("New pipeline"), json!([]))
    );
    let (status, body) = call(
        &r,
        &c,
        "POST",
        "/api/pipelines/new-pipeline/runs",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("New pipeline has no steps yet"),
        "{body}"
    );
}

#[tokio::test]
async fn a_run_can_be_deleted_in_any_state() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let run = r
        .app
        .pipelines
        .start(&id, vec![Subject::default()], "you")
        .unwrap()
        .remove(0);
    let url = format!("/api/runs/{}", run.id);
    let (status, body) = call(&r, &c, "DELETE", &url, None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a run in progress can be deleted: {body}"
    );
    let (_, listed) = call(&r, &c, "GET", "/api/runs", None).await;
    assert_eq!(listed["runs"], json!([]));
    let mut stopping = r.app.pipelines.run(&run.id).unwrap();
    assert_eq!(stopping.state, RunState::Dropped);
    stopping.pending = None;
    r.app.pipelines.put(stopping);
    let (status, body) = call(&r, &c, "DELETE", &url, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(r.app.pipelines.run(&run.id).is_none());
    let (status, _) = call(&r, &c, "DELETE", &url, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn settings_says_which_service_each_folder_uses() {
    let r = rig();
    let c = cookie(&r.app).await;
    let folder = r
        .app
        .state
        .snapshot("hp")
        .unwrap()
        .folder_paths
        .into_iter()
        .next()
        .expect("the rig has a folder");
    r.fake.stub(
        "FOLDER",
        Output::ok_with(&format!(
            "FOLDER\t{}\thttps://me:hunter2@gitlab.com/group/app.git\n\n",
            folder.1
        )),
    );
    let (status, body) = call(&r, &c, "GET", "/api/settings/pull-requests/folders", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row = &body["folders"][0];
    assert_eq!(row["machine"], "hp");
    assert_eq!(row["folder"], json!(folder.0));
    assert_eq!(row["host"], "gitlab.com");
    assert_eq!(row["project"], "group/app");
    assert_eq!(row["service"], "gitlab_unlisted");
    assert!(!body.to_string().contains("hunter2"), "{body}");
}

#[tokio::test]
async fn an_ended_run_lists_no_terminals() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let cfg = r.app.config().unwrap();
    let live = r
        .app
        .state
        .view(&cfg, r.app.ports.as_ref(), "localhost")
        .sessions
        .into_iter()
        .find_map(|s| s.tmux.map(|t| (s.machine, t)))
        .expect("the rig has a session");
    let mut run = r
        .app
        .pipelines
        .start(&id, vec![Subject::default()], "you")
        .unwrap()
        .remove(0);
    run.state = RunState::Done;
    let st = run.state_of("review");
    st.session = live.1;
    st.machine = live.0;
    r.app.pipelines.put(run);
    let (_, body) = call(&r, &c, "GET", "/api/runs", None).await;
    assert_eq!(body["runs"][0]["terminals"], json!([]));
}

#[tokio::test]
async fn stopping_a_runs_session_makes_its_step_wait() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let cfg = r.app.config().unwrap();
    let live = r
        .app
        .state
        .view(&cfg, r.app.ports.as_ref(), "localhost")
        .sessions
        .into_iter()
        .find_map(|s| s.tmux.map(|t| (s.machine, t)))
        .expect("the rig has a session");
    let mut run = r
        .app
        .pipelines
        .start(&id, vec![Subject::default()], "you")
        .unwrap()
        .remove(0);
    let rid = run.id.clone();
    run.step = "review".into();
    run.state = RunState::Running;
    run.pending = None;
    let st = run.state_of("review");
    st.session = live.1.clone();
    st.machine = live.0.clone();
    r.app.pipelines.put(run);
    let path = format!("/api/runs/{rid}/stop-session");
    let (status, _) = call(
        &r,
        &c,
        "POST",
        &path,
        Some(json!({ "name": "someone-else" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "only a session of this run"
    );
    r.fake.stub("kill-session", Output::ok_with(""));
    let (status, body) = call(&r, &c, "POST", &path, Some(json!({ "name": live.1 }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let run = r.app.pipelines.run(&rid).unwrap();
    assert_eq!(run.state, RunState::Waiting);
    assert_eq!(run.waiting.unwrap().reason, "You stopped the session");
    assert!(r
        .fake
        .calls()
        .iter()
        .any(|c| c.join(" ").contains("kill-session")));
}

#[tokio::test]
async fn runs_list_their_live_terminals() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = copy(&r, &c, IMPLEMENT).await;
    let cfg = r.app.config().unwrap();
    let live = r
        .app
        .state
        .view(&cfg, r.app.ports.as_ref(), "localhost")
        .sessions
        .into_iter()
        .find_map(|s| s.tmux.map(|t| (s.machine, t)))
        .expect("the rig has a session");
    let mut run = r
        .app
        .pipelines
        .start(&id, vec![Subject::default()], "you")
        .unwrap()
        .remove(0);
    run.step = "review".into();
    run.state = RunState::Running;
    let st = run.state_of("review");
    st.session = live.1.clone();
    st.machine = live.0.clone();
    run.state_of("implement").session = "hp-gone".into();
    r.app.pipelines.put(run);
    let (status, body) = call(&r, &c, "GET", "/api/runs", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["runs"][0]["terminals"],
        json!([{ "step": "review", "name": live.1, "machine": live.0, "label": "Review", "current": true }])
    );
    let (_, body) = call(&r, &c, "GET", &format!("/api/pipelines/{id}/runs"), None).await;
    assert_eq!(body["runs"][0]["terminals"][0]["name"], live.1);
}

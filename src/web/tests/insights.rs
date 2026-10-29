use super::*;
use crate::snapshot::Activity;

async fn get_json(r: &Rig, c: &str, url: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::get(url)
        .header(header::COOKIE, c)
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    (status, serde_json::from_str(&body).unwrap_or(json!(body)))
}

fn observe(r: &Rig, activity: Activity, screen: &str, minutes_ago: i64) {
    let mut snap = r.app.state.snapshot("hp").unwrap();
    for s in snap.sessions.iter_mut() {
        s.activity = activity;
    }
    snap.runs
        .insert("hp:hp-eng-1301".into(), crate::insights::runs::runs(screen));
    let at = chrono::Local::now() - chrono::Duration::minutes(minutes_ago);
    r.app.insights.observe("hp", &snap, at);
}

#[tokio::test]
async fn insights_show_the_timeline_runs_from_the_scrollback_and_a_suggestion() {
    let r = rig();
    let c = cookie(&r.app).await;
    observe(&r, Activity::Active, "⏺ Bash(cargo test)\n", 30);
    observe(
        &r,
        Activity::Blocked,
        "test result: FAILED. 1 passed; 1 failed; 0 ignored\n",
        10,
    );
    r.app
        .remember_task("hp", "hp-eng-1301", "fix the inbox filter");
    r.fake.stub(
        "capture-pane",
        Output::ok_with(
            "⏺ Read(src/inbox.rs)\n⏺ Bash(cargo test)\ntest result: FAILED. 1 passed; 1 failed; 0 ignored\n⏺ Read(src/inbox.rs)\n",
        ),
    );
    let (status, body) = get_json(&r, &c, "/sessions/hp/hp-eng-1301/insights").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["live"], true);
    assert_eq!(body["activity"], "idle");
    let t = &body["timeline"];
    assert_eq!(t["started"], false, "it ran before Yardbell watched it");
    let states: Vec<&str> = t["periods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["working", "waiting"]);
    assert_eq!(t["periods"][0]["seconds"], 20 * 60);
    assert!(t["periods"][1]["to"].is_null());
    assert_eq!(t["runs"].as_array().unwrap().len(), 2);
    assert_eq!(t["runs"][1]["ok"], false);
    assert_eq!(
        body["earlier"],
        json!([{ "kind": "tool", "text": "Read: src/inbox.rs" }]),
        "runs Yardbell recorded are not repeated, and the scrollback lists each once"
    );
    let reads = r
        .fake
        .calls()
        .iter()
        .filter(|c| c.join(" ").contains("capture-pane"))
        .map(|c| c.join(" "))
        .collect::<Vec<_>>();
    assert!(reads.iter().all(|c| c.contains("-S -2000")), "{reads:?}");
    assert_eq!(body["task"], "fix the inbox filter");
    let suggest = body["suggest"].as_str().unwrap();
    assert!(suggest.contains("hp-eng-1301 on hp"), "{suggest}");
    assert!(suggest.contains("fix the inbox filter"), "{suggest}");
    assert!(suggest.contains("1 failing test run"), "{suggest}");
    assert!(body.get("from").is_none());

    let (status, body) = get_json(&r, &c, "/sessions/hp/hp-nope/insights").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, _) = get_json(&r, &c, "/sessions/nowhere/hp-eng-1301/insights").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_ended_session_still_has_its_timeline_without_reading_tmux() {
    let r = rig();
    let c = cookie(&r.app).await;
    observe(&r, Activity::Active, "", 5);
    let mut snap = r.app.state.snapshot("hp").unwrap();
    snap.sessions
        .retain(|s| s.tmux.as_deref() != Some("hp-eng-1301"));
    r.app.insights.observe(
        "hp",
        &snap,
        chrono::Local::now() - chrono::Duration::minutes(1),
    );
    r.app.state.update(MachineStatus {
        name: "hp".into(),
        up: true,
        reason: None,
        snapshot: Some(snap),
        checked_at: chrono::Local::now(),
    });
    let (status, body) = get_json(&r, &c, "/sessions/hp/hp-eng-1301/insights").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["live"], false);
    assert!(body["timeline"]["ended"].is_string());
    assert!(!r
        .fake
        .calls()
        .iter()
        .any(|c| c.join(" ").contains("capture-pane")));
    assert!(body["suggest"].as_str().unwrap().contains("It has ended"));
}

#[tokio::test]
async fn task_history_diff_and_restore_over_http() {
    let r = rig();
    let c = cookie(&r.app).await;
    for (text, replacing) in [("run the tests", "null"), ("run all tests", "\"Tests\"")] {
        let body = format!(r#"{{"name":"Tests","text":"{text}","replacing":{replacing}}}"#);
        let (status, _, out) = post_json(&r.app, &c, "/dispatch/tasks", &body).await;
        assert_eq!(status, StatusCode::OK, "{out}");
    }
    let (status, h) = get_json(&r, &c, "/dispatch/tasks/history?name=Tests").await;
    assert_eq!(status, StatusCode::OK, "{h}");
    assert_eq!(h["current"], 2);
    assert_eq!(h["versions"][0]["text"], "run the tests");
    let (status, d) = get_json(&r, &c, "/dispatch/tasks/diff?name=Tests&from=1&to=2").await;
    assert_eq!(status, StatusCode::OK, "{d}");
    assert_eq!(
        d["parts"],
        json!([
            { "op": "same", "text": "run " },
            { "op": "del", "text": "the" },
            { "op": "add", "text": "all" },
            { "op": "same", "text": " tests" },
        ])
    );
    let (status, _, out) = post_json(
        &r.app,
        &c,
        "/dispatch/tasks/versions/restore",
        r#"{"name":"Tests","version":1}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let out: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(out["history"]["current"], 3);
    assert_eq!(out["history"]["versions"][2]["restored"], 1);
    let task = out["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Tests")
        .unwrap();
    assert_eq!(
        (&task["text"], &task["version"]),
        (&json!("run the tests"), &json!(3))
    );
    let (status, _, _) = post_json(
        &r.app,
        &c,
        "/dispatch/tasks/versions/restore",
        r#"{"name":"Tests","version":1}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = get_json(&r, &c, "/dispatch/tasks/history?name=Nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn insights_carry_the_sessions_pull_request() {
    let r = rig();
    let c = cookie(&r.app).await;
    observe(&r, Activity::Active, "", 5);
    let (_, body) = get_json(&r, &c, "/sessions/hp/hp-eng-1301/insights").await;
    assert!(body["pull"].is_null(), "no pull request known: {body}");

    let snap = r.app.state.snapshot("hp").unwrap();
    let s = snap
        .sessions
        .iter()
        .find(|s| s.tmux.as_deref() == Some("hp-eng-1301"))
        .unwrap();
    let path = snap.folder_paths[&s.folder].clone();
    let view = crate::pulls::PullView {
        forge: "gitlab".into(),
        number: 12,
        url: "https://git.example.com/acme/app/-/merge_requests/12".into(),
        title: "Fix the inbox filter".into(),
        state: "open".into(),
        draft: false,
        review: "approved".into(),
        ci: crate::pulls::Ci::Passing,
        failed: Vec::new(),
    };
    r.app.state.set_pulls(
        [(("hp".to_string(), path, s.branch.clone()), view)]
            .into_iter()
            .collect(),
    );
    let (status, body) = get_json(&r, &c, "/sessions/hp/hp-eng-1301/insights").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["pull"]["number"], 12);
    assert_eq!(body["pull"]["forge"], "gitlab");
    assert_eq!(body["pull"]["review"], "approved");
}

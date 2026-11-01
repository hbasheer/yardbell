use super::*;
use crate::config::HealthChecks;
use crate::health::Ledger;
use crate::pipeline::record::{Run, RunState};

fn queued(id: &str, minutes_ago: i64) -> Run {
    let def = crate::pipeline::templates::all().remove(0);
    Run {
        id: id.into(),
        pipeline: def.id.clone(),
        pipeline_name: def.name.clone(),
        definition: Some(def),
        state: RunState::Queued,
        step: "implement".into(),
        slot: Some("hp".into()),
        step_since: (chrono::Local::now() - chrono::Duration::minutes(minutes_ago)).to_rfc3339(),
        ..Run::default()
    }
}

async fn state_problems(r: &Rig, c: &str) -> Vec<serde_json::Value> {
    let req = Request::get("/state")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let state: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(state["machines"].is_array(), "the view stays at the top");
    state["problems"].as_array().unwrap().clone()
}

fn notes(r: &Rig) -> Vec<String> {
    let now = std::time::Instant::now();
    r.app
        .phone
        .inbox
        .page(Some("another run"), 0, now)
        .notes
        .into_iter()
        .map(|note| note.title)
        .collect()
}

#[tokio::test]
async fn a_problem_shows_on_state_and_notifies_once_across_a_restart() {
    let r = rig();
    let c = cookie(&r.app).await;
    let cfg = r.app.config().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("health.json");
    r.app.pipelines.put(queued("r1", 30));
    let mut ledger = Ledger::load(file.clone());

    ledger.tick(&r.app, &cfg, chrono::Local::now());
    assert_eq!(
        state_problems(&r, &c).await,
        Vec::<serde_json::Value>::new()
    );
    assert_eq!(notes(&r), Vec::<String>::new());

    r.app.pipelines.put(queued("r1", 121));
    let before_runs = r.app.pipelines.runs();
    let calls = r.fake.calls().len();
    ledger.tick(&r.app, &cfg, chrono::Local::now());
    assert_eq!(r.fake.calls().len(), calls, "a check runs no command");
    assert_eq!(
        r.app.pipelines.runs(),
        before_runs,
        "a check changes no run"
    );
    let open = state_problems(&r, &c).await;
    assert_eq!(open.len(), 1);
    assert_eq!(open[0]["check"], "run_queued");
    assert_eq!(notes(&r).len(), 1);

    ledger.tick(&r.app, &cfg, chrono::Local::now());
    let mut restarted = Ledger::load(file);
    restarted.tick(&r.app, &cfg, chrono::Local::now());
    assert_eq!(notes(&r).len(), 1, "told once, also after a restart");
    assert_eq!(state_problems(&r, &c).await.len(), 1);

    assert_eq!(r.fake.calls().len(), calls, "a check runs no command");
    assert_eq!(
        r.app.pipelines.runs(),
        before_runs,
        "a check changes no run"
    );
}

#[tokio::test]
async fn health_settings_are_saved_validated_and_shown() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (before, _) = get_settings(&r, &c).await;
    assert_eq!(
        before["health_checks"],
        serde_json::to_value(HealthChecks::default()).unwrap()
    );
    let url = "/api/settings/health";
    let edit = HealthChecks {
        ci_pending: false,
        memory_short_minutes: 15,
        ..HealthChecks::default()
    };
    let body = serde_json::to_string(&edit).unwrap();
    let (status, _, said) = post_json(&r.app, &c, url, &body).await;
    assert_eq!(status, StatusCode::OK, "{said}");
    assert_eq!(r.app.config().unwrap().health_checks, edit);

    let refused = HealthChecks {
        run_queued_minutes: 1,
        ..edit.clone()
    };
    let body = serde_json::to_string(&refused).unwrap();
    let (status, _, said) = post_json(&r.app, &c, url, &body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
    assert!(
        said.contains("run_queued_minutes must be from 5 to 10080"),
        "{said}"
    );
    assert_eq!(r.app.config().unwrap().health_checks, edit);
}

#[tokio::test]
async fn a_switched_off_check_shows_and_tells_nothing() {
    let r = rig();
    let mut cfg = r.app.config().unwrap();
    cfg.health_checks.run_queued = false;
    r.app.pipelines.put(queued("r1", 500));
    let dir = tempfile::tempdir().unwrap();
    let mut ledger = Ledger::load(dir.path().join("health.json"));
    ledger.tick(&r.app, &cfg, chrono::Local::now());
    assert_eq!(r.app.state.problems(), vec![]);
    assert_eq!(notes(&r), Vec::<String>::new());
}

#[tokio::test]
async fn a_failed_scheduled_read_leaves_after_a_day_and_stays_on_its_row() {
    let r = rig();
    let c = cookie(&r.app).await;
    let cfg = r.app.config().unwrap();
    let library = r.app.pipelines.library();
    let def = library.copy_template("Implement my tickets", &cfg).unwrap();
    library.set_enabled(&def.id, true, &cfg).unwrap();
    let now = chrono::Local::now();
    r.app.pipelines.watch().set_kept(
        &def.id,
        crate::pipeline::triggers::Kept {
            problem: "the server said no".into(),
            problem_at: (now - chrono::Duration::hours(2)).to_rfc3339(),
            ..Default::default()
        },
    );
    let row_problem = || async {
        let req = Request::get("/api/pipelines")
            .header(header::COOKIE, &c)
            .body(Body::empty())
            .unwrap();
        let (status, _, body) = send(&r.app, req).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let list: serde_json::Value = serde_json::from_str(&body).unwrap();
        list["pipelines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["definition"]["id"] == def.id.as_str())
            .unwrap()["problem"]
            .clone()
    };
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("health.json");
    let hours = |h: i64, m: i64| now + chrono::Duration::hours(h) + chrono::Duration::minutes(m);

    let mut ledger = Ledger::load(file.clone());
    ledger.tick(&r.app, &cfg, now);
    ledger.tick(&r.app, &cfg, hours(1, 1));
    assert_eq!(r.app.state.problems().len(), 1);
    assert_eq!(notes(&r).len(), 1);

    ledger.tick(&r.app, &cfg, hours(22, 0));
    assert_eq!(r.app.state.problems(), vec![], "a day after the read");
    assert_eq!(row_problem().await, "the server said no");

    let mut restarted = Ledger::load(file);
    restarted.tick(&r.app, &cfg, hours(22, 5));
    restarted.tick(&r.app, &cfg, hours(100, 0));
    assert_eq!(r.app.state.problems(), vec![]);
    assert_eq!(notes(&r).len(), 1, "told once, also after a restart");
    assert_eq!(row_problem().await, "the server said no");
}

use super::*;
use crate::pipeline::definition::{Definition, Trigger};

const IMPLEMENT: &str = "Implement my Linear tickets";
const REVIEW: &str = "Review my merge requests";

fn text(result: &serde_json::Value) -> String {
    result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn answer(result: &serde_json::Value) -> serde_json::Value {
    serde_json::from_str(&text(result)).unwrap_or(json!(text(result)))
}

fn outcome(step: &serde_json::Value) -> serde_json::Value {
    serde_json::from_str(step["result"]["text"].as_str().unwrap_or("null")).unwrap()
}

fn copied(r: &Rig, template: &str) -> Definition {
    let cfg = r.app.config().unwrap();
    r.app
        .pipelines
        .library()
        .copy_template(template, &cfg)
        .unwrap()
}

fn by_hand(r: &Rig, template: &str) -> Definition {
    let mut def = copied(r, template);
    def.trigger = Trigger::Manual;
    let cfg = r.app.config().unwrap();
    r.app.pipelines.library().save(def, &cfg).unwrap()
}

async fn approve(r: &Rig, c: &str, id: &str, step: &serde_json::Value) -> serde_json::Value {
    let url = format!(
        "/dispatch/conversations/{id}/actions/{}",
        step["id"].as_str().unwrap()
    );
    let (status, done) = step_post(r, c, &url, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    done
}

fn step_named<'a>(def: &'a mut serde_json::Value, id: &str) -> &'a mut serde_json::Value {
    def["steps"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == id)
        .unwrap()
}

#[tokio::test]
async fn a_new_pipeline_waits_and_saves_switched_off() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    set_rules(
        &r,
        "allow",
        json!([{ "action": "save_pipeline", "approval": "allow" }]),
    );
    let mut def = json!(by_hand(&r, IMPLEMENT));
    def["id"] = json!("");
    def["name"] = json!("Nightly tickets");
    def["enabled"] = json!(true);
    let result = dispatch_tool(&r, Some(&id), "save_pipeline", json!({ "definition": def })).await;
    assert_eq!(result["isError"], false, "{result}");
    assert!(text(&result).starts_with("Not run yet"), "{result}");
    let step = last_event(&r, &id);
    assert!(step["input"]["before"].is_null());

    let done = approve(&r, &c, &id, &step).await;
    let saved = outcome(&done);
    let made = r
        .app
        .pipelines
        .library()
        .get(saved["saved"].as_str().unwrap())
        .unwrap();
    assert_eq!(made.name, "Nightly tickets");
    assert!(!made.enabled);
    assert_eq!(saved["version"], 1);
}

#[tokio::test]
async fn a_changed_pipeline_shows_its_changes() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let before = by_hand(&r, IMPLEMENT);
    let mut def = json!(before);
    step_named(&mut def, "review")["name"] = json!("Code review");
    step_named(&mut def, "implement")["next"]["fail"] = json!("fix");
    let words = format!(
        "{} Keep commits small.",
        step_named(&mut def, "implement")["instructions"]
            .as_str()
            .unwrap()
    );
    step_named(&mut def, "implement")["instructions"] = json!(words);
    dispatch_tool(&r, Some(&id), "save_pipeline", json!({ "definition": def })).await;
    let step = last_event(&r, &id);
    let changes = &step["input"]["changes"];
    assert_eq!(step["input"]["before"]["version"], before.version);
    assert!(
        changes["changed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["step"] == "Code review" && c["fields"] == json!(["name"])),
        "{changes}"
    );
    assert_eq!(
        changes["lines"],
        json!([{ "from": "Implement", "outcome": "fail", "was": "wait for you", "now": "Fix" }])
    );
    assert_eq!(changes["wording"][0]["step"], "Implement");
    assert_eq!(changes["trigger"], false);

    let done = approve(&r, &c, &id, &step).await;
    assert_eq!(outcome(&done)["version"], before.version + 1);
}

#[tokio::test]
async fn a_broken_pipeline_returns_its_problems_and_no_card() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let mut def = json!(by_hand(&r, IMPLEMENT));
    step_named(&mut def, "implement")["next"]["pass"] = json!("nowhere");
    let events = r.app.dispatch.get(&id).unwrap()["events"]
        .as_array()
        .unwrap()
        .len();
    let result = dispatch_tool(&r, Some(&id), "save_pipeline", json!({ "definition": def })).await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        text(&result).contains("Implement: its pass line goes to a step that does not exist"),
        "{result}"
    );
    assert_eq!(
        r.app.dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        events
    );
}

#[tokio::test]
async fn approving_an_older_pipeline_says_what_it_replaced() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let before = by_hand(&r, IMPLEMENT);
    let mut older = json!(before);
    step_named(&mut older, "review")["name"] = json!("Review A");
    dispatch_tool(
        &r,
        Some(&id),
        "save_pipeline",
        json!({ "definition": older }),
    )
    .await;
    let first = last_event(&r, &id);
    let mut newer = json!(before);
    step_named(&mut newer, "review")["name"] = json!("Review B");
    dispatch_tool(
        &r,
        Some(&id),
        "save_pipeline",
        json!({ "definition": newer }),
    )
    .await;
    let second = last_event(&r, &id);
    approve(&r, &c, &id, &second).await;
    let done = approve(&r, &c, &id, &first).await;
    let said = outcome(&done);
    assert_eq!(said["version"], before.version + 2);
    assert_eq!(said["replaced"], before.version + 1);
    assert!(
        said["note"].as_str().unwrap().contains("changed since"),
        "{said}"
    );
    let now = r.app.pipelines.library().get(&before.id).unwrap();
    assert_eq!(now.step("review").unwrap().name, "Review A");
}

#[tokio::test]
async fn switching_on_a_pipeline_that_cannot_run_is_refused() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let def = copied(&r, REVIEW);
    let result = dispatch_tool(
        &r,
        Some(&id),
        "set_pipeline_enabled",
        json!({ "id": def.id, "on": true }),
    )
    .await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        text(&result).contains("gitlab_reviewer needs a host"),
        "{result}"
    );
    assert!(r.app.dispatch.pending(&id).is_empty());
}

#[tokio::test]
async fn set_pipeline_enabled_follows_the_rules() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let def = by_hand(&r, IMPLEMENT);
    set_rules(&r, "allow", json!([]));
    let result = dispatch_tool(
        &r,
        Some(&id),
        "set_pipeline_enabled",
        json!({ "id": def.id, "on": true }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(answer(&result)["enabled"], true);
    assert!(r.app.pipelines.library().get(&def.id).unwrap().enabled);

    set_rules(
        &r,
        "allow",
        json!([{ "action": "set_pipeline_enabled", "approval": "deny" }]),
    );
    let result = dispatch_tool(
        &r,
        Some(&id),
        "set_pipeline_enabled",
        json!({ "id": def.id, "on": false }),
    )
    .await;
    assert!(text(&result).starts_with("Refused, not run"), "{result}");
    assert!(r.app.pipelines.library().get(&def.id).unwrap().enabled);
}

#[tokio::test]
async fn pipeline_tools_reach_outside_clients_as_proposals() {
    let r = rig();
    mcp_on(&r);
    let (_, listed) = mcp(
        &r.app,
        Some("yb_secret"),
        None,
        rpc("tools/list", json!({})),
    )
    .await;
    for tool in [
        "save_pipeline",
        "set_pipeline_enabled",
        "run_pipeline",
        "answer_run",
    ] {
        assert!(listed.to_string().contains(tool), "{tool} is not listed");
    }
    let def = by_hand(&r, IMPLEMENT);
    let result = tool_call(
        &r,
        "set_pipeline_enabled",
        json!({ "id": def.id, "on": true }),
    )
    .await;
    assert!(text(&result).contains("Proposals inbox"), "{result}");
    assert!(!r.app.pipelines.library().get(&def.id).unwrap().enabled);
}

async fn fake_linear() -> String {
    let app = axum::Router::new().fallback(|| async {
        json!({"data":{"viewer":{"assignedIssues":{"nodes":[
            {"id":"u-1","identifier":"COM-1","title":"Fix login","url":"https://linear.app/c/issue/COM-1","state":{"name":"Todo"}}
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

fn waiting_run(r: &Rig, kind: crate::pipeline::record::WaitKind, conversation: &str) -> String {
    use crate::pipeline::record::{RunState, Subject, Waiting};
    let def = by_hand(r, IMPLEMENT);
    let mut run = r
        .app
        .pipelines
        .start(&def.id, vec![Subject::default()], "you")
        .unwrap()
        .remove(0);
    run.state = RunState::Waiting;
    run.step = "implement".into();
    run.conversation = conversation.into();
    run.waiting = Some(Waiting {
        kind,
        step: "implement".into(),
        reason: "Which docker stack should it use?".into(),
        screen: String::new(),
        tool_hash: String::new(),
    });
    let id = run.id.clone();
    r.app.pipelines.put(run);
    id
}

const MR: &str = "https://git.commslayer.com/commslayer/app/-/merge_requests/87";

#[tokio::test]
async fn run_pipeline_starts_a_run_by_dispatch() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let def = by_hand(&r, IMPLEMENT);
    let result = dispatch_tool(
        &r,
        Some(&id),
        "run_pipeline",
        json!({ "id": def.id, "prs": [MR] }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    let run = answer(&result)["runs"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let run = r.app.pipelines.run(&run).unwrap();
    assert_eq!(run.started_by, "dispatch");
    assert_eq!(run.subject.pr.unwrap().number, 87);

    let result = dispatch_tool(
        &r,
        Some(&id),
        "run_pipeline",
        json!({ "id": def.id, "prs": ["https://example.com/x"] }),
    )
    .await;
    assert!(
        text(&result).contains("is not a GitHub pull request or GitLab merge request link"),
        "{result}"
    );
}

#[tokio::test]
async fn run_pipeline_with_an_unknown_ticket_fails_on_the_card() {
    let r = rig();
    with_linear(&r).await;
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let def = by_hand(&r, IMPLEMENT);
    dispatch_tool(
        &r,
        Some(&id),
        "run_pipeline",
        json!({ "id": def.id, "tickets": ["COM-99"] }),
    )
    .await;
    let step = last_event(&r, &id);
    assert_eq!(step["tool"], "run_pipeline");
    let done = approve(&r, &c, &id, &step).await;
    assert_eq!(done["result"]["ok"], false, "{done}");
    assert!(
        done["result"]["text"]
            .as_str()
            .unwrap()
            .contains("COM-99 is not one of your open tickets in Linear"),
        "{done}"
    );
    assert!(r.app.pipelines.runs().is_empty());
}

#[tokio::test]
async fn answer_run_answers_a_waiting_run() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let run = waiting_run(&r, crate::pipeline::record::WaitKind::Asking, "");
    let result = dispatch_tool(
        &r,
        Some(&id),
        "answer_run",
        json!({ "id": run, "action": "answer", "text": "Use the shared stack" }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    assert_ne!(answer(&result)["state"], "waiting", "{result}");
    let step = last_event(&r, &id);
    assert_eq!(
        step["input"]["waiting"]["reason"],
        "Which docker stack should it use?"
    );

    let result = dispatch_tool(
        &r,
        Some(&id),
        "answer_run",
        json!({ "id": run, "action": "answer", "text": "again" }),
    )
    .await;
    assert!(
        text(&result).contains("is not waiting for an answer"),
        "{result}"
    );
}

#[tokio::test]
async fn answer_run_on_a_run_that_stopped_waiting_fails_cleanly() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let run = waiting_run(&r, crate::pipeline::record::WaitKind::Stopped, "");
    dispatch_tool(
        &r,
        Some(&id),
        "answer_run",
        json!({ "id": run, "action": "continue_pass" }),
    )
    .await;
    let step = last_event(&r, &id);
    assert_eq!(step["tool"], "answer_run");
    let (status, body) = step_post(&r, &c, &format!("/api/runs/{run}/drop"), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let done = approve(&r, &c, &id, &step).await;
    assert_eq!(done["result"]["ok"], false, "{done}");
    assert!(
        done["result"]["text"]
            .as_str()
            .unwrap()
            .contains("is not waiting for you"),
        "{done}"
    );
    assert_eq!(
        r.app.pipelines.run(&run).unwrap().state,
        crate::pipeline::record::RunState::Dropped
    );
}

#[tokio::test]
async fn a_runs_own_turn_cannot_answer_it() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let run = waiting_run(&r, crate::pipeline::record::WaitKind::NeedsYou, &id);
    for (tool, args) in [
        (
            "answer_run",
            json!({ "id": run, "action": "continue_pass" }),
        ),
        ("change_settings", json!({ "area": "phone", "value": {} })),
    ] {
        let result = dispatch_tool(&r, Some(&id), tool, args).await;
        assert_eq!(result["isError"], true, "{tool}: {result}");
        assert!(
            text(&result).contains("A pipeline run's own Dispatch turn cannot change"),
            "{result}"
        );
    }
    assert_eq!(
        r.app.pipelines.run(&run).unwrap().state,
        crate::pipeline::record::RunState::Waiting
    );
}

#[tokio::test]
async fn an_answer_for_an_earlier_wait_is_refused() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let run = waiting_run(&r, crate::pipeline::record::WaitKind::Stopped, "");
    dispatch_tool(
        &r,
        Some(&id),
        "answer_run",
        json!({ "id": run, "action": "continue_pass" }),
    )
    .await;
    let step = last_event(&r, &id);
    let mut later = r.app.pipelines.run(&run).unwrap();
    later.step = "review".into();
    later.waiting = Some(crate::pipeline::record::Waiting {
        kind: crate::pipeline::record::WaitKind::Stopped,
        step: "review".into(),
        reason: "Review failed".into(),
        screen: String::new(),
        tool_hash: String::new(),
    });
    r.app.pipelines.put(later);
    let done = approve(&r, &c, &id, &step).await;
    assert_eq!(done["result"]["ok"], false, "{done}");
    assert!(
        done["result"]["text"]
            .as_str()
            .unwrap()
            .contains("now waits at review"),
        "{done}"
    );
    let now = r.app.pipelines.run(&run).unwrap();
    assert_eq!(now.state, crate::pipeline::record::RunState::Waiting);
    assert_eq!(now.step, "review");
}

#[tokio::test]
async fn two_new_pipeline_cards_make_two_pipelines() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let mut def = json!(by_hand(&r, IMPLEMENT));
    def["id"] = json!("nightly-tickets");
    def["name"] = json!("Nightly tickets");
    dispatch_tool(&r, Some(&id), "save_pipeline", json!({ "definition": def })).await;
    let first = last_event(&r, &id);
    dispatch_tool(&r, Some(&id), "save_pipeline", json!({ "definition": def })).await;
    let second = last_event(&r, &id);
    let a = outcome(&approve(&r, &c, &id, &first).await);
    let b = outcome(&approve(&r, &c, &id, &second).await);
    assert_ne!(a["saved"], b["saved"], "{a} {b}");
    assert_eq!(
        (a["version"].clone(), b["version"].clone()),
        (json!(1), json!(1))
    );
}

#[tokio::test]
async fn a_change_to_a_deleted_pipeline_fails() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let before = by_hand(&r, IMPLEMENT);
    let mut def = json!(before);
    step_named(&mut def, "review")["name"] = json!("Code review");
    dispatch_tool(&r, Some(&id), "save_pipeline", json!({ "definition": def })).await;
    let step = last_event(&r, &id);
    r.app.pipelines.delete(&before.id).unwrap();
    let done = approve(&r, &c, &id, &step).await;
    assert_eq!(done["result"]["ok"], false, "{done}");
    assert!(
        done["result"]["text"]
            .as_str()
            .unwrap()
            .contains("was deleted since this was proposed"),
        "{done}"
    );
    assert!(r.app.pipelines.library().get(&before.id).is_none());
}

#[tokio::test]
async fn an_edit_naming_another_pipeline_is_refused() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let shown = by_hand(&r, IMPLEMENT);
    let other = by_hand(&r, IMPLEMENT);
    let mut def = json!(shown);
    step_named(&mut def, "review")["name"] = json!("Code review");
    dispatch_tool(&r, Some(&id), "save_pipeline", json!({ "definition": def })).await;
    let step = last_event(&r, &id);
    let mut edited = step["input"].clone();
    edited["definition"]["id"] = json!(other.id);
    let url = format!(
        "/dispatch/conversations/{id}/actions/{}",
        step["id"].as_str().unwrap()
    );
    let (status, body) = step_post(
        &r,
        &c,
        &url,
        json!({ "decision": "approve", "input": edited }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("names another pipeline"),
        "{body}"
    );
    assert_eq!(
        r.app.pipelines.library().get(&other.id).unwrap().version,
        other.version
    );
}

#[tokio::test]
async fn a_trigger_problem_on_a_pipeline_that_is_on_returns_to_dispatch() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let def = by_hand(&r, IMPLEMENT);
    let cfg = r.app.config().unwrap();
    r.app
        .pipelines
        .library()
        .set_enabled(&def.id, true, &cfg)
        .unwrap();
    let mut sent = json!(def);
    sent["enabled"] = json!(false);
    sent["trigger"] = json!({ "kind": "schedule", "schedule": "whenever you like" });
    let result = dispatch_tool(
        &r,
        Some(&id),
        "save_pipeline",
        json!({ "definition": sent }),
    )
    .await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(text(&result).contains("Not proposed"), "{result}");
    assert!(r.app.dispatch.pending(&id).is_empty());
}

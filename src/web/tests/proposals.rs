use super::*;

fn text(result: &serde_json::Value) -> String {
    result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn phone(wait_minutes: u64) -> serde_json::Value {
    json!({
        "wait_minutes": wait_minutes,
        "agent_waiting": true,
        "session_ended": false,
        "machines": true,
        "memory": true,
    })
}

fn saved(r: &Rig) -> Config {
    Config::load(&r._dir.path().join("yardbell.yml")).unwrap()
}

async fn client(r: &Rig, agent: Option<&str>, body: serde_json::Value) -> serde_json::Value {
    let mut req = Request::post("/mcp")
        .header(header::HOST, "localhost:4000")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, "Bearer yb_secret");
    if let Some(agent) = agent {
        req = req.header(header::USER_AGENT, agent);
    }
    let res = router(r.app.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["result"].clone()
}

async fn propose(r: &Rig, tool: &str, args: serde_json::Value) -> serde_json::Value {
    client(
        r,
        Some("claude-code/2.1.0 (linux)"),
        rpc("tools/call", json!({ "name": tool, "arguments": args })),
    )
    .await
}

#[tokio::test]
async fn an_outside_change_becomes_a_proposal() {
    let r = rig();
    mcp_on(&r);
    let result = propose(
        &r,
        "change_settings",
        json!({ "area": "phone", "value": phone(7) }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    assert!(
        text(&result).starts_with("Not run yet. This is proposal"),
        "{result}"
    );
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 2);
    let listed = r.app.proposals.list();
    assert_eq!(listed.len(), 1);
    let p = &listed[0];
    assert_eq!(
        (
            &p["tool"],
            &p["status"],
            &p["by"],
            &p["from"],
            &p["input"]["area"]
        ),
        (
            &json!("change_settings"),
            &json!("pending"),
            &json!("client"),
            &json!("claude-code"),
            &json!("phone")
        )
    );
    assert!(text(&result).contains(p["id"].as_str().unwrap()));
}

#[tokio::test]
async fn a_client_without_a_name_is_an_mcp_client() {
    let r = rig();
    mcp_on(&r);
    client(
        &r,
        None,
        rpc("tools/call", json!({ "name": "save_task", "arguments": { "name": "Notes", "text": "Sum up my day" } })),
    )
    .await;
    assert_eq!(r.app.proposals.list()[0]["from"], "an MCP client");
}

#[tokio::test]
async fn a_failing_outside_change_makes_no_proposal() {
    let r = rig();
    mcp_on(&r);
    let result = propose(
        &r,
        "change_settings",
        json!({ "area": "phone", "value": phone(500) }),
    )
    .await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        text(&result).contains("wait_minutes must be from 0 to 60"),
        "{result}"
    );
    assert!(r.app.proposals.list().is_empty());
}

#[tokio::test]
async fn a_deny_rule_refuses_an_outside_proposal() {
    let r = rig();
    mcp_on(&r);
    set_rules(
        &r,
        "allow",
        json!([{ "action": "change_settings", "approval": "deny" }]),
    );
    let result = propose(
        &r,
        "change_settings",
        json!({ "area": "phone", "value": phone(7) }),
    )
    .await;
    assert!(text(&result).starts_with("Refused, not run"), "{result}");
    assert!(r.app.proposals.list().is_empty());
}

#[tokio::test]
async fn an_allow_rule_still_only_proposes() {
    let r = rig();
    mcp_on(&r);
    set_rules(
        &r,
        "allow",
        json!([{ "action": "change_settings", "approval": "allow" }]),
    );
    let result = propose(
        &r,
        "change_settings",
        json!({ "area": "phone", "value": phone(7) }),
    )
    .await;
    assert!(text(&result).starts_with("Not run yet"), "{result}");
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 2);
    assert_eq!(r.app.proposals.waiting(), 1);
}

#[tokio::test]
async fn outside_clients_see_the_change_tools_but_not_remember() {
    let r = rig();
    mcp_on(&r);
    let listed = client(&r, None, rpc("tools/list", json!({})))
        .await
        .to_string();
    for tool in [
        "change_settings",
        "save_task",
        "run_trigger",
        "save_pipeline",
        "answer_run",
    ] {
        assert!(
            listed.contains(&format!("\"{tool}\"")),
            "{tool} is not listed"
        );
    }
    assert!(!listed.contains("\"remember\""));
    let result = propose(
        &r,
        "remember",
        json!({ "change": "add", "entry": "x", "reason": "y" }),
    )
    .await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(r.app.proposals.list().is_empty());
}

async fn decide(
    r: &Rig,
    c: &str,
    id: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    step_post(r, c, &format!("/api/proposals/{id}"), body).await
}

async fn proposed_phone(r: &Rig, wait: u64) -> String {
    propose(
        r,
        "change_settings",
        json!({ "area": "phone", "value": phone(wait) }),
    )
    .await;
    r.app.proposals.list()[0]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn pushes(r: &Rig) -> Vec<String> {
    r.app
        .phone
        .inbox
        .page(Some("another boot"), 0, std::time::Instant::now())
        .notes
        .iter()
        .map(|n| n.message.clone())
        .collect()
}

#[tokio::test]
async fn approving_a_proposal_runs_it() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    let id = proposed_phone(&r, 7).await;
    let (status, done) = decide(&r, &c, &id, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(
        (&done["status"], &done["result"]["ok"]),
        (&json!("approved"), &json!(true))
    );
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 7);
}

#[tokio::test]
async fn an_edited_proposal_is_checked_first() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    let id = proposed_phone(&r, 7).await;
    let (status, body) = decide(
        &r,
        &c,
        &id,
        json!({ "decision": "approve", "input": { "area": "phone", "value": phone(500) } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("from 0 to 60"),
        "{body}"
    );
    assert_eq!(r.app.proposals.get(&id).unwrap()["status"], "pending");
    let (status, done) = decide(
        &r,
        &c,
        &id,
        json!({ "decision": "approve", "input": { "area": "phone", "value": phone(9) } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["status"], "edited");
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 9);
}

#[tokio::test]
async fn rejecting_a_proposal_changes_nothing() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    let id = proposed_phone(&r, 7).await;
    let (status, done) = decide(&r, &c, &id, json!({ "decision": "reject" })).await;
    assert_eq!(
        (status, &done["status"]),
        (StatusCode::OK, &json!("rejected"))
    );
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 2);
    let (status, _) = decide(&r, &c, "nosuchid", json!({ "decision": "reject" })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_proposal_is_decided_once() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    let id = proposed_phone(&r, 7).await;
    decide(&r, &c, &id, json!({ "decision": "approve" })).await;
    let (status, body) = decide(&r, &c, &id, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "this proposal was already approved");
}

#[tokio::test]
async fn a_proposal_that_no_longer_passes_fails_on_its_card() {
    use crate::pipeline::record::{RunState, Subject, WaitKind, Waiting};
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    let cfg = r.app.config().unwrap();
    let library = r.app.pipelines.library();
    let mut def = library
        .copy_template("Implement my Linear tickets", &cfg)
        .unwrap();
    def.trigger = crate::pipeline::definition::Trigger::Manual;
    let def = library.save(def, &cfg).unwrap();
    let mut run = r
        .app
        .pipelines
        .start(&def.id, vec![Subject::default()], "you")
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
    propose(
        &r,
        "answer_run",
        json!({ "id": run_id, "action": "continue_pass" }),
    )
    .await;
    let id = r.app.proposals.list()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    r.app.pipelines.drop_run(&run_id).unwrap();
    let (status, done) = decide(&r, &c, &id, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["result"]["ok"], false, "{done}");
    assert!(
        done["result"]["text"]
            .as_str()
            .unwrap()
            .contains("is not waiting for you"),
        "{done}"
    );
    assert_eq!(
        r.app.pipelines.run(&run_id).unwrap().state,
        RunState::Dropped
    );
}

#[tokio::test]
async fn one_phone_push_for_a_burst_of_proposals() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    for wait in 0..20 {
        proposed_phone(&r, wait).await;
    }
    assert_eq!(
        pushes(&r),
        vec!["A proposal from claude-code waits for you".to_string()]
    );
    assert_eq!(r.app.proposals.waiting(), 20);
    let (status, listed) = step_get(&r, &c, "/api/proposals?opened=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["waiting"], 20);
    proposed_phone(&r, 21).await;
    assert_eq!(pushes(&r).len(), 2);
}

#[tokio::test]
async fn an_open_page_polling_does_not_undo_the_push_limit() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    for wait in 0..5 {
        proposed_phone(&r, wait).await;
        step_get(&r, &c, "/api/proposals").await;
    }
    assert_eq!(pushes(&r).len(), 1);
}

#[tokio::test]
async fn too_many_waiting_proposals_are_refused() {
    let r = rig();
    mcp_on(&r);
    for _ in 0..100 {
        r.app
            .proposals
            .add("save_task", json!({}), "x", chrono::Local::now());
    }
    let result = propose(
        &r,
        "save_task",
        json!({ "name": "Notes", "text": "Sum up my day" }),
    )
    .await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        text(&result).contains("100 proposals already wait for the user"),
        "{result}"
    );
    assert_eq!(r.app.proposals.waiting(), 100);
}

#[tokio::test]
async fn a_huge_proposal_is_refused() {
    let r = rig();
    mcp_on(&r);
    let text_300k = "word ".repeat(60_000);
    let result = propose(
        &r,
        "save_task",
        json!({ "name": "Huge", "text": text_300k }),
    )
    .await;
    assert_eq!(result["isError"], true);
    assert!(text(&result).contains("too large to propose"), "{result}");
    assert!(r.app.proposals.list().is_empty());
}

#[tokio::test]
async fn a_client_cannot_call_itself_dispatch() {
    let r = rig();
    mcp_on(&r);
    for agent in ["Dispatch/1.0", "yardbell", "YOU"] {
        client(
            &r,
            Some(agent),
            rpc(
                "tools/call",
                json!({ "name": "save_task", "arguments": { "name": agent, "text": "x" } }),
            ),
        )
        .await;
    }
    for p in r.app.proposals.list() {
        assert_eq!(p["from"], "an MCP client", "{p}");
    }
}

#[tokio::test]
async fn state_counts_waiting_proposals() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    proposed_phone(&r, 3).await;
    proposed_phone(&r, 4).await;
    let (_, state) = step_get(&r, &c, "/state").await;
    assert_eq!(state["proposals"], 2);
}

async fn step_get(r: &Rig, cookie: &str, url: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::get(url)
        .header(header::COOKIE, cookie)
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (
        status,
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
    )
}

async fn step_delete(r: &Rig, cookie: &str, url: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::delete(url)
        .header(header::COOKIE, cookie)
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (
        status,
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn a_proposal_can_be_deleted_without_running() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    let id = proposed_phone(&r, 7).await;
    let (status, body) = step_delete(&r, &c, &format!("/api/proposals/{id}")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(r.app.proposals.get(&id).is_none());
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 2);
    let (status, _) = step_delete(&r, &c, &format!("/api/proposals/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn clearing_keeps_what_still_waits() {
    let r = rig();
    mcp_on(&r);
    let c = cookie(&r.app).await;
    let decided = proposed_phone(&r, 7).await;
    decide(&r, &c, &decided, json!({ "decision": "reject" })).await;
    let waiting = proposed_phone(&r, 8).await;
    let (status, body) = step_post(&r, &c, "/api/proposals/clear", json!({})).await;
    assert_eq!(
        (status, &body["cleared"]),
        (StatusCode::OK, &json!(1)),
        "{body}"
    );
    let ids: Vec<serde_json::Value> = r
        .app
        .proposals
        .list()
        .iter()
        .map(|p| p["id"].clone())
        .collect();
    assert_eq!(ids, vec![json!(waiting)]);
}

#[tokio::test]
async fn instructions_say_changes_wait_in_the_inbox() {
    let r = rig();
    mcp_on(&r);
    let init = client(
        &r,
        None,
        rpc("initialize", json!({ "protocolVersion": "2025-03-26" })),
    )
    .await;
    let words = init["instructions"].as_str().unwrap();
    assert!(words.contains("Proposals inbox"), "{words}");
    assert!(
        words.contains("never runs before the user approves it"),
        "{words}"
    );
    let listed = client(&r, None, rpc("tools/list", json!({}))).await;
    let change = listed["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "change_settings")
        .unwrap();
    assert!(
        change["description"]
            .as_str()
            .unwrap()
            .contains("Proposals inbox"),
        "{change}"
    );
}

#[tokio::test]
async fn a_proposal_push_follows_its_switch() {
    let r = rig();
    mcp_on(&r);
    let mut phone = saved(&r).phone_notifications;
    phone.proposals = false;
    r.app
        .settings
        .change(|cfg| {
            cfg.phone_notifications = phone;
            Ok(())
        })
        .unwrap();
    proposed_phone(&r, 7).await;
    assert!(pushes(&r).is_empty());
    assert_eq!(r.app.proposals.waiting(), 1);
}

#[tokio::test]
async fn old_config_keeps_every_notification_on() {
    let phone: crate::config::PhoneNotifications =
        serde_json::from_value(json!({ "wait_minutes": 5 })).unwrap();
    assert!(phone.pipeline_waiting && phone.pipeline_finished && phone.proposals);
}

use super::*;

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

fn saved(r: &Rig) -> Config {
    Config::load(&r._dir.path().join("yardbell.yml")).unwrap()
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

async fn change(r: &Rig, id: &str, area: &str, value: serde_json::Value) -> serde_json::Value {
    dispatch_tool(
        r,
        Some(id),
        "change_settings",
        json!({ "area": area, "value": value }),
    )
    .await
}

#[tokio::test]
async fn a_change_waits_then_applies_on_approve() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    let result = change(&r, &id, "phone", phone(7)).await;
    assert_eq!(result["isError"], false, "{result}");
    assert!(text(&result).starts_with("Not run yet"), "{result}");
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 2);

    let step = last_event(&r, &id);
    assert_eq!(step["tool"], "change_settings");
    assert_eq!(step["input"]["area"], "phone");
    assert_eq!(step["input"]["before"]["wait_minutes"], 2);
    assert!(step["input"]["diff"]
        .as_array()
        .is_some_and(|d| !d.is_empty()));

    let url = format!(
        "/dispatch/conversations/{id}/actions/{}",
        step["id"].as_str().unwrap()
    );
    let (status, done) = step_post(&r, &c, &url, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(outcome(&done)["saved"], "phone", "{done}");
    let cfg = saved(&r);
    assert_eq!(cfg.phone_notifications.wait_minutes, 7);
    assert!(!cfg.phone_notifications.session_ended);
}

#[tokio::test]
async fn approving_a_stale_change_says_what_it_replaced() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    change(&r, &id, "phone", phone(7)).await;
    let older = last_event(&r, &id)["id"].as_str().unwrap().to_string();
    change(&r, &id, "phone", phone(11)).await;
    let newer = last_event(&r, &id)["id"].as_str().unwrap().to_string();
    let url = |step: &str| format!("/dispatch/conversations/{id}/actions/{step}");
    step_post(&r, &c, &url(&newer), json!({ "decision": "approve" })).await;
    let (status, done) = step_post(&r, &c, &url(&older), json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 7);
    let outcome = outcome(&done);
    assert_eq!(outcome["replaced"]["wait_minutes"], 11, "{done}");
    assert!(outcome["note"].as_str().unwrap().contains("changed since"));
}

#[tokio::test]
async fn allow_applies_at_once_and_undo_restores() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let result = change(&r, &id, "phone", phone(9)).await;
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(answer(&result)["saved"], "phone", "{result}");
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 9);
    assert_eq!(last_event(&r, &id)["status"], "auto");

    r.app.settings.undo().unwrap();
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 2);
}

#[tokio::test]
async fn settings_offers_undo_for_a_change_dispatch_made() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    set_rules(&r, "allow", json!([]));
    change(&r, &id, "phone", phone(9)).await;
    let (data, _) = get_settings(&r, &c).await;
    assert_eq!(data["can_undo"], true);
    assert_eq!(data["undo_note"], "Dispatch changed the phone settings.");

    r.app.settings.set_triggers(Vec::new()).unwrap();
    let (data, _) = get_settings(&r, &c).await;
    assert!(data["undo_note"].is_null(), "{data}");
}

#[tokio::test]
async fn the_dispatch_area_always_waits() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(
        &r,
        "allow",
        json!([{ "action": "change_settings", "approval": "allow" }]),
    );
    let read = dispatch_tool(
        &r,
        Some(&id),
        "read_settings",
        json!({ "area": "dispatch" }),
    )
    .await;
    let mut value = answer(&read)["value"].clone();
    value["instructions"] = json!("Answer in short sentences.");
    let result = change(&r, &id, "dispatch", value).await;
    assert_eq!(result["isError"], false, "{result}");
    assert!(text(&result).starts_with("Not run yet"), "{result}");
    assert!(saved(&r).dispatch.instructions.is_empty());
    assert_eq!(r.app.dispatch.pending(&id).len(), 1);
}

#[tokio::test]
async fn a_deny_rule_refuses_change_settings() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(
        &r,
        "allow",
        json!([{ "action": "change_settings", "approval": "deny" }]),
    );
    for (area, value) in [("phone", phone(5)), ("triggers", json!([]))] {
        let result = change(&r, &id, area, value).await;
        assert_eq!(result["isError"], true, "{area}: {result}");
        assert!(text(&result).starts_with("Refused, not run"), "{result}");
    }
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 2);
    assert!(r.app.dispatch.pending(&id).is_empty());
}

#[tokio::test]
async fn a_failing_change_returns_its_problems_and_no_card() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let before = r.app.dispatch.get(&id).unwrap()["events"]
        .as_array()
        .unwrap()
        .len();
    let result = change(&r, &id, "phone", phone(500)).await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        text(&result).contains("wait_minutes must be from 0 to 60"),
        "{result}"
    );
    let result = change(
        &r,
        &id,
        "machines",
        json!([{ "name": "new-box", "local": true }]),
    )
    .await;
    assert!(
        text(&result).contains("adding or removing a machine"),
        "{result}"
    );
    let after = r.app.dispatch.get(&id).unwrap()["events"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(before, after);
}

#[tokio::test]
async fn a_hidden_value_survives_a_change_and_never_reaches_the_card() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    r.app
        .settings
        .set_mcp_servers(vec![crate::config::McpServer {
            name: "probe".into(),
            command: "npx probe-mcp".into(),
            url: String::new(),
            env: [("TOKEN".to_string(), "sk-planted-real".to_string())].into(),
            headers: Default::default(),
            machines: vec![],
        }])
        .unwrap();
    let read = dispatch_tool(
        &r,
        Some(&id),
        "read_settings",
        json!({ "area": "session_mcp_servers" }),
    )
    .await;
    let mut value = answer(&read)["value"].clone();
    assert_eq!(value[0]["env"]["TOKEN"], "(hidden)", "{value}");
    value[0]["machines"] = json!(["hp"]);
    let result = change(&r, &id, "session_mcp_servers", value).await;
    assert_eq!(result["isError"], false, "{result}");

    let step = last_event(&r, &id);
    let url = format!(
        "/dispatch/conversations/{id}/actions/{}",
        step["id"].as_str().unwrap()
    );
    let (status, done) = step_post(&r, &c, &url, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");

    let cfg = saved(&r);
    assert_eq!(cfg.mcp_servers[0].env["TOKEN"], "sk-planted-real");
    assert_eq!(cfg.mcp_servers[0].machines, vec!["hp".to_string()]);
    let conversation = r.app.dispatch.get(&id).unwrap().to_string();
    assert!(!conversation.contains("sk-planted-real"), "{conversation}");
}

#[tokio::test]
async fn security_and_about_are_read_only() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    for (area, pointer) in [
        ("security", "Change this in Settings, Security"),
        ("about", "Settings, About"),
    ] {
        let result = change(&r, &id, area, json!({})).await;
        assert_eq!(result["isError"], true, "{area}: {result}");
        assert!(text(&result).contains(pointer), "{result}");
    }
    let result = change(&r, &id, "secrets", json!({})).await;
    assert!(
        text(&result).contains("dispatch, triggers, worktree_setup"),
        "{result}"
    );
    assert!(r.app.dispatch.pending(&id).is_empty());
}

#[tokio::test]
async fn an_outside_change_is_proposed_not_saved() {
    let r = rig();
    mcp_on(&r);
    let result = tool_call(
        &r,
        "change_settings",
        json!({ "area": "phone", "value": phone(4) }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    assert!(
        text(&result).contains("waiting in Yardbell's Proposals inbox"),
        "{result}"
    );
    assert_eq!(saved(&r).phone_notifications.wait_minutes, 2);
    assert_eq!(r.app.proposals.waiting(), 1);
}

#[tokio::test]
async fn outside_tasks_and_triggers_are_checked_then_proposed() {
    let r = rig();
    mcp_on(&r);
    let result = tool_call(
        &r,
        "save_task",
        json!({ "name": "Notes", "text": "Sum up my day" }),
    )
    .await;
    assert!(text(&result).contains("Proposals inbox"), "{result}");
    let result = tool_call(&r, "run_trigger", json!({ "name": "Morning" })).await;
    assert!(
        text(&result).contains("there is no trigger called Morning"),
        "{result}"
    );
    assert!(!r.app.dispatch.tasks().iter().any(|t| t.name == "Notes"));
    assert_eq!(r.app.proposals.waiting(), 1);
}

#[tokio::test]
async fn save_task_adds_a_version() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let c = cookie(&r.app).await;
    r.app
        .dispatch
        .save_task("Standup", "List what changed yesterday.", None)
        .unwrap();
    let result = dispatch_tool(
        &r,
        Some(&id),
        "save_task",
        json!({ "name": "Standup", "text": "List what changed yesterday and what waits." }),
    )
    .await;
    assert!(text(&result).starts_with("Not run yet"), "{result}");
    let step = last_event(&r, &id);
    assert_eq!(step["input"]["before"], "List what changed yesterday.");
    assert!(step["input"]["diff"]
        .as_array()
        .is_some_and(|d| !d.is_empty()));

    let url = format!(
        "/dispatch/conversations/{id}/actions/{}",
        step["id"].as_str().unwrap()
    );
    let (status, done) = step_post(&r, &c, &url, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(outcome(&done)["version"], 2, "{done}");
    let history = r.app.dispatch.task_history("Standup").unwrap();
    assert_eq!(history.versions.len(), 2);
    assert_eq!(
        history.versions.last().unwrap().text,
        "List what changed yesterday and what waits."
    );
}

#[tokio::test]
async fn a_new_task_is_created() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let result = dispatch_tool(
        &r,
        Some(&id),
        "save_task",
        json!({ "name": "Review my MRs", "text": "Review every merge request waiting on me." }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(answer(&result)["version"], 1, "{result}");
    assert_eq!(last_event(&r, &id)["input"]["before"], "");
    assert!(r
        .app
        .dispatch
        .tasks()
        .iter()
        .any(|t| t.name == "Review my MRs"));

    let empty = dispatch_tool(
        &r,
        Some(&id),
        "save_task",
        json!({ "name": "Blank", "text": "  " }),
    )
    .await;
    assert_eq!(empty["isError"], true, "{empty}");
    assert!(
        text(&empty).contains("a task needs a name and what to ask"),
        "{empty}"
    );
}

#[tokio::test]
async fn run_trigger_runs_it_now() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    r.app
        .settings
        .set_triggers(
            serde_json::from_value(json!([{
                "name": "Morning",
                "task": "What's going on?",
                "schedule": "daily 09:00",
            }]))
            .unwrap(),
        )
        .unwrap();
    let before = r.app.dispatch.list().as_array().unwrap().len();
    let result = dispatch_tool(&r, Some(&id), "run_trigger", json!({ "name": "Morning" })).await;
    assert_eq!(result["isError"], false, "{result}");
    let started = answer(&result)["conversation"]
        .as_str()
        .unwrap()
        .to_string();
    let list = r.app.dispatch.list();
    assert_eq!(list.as_array().unwrap().len(), before + 1);
    assert!(list
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == started.as_str() && c["trigger"] == "Morning"));
}

#[tokio::test]
async fn an_unknown_trigger_says_so() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let result = dispatch_tool(&r, Some(&id), "run_trigger", json!({ "name": "Nope" })).await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        text(&result).contains("there is no trigger called Nope"),
        "{result}"
    );
    assert!(r.app.dispatch.pending(&id).is_empty());
}

#[tokio::test]
async fn a_refused_change_never_quotes_a_kept_credential() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let path = r._dir.path().join("yardbell.yml");
    let mut cfg = Config::load(&path).unwrap();
    cfg.agents = vec![crate::agents::Agent {
        name: "mine".into(),
        label: Some("Mine".into()),
        command: "ANTHROPIC_API_KEY=sk-inline-real-999 claude".into(),
        resume: "claude --continue".into(),
        process: Some("claude".into()),
        prompt_arg: None,
    }];
    cfg.save(&path).unwrap();
    let read = dispatch_tool(&r, Some(&id), "read_settings", json!({ "area": "agents" })).await;
    let mut value = answer(&read)["value"].clone();
    value["custom"][0]
        .as_object_mut()
        .unwrap()
        .remove("process");
    let result = change(&r, &id, "agents", value).await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        text(&result).contains("must be a plain program name"),
        "{result}"
    );
    assert!(!text(&result).contains("sk-inline-real-999"), "{result}");
    let conversation = r.app.dispatch.get(&id).unwrap().to_string();
    assert!(!conversation.contains("sk-inline-real-999"));
}

#[tokio::test]
async fn a_change_that_uses_a_saved_secret_always_waits() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let read = dispatch_tool(
        &r,
        Some(&id),
        "read_settings",
        json!({ "area": "pull_requests" }),
    )
    .await;
    let mut value = answer(&read)["value"].clone();
    value["gitlab"] = json!([{ "host": "git.example.org", "token": "${secret:gitlab}" }]);
    let result = change(&r, &id, "pull_requests", value).await;
    assert_eq!(result["isError"], false, "{result}");
    assert!(text(&result).starts_with("Not run yet"), "{result}");
    let step = last_event(&r, &id);
    assert_eq!(
        step["input"]["secrets"],
        json!(["${secret:gitlab} in gitlab[0].token"])
    );
    assert!(saved(&r).pull_requests.gitlab.is_empty());
}

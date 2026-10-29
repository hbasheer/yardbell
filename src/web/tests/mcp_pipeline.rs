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
async fn pipeline_tools_are_hidden_from_outside_clients() {
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
        assert!(!listed.to_string().contains(tool), "{tool} is listed");
        let result = tool_call(&r, tool, json!({})).await;
        assert!(
            text(&result).contains("Proposals inbox"),
            "{tool}: {result}"
        );
    }
}

use super::*;

fn add(entry: &str) -> serde_json::Value {
    json!({ "change": "add", "entry": entry, "reason": "the user corrected me" })
}

fn entries(r: &Rig) -> Vec<String> {
    r.app.dispatch.memory().entries().unwrap()
}

fn history(r: &Rig) -> Vec<serde_json::Value> {
    r.app.dispatch.memory().view()["history"]
        .as_array()
        .unwrap()
        .clone()
}

async fn propose(r: &Rig, id: &str, args: serde_json::Value) -> (serde_json::Value, String) {
    let result = dispatch_tool(r, Some(id), "remember", args).await;
    (
        result,
        last_event(r, id)["id"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

#[tokio::test]
async fn a_memory_step_is_saved_only_once_approved() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    let url = |step: &str| format!("/dispatch/conversations/{id}/actions/{step}");

    let (result, step) = propose(&r, &id, add("Always use the shared docker stack on hp")).await;
    assert_eq!(result["isError"], false, "{result}");
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Not run yet. This is now proposal "));
    let event = last_event(&r, &id);
    assert_eq!(
        (&event["tool"], &event["status"], &event["input"]),
        (
            &json!("remember"),
            &json!("pending"),
            &add("Always use the shared docker stack on hp")
        )
    );
    assert!(entries(&r).is_empty(), "nothing is saved before approval");
    assert!(!r.app.dispatch.memory().file().exists());

    let (status, done) = step_post(&r, &c, &url(&step), json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(
        (&done["status"], &done["result"]["ok"]),
        (&json!("approved"), &json!(true))
    );
    assert_eq!(entries(&r), ["Always use the shared docker stack on hp"]);
    assert_eq!(history(&r)[0]["by"], "dispatch");
    assert_eq!(history(&r)[0]["reason"], "the user corrected me");

    let (_, rejected) = propose(&r, &id, add("Never open PRs on Fridays")).await;
    let (status, body) = step_post(&r, &c, &url(&rejected), json!({ "decision": "reject" })).await;
    assert_eq!(
        (status, &body["status"]),
        (StatusCode::OK, &json!("rejected"))
    );
    assert_eq!(entries(&r).len(), 1, "a rejected change is never saved");

    let (_, edited) = propose(
        &r,
        &id,
        json!({ "change": "replace", "old": "Always use the shared docker stack on hp", "entry": "Use docker on hp", "reason": "said again" }),
    )
    .await;
    let (status, body) = step_post(
        &r,
        &c,
        &url(&edited),
        json!({ "decision": "approve", "input": { "change": "replace", "old": "Always use the shared docker stack on hp", "entry": "Use the shared docker stack on hp, never a local one", "reason": "said again" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "edited");
    assert_eq!(body["original"]["entry"], "Use docker on hp");
    assert_eq!(
        entries(&r),
        ["Use the shared docker stack on hp, never a local one"]
    );

    let (_, stale) = propose(
        &r,
        &id,
        json!({ "change": "forget", "old": "Use the shared docker stack on hp, never a local one", "reason": "no longer true" }),
    )
    .await;
    r.app
        .dispatch
        .memory()
        .apply(
            &serde_json::from_value(json!({ "change": "forget", "old": "Use the shared docker stack on hp, never a local one" })).unwrap(),
            crate::dispatch::By::You,
        )
        .unwrap();
    let (status, body) = step_post(&r, &c, &url(&stale), json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["result"]["ok"], false);
    assert_eq!(
        body["result"]["text"],
        "\"Use the shared docker stack on hp, never a local one\" is not in memory; give the entry exactly as it is in memory"
    );

    let (status, body) = step_post(
        &r,
        &c,
        &url(
            &propose(&r, &id, add("Branches are named after the ticket"))
                .await
                .1,
        ),
        json!({ "decision": "approve", "input": { "change": "add", "entry": " ", "reason": "x" } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "the entry is empty");
    assert_eq!(
        r.app.dispatch.pending(&id).len(),
        1,
        "a bad edit decides nothing"
    );
}

#[tokio::test]
async fn memory_proposals_are_checked_before_they_reach_the_person() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let before = event_count(&r, &id);
    for (args, message) in [
        (
            json!({ "change": "add", "entry": "x", "reason": "r", "machine": "hp" }),
            "unknown field `machine`",
        ),
        (
            json!({ "change": "add", "entry": "x", "reason": " " }),
            "give a reason: what the user said or did that makes this worth remembering",
        ),
        (
            json!({ "change": "forget", "old": "nothing", "reason": "r" }),
            "\"nothing\" is not in memory; give the entry exactly as it is in memory",
        ),
        (
            json!({ "change": "move", "entry": "x", "reason": "r" }),
            "unknown variant `move`, expected one of `add`, `replace`, `forget`",
        ),
    ] {
        let result = dispatch_tool(&r, Some(&id), "remember", args).await;
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains(message), "{text}");
    }
    assert_eq!(event_count(&r, &id), before, "a mistake is no step");
}

#[tokio::test]
async fn rules_decide_memory_steps_and_approval_off_still_asks() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    r.app
        .settings
        .set_dispatch(crate::config::DispatchSettings {
            approval: crate::config::Approval::Allow,
            ..Default::default()
        })
        .unwrap();
    let (result, _) = propose(&r, &id, add("one")).await;
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Not run yet."));
    assert_eq!(last_event(&r, &id)["status"], "pending");
    assert!(
        entries(&r).is_empty(),
        "going ahead without asking leaves memory alone"
    );

    set_rules(
        &r,
        "auto",
        json!([{ "action": "remember", "approval": "allow" }]),
    );
    let (result, _) = propose(&r, &id, add("two")).await;
    assert_eq!(result["isError"], false, "{result}");
    let step = last_event(&r, &id);
    assert_eq!(
        (
            &step["status"],
            &step["result"]["ok"],
            &step["rule"]["action"]
        ),
        (&json!("auto"), &json!(true), &json!("remember"))
    );
    assert_eq!(entries(&r), ["two"]);

    set_rules(
        &r,
        "auto",
        json!([{ "action": "remember", "approval": "deny" }]),
    );
    let before = event_count(&r, &id);
    let (result, _) = propose(&r, &id, add("three")).await;
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Refused, not run: the user's Dispatch rule \"deny remember\" refuses it."));
    assert_eq!(event_count(&r, &id), before);
    assert_eq!(entries(&r), ["two"]);

    set_rules(&r, "deny", json!([]));
    let (result, _) = propose(&r, &id, add("four")).await;
    assert_eq!(result["isError"], true);
    assert_eq!(entries(&r), ["two"]);
}

#[tokio::test]
async fn other_mcp_clients_cannot_write_memory() {
    let r = rig();
    mcp_on(&r);
    let (_, body) = mcp(
        &r.app,
        Some("yb_secret"),
        None,
        rpc("tools/list", json!({})),
    )
    .await;
    assert!(body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["name"] != "remember"));
    let result = tool_call(&r, "remember", add("x")).await;
    assert_eq!(result["isError"], true);
    assert!(entries(&r).is_empty());
    let id = dispatch_conversation(&r).await;
    let listed = {
        let req = Request::post("/mcp")
            .header(header::HOST, "localhost:4000")
            .header(header::CONTENT_TYPE, "application/json")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", r.app.dispatch.token()),
            )
            .header(crate::dispatch::CONVERSATION_HEADER, id)
            .body(Body::from(rpc("tools/list", json!({})).to_string()))
            .unwrap();
        let (_, _, text) = send(&r.app, req).await;
        serde_json::from_str::<serde_json::Value>(&text).unwrap()
    };
    assert!(listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "remember"));
}

#[tokio::test]
async fn the_person_edits_memory_from_settings() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, view) = step_post(
        &r,
        &c,
        "/dispatch/memory",
        json!({ "change": "add", "entry": "Never open PRs on Fridays" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["entries"], json!(["Never open PRs on Fridays"]));
    assert_eq!(view["max_bytes"], 8192);
    assert_eq!(view["history"][0]["by"], "you");
    let (status, body) = step_post(
        &r,
        &c,
        "/dispatch/memory",
        json!({ "change": "add", "entry": "never open prs on fridays" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"],
        "\"never open prs on fridays\" is already in memory"
    );
    let req = Request::get("/dispatch/memory")
        .header(header::COOKIE, &c)
        .body(Body::empty())
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
    let view: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(view["entries"].as_array().unwrap().len(), 1);
    let req = Request::get("/dispatch/memory")
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&r.app, req).await;
    assert_ne!(status, StatusCode::OK, "memory needs a login");
}

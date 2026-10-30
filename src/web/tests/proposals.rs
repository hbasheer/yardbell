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

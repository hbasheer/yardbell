use super::*;

fn answer(result: &serde_json::Value) -> serde_json::Value {
    let text = result["content"][0]["text"].as_str().unwrap_or_default();
    serde_json::from_str(text).unwrap_or(json!(text))
}

fn edit_config(r: &Rig, change: impl FnOnce(&mut Config)) {
    let path = r._dir.path().join("yardbell.yml");
    let mut cfg = Config::load(&path).unwrap();
    change(&mut cfg);
    cfg.save(&path).unwrap();
}

const AREAS: [&str; 11] = [
    "dispatch",
    "triggers",
    "worktree_setup",
    "agents",
    "session_mcp_servers",
    "phone",
    "machines",
    "pipelines",
    "pull_requests",
    "security",
    "about",
];

#[tokio::test]
async fn read_settings_covers_every_area() {
    let r = rig();
    mcp_on(&r);
    for area in AREAS {
        let result = tool_call(&r, "read_settings", json!({ "area": area })).await;
        assert_eq!(result["isError"], false, "{area}: {result}");
        assert_eq!(answer(&result)["area"], area, "{result}");
    }
}

#[tokio::test]
async fn an_unknown_area_lists_the_valid_ones() {
    let r = rig();
    mcp_on(&r);
    let result = tool_call(&r, "read_settings", json!({ "area": "secrets" })).await;
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("dispatch, triggers, worktree_setup"),
        "{text}"
    );
    assert!(!text.contains("secrets,"), "{text}");
}

#[tokio::test]
async fn no_secret_reaches_read_settings() {
    let r = rig();
    let token = mcp_on(&r);
    edit_config(&r, |cfg| {
        cfg.mcp_servers = vec![crate::config::McpServer {
            name: "probe".into(),
            command: "probe-server".into(),
            url: String::new(),
            env: [("TOKEN".to_string(), "sk-planted-env".to_string())].into(),
            headers: [
                (
                    "Authorization".to_string(),
                    "Bearer ${secret:probe}".to_string(),
                ),
                ("X-Api-Key".to_string(), "planted-header".to_string()),
            ]
            .into(),
            machines: vec![],
        }];
        cfg.pull_requests.gitlab = vec![crate::config::GitLabHost {
            host: "git.example.com".into(),
            url: String::new(),
            token: "glpat-planted".into(),
        }];
    });
    let mut secrets = r.app.secrets().unwrap();
    secrets
        .set("linear", "lin_planted", chrono::Utc::now())
        .unwrap();
    secrets.save().unwrap();
    let cfg = r.app.config().unwrap();
    let mut seen = String::new();
    for area in AREAS {
        let result = tool_call(&r, "read_settings", json!({ "area": area })).await;
        seen.push_str(&result.to_string());
    }
    for planted in [
        "sk-planted-env",
        "planted-header",
        "glpat-planted",
        "lin_planted",
        token.as_str(),
        cfg.passcode_hash.as_deref().unwrap(),
    ] {
        assert!(!seen.contains(planted), "{planted} leaked");
    }
    assert!(
        seen.contains("${secret:probe}"),
        "a secret reference is shown as written"
    );
    assert!(seen.contains("(hidden)"));
    if let Some(key) = cfg.cookie_key.as_deref() {
        assert!(!seen.contains(key), "the cookie key leaked");
    }
}

#[tokio::test]
async fn read_settings_answers_dispatch_and_outside_clients_alike() {
    let r = rig();
    mcp_on(&r);
    let outside = tool_call(&r, "read_settings", json!({ "area": "phone" })).await;
    let inside = dispatch_tool(&r, None, "read_settings", json!({ "area": "phone" })).await;
    assert_eq!(answer(&outside), answer(&inside));
    assert_eq!(answer(&outside)["value"]["wait_minutes"], 2);
}

fn seed_conversation(r: &Rig, title: &str, big: usize) -> String {
    let id = r.app.dispatch.open_conversation(title);
    r.app.dispatch.record_as(
        &id,
        "read_session",
        json!({ "machine": "hp", "name": "hp-x" }),
        None,
        None,
        &Ok(json!({ "screen": "x".repeat(big) })),
        crate::dispatch::By::Dispatch,
        None,
    );
    id
}

#[tokio::test]
async fn conversations_are_listed_and_filtered() {
    let r = rig();
    mcp_on(&r);
    let mine = seed_conversation(&r, "Look at hp", 10);
    let piped = seed_conversation(&r, "Implement: COM-1 Fix", 10);
    let mut run = crate::pipeline::record::Run {
        id: "run1".into(),
        pipeline: "implement".into(),
        conversation: piped.clone(),
        ..Default::default()
    };
    run.state = crate::pipeline::record::RunState::Running;
    r.app.pipelines.put(run);
    let all = answer(&tool_call(&r, "list_conversations", json!({})).await);
    let ids: Vec<&str> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(
        ids.contains(&mine.as_str()) && ids.contains(&piped.as_str()),
        "{all}"
    );
    let started_by = |id: &str| {
        all.as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()["started_by"]
            .clone()
    };
    assert_eq!(
        (started_by(&mine), started_by(&piped)),
        (json!("you"), json!("a pipeline run"))
    );
    let only = answer(&tool_call(&r, "list_conversations", json!({ "filter": "pipeline" })).await);
    assert_eq!(only.as_array().unwrap().len(), 1, "{only}");
    assert_eq!(only[0]["id"], piped);
}

#[tokio::test]
async fn a_long_conversation_is_clipped() {
    let r = rig();
    mcp_on(&r);
    let id = seed_conversation(&r, "Big screen", 50_000);
    let result = tool_call(&r, "read_conversation", json!({ "id": id })).await;
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.len() < 8_000, "{} characters came back", text.len());
    let got = answer(&result);
    assert_eq!(got["clipped"], 1, "{got}");
    assert_eq!(got["title"], "Big screen");
}

#[tokio::test]
async fn an_unknown_conversation_says_so() {
    let r = rig();
    mcp_on(&r);
    let result = tool_call(&r, "read_conversation", json!({ "id": "abcdefghijklmnop" })).await;
    assert_eq!(result["isError"], true);
    assert!(
        result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("list_conversations"),
        "{result}"
    );
}

#[tokio::test]
async fn tasks_and_their_versions() {
    let r = rig();
    mcp_on(&r);
    let tasks = answer(&tool_call(&r, "list_tasks", json!({})).await);
    let first = tasks[0]["name"].as_str().unwrap().to_string();
    assert!(tasks[0]["versions"].as_u64().unwrap() >= 1, "{tasks}");
    let one = answer(&tool_call(&r, "read_task", json!({ "name": first })).await);
    assert_eq!(one["name"], first);
    assert!(
        one["text"].as_str().is_some() && one["versions"][0]["n"] == 1,
        "{one}"
    );
    let missing = tool_call(&r, "read_task", json!({ "name": "No such task" })).await;
    assert_eq!(missing["isError"], true);
}

fn implement(r: &Rig) -> crate::pipeline::definition::Definition {
    let cfg = r.app.config().unwrap();
    let lib = r.app.pipelines.library();
    let def = lib
        .copy_template("Implement my Linear tickets", &cfg)
        .unwrap();
    let mut changed = def.clone();
    changed.steps[1].name = "Build it".into();
    lib.save(changed, &cfg).unwrap()
}

#[tokio::test]
async fn pipelines_and_their_versions() {
    let r = rig();
    mcp_on(&r);
    let def = implement(&r);
    let list = answer(&tool_call(&r, "list_pipelines", json!({})).await);
    assert_eq!(list[0]["id"], def.id.as_str(), "{list}");
    assert_eq!(list[0]["version"], 2);
    assert_eq!(list[0]["steps"][1], "Build it");
    assert_eq!(
        list[0]["runs"],
        json!({ "running": 0, "waiting": 0, "done": 0 })
    );
    let one = answer(&tool_call(&r, "read_pipeline", json!({ "id": def.id })).await);
    assert_eq!(one["definition"]["steps"][1]["name"], "Build it");
    let versions: Vec<u64> = one["versions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["version"].as_u64().unwrap())
        .collect();
    assert_eq!(versions, vec![2, 1]);
}

#[tokio::test]
async fn runs_are_summaries_and_one_run_is_whole() {
    let r = rig();
    mcp_on(&r);
    let def = implement(&r);
    let mut run = r
        .app
        .pipelines
        .start(&def.id, vec![Default::default()], "you")
        .unwrap()
        .remove(0);
    run.state = crate::pipeline::record::RunState::Waiting;
    run.waiting = Some(crate::pipeline::record::Waiting {
        kind: crate::pipeline::record::WaitKind::NeedsYou,
        step: "plan".into(),
        reason: "Plan needs you".into(),
        screen: String::new(),
    });
    run.state_of("plan").report = "y".repeat(9_000);
    let id = run.id.clone();
    r.app.pipelines.put(run);
    let list = answer(&tool_call(&r, "list_runs", json!({ "state": "waiting" })).await);
    assert_eq!(list[0]["id"], id.as_str(), "{list}");
    assert_eq!(list[0]["waiting_reason"], "Plan needs you");
    assert!(list[0].get("steps").is_none(), "a list entry is a summary");
    let none = answer(&tool_call(&r, "list_runs", json!({ "state": "done" })).await);
    assert_eq!(none, json!([]));
    let whole = answer(&tool_call(&r, "read_run", json!({ "id": id })).await);
    assert!(whole.get("definition").is_none(), "{whole}");
    let report = whole["steps"]["plan"]["report"].as_str().unwrap();
    assert!(
        report.len() < 5_000 && report.contains("clipped"),
        "{report}"
    );
}

#[tokio::test]
async fn an_unknown_pipeline_or_run_says_so() {
    let r = rig();
    mcp_on(&r);
    for (tool, hint) in [
        ("read_pipeline", "list_pipelines"),
        ("read_run", "list_runs"),
    ] {
        let result = tool_call(&r, tool, json!({ "id": "nope" })).await;
        assert_eq!(result["isError"], true);
        assert!(
            result["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains(hint),
            "{result}"
        );
    }
}

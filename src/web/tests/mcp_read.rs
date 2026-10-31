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
        cfg.mcp_servers = vec![
            crate::config::McpServer {
                name: "probe".into(),
                command: "npx mcp-remote https://x/mcp --header \"Authorization: Bearer abc123planted\" --token ghp_plantedplantedplantedplantedplanted12".into(),
                url: String::new(),
                env: [("TOKEN".to_string(), "sk-planted-env".to_string())].into(),
                headers: [
                    ("Authorization".to_string(), "Bearer ${secret:probe}".to_string()),
                    ("X-Api-Key".to_string(), "planted-header".to_string()),
                ]
                .into(),
                machines: vec![],
                allow_private: false,
            },
            crate::config::McpServer {
                name: "remote".into(),
                command: String::new(),
                url: "https://user:pwplanted@mcp.example.com/sse?api_key=lin_api_queryplanted&mode=fast".into(),
                env: Default::default(),
                headers: Default::default(),
                machines: vec![],
                allow_private: false,
            },
        ];
        cfg.pull_requests.gitlab = vec![crate::config::GitLabHost {
            host: "git.example.com".into(),
            url: String::new(),
            token: "glpat-planted".into(),
        }];
        cfg.agents = vec![crate::agents::Agent {
            name: "keyed".into(),
            label: None,
            command: "ANTHROPIC_API_KEY=sk-ant-plantedplantedplantedplanted claude".into(),
            resume: "claude --continue".into(),
            process: Some("claude".into()),
            prompt_arg: None,
        }];
        cfg.worktree_setup = vec![crate::worktrees::setup::WorktreeSetup {
            teardown: String::new(),
            folder: "app".into(),
            machine: "any".into(),
            command: "echo API_TOKEN=tokplanted > .env".into(),
            timeout_seconds: 300,
        }];
        cfg.pipelines.qa_notes =
            [("acme/auth-api".to_string(), "Run bin/rspec".to_string())].into();
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
        assert_eq!(result["isError"], false, "{area}: {result}");
        seen.push_str(&result.to_string());
    }
    for planted in [
        "abc123planted",
        "ghp_plantedplanted",
        "pwplanted",
        "lin_api_queryplanted",
        "sk-ant-planted",
        "tokplanted",
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
    assert!(
        seen.contains("Run bin/rspec"),
        "a QA note for a folder named auth stays readable"
    );
    assert!(
        seen.contains("mode=(hidden)") && seen.contains("@mcp.example.com/sse"),
        "a URL keeps its host, path and query names"
    );
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
    let all =
        answer(&tool_call(&r, "list_conversations", json!({})).await)["conversations"].clone();
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
    let only = answer(&tool_call(&r, "list_conversations", json!({ "filter": "pipeline" })).await)
        ["conversations"]
        .clone();
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
        tool_hash: String::new(),
    });
    run.state_of("plan").report = "y".repeat(9_000);
    let id = run.id.clone();
    r.app.pipelines.put(run);
    let list =
        answer(&tool_call(&r, "list_runs", json!({ "state": "waiting" })).await)["runs"].clone();
    assert_eq!(list[0]["id"], id.as_str(), "{list}");
    assert_eq!(list[0]["waiting_reason"], "Plan needs you");
    assert!(list[0].get("steps").is_none(), "a list entry is a summary");
    let none = answer(&tool_call(&r, "list_runs", json!({ "state": "done" })).await);
    assert_eq!(
        (none["runs"].clone(), none["more"].clone()),
        (json!([]), json!(0))
    );
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

#[tokio::test]
async fn insights_for_a_session_and_a_machine() {
    let r = rig();
    mcp_on(&r);
    let session = crate::snapshot::Session {
        machine: "hp".into(),
        agent: "claude".into(),
        pid: 42,
        cwd: "/r/app".into(),
        folder: "app".into(),
        branch: "fix-login".into(),
        ticket: "-".into(),
        tmux: Some("hp-app".into()),
        activity: crate::snapshot::Activity::Active,
    };
    let now = chrono::Local::now();
    r.app.insights.observe(
        "hp",
        &Default::default(),
        now - chrono::Duration::minutes(10),
    );
    let snap = crate::snapshot::Snapshot {
        sessions: vec![session],
        ..Default::default()
    };
    r.app
        .insights
        .observe("hp", &snap, now - chrono::Duration::minutes(5));
    let one = answer(
        &tool_call(
            &r,
            "read_insights",
            json!({ "machine": "hp", "session": "hp-app" }),
        )
        .await,
    );
    assert_eq!(
        (one["name"].clone(), one["branch"].clone()),
        (json!("hp-app"), json!("fix-login")),
        "{one}"
    );
    let all = answer(&tool_call(&r, "read_insights", json!({ "machine": "hp" })).await);
    assert_eq!(all["sessions"][0]["name"], "hp-app", "{all}");
    let none = tool_call(
        &r,
        "read_insights",
        json!({ "machine": "hp", "session": "nope" }),
    )
    .await;
    assert_eq!(none["isError"], true);
}

#[tokio::test]
async fn pulls_from_the_cards() {
    let r = rig();
    mcp_on(&r);
    r.app.state.set_pulls(
        [(
            (
                "hp".to_string(),
                "/r/app".to_string(),
                "fix-login".to_string(),
            ),
            crate::pulls::PullView {
                forge: "github".into(),
                number: 12,
                url: "https://github.com/acme/app/pull/12".into(),
                title: "Fix login".into(),
                state: "open".into(),
                draft: false,
                review: "changes_requested".into(),
                ci: crate::pulls::Ci::Failing,
                failed: vec!["rspec".into()],
            },
        )]
        .into(),
    );
    let pulls = answer(&tool_call(&r, "list_pulls", json!({})).await);
    assert_eq!(pulls[0]["number"], 12, "{pulls}");
    assert_eq!(
        (
            pulls[0]["branch"].clone(),
            pulls[0]["failing_jobs"][0].clone()
        ),
        (json!("fix-login"), json!("rspec"))
    );
    let other = answer(&tool_call(&r, "list_pulls", json!({ "machine": "pro" })).await);
    assert_eq!(other, json!([]));
}

#[tokio::test]
async fn usage_as_the_sidebar_shows_it() {
    let r = rig();
    mcp_on(&r);
    let usage = answer(&tool_call(&r, "read_usage", json!({})).await);
    assert!(usage.get("runs_on").is_some(), "{usage}");
}

#[tokio::test]
async fn the_dispatch_area_shows_every_field_as_settings_does() {
    let r = rig();
    mcp_on(&r);
    let got = answer(&tool_call(&r, "read_settings", json!({ "area": "dispatch" })).await);
    assert_eq!(got["value"]["approval"], "prompt", "{got}");
    assert!(
        got["value"].get("runs_on").is_some() && got["value"].get("rules").is_some(),
        "{got}"
    );
    assert!(
        got["choices"]["runs_on"].is_array() && got["choices"]["models"].is_array(),
        "{got}"
    );
    edit_config(&r, |cfg| {
        cfg.dispatch.approval = crate::config::Approval::Allow
    });
    let got = answer(&tool_call(&r, "read_settings", json!({ "area": "dispatch" })).await);
    assert_eq!(got["value"]["approval"], "allow");
}

#[tokio::test]
async fn many_conversations_are_capped_and_counted() {
    let r = rig();
    mcp_on(&r);
    for n in 0..60 {
        r.app
            .dispatch
            .open_conversation(&format!("Conversation {n}"));
    }
    let got = answer(&tool_call(&r, "list_conversations", json!({})).await);
    assert_eq!(got["conversations"].as_array().unwrap().len(), 50, "{got}");
    assert_eq!(got["more"], 10);
}

#[tokio::test]
async fn a_conversation_read_stays_within_its_budget() {
    let r = rig();
    mcp_on(&r);
    let id = r.app.dispatch.open_conversation("Many big screens");
    for _ in 0..30 {
        r.app.dispatch.record_as(
            &id,
            "read_session",
            json!({ "machine": "hp", "name": "hp-x" }),
            None,
            None,
            &Ok(json!({ "screen": "z".repeat(6_000) })),
            crate::dispatch::By::Dispatch,
            None,
        );
    }
    let result = tool_call(&r, "read_conversation", json!({ "id": id, "last": 50 })).await;
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.len() < 40_000, "{} characters came back", text.len());
    assert!(answer(&result)["left_out"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn a_machine_wide_insights_read_is_a_summary() {
    let r = rig();
    mcp_on(&r);
    let session = crate::snapshot::Session {
        machine: "hp".into(),
        agent: "claude".into(),
        pid: 42,
        cwd: "/r/app".into(),
        folder: "app".into(),
        branch: "fix-login".into(),
        ticket: "-".into(),
        tmux: Some("hp-app".into()),
        activity: crate::snapshot::Activity::Active,
    };
    let now = chrono::Local::now();
    r.app.insights.observe(
        "hp",
        &Default::default(),
        now - chrono::Duration::minutes(10),
    );
    let snap = crate::snapshot::Snapshot {
        sessions: vec![session],
        ..Default::default()
    };
    r.app
        .insights
        .observe("hp", &snap, now - chrono::Duration::minutes(5));
    let all = answer(&tool_call(&r, "read_insights", json!({ "machine": "hp" })).await);
    assert!(
        all["sessions"][0].get("periods").is_none() && all["sessions"][0].get("totals").is_some(),
        "{all}"
    );
    let missing = tool_call(
        &r,
        "read_insights",
        json!({ "machine": "hp", "session": "nope" }),
    )
    .await;
    assert!(
        missing["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("read_insights without a session"),
        "{missing}"
    );
}

#[tokio::test]
async fn a_config_caught_mid_edit_gives_an_error() {
    let r = rig();
    mcp_on(&r);
    std::fs::write(r._dir.path().join("yardbell.yml"), "port: [unfinished").unwrap();
    let (status, body) = mcp(
        &r.app,
        Some("yb_secret"),
        None,
        rpc(
            "tools/call",
            json!({ "name": "read_settings", "arguments": { "area": "phone" } }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(
        body["error"].as_str().unwrap().starts_with("cannot parse"),
        "{body}"
    );
}

#[tokio::test]
async fn a_credential_in_a_teardown_command_is_hidden() {
    let r = rig();
    mcp_on(&r);
    edit_config(&r, |cfg| {
        cfg.worktree_setup = vec![crate::worktrees::setup::WorktreeSetup {
            teardown:
                "deploy down --token ghp_plantedplantedplantedplantedplanted12 --password pwplanted"
                    .into(),
            folder: "app".into(),
            machine: "any".into(),
            command: String::new(),
            timeout_seconds: 60,
        }];
    });
    let result = tool_call(&r, "read_settings", json!({ "area": "worktree_setup" })).await;
    let shown = answer(&result)["value"][0]["teardown"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(shown.starts_with("deploy down"), "{shown}");
    assert!(
        !shown.contains("ghp_planted") && !shown.contains("pwplanted"),
        "{shown}"
    );
}

#[tokio::test]
async fn tokens_are_not_in_read_settings() {
    let r = rig();
    r.app
        .settings
        .set_reserved_secrets(&[(
            "mcp_oauth_tool_access".to_string(),
            "acc-secret-1".to_string(),
        )])
        .unwrap();
    let c = cookie(&r.app).await;
    let req = Request::builder()
        .uri("/api/settings")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (_, _, text) = send(&r.app, req).await;
    assert!(
        !text.contains("mcp_oauth_tool"),
        "hidden from the Secrets list"
    );
    assert!(!text.contains("acc-secret-1"));
    let cfg = r.app.config().unwrap();
    let shown = crate::mcp_read::shown_area(&r.app, &cfg, "session_mcp_servers");
    assert!(!shown.to_string().contains("acc-secret-1"));
    assert!(!std::fs::read_to_string(&r.app.cfg_path)
        .unwrap()
        .contains("acc-secret-1"));
    assert!(
        crate::mcp_read::saved_values(&r.app).contains(&"acc-secret-1".to_string()),
        "scrubbed from replies"
    );
}

#[tokio::test]
async fn a_proposal_cannot_allow_private_addresses() {
    let r = rig();
    let saved = crate::mcp_read::saved_values(&r.app);
    let value =
        serde_json::json!([{ "name": "x", "url": "https://x.example/mcp", "allow_private": true }]);
    crate::mcp_change::apply(&r.app.settings, "session_mcp_servers", value, &saved).unwrap();
    assert!(!r.app.config().unwrap().mcp_servers[0].allow_private);
}

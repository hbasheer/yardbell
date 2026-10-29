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

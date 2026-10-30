use super::*;

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

fn with_setup(r: &Rig, command: &str) {
    let mut cfg = r.app.config().unwrap();
    cfg.worktree_setup = vec![crate::worktrees::setup::WorktreeSetup {
        folder: "slot2".into(),
        machine: "any".into(),
        command: command.into(),
        timeout_seconds: 60,
    }];
    cfg.save(&r.app.cfg_path).unwrap();
}

fn position(r: &Rig, command: &str) -> usize {
    r.fake
        .calls()
        .iter()
        .position(|call| call.join(" ").contains(command))
        .unwrap_or_else(|| panic!("{command} never ran"))
}

fn pro_is_up(r: &Rig) {
    let mut snap = Snapshot::default();
    snap.folders.insert("slot2".into(), "main".into());
    snap.folder_paths
        .insert("slot2".into(), "/p/slots/slot2".into());
    snap.health = Some(crate::snapshot::Health {
        mem_total_kb: 32_000_000,
        mem_used_kb: 4_000_000,
        agent_kb: 0,
        user_kb: 0,
        limit_kb: 0,
        limit_used_kb: 0,
        load1: 0.5,
        cpus: 8,
        disk_total_kb: 0,
        disk_used_kb: 0,
    });
    r.app.state.update(MachineStatus {
        name: "pro".into(),
        up: true,
        reason: None,
        snapshot: Some(snap),
        checked_at: chrono::Local::now(),
    });
}

#[tokio::test]
async fn a_new_worktree_runs_its_setup_before_the_agent_and_a_failure_is_shown() {
    let r = rig();
    with_setup(&r, "bin/setup");
    r.fake.stub("tmux new", Output::ok_with("hp-eng-5\n"));
    r.fake.stub(
        "yardbell-setup.log",
        Output::ok_with(
            "LOG\t/r/slots/slot2/.git/worktrees/eng-5/yardbell-setup.log\nEXIT\t1\nSECONDS\t2\nOUTPUT\nno database\n",
        ),
    );
    r.fake.stub(
        "worktree add",
        Output::ok_with("PATH\t/r/slots/slot2-worktrees/eng-5\nCREATED\n"),
    );
    r.fake
        .stub("refs/remotes/origin/HEAD", Output::ok_with("CUR\tmain\n"));
    let (status, body) = post_session(
        &r,
        r#"{"machine":"hp","folder":"slot2","branch":"eng-5","new_branch":true,"base":"main","prompt":"fix it"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let started: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(started["setup"]["ok"], false);
    assert_eq!(started["setup"]["exit"], 1);
    assert_eq!(started["setup"]["output"], "no database");
    assert!(position(&r, "worktree add") < position(&r, "yardbell-setup.log"));
    assert!(position(&r, "yardbell-setup.log") < position(&r, "tmux new"));
    let setup = r.fake.calls()[position(&r, "yardbell-setup.log")].join(" ");
    assert!(
        setup.contains("cd '/r/slots/slot2-worktrees/eng-5'"),
        "{setup}"
    );
    assert!(setup.contains("[ $s -ge 60 ]"), "{setup}");
    let agent = r.fake.calls()[position(&r, "tmux new")].join(" ");
    assert!(agent.contains("fix it"), "{agent}");
    assert!(agent.contains("setup command did not finish"), "{agent}");
    let shown = r
        .app
        .state
        .setup("hp", "/r/slots/slot2-worktrees/eng-5")
        .unwrap();
    assert_eq!(shown.summary(), "bin/setup failed with exit code 1");
    assert_eq!(r.app.task_of("hp", "hp-eng-5").as_deref(), Some("fix it"));
}

#[tokio::test]
async fn an_existing_worktree_or_folder_does_not_run_setup_again() {
    let r = rig();
    with_setup(&r, "bin/setup");
    r.fake.stub(
        "worktree add",
        Output::ok_with("PATH\t/r/slots/slot2-worktrees/eng-5\n"),
    );
    r.fake
        .stub("refs/remotes/origin/HEAD", Output::ok_with("CUR\tmain\n"));
    r.fake.stub("tmux new", Output::ok_with(""));
    let (status, body) =
        post_session(&r, r#"{"machine":"hp","folder":"slot2","branch":"eng-5"}"#).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.contains("setup"), "{body}");
    assert!(!ran(&r, "yardbell-setup.log"));
}

#[tokio::test]
async fn remove_worktree_refuses_until_the_loss_is_confirmed() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake.stub(
        "status --porcelain",
        Output::ok_with(
            "TOP\t/r/slots/slot2-worktrees/eng-5\nMAIN\t/r/slots/slot2\nLINKED\nBRANCH\teng-5\nDIRTY\t?? notes.txt\nAHEAD\tabc1234 wip\n",
        ),
    );
    let url = "/worktrees/hp/remove";
    let (status, _, body) = post_json(
        &r.app,
        &c,
        url,
        r#"{"path":"/r/slots/slot2-worktrees/eng-5"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let refused: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(refused["worktree"]["dirty"], json!(["?? notes.txt"]));
    assert_eq!(refused["worktree"]["unpushed"], json!(["abc1234 wip"]));
    assert!(refused["error"]
        .as_str()
        .unwrap()
        .contains("Confirm to remove it anyway"));
    assert!(!ran(&r, "worktree remove"));

    r.fake.stub("worktree remove", Output::ok_with("REMOVED\n"));
    let (status, _, body) = post_json(
        &r.app,
        &c,
        url,
        r#"{"path":"/r/slots/slot2-worktrees/eng-5","force":true}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(ran(
        &r,
        "git worktree remove --force '/r/slots/slot2-worktrees/eng-5'"
    ));

    r.fake.restub(
        "status --porcelain",
        Output::ok_with("TOP\t/r/slots/slot2\nMAIN\t/r/slots/slot2\nBRANCH\teng-1301-inbox\n"),
    );
    let (status, _, body) = post_json(&r.app, &c, url, r#"{"folder":"slot2","force":true}"#).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(
        body.contains("hp-eng-1301 still runs in /r/slots/slot2; stop it first"),
        "{body}"
    );
}

#[tokio::test]
async fn dispatch_cannot_force_a_removal() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    r.fake.stub(
        "status --porcelain",
        Output::ok_with("TOP\t/r/w\nMAIN\t/r/slots/slot2\nLINKED\nBRANCH\teng-5\nDIRTY\t M a.rs\n"),
    );
    let result = dispatch_tool(
        &r,
        Some(&id),
        "remove_worktree",
        json!({ "machine": "hp", "path": "/r/w", "force": true }),
    )
    .await;
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("1 uncommitted change"),
        "{result}"
    );
    assert!(!ran(&r, "worktree remove"));
}

#[tokio::test]
async fn move_session_follows_the_rules_and_starts_the_task_on_the_roomiest_machine() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    pro_is_up(&r);
    r.app
        .remember_task("hp", "hp-eng-1301", "fix the inbox filter");
    set_rules(
        &r,
        "allow",
        json!([{ "action": "move_session", "machine": "hp", "approval": "deny" }]),
    );
    let args = json!({ "machine": "hp", "name": "hp-eng-1301" });
    let refused = dispatch_tool(&r, Some(&id), "move_session", args.clone()).await;
    assert_eq!(refused["isError"], true);
    assert!(refused["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Refused"));
    assert!(r
        .fake
        .calls()
        .iter()
        .all(|c| !c.join(" ").contains("CHANGES")));

    set_rules(&r, "allow", json!([]));
    r.fake.stub(
        "CHANGES",
        Output::ok_with(&format!(
            "TOP\t/r/slots/slot2\nMAIN\t/r/slots/slot2\nBRANCH\teng-1301-inbox\nHEAD\t{HEAD}\nORIGIN\tgit@github.com:acme/app.git\nCHANGES\t3\n"
        )),
    );
    r.fake.stub(
        "HAVE%09",
        Output::ok_with(
            "REPO\t/p/slots/slot2\nORIGIN\thttps://github.com/acme/app\nHAVE\taaaaaaa1111111\n",
        ),
    );
    r.fake.stub(
        "git bundle create",
        Output::ok_with(&format!(
            "BRANCH\teng-1301-inbox\nHEAD\t{HEAD}\nBUNDLE\tQlVORExF\nPATCH\tUEFUQ0g=\n"
        )),
    );
    r.fake.stub(
        "git bundle verify",
        Output::ok_with("PATH\t/p/slots/slot2-worktrees/eng-1301-inbox\nCREATED\nAPPLIED\n"),
    );
    r.fake.stub("tmux new", Output::ok_with("pro-eng-1301\n"));
    let moved = dispatch_tool(&r, Some(&id), "move_session", args).await;
    assert_eq!(moved["isError"], false, "{moved}");
    let out: serde_json::Value =
        serde_json::from_str(moved["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(out["machine"], "pro");
    assert_eq!(out["name"], "pro-eng-1301");
    assert_eq!(out["from"]["stopped"], false);
    let unpack = position(&r, "git bundle verify");
    assert!(r.fake.calls()[unpack].contains(&"mac_pro".to_string()));
    assert_eq!(
        r.fake.inputs()[unpack].as_deref(),
        Some("QlVORExF\nUEFUQ0g=\n")
    );
    let start = r.fake.calls()[position(&r, "tmux new")].join(" ");
    assert!(start.contains("mac_pro"), "{start}");
    assert!(start.contains("fix the inbox filter"), "{start}");
    assert!(start.contains("Continued from hp"), "{start}");
    assert!(!ran(&r, "kill-session"), "the original keeps running");
    assert!(!ran(&r, "git push"));
}

#[tokio::test]
async fn a_move_can_start_read_only() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    pro_is_up(&r);
    set_rules(&r, "allow", json!([]));
    r.fake.stub(
        "CHANGES",
        Output::ok_with(&format!(
            "TOP\t/r/slots/slot2\nMAIN\t/r/slots/slot2\nBRANCH\teng-1301-inbox\nHEAD\t{HEAD}\nORIGIN\tgit@github.com:acme/app.git\nCHANGES\t0\n"
        )),
    );
    r.fake.stub(
        "HAVE%09",
        Output::ok_with(
            "REPO\t/p/slots/slot2\nORIGIN\thttps://github.com/acme/app\nHAVE\taaaaaaa1111111\n",
        ),
    );
    r.fake.stub(
        "git bundle create",
        Output::ok_with(&format!(
            "BRANCH\teng-1301-inbox\nHEAD\t{HEAD}\nBUNDLE\tQlVORExF\nPATCH\t\n"
        )),
    );
    r.fake.stub(
        "git bundle verify",
        Output::ok_with("PATH\t/p/slots/slot2-worktrees/eng-1301-inbox\nAPPLIED\n"),
    );
    r.fake.stub("tmux new", Output::ok_with("pro-eng-1301\n"));
    let args = json!({ "machine": "hp", "name": "hp-eng-1301", "to": "pro", "task": "check it", "read_only": true });
    let moved = dispatch_tool(&r, Some(&id), "move_session", args).await;
    assert_eq!(moved["isError"], false, "{moved}");
    let start = r.fake.calls()[position(&r, "tmux new")].join(" ");
    assert!(start.contains("--disallowed-tools"), "{start}");
}

#[tokio::test]
async fn a_push_with_a_saved_secret_in_it_is_blocked_without_showing_it() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "allow", json!([]));
    let value = "lin-value-that-must-not-leak-123";
    let mut secrets = r.app.secrets().unwrap();
    secrets.set("linear", value, chrono::Utc::now()).unwrap();
    secrets.save().unwrap();
    r.fake.stub(
        "--not --remotes",
        Output::ok_with(&format!(
            "COUNT\t1\nPATCH\ncommit {HEAD}\n\ndiff --git a/.env b/.env\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1,2 @@\n+A=1\n+LINEAR={value}\n"
        )),
    );
    let result = dispatch_tool(
        &r,
        Some(&id),
        "push_branch",
        json!({ "machine": "hp", "folder": "slot2", "branch": "eng-1301-inbox" }),
    )
    .await;
    assert_eq!(result["isError"], true, "{result}");
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains(".env:2 (commit 0123456) holds the value of the secret linear"),
        "{text}"
    );
    assert!(!text.contains(value));
    assert!(!r.app.dispatch.get(&id).unwrap().to_string().contains(value));
    assert!(!ran(&r, "git push"));
}

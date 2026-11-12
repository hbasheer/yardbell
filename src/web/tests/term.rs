use super::*;
use crate::snapshot::Activity;
use base64::Engine;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

async fn get_json(r: &Rig, c: &str, url: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::get(url)
        .header(header::COOKIE, c)
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    (status, serde_json::from_str(&body).unwrap_or(json!(body)))
}

fn show(r: &Rig, activity: Activity, screen: &str) {
    let mut snap = r.app.state.snapshot("hp").unwrap();
    for s in snap.sessions.iter_mut() {
        s.activity = activity;
    }
    snap.screens.insert("hp:hp-eng-1301".into(), "f00d".into());
    snap.prompts.clear();
    if let Some(p) = crate::detect::prompt("claude", screen) {
        snap.prompts.insert("hp:hp-eng-1301".into(), p);
    }
    r.app.state.update(MachineStatus {
        name: "hp".into(),
        up: true,
        reason: None,
        snapshot: Some(snap),
        checked_at: chrono::Local::now(),
    });
}

async fn upload(r: &Rig, c: &str, url: &str, body: Vec<u8>) -> (StatusCode, serde_json::Value) {
    let req = Request::post(url)
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(body))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    (status, serde_json::from_str(&body).unwrap_or(json!(body)))
}

#[tokio::test]
async fn the_agent_state_names_the_prompt_and_its_choices() {
    let r = rig();
    let c = cookie(&r.app).await;
    let url = "/sessions/hp/hp-eng-1301/agent";
    let (status, got) = get_json(&r, &c, url).await;
    assert_eq!(status, StatusCode::OK, "{got}");
    assert_eq!(
        (got["agent"].as_str(), got["state"].as_str()),
        (Some("claude"), Some("idle"))
    );

    show(
        &r,
        Activity::Blocked,
        " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for rm\n   3. No\n\n Esc to cancel",
    );
    let (_, got) = get_json(&r, &c, url).await;
    assert_eq!(got["state"], "permission");
    assert_eq!(got["screen"], "f00d");
    let roles: Vec<_> = got["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["keys"].as_str().unwrap(), c["role"].as_str().unwrap()))
        .collect();
    assert_eq!(roles, [("1", "yes"), ("2", "always"), ("3", "no")]);

    show(
        &r,
        Activity::Blocked,
        "❯ 1. Postgres\n  2. SQLite\n\nEnter to select · Esc to cancel",
    );
    let (_, got) = get_json(&r, &c, url).await;
    assert_eq!(got["state"], "question");
    assert_eq!(got["choices"][1]["label"], "SQLite");
    assert!(got["choices"][1]["role"].is_null());

    show(&r, Activity::Blocked, "Waiting for something unusual");
    let (_, got) = get_json(&r, &c, url).await;
    assert_eq!(
        got["state"], "blocked",
        "a wait the screen does not explain"
    );
    assert_eq!(got["choices"], json!([]));

    show(&r, Activity::Active, "");
    let (_, got) = get_json(&r, &c, url).await;
    assert_eq!(got["state"], "working");
}

#[tokio::test]
async fn an_unknown_session_has_no_agent_and_asking_again_checks_its_machine() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, got) = get_json(&r, &c, "/sessions/hp/nobody/agent").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got, json!({ "agent": null, "state": "unknown" }));
    let (status, _) = get_json(&r, &c, "/sessions/nowhere/x/agent").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let req = Request::post("/sessions/hp/hp-eng-1301/agent")
        .header(header::COOKIE, &c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(r.rechecked().await, [Some("hp".to_string())]);
}

#[tokio::test]
async fn an_upload_lands_on_the_sessions_machine_under_its_own_folder() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake.stub(
        "yardbell-uploads",
        Output::ok_with("/tmp/yardbell-uploads/hp-eng-1301/1700000000-sh_ot.png\n"),
    );
    let (status, got) = upload(
        &r,
        &c,
        "/sessions/hp/hp-eng-1301/upload?name=..%2F..%2Fetc%2Fsh%20ot.png",
        PNG.to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{got}");
    assert_eq!(
        got["path"],
        "/tmp/yardbell-uploads/hp-eng-1301/1700000000-sh_ot.png"
    );
    assert_eq!(got["kind"], "image");
    let call = r.fake.calls().pop().unwrap().join(" ");
    assert!(
        call.contains("d='/tmp/yardbell-uploads/hp-eng-1301'"),
        "{call}"
    );
    assert!(
        call.contains("-'sh_ot.png'"),
        "the name loses its folders: {call}"
    );
    assert!(!call.contains(".."), "{call}");
    assert!(call.contains("belongs to someone else"), "{call}");
    let sent = r.fake.inputs().pop().unwrap().unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(sent)
            .unwrap(),
        PNG
    );
}

#[tokio::test]
async fn an_upload_is_refused_when_it_is_too_big_the_wrong_type_or_for_no_session() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake.stub("yardbell-uploads", Output::ok_with("/tmp/x\n"));
    let url = "/sessions/hp/hp-eng-1301/upload?name=a.png";

    let mut big = PNG.to_vec();
    big.resize(crate::web::term_api::UPLOAD_MAX + 1, 0);
    let (status, got) = upload(&r, &c, url, big).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{got}");
    assert_eq!(got["error"], "the file is over 10 MB");

    let (status, got) = upload(&r, &c, url, vec![0, 1, 2, 255]).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{got}");

    let (status, _) = upload(&r, &c, url, Vec::new()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, got) = upload(
        &r,
        &c,
        "/sessions/hp/nobody/upload?name=a.png",
        PNG.to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{got}");

    assert!(r.fake.calls().is_empty(), "nothing reached the machine");

    let (status, got) = upload(&r, &c, url, b"plain notes\n".to_vec()).await;
    assert_eq!(status, StatusCode::OK, "{got}");
    assert_eq!(got["kind"], "text");
}

#[tokio::test]
async fn a_failed_upload_says_what_the_machine_said() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.fake.stub(
        "yardbell-uploads",
        Output::failed(1, "/tmp/yardbell-uploads belongs to someone else"),
    );
    let (status, got) = upload(
        &r,
        &c,
        "/sessions/hp/hp-eng-1301/upload?name=a.txt",
        b"hi\n".to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(
        got["error"]
            .as_str()
            .unwrap()
            .contains("belongs to someone else"),
        "{got}"
    );
}

#[tokio::test]
async fn the_terminal_dock_scripts_are_served_and_loaded() {
    let r = rig();
    let c = cookie(&r.app).await;
    for path in ["/term-agent.js", "/term-compose.js"] {
        let req = Request::get(path)
            .header(header::COOKIE, &c)
            .body(Body::empty())
            .unwrap();
        let (status, _, _) = send(&r.app, req).await;
        assert_eq!(status, StatusCode::OK, "{path}");
    }
    let html = String::from_utf8(Assets::get("term.html").unwrap().data.into_owned()).unwrap();
    assert!(html.contains(r#"<div id="term-dock"></div>"#));
    assert!(html.contains(r#"<script src="/term-agent.js"></script>"#));
    assert!(html.contains(r#"<script type="module" src="/term-compose.js"></script>"#));
}

#[test]
fn the_upload_script_writes_into_a_folder_it_owns() {
    let script = crate::sessions::upload_script("hp-app", "notes.txt");
    let tmp = tempfile::tempdir().unwrap();
    let local = script.replace(
        "/tmp/yardbell-uploads",
        &tmp.path().join("up").display().to_string(),
    );
    let out = std::process::Command::new("bash")
        .arg("-c")
        .arg(&local)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(b"aGkK")?;
            child.wait_with_output()
        })
        .unwrap();
    assert!(out.status.success());
    let path = String::from_utf8(out.stdout).unwrap();
    let path = path.trim();
    assert!(
        path.starts_with(&tmp.path().join("up/hp-app/").display().to_string()),
        "{path}"
    );
    assert!(path.ends_with("-notes.txt"), "{path}");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "hi\n");

    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::create_dir(tmp.path().join("up2")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, tmp.path().join("up2/hp-app")).unwrap();
    let planted = script.replace(
        "/tmp/yardbell-uploads",
        &tmp.path().join("up2").display().to_string(),
    );
    let out = std::process::Command::new("bash")
        .arg("-c")
        .arg(&planted)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(!out.status.success(), "a planted link is not followed");
    assert!(String::from_utf8_lossy(&out.stderr).contains("belongs to someone else"));
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
}

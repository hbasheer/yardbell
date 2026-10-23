use super::*;
use crate::config::Config;
use crate::phone::ntfy::Target;
use crate::probe::MachineStatus;
use crate::shell::Output;
use crate::snapshot::{Port, Snapshot};
use crate::ssh::Ssh;
use crate::testing::{FakeRunner, FakeSender};
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use std::path::Path;
use tower::ServiceExt;

struct FakePorts;

impl PortStatus for FakePorts {
    fn local_port(&self, m: &Machine, remote: u16) -> Option<u16> {
        m.port_prefix.map(|p| p as u16 * 10000 + remote)
    }
    fn status(&self, _m: &Machine, _port: &Port) -> String {
        "tunnel up".into()
    }
}

struct Rig {
    app: Arc<AppState>,
    fake: Arc<FakeRunner>,
    phone_sender: Arc<FakeSender>,
    refreshes: Arc<std::sync::atomic::AtomicUsize>,
    now: Arc<std::sync::Mutex<std::time::Instant>>,
    _dir: tempfile::TempDir,
}

impl Rig {
    fn advance(&self, secs: u64) {
        *self.now.lock().unwrap() += std::time::Duration::from_secs(secs);
    }
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let cfg_path = dir.path().join("yardbell.yml");
    let mut cfg = Config::load(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/yardbell.yml"
    )))
    .unwrap();
    cfg.passcode_hash = Some(crate::auth::hash("pw"));
    cfg.save(&cfg_path).unwrap();
    let fake = Arc::new(FakeRunner::default());
    let ssh = Ssh::new(dir.path().join("state"));
    let state = State::default();
    let mut snap = Snapshot::default();
    snap.folders.insert("slot2".into(), "eng-1301-inbox".into());
    snap.folder_paths
        .insert("slot2".into(), "/r/slots/slot2".into());
    snap.ports.insert(
        "slot2".into(),
        vec![Port {
            service: "rails".into(),
            remote_port: 3020,
            listening: true,
        }],
    );
    snap.sessions.push(crate::snapshot::Session {
        machine: "hp".into(),
        agent: "claude".into(),
        pid: 9,
        cwd: "/r/slots/slot2".into(),
        folder: "slot2".into(),
        branch: "eng-1301-inbox".into(),
        ticket: "ENG-1301".into(),
        tmux: Some("hp-eng-1301".into()),
        activity: crate::snapshot::Activity::Idle,
    });
    snap.sessions.push(crate::snapshot::Session {
        machine: "hp".into(),
        agent: "codex".into(),
        pid: 77,
        cwd: "/r/app".into(),
        folder: "app".into(),
        branch: "main".into(),
        ticket: "-".into(),
        tmux: None,
        activity: crate::snapshot::Activity::Idle,
    });
    state.update(MachineStatus {
        name: "hp".into(),
        up: true,
        reason: None,
        snapshot: Some(snap),
        checked_at: chrono::Local::now(),
    });
    let tunnels = Arc::new(crate::tunnels::Tunnels::new(
        fake.clone(),
        vec!["127.0.0.1".into()],
        dir.path().join("logs"),
        Arc::new(std::time::Instant::now),
    ));
    let onboarding = Arc::new(crate::onboarding::Onboarding::new(
        fake.clone(),
        ssh.clone(),
        cfg_path.clone(),
        crate::onboarding::ssh_config::SshConfig::new(
            dir.path().join("ssh_config"),
            Arc::new(chrono::Local::now),
        ),
        tunnels,
        state.clone(),
        dir.path().join("id_ed25519"),
    ));
    let refreshes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let phone_sender = Arc::new(FakeSender::default());
    let services = Services {
        state,
        ports: Arc::new(FakePorts),
        sessions: Sessions::new(fake.clone(), ssh),
        onboarding,
        host_mesh: crate::mesh::HostMesh::new(fake.clone()),
        folders: crate::folders::Folders::new(fake.clone(), Ssh::new(dir.path().join("state2"))),
        settings: crate::settings::Settings::new(
            cfg_path.clone(),
            dir.path().join("ssh_config"),
            Arc::new(chrono::Local::now),
        ),
        phone: Arc::new(Phone::new(phone_sender.clone())),
        dispatch: Arc::new(crate::dispatch::Dispatch::new(
            fake.clone(),
            dir.path().join("dispatch"),
        )),
        refresh: {
            let refreshes = refreshes.clone();
            Arc::new(move || {
                refreshes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Box::pin(async {})
            })
        },
    };
    let now = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    let clock_now = now.clone();
    let app = Arc::new(AppState::new(
        cfg_path,
        services,
        &cfg,
        Arc::new(move || *clock_now.lock().unwrap()),
    ));
    Rig {
        app,
        fake,
        phone_sender,
        refreshes,
        now,
        _dir: dir,
    }
}

async fn send(
    app: &Arc<AppState>,
    mut req: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, String) {
    let headers = req.headers_mut();
    if !headers.contains_key(header::HOST) {
        headers.insert(header::HOST, "localhost:4000".parse().unwrap());
    }
    if !headers.contains_key(header::ORIGIN) {
        let origin = format!("http://{}", headers[header::HOST].to_str().unwrap());
        headers.insert(header::ORIGIN, origin.parse().unwrap());
    }
    let res = router(app.clone()).oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8_lossy(&body).into_owned())
}

fn login_req(pw: &str) -> Request<Body> {
    Request::post("/login")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(format!("passcode={pw}")))
        .unwrap()
}

async fn cookie(app: &Arc<AppState>) -> String {
    let (_, headers, _) = send(app, login_req("pw")).await;
    headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn requires_login_redirect_and_401() {
    let r = rig();
    let (status, headers, _) = send(&r.app, Request::get("/").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "/login");
    let (status, _, body) = send(
        &r.app,
        Request::get("/state")
            .header(header::ACCEPT, "application/json")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.contains("error"));
    let (status, _, _) = send(&r.app, Request::get("/login").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn shared_nav_script_is_served_to_logged_in_pages() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::get("/nav.js")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, headers, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );
    assert!(body.contains("YardbellNav"));
    for page in ["dashboard.html", "settings.html", "add.html"] {
        let html = String::from_utf8(Assets::get(page).unwrap().data.into_owned()).unwrap();
        assert!(
            html.contains(r#"<script src="/nav.js"></script>"#),
            "{page}"
        );
        assert!(html.contains(r#"id="nav-machines""#), "{page}");
    }
}

#[test]
fn cdn_files_are_pinned() {
    let pages: Vec<_> = Assets::iter().filter(|n| n.ends_with(".html")).collect();
    assert!(pages.len() >= 5, "{pages:?}");
    for page in pages {
        let html = String::from_utf8(Assets::get(&page).unwrap().data.into_owned()).unwrap();
        for tag in html
            .split('<')
            .filter(|t| t.starts_with("link") || t.starts_with("script"))
        {
            if !tag.contains("://") {
                continue;
            }
            assert!(tag.contains(r#"integrity="sha384-"#), "{page}: <{tag}");
            assert!(tag.contains(r#"crossorigin="anonymous""#), "{page}: <{tag}");
        }
    }
}

#[tokio::test]
async fn login_cookie_flags() {
    let r = rig();
    let (status, headers, _) = send(&r.app, login_req("pw")).await;
    assert_eq!(status, StatusCode::OK);
    let set = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(set.contains("HttpOnly"), "{set}");
    assert!(set.contains("SameSite=Strict"), "{set}");
    assert!(set.contains("Max-Age=2592000"), "{set}");
    let (status, _, _) = send(&r.app, login_req("bad")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn forged_cookie_rejected() {
    let r = rig();
    let req = Request::get("/state")
        .header(header::COOKIE, "yardbell_session=ok")
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn locked_ip_gets_429() {
    let r = rig();
    for _ in 0..5 {
        send(&r.app, login_req("bad")).await;
    }
    let (status, _, _) = send(&r.app, login_req("pw")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn state_urls_use_request_host() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::get("/state")
        .header(header::HOST, "100.9.9.9:4000")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        v["sessions"][0]["ports"][0]["url"],
        "http://100.9.9.9:13020"
    );
}

#[tokio::test]
async fn new_session_resolves_folder_and_ticket() {
    let r = rig();
    r.fake.stub("tmux new", Output::ok_with(""));
    let c = cookie(&r.app).await;
    let req = Request::post("/sessions")
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"machine":"hp","folder":"slot2","resume":false}"#,
        ))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("hp-eng-1301"));
    assert!(r
        .fake
        .calls()
        .pop()
        .unwrap()
        .last()
        .unwrap()
        .contains("/r/slots/slot2"));
}

async fn post_session(r: &Rig, body: &'static str) -> (StatusCode, String) {
    let c = cookie(&r.app).await;
    let req = Request::post("/sessions")
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    (status, body)
}

#[tokio::test]
async fn new_session_starts_the_requested_agent() {
    let r = rig();
    r.fake.stub("tmux new", Output::ok_with(""));
    let (status, body) =
        post_session(&r, r#"{"machine":"hp","folder":"slot2","agent":"gemini"}"#).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let call = r.fake.calls().pop().unwrap();
    assert!(
        call.last().unwrap().contains(r"'\''gemini'\'' || exit $?"),
        "{call:?}"
    );
}

#[tokio::test]
async fn new_session_defaults_to_claude_and_rejects_unknown_agents() {
    let r = rig();
    r.fake.stub("tmux new", Output::ok_with(""));
    let (status, _) = post_session(&r, r#"{"machine":"hp","folder":"slot2"}"#).await;
    assert_eq!(status, StatusCode::OK);
    let call = r.fake.calls().pop().unwrap();
    assert!(
        call.last().unwrap().contains(r"'\''claude'\'' || exit $?"),
        "{call:?}"
    );
    let (status, body) =
        post_session(&r, r#"{"machine":"hp","folder":"slot2","agent":"nope"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("no agent named nope"), "{body}");
}

#[tokio::test]
async fn state_lists_agents_and_each_sessions_agent() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::get("/state")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (_, _, body) = send(&r.app, req).await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["default_agent"], "claude");
    assert_eq!(v["agents"][1]["name"], "codex");
    assert_eq!(v["agents"][1]["label"], "Codex");
    assert_eq!(v["sessions"][0]["agent"], "claude");
    assert_eq!(v["sessions"][1]["pid"], 77);
}

#[tokio::test]
async fn new_session_unknown_folder_is_400() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::post("/sessions")
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"machine":"hp","folder":"slot9","resume":false}"#,
        ))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("slot9"));
}

#[tokio::test]
async fn stop_failure_returns_stderr() {
    let r = rig();
    r.fake.stub(
        "kill-session",
        Output::failed(1, "can't find session: hp-x"),
    );
    let c = cookie(&r.app).await;
    let req = Request::post("/sessions/hp/hp-x/stop")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(body.contains("can't find session: hp-x"));
}

#[tokio::test]
async fn host_terminal_refused_from_other_device() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::post("/sessions/hp/hp-eng-1301/host-terminal")
        .header(header::HOST, "100.9.9.9:4000")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn forget_ended() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::post("/ended/hp:hp-x/forget")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn onboarding_step_route() {
    let r = rig();
    r.fake.stub("ping", Output::failed(1, ""));
    let c = cookie(&r.app).await;
    let req = Request::post("/onboarding/reachable")
        .header(header::COOKIE, c.clone())
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"ip":"100.1.1.1"}"#))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["message"], "peer offline");
    let req = Request::post("/onboarding/format_disk")
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (status, _, _) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn remove_machine_route() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::post("/machines/pro/remove")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("left unchanged"), "{body}");
}

#[tokio::test]
async fn cross_origin_post_rejected() {
    let r = rig();
    r.fake.stub("kill-session", Output::ok_with(""));
    let c = cookie(&r.app).await;
    for origin in ["http://localhost:13020", "null"] {
        let req = Request::post("/sessions/hp/hp-x/stop")
            .header(header::HOST, "localhost:4000")
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, c.clone())
            .body(Body::empty())
            .unwrap();
        let (status, _, _) = send(&r.app, req).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin}");
    }
    assert!(r.fake.calls().is_empty());
}

#[tokio::test]
async fn state_includes_host_mesh_status() {
    let r = rig();
    r.fake.stub(
        "ip -o -4 addr",
        Output::ok_with("4: nordlynx    inet 100.64.0.10/10 scope global nordlynx\n"),
    );
    let c = cookie(&r.app).await;
    let req = Request::get("/state")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (_, _, body) = send(&r.app, req).await;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["mesh"]["on"], true);
    assert_eq!(v["mesh"]["label"], "Mesh VPN");
}

#[tokio::test]
async fn mesh_on_route() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::post("/mesh/on")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(body.contains("cannot be turned on from Yardbell"), "{body}");
}

#[tokio::test]
async fn browse_route_lists_folder() {
    let r = rig();
    r.fake.stub(
        "PWD",
        Output::ok_with("PWD\t/home/u/Projects\nGIT\tyardbell\tmain\n"),
    );
    let c = cookie(&r.app).await;
    let req = Request::get("/machines/hp/browse?path=~/Projects")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["entries"][0]["name"], "yardbell");
    assert_eq!(v["entries"][0]["git"], true);
}

#[tokio::test]
async fn new_session_in_new_worktree_and_remembered() {
    let r = rig();
    r.fake
        .stub("CUR", Output::ok_with("CUR\tmain\nDEF\torigin/main\n"));
    r.fake.stub(
        "worktree add",
        Output::ok_with("PATH\t/r/app-worktrees/eng-1400-new\n"),
    );
    r.fake.stub("tmux new", Output::ok_with(""));
    let c = cookie(&r.app).await;
    let req = Request::post("/sessions")
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"machine":"hp","path":"/r/app","branch":"eng-1400-new","new_branch":true,"base":"origin/main"}"#))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("hp-eng-1400"), "{body}");
    let tmux = r
        .fake
        .calls()
        .into_iter()
        .find(|c| c.join(" ").contains("tmux new"))
        .unwrap();
    assert!(tmux
        .last()
        .unwrap()
        .contains("/r/app-worktrees/eng-1400-new"));
    let cfg = Config::load(&r.app.cfg_path).unwrap();
    assert_eq!(cfg.machine("hp").unwrap().recent, vec!["/r/app"]);
}

#[tokio::test]
async fn new_session_plain_folder_without_branch() {
    let r = rig();
    r.fake.stub("tmux new", Output::ok_with(""));
    let c = cookie(&r.app).await;
    let req = Request::post("/sessions")
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"machine":"hp","path":"/home/u/notes"}"#))
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("hp-u-notes"), "{body}");
}

async fn post_json(
    app: &Arc<AppState>,
    cookie: &str,
    url: &str,
    body: &str,
) -> (StatusCode, axum::http::HeaderMap, String) {
    let req = Request::post(url)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    send(app, req).await
}

#[tokio::test]
async fn settings_json_has_no_secrets() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::get("/api/settings")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.contains("argon2"), "{body}");
    assert!(!body.contains("cookie_key"));
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["machines"].as_array().unwrap().len(), 3);
    assert_eq!(v["mesh"], "none");
}

#[tokio::test]
async fn passcode_change_takes_effect_live() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/api/settings/passcode",
        r#"{"current":"pw","new":"brand-new-pass"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (old, _, _) = send(&r.app, login_req("pw")).await;
    assert_eq!(old, StatusCode::UNAUTHORIZED);
    let (new, _, _) = send(&r.app, login_req("brand-new-pass")).await;
    assert_eq!(new, StatusCode::OK);
}

#[tokio::test]
async fn logout_everywhere_invalidates_old_cookies_but_keeps_caller() {
    let r = rig();
    let old = cookie(&r.app).await;
    let (status, headers, _) = post_json(&r.app, &old, "/api/settings/logout-all", "{}").await;
    assert_eq!(status, StatusCode::OK);
    let fresh = headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let get = |c: String| {
        Request::get("/state")
            .header(header::COOKIE, c)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(send(&r.app, get(old)).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&r.app, get(fresh)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn machine_edit_and_undo() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/api/settings/machines/hp",
        r#"{"ssh":"hp","mesh_ip":"100.64.0.11","port_prefix":4,"root":"~/Code","mesh":null}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        Config::load(&r.app.cfg_path)
            .unwrap()
            .machine("hp")
            .unwrap()
            .port_prefix,
        Some(4)
    );
    let (status, _, _) = post_json(&r.app, &c, "/api/settings/undo", "{}").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        Config::load(&r.app.cfg_path)
            .unwrap()
            .machine("hp")
            .unwrap()
            .port_prefix,
        Some(1)
    );
    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/api/settings/machines/hp",
        r#"{"ssh":"hp","mesh_ip":"x;y","port_prefix":4,"root":"~/Code","mesh":null}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn mesh_preview_proposes_addresses() {
    let r = rig();
    r.fake.stub("tailscale status --json", Output::ok_with(r#"{"BackendState":"Running","Peer":{"a":{"HostName":"hp","TailscaleIPs":["100.101.0.2"],"Online":true}}}"#));
    let c = cookie(&r.app).await;
    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/api/settings/mesh/preview",
        r#"{"provider":"tailscale"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let hp = v["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["machine"] == "hp")
        .unwrap()
        .clone();
    assert_eq!(hp["new_ip"], "100.101.0.2");
}

async fn move_to_tmux(r: &Rig, pid: u32) -> (StatusCode, String) {
    let c = cookie(&r.app).await;
    let req = Request::post(format!("/sessions/hp/{pid}/move-to-tmux"))
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    (status, body)
}

#[tokio::test]
async fn move_to_tmux_stops_the_agent_and_resumes_it_in_tmux() {
    let r = rig();
    r.fake.stub("kill ", Output::ok_with(""));
    r.fake.stub("tmux new", Output::ok_with(""));
    let (status, body) = move_to_tmux(&r, 77).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("hp-r-app"), "{body}");
    let calls: Vec<String> = r.fake.calls().iter().map(|c| c.join(" ")).collect();
    let kill = calls.iter().position(|c| c.contains("kill 77")).unwrap();
    let tmux = calls.iter().position(|c| c.contains("tmux new")).unwrap();
    assert!(kill < tmux, "{calls:?}");
    assert!(calls[tmux].contains("/r/app"), "{calls:?}");
    assert!(calls[tmux].contains("codex resume --last"), "{calls:?}");
}

#[tokio::test]
async fn move_to_tmux_only_for_known_sessions_outside_tmux() {
    let r = rig();
    let (status, _) = move_to_tmux(&r, 9).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = move_to_tmux(&r, 5).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(r.fake.calls().iter().all(|c| !c.join(" ").contains("kill")));
}

#[tokio::test]
async fn move_to_tmux_does_not_start_when_the_agent_keeps_running() {
    let r = rig();
    r.fake.stub("kill ", Output::failed(1, "still running"));
    let (status, body) = move_to_tmux(&r, 77).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(body.contains("still running"), "{body}");
    assert!(r
        .fake
        .calls()
        .iter()
        .all(|c| !c.join(" ").contains("tmux new")));
}

async fn new_code(r: &Rig, c: &str) -> String {
    let (status, _, body) = send(
        &r.app,
        Request::post("/app/handoff")
            .header(header::COOKIE, c)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    v["code"].as_str().unwrap().to_string()
}

async fn redeem(r: &Rig, code: &str) -> (StatusCode, axum::http::HeaderMap, String) {
    send(
        &r.app,
        Request::get(format!("/app/handoff/{code}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn handoff_code_logs_in_once() {
    let r = rig();
    let c = cookie(&r.app).await;
    let code = new_code(&r, &c).await;
    assert_eq!(code.len(), 32);
    let (status, headers, body) = redeem(&r, &code).await;
    assert_eq!(status, StatusCode::OK);
    let set = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(set.starts_with("yardbell_session="), "{set}");
    assert!(set.contains("SameSite=Strict"), "{set}");
    assert!(body.contains("location.replace(\"/\")"), "{body}");
    assert!(
        body.contains(r#"<meta name="color-scheme" content="light dark">"#),
        "{body}"
    );
    assert!(body.contains("background:#0a0a0b"), "{body}");
    let (status, headers, _) = redeem(&r, &code).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "/login");
    assert!(!headers.contains_key(header::SET_COOKIE));
}

#[tokio::test]
async fn handoff_cookie_is_session_only() {
    let r = rig();
    let c = cookie(&r.app).await;
    let code = new_code(&r, &c).await;
    let (status, headers, _) = redeem(&r, &code).await;
    assert_eq!(status, StatusCode::OK);
    let set = headers[header::SET_COOKIE].to_str().unwrap();
    assert!(set.starts_with("yardbell_session="), "{set}");
    assert!(set.contains("HttpOnly"), "{set}");
    assert!(set.contains("SameSite=Strict"), "{set}");
    let lower = set.to_ascii_lowercase();
    assert!(!lower.contains("max-age"), "{set}");
    assert!(!lower.contains("expires"), "{set}");
    let session = set.split(';').next().unwrap().to_string();
    let req = Request::get("/state")
        .header(header::COOKIE, session)
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&r.app, req).await.0, StatusCode::OK);
}

#[tokio::test]
async fn handoff_code_expires_after_30_seconds() {
    let r = rig();
    let c = cookie(&r.app).await;
    let code = new_code(&r, &c).await;
    r.advance(31);
    let (status, headers, _) = redeem(&r, &code).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "/login");
    assert!(!headers.contains_key(header::SET_COOKIE));
}

#[tokio::test]
async fn handoff_needs_login() {
    let r = rig();
    let (status, _, _) = send(
        &r.app,
        Request::post("/app/handoff").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn handoff_keeps_16_codes() {
    let r = rig();
    let c = cookie(&r.app).await;
    let first = new_code(&r, &c).await;
    let mut last = String::new();
    for _ in 0..16 {
        last = new_code(&r, &c).await;
    }
    let (status, _, _) = redeem(&r, &first).await;
    assert_eq!(status, StatusCode::FOUND);
    let (status, _, _) = redeem(&r, &last).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn refresh_runs_a_check_of_every_machine_now() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::post("/refresh")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(r.refreshes.load(std::sync::atomic::Ordering::SeqCst), 1);
    let (status, _, _) = send(
        &r.app,
        Request::post("/refresh").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.refreshes.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn shell_opens_a_plain_session_on_the_machine() {
    let r = rig();
    r.fake.stub("tmux", Output::ok_with(""));
    let c = cookie(&r.app).await;
    let req = Request::post("/machines/hp/shell")
        .header(header::COOKIE, c.clone())
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["name"], "hp-shell");
    let req = Request::post("/machines/nope/shell")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

const OK_BODY: &str = r#"{"ok":true}"#;

async fn get_settings(r: &Rig, c: &str) -> (serde_json::Value, String) {
    let req = Request::get("/api/settings")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (serde_json::from_str(&body).unwrap(), body)
}

async fn phone_post(r: &Rig, c: &str, route: &str) -> (StatusCode, String) {
    let url = format!("/api/settings/phone/{route}");
    let (status, _, body) = post_json(&r.app, c, &url, "{}").await;
    (status, body)
}

async fn save_phone(r: &Rig, c: &str, changes: serde_json::Value) -> (StatusCode, String) {
    let mut form = json!({
        "server": "https://ntfy.sh",
        "wait_minutes": 2,
        "agent_waiting": true,
        "session_ended": true,
        "machines": true,
        "memory": true,
    });
    form.as_object_mut()
        .unwrap()
        .extend(changes.as_object().unwrap().clone());
    let (status, _, body) = post_json(&r.app, c, "/api/settings/phone", &form.to_string()).await;
    (status, body)
}

fn stored_token(r: &Rig) -> String {
    Config::load(&r.app.cfg_path)
        .unwrap()
        .phone_notifications
        .token
}

#[tokio::test]
async fn phone_setup_creates_a_topic_once() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (before, _) = get_settings(&r, &c).await;
    assert_eq!(
        before["phone"],
        json!({
            "on": false,
            "server": "https://ntfy.sh",
            "topic": "",
            "wait_minutes": 2,
            "agent_waiting": true,
            "session_ended": true,
            "machines": true,
            "memory": true,
            "token_set": false,
            "last_sent": null,
            "last_error": null,
            "last_error_at": null,
        })
    );

    let mut topics = Vec::new();
    for _ in 0..2 {
        let (status, body) = phone_post(&r, &c, "setup").await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, OK_BODY));
        let (settings, _) = get_settings(&r, &c).await;
        assert_eq!(settings["phone"]["on"], true);
        topics.push(settings["phone"]["topic"].as_str().unwrap().to_string());
    }
    let shape = regex::Regex::new("^yardbell-[A-Za-z0-9]{24}$").unwrap();
    assert!(shape.is_match(&topics[0]), "{topics:?}");
    assert_eq!(topics[0], topics[1]);

    let (status, _, body) = post_json(&r.app, &c, "/api/settings/undo", "{}").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (settings, _) = get_settings(&r, &c).await;
    assert_eq!(
        settings["phone"]["on"], false,
        "the second setup must not write, so one Undo goes back to off"
    );
}

#[tokio::test]
async fn phone_settings_are_validated_and_trimmed() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, body) = save_phone(
        &r,
        &c,
        json!({
            "server": " https://ntfy.example.com ",
            "wait_minutes": 7,
            "agent_waiting": false,
            "session_ended": false,
            "machines": false,
            "memory": false,
        }),
    )
    .await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, OK_BODY));
    let (saved, _) = get_settings(&r, &c).await;
    assert_eq!(
        saved["phone"],
        json!({
            "on": false,
            "server": "https://ntfy.example.com",
            "topic": "",
            "wait_minutes": 7,
            "agent_waiting": false,
            "session_ended": false,
            "machines": false,
            "memory": false,
            "token_set": false,
            "last_sent": null,
            "last_error": null,
            "last_error_at": null,
        })
    );

    let (status, body) = save_phone(&r, &c, json!({"wait_minutes": 61})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body.contains("phone_notifications.wait_minutes must be from 0 to 60"),
        "{body}"
    );
    let (after, _) = get_settings(&r, &c).await;
    assert_eq!(
        after["phone"], saved["phone"],
        "a refused save changes nothing"
    );
}

#[tokio::test]
async fn phone_token_is_kept_replaced_or_cleared_and_never_returned() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut seen = Vec::new();
    for (changes, stored) in [
        (json!({"token": " tk_secret "}), "tk_secret"),
        (json!({"wait_minutes": 9}), "tk_secret"),
        (json!({"token": "  "}), "tk_secret"),
        (json!({"token": "tk_other"}), "tk_other"),
        (
            json!({"token": "tk_third", "clear_token": true}),
            "tk_third",
        ),
        (json!({"clear_token": true}), ""),
    ] {
        let (status, body) = save_phone(&r, &c, changes.clone()).await;
        assert_eq!(
            (status, body.as_str()),
            (StatusCode::OK, OK_BODY),
            "{changes}"
        );
        assert_eq!(stored_token(&r), stored, "{changes}");
        let (settings, raw) = get_settings(&r, &c).await;
        assert_eq!(
            settings["phone"]["token_set"],
            !stored.is_empty(),
            "{changes}"
        );
        seen.extend([body, raw]);
    }
    for body in seen {
        assert!(!body.contains("tk_"), "{body}");
    }
}

#[tokio::test]
async fn phone_test_sends_one_notification() {
    let r = rig();
    let c = cookie(&r.app).await;
    phone_post(&r, &c, "setup").await;
    save_phone(
        &r,
        &c,
        json!({"server": "https://ntfy.example.com", "token": "tk_secret"}),
    )
    .await;
    let (settings, _) = get_settings(&r, &c).await;
    let topic = settings["phone"]["topic"].as_str().unwrap().to_string();

    let (status, body) = phone_post(&r, &c, "test").await;

    assert_eq!((status, body.as_str()), (StatusCode::OK, OK_BODY));
    let calls = r.phone_sender.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    let (to, push) = &calls[0];
    assert_eq!(
        *to,
        Target {
            server: "https://ntfy.example.com".into(),
            topic,
            token: Some("tk_secret".into()),
        }
    );
    assert_eq!(
        (push.title.as_str(), push.message.as_str()),
        ("Yardbell", "Notifications from mini work.")
    );
    let (settings, raw) = get_settings(&r, &c).await;
    assert!(settings["phone"]["last_sent"].is_string(), "{raw}");
    assert!(!raw.contains("tk_secret"), "{raw}");
}

#[tokio::test]
async fn phone_test_names_yardbell_without_a_local_machine() {
    let r = rig();
    let c = cookie(&r.app).await;
    phone_post(&r, &c, "setup").await;
    let mut cfg = Config::load(&r.app.cfg_path).unwrap();
    let host = cfg.machines.iter_mut().find(|m| m.local).unwrap();
    host.local = false;
    host.port_prefix = Some(3);
    cfg.save(&r.app.cfg_path).unwrap();

    let (status, body) = phone_post(&r, &c, "test").await;

    assert_eq!((status, body.as_str()), (StatusCode::OK, OK_BODY));
    assert_eq!(
        r.phone_sender.calls()[0].1.message,
        "Notifications from Yardbell work."
    );
}

#[tokio::test]
async fn phone_test_reports_the_error() {
    let r = rig();
    let c = cookie(&r.app).await;
    phone_post(&r, &c, "setup").await;
    let failure = "https://ntfy.example.com answered 429: limit reached";
    r.phone_sender.fail_all(failure);

    let (status, body) = phone_post(&r, &c, "test").await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(body.contains(failure), "{body}");
    assert_eq!(r.phone_sender.calls().len(), 1, "a test is one attempt");
    let (settings, _) = get_settings(&r, &c).await;
    assert_eq!(settings["phone"]["last_error"], failure);
    assert!(settings["phone"]["last_error_at"].is_string());
    assert!(settings["phone"]["last_sent"].is_null());
}

#[tokio::test]
async fn phone_test_error_hides_the_token_a_server_echoes() {
    let r = rig();
    let c = cookie(&r.app).await;
    phone_post(&r, &c, "setup").await;
    save_phone(&r, &c, json!({"token": "tk_secret"})).await;
    r.phone_sender
        .fail_all("https://ntfy.sh answered 401: Bearer tk_secret is not valid");

    let (status, body) = phone_post(&r, &c, "test").await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(!body.contains("tk_secret"), "{body}");
    let (settings, raw) = get_settings(&r, &c).await;
    assert!(!raw.contains("tk_secret"), "{raw}");
    assert_eq!(
        settings["phone"]["last_error"],
        "https://ntfy.sh answered 401: Bearer [token] is not valid"
    );
}

#[tokio::test]
async fn phone_test_is_refused_while_off() {
    let r = rig();
    let c = cookie(&r.app).await;

    let (status, body) = phone_post(&r, &c, "test").await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("Set up phone notifications first"), "{body}");
    assert!(r.phone_sender.calls().is_empty());
}

#[tokio::test]
async fn phone_off_clears_the_topic_and_undo_restores_it() {
    let r = rig();
    let c = cookie(&r.app).await;
    phone_post(&r, &c, "setup").await;
    save_phone(
        &r,
        &c,
        json!({
            "server": "https://ntfy.example.com",
            "wait_minutes": 0,
            "memory": false,
            "token": "tk_secret",
        }),
    )
    .await;
    let (on, _) = get_settings(&r, &c).await;
    assert_eq!(on["phone"]["on"], true);

    let (status, body) = phone_post(&r, &c, "off").await;

    assert_eq!((status, body.as_str()), (StatusCode::OK, OK_BODY));
    let (off, _) = get_settings(&r, &c).await;
    let mut expected = on["phone"].clone();
    expected["on"] = json!(false);
    expected["topic"] = json!("");
    assert_eq!(off["phone"], expected, "only the topic is cleared");
    assert_eq!(stored_token(&r), "tk_secret");

    let (status, body) = phone_post(&r, &c, "off").await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, OK_BODY));
    let (status, _, body) = post_json(&r.app, &c, "/api/settings/undo", "{}").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (restored, _) = get_settings(&r, &c).await;
    assert_eq!(
        restored["phone"], on["phone"],
        "the second off must not write, so Undo restores the topic"
    );
}

#[tokio::test]
async fn phone_routes_need_a_login_and_the_page_origin() {
    let r = rig();
    let c = cookie(&r.app).await;
    for url in [
        "/api/settings/phone/setup",
        "/api/settings/phone",
        "/api/settings/phone/test",
        "/api/settings/phone/off",
    ] {
        let anonymous = Request::post(url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(
            send(&r.app, anonymous).await.0,
            StatusCode::UNAUTHORIZED,
            "{url}"
        );
        let foreign = Request::post(url)
            .header(header::HOST, "localhost:4000")
            .header(header::ORIGIN, "http://localhost:13020")
            .header(header::COOKIE, c.clone())
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(
            send(&r.app, foreign).await.0,
            StatusCode::FORBIDDEN,
            "{url}"
        );
    }
    let (settings, _) = get_settings(&r, &c).await;
    assert_eq!(settings["phone"]["on"], false);
    assert!(r.phone_sender.calls().is_empty());
}

#[tokio::test]
async fn move_to_tmux_says_the_agent_was_stopped_when_it_cannot_start_again() {
    let r = rig();
    r.fake.stub("kill ", Output::ok_with(""));
    r.fake.stub(
        "tmux new",
        Output::failed(127, "Codex is not installed on hp\n"),
    );
    let (status, body) = move_to_tmux(&r, 77).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(body.contains("Codex is not installed on hp"), "{body}");
    assert!(body.contains("was stopped"), "{body}");
}

fn with_recent(r: &Rig, recent: &[&str]) {
    let mut cfg = Config::load(&r.app.cfg_path).unwrap();
    let hp = cfg.machines.iter_mut().find(|m| m.name == "hp").unwrap();
    hp.recent = recent.iter().map(|p| p.to_string()).collect();
    cfg.save(&r.app.cfg_path).unwrap();
}

#[tokio::test]
async fn forgetting_a_recent_folder_removes_it_for_that_machine() {
    let r = rig();
    with_recent(&r, &["/r/app", "/r/web"]);
    let c = cookie(&r.app).await;
    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/machines/hp/recent/forget",
        r#"{"path":"/r/app"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["recent"], serde_json::json!(["/r/web"]));
    let cfg = Config::load(&r.app.cfg_path).unwrap();
    assert_eq!(cfg.machine("hp").unwrap().recent, vec!["/r/web"]);

    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/machines/hp/recent/forget",
        r#"{"path":"/r/gone"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let cfg = Config::load(&r.app.cfg_path).unwrap();
    assert_eq!(cfg.machine("hp").unwrap().recent, vec!["/r/web"]);
}

#[tokio::test]
async fn forgetting_a_recent_folder_needs_a_known_machine() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (status, _, _) = post_json(
        &r.app,
        &c,
        "/machines/nope/recent/forget",
        r#"{"path":"/r/app"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn state_carries_the_build_of_the_page_files() {
    let r = rig();
    let c = cookie(&r.app).await;
    let get = || {
        Request::get("/state")
            .header(header::COOKIE, c.clone())
            .body(Body::empty())
            .unwrap()
    };
    let (status, headers, _) = send(&r.app, get()).await;
    assert_eq!(status, StatusCode::OK);
    let build = headers
        .get("x-yardbell-build")
        .expect("no build header")
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(build.len(), 16, "{build}");
    assert!(build.chars().all(|c| c.is_ascii_hexdigit()), "{build}");
    let (_, again, _) = send(&r.app, get()).await;
    assert_eq!(again.get("x-yardbell-build").unwrap(), build.as_str());
}

async fn mcp(
    app: &Arc<AppState>,
    token: Option<&str>,
    origin: Option<&str>,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let mut req = Request::post("/mcp")
        .header(header::HOST, "localhost:4000")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(origin) = origin {
        req = req.header(header::ORIGIN, origin);
    }
    let res = router(app.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

fn mcp_on(r: &Rig) -> String {
    r.app
        .settings
        .set_mcp_token(Some("yb_secret".into()))
        .unwrap();
    "yb_secret".into()
}

fn rpc(method: &str, params: serde_json::Value) -> serde_json::Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
}

async fn tool_call(r: &Rig, name: &str, args: serde_json::Value) -> serde_json::Value {
    let (status, body) = mcp(
        &r.app,
        Some("yb_secret"),
        None,
        rpc("tools/call", json!({ "name": name, "arguments": args })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["result"].clone()
}

#[tokio::test]
async fn mcp_is_off_until_a_token_is_set() {
    let r = rig();
    let (status, body) = mcp(&r.app, Some("anything"), None, rpc("ping", json!({}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"],
        "the MCP server is off, turn it on in Settings"
    );
}

#[tokio::test]
async fn mcp_needs_the_bearer_token_and_rejects_other_sites() {
    let r = rig();
    mcp_on(&r);
    for token in [None, Some("yb_wrong")] {
        let (status, _) = mcp(&r.app, token, None, rpc("ping", json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _) = mcp(
        &r.app,
        Some("yb_secret"),
        Some("http://evil.example"),
        rpc("ping", json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = mcp(&r.app, Some("yb_secret"), None, rpc("ping", json!({}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["result"], json!({}));
}

#[tokio::test]
async fn mcp_initialize_lists_tools_and_accepts_notifications() {
    let r = rig();
    mcp_on(&r);
    let (_, body) = mcp(
        &r.app,
        Some("yb_secret"),
        None,
        rpc("initialize", json!({ "protocolVersion": "2025-03-26" })),
    )
    .await;
    assert_eq!(body["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(body["result"]["serverInfo"]["name"], "yardbell");
    let (status, _) = mcp(
        &r.app,
        Some("yb_secret"),
        None,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (_, body) = mcp(
        &r.app,
        Some("yb_secret"),
        None,
        rpc("tools/list", json!({})),
    )
    .await;
    let names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "list_machines",
            "list_sessions",
            "list_folders",
            "start_session",
            "read_session",
            "send_to_session",
            "stop_session"
        ]
    );
    let (_, body) = mcp(&r.app, Some("yb_secret"), None, rpc("nope", json!({}))).await;
    assert_eq!(body["error"]["code"], -32601);
}

#[tokio::test]
async fn mcp_lists_sessions_for_one_machine() {
    let r = rig();
    mcp_on(&r);
    let result = tool_call(&r, "list_sessions", json!({ "machine": "hp" })).await;
    assert_eq!(result["isError"], false);
    let sessions: serde_json::Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(sessions.as_array().unwrap().len(), 2);
    assert_eq!(sessions[0]["tmux"], "hp-eng-1301");
    let result = tool_call(&r, "list_sessions", json!({ "machine": "mini" })).await;
    assert_eq!(result["content"][0]["text"], "[]");
}

#[tokio::test]
async fn mcp_start_session_passes_the_task_and_refreshes() {
    let r = rig();
    mcp_on(&r);
    r.fake.stub("tmux new", Output::ok_with(""));
    let result = tool_call(
        &r,
        "start_session",
        json!({ "machine": "hp", "folder": "slot2", "prompt": "fix the inbox" }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    let started: serde_json::Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(started["name"], "hp-eng-1301");
    let call = r.fake.calls().pop().unwrap();
    assert!(call.last().unwrap().contains("fix the inbox"), "{call:?}");
    assert_eq!(r.refreshes.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn mcp_tool_errors_come_back_as_error_results() {
    let r = rig();
    mcp_on(&r);
    let result = tool_call(
        &r,
        "stop_session",
        json!({ "machine": "nope", "name": "x" }),
    )
    .await;
    assert_eq!(result["isError"], true);
    assert_eq!(result["content"][0]["text"], "no machine named nope");
    let result = tool_call(
        &r,
        "send_to_session",
        json!({ "machine": "hp", "name": "hp-eng-1301", "text": "" }),
    )
    .await;
    assert_eq!(result["content"][0]["text"], "text is empty");
}

#[tokio::test]
async fn the_dispatch_token_works_while_mcp_is_off() {
    let r = rig();
    let token = r.app.dispatch.token().to_string();
    let (status, body) = mcp(&r.app, Some(&token), None, rpc("ping", json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn dispatch_routes_need_login_and_check_conversation_ids() {
    let r = rig();
    let get = |url: &str, cookie: Option<&str>| {
        let mut req = Request::get(url).header(header::ACCEPT, "application/json");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        req.body(Body::empty()).unwrap()
    };
    let (status, _, _) = send(&r.app, get("/dispatch/conversations", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let c = cookie(&r.app).await;
    let (status, _, body) = send(&r.app, get("/dispatch/conversations", Some(&c))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "[]");
    for url in [
        "/dispatch/conversations/..%2F..%2Fetc",
        "/dispatch/conversations/abcdefghijklmnop",
    ] {
        let (status, _, _) = send(&r.app, get(url, Some(&c))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{url}");
    }
    let post = |url: &str, body: &'static str| {
        Request::post(url)
            .header(header::COOKIE, &c)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    };
    let (status, _, body) = send(&r.app, post("/dispatch/ask", r#"{"text":"  "}"#)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains("type a task first"), "{body}");
    let (status, _, _) = send(
        &r.app,
        post("/dispatch/ask", r#"{"conversation":"../x","text":"hi"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, body) = send(
        &r.app,
        post("/dispatch/conversations/abcdefghijklmnop/delete", "{}"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains("no such conversation"), "{body}");
    let (status, _, body) = send(&r.app, post("/dispatch/clear", "{}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, r#"{"kept":0}"#);
}

#[tokio::test]
async fn mcp_servers_are_saved_from_settings_and_reach_new_sessions() {
    let r = rig();
    let c = cookie(&r.app).await;
    let save = |body: &'static str| {
        Request::post("/api/settings/mcp/servers")
            .header(header::COOKIE, &c)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    };
    let (status, _, body) = send(&r.app, save(r#"{"servers":[{"name":"gh"}]}"#)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("needs either a command or a URL"), "{body}");
    let (status, _, body) = send(
        &r.app,
        save(r#"{"servers":[{"name":"gh","command":"npx gh-mcp","env":{"GITHUB_TOKEN":"t"}}]}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(r.app.settings.can_undo());

    r.fake.stub("tmux new", Output::ok_with(""));
    let (status, _, body) = send(
        &r.app,
        Request::post("/sessions")
            .header(header::COOKIE, &c)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"machine":"hp","folder":"slot2"}"#))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let call = r.fake.calls().pop().unwrap();
    assert!(call.last().unwrap().contains("--mcp-config"), "{call:?}");
    assert!(call.last().unwrap().contains("gh-mcp"), "{call:?}");
}

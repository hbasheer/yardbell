use super::*;
use crate::config::Config;
use crate::probe::MachineStatus;
use crate::shell::Output;
use crate::snapshot::{Port, Snapshot};
use crate::ssh::Ssh;
use crate::testing::FakeRunner;
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use std::path::Path;
use tower::ServiceExt;

mod insights;
mod mcp_read;
mod memory;
mod pipeline;
mod worktrees;

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
    refreshes: Arc<std::sync::Mutex<Vec<Option<String>>>>,
    now: Arc<std::sync::Mutex<std::time::Instant>>,
    releases_asked: Arc<std::sync::atomic::AtomicUsize>,
    _dir: tempfile::TempDir,
}

impl Rig {
    fn advance(&self, secs: u64) {
        *self.now.lock().unwrap() += std::time::Duration::from_secs(secs);
    }

    fn refreshed(&self) -> Vec<Option<String>> {
        self.refreshes.lock().unwrap().clone()
    }

    async fn rechecked(&self) -> Vec<Option<String>> {
        for _ in 0..20 {
            if !self.refreshed().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        self.refreshed()
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
            host: None,
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
    let refreshes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let releases_asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let services = Services {
        state,
        ports: Arc::new(FakePorts),
        sessions: Sessions::new(fake.clone(), ssh),
        onboarding,
        host_mesh: crate::mesh::HostMesh::new(fake.clone()),
        folders: crate::folders::Folders::new(fake.clone(), Ssh::new(dir.path().join("state2"))),
        worktrees: crate::worktrees::Worktrees::new(
            fake.clone(),
            Ssh::new(dir.path().join("state3")),
        ),
        settings: crate::settings::Settings::new(
            cfg_path.clone(),
            dir.path().join("ssh_config"),
            Arc::new(chrono::Local::now),
        ),
        phone: Arc::new(Phone::default()),
        dispatch: Arc::new(crate::dispatch::Dispatch::new(
            fake.clone(),
            dir.path().join("dispatch"),
        )),
        triggers: Arc::new(crate::triggers::Triggers::new(
            Arc::new(crate::triggers::Live::new(fake.clone())),
            dir.path().join("triggers.json"),
        )),
        insights: Arc::new(crate::insights::Insights::load(
            dir.path().join("insights.json"),
        )),
        pipelines: Arc::new(crate::pipeline::Pipelines::new(
            dir.path().join("pipelines-state"),
        )),
        refresh: {
            let refreshes = refreshes.clone();
            Arc::new(move |machine: Option<String>| {
                let refreshes = refreshes.clone();
                Box::pin(async move { refreshes.lock().unwrap().push(machine) })
            })
        },
        releases: {
            let asked = releases_asked.clone();
            Arc::new(move || {
                asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Box::pin(async {
                    Ok(json!({
                        "tag_name": "v99.0.0",
                        "html_url": "https://github.com/hbasheer/yardbell/releases/tag/v99.0.0",
                    }))
                })
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
        refreshes,
        now,
        releases_asked,
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

#[tokio::test]
async fn pages_that_show_the_state_load_the_live_script_first() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::get("/live.js")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, headers, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );
    assert!(body.contains("YardbellLive"));
    for (page, user) in [
        ("dashboard.html", "/nav.js"),
        ("dispatch.html", "/nav.js"),
        ("settings.html", "/nav.js"),
        ("add.html", "/nav.js"),
        ("workspace.html", "/workspace.js"),
    ] {
        let html = String::from_utf8(Assets::get(page).unwrap().data.into_owned()).unwrap();
        let live = html
            .find(r#"<script src="/live.js"></script>"#)
            .unwrap_or_else(|| panic!("{page} does not load live.js"));
        let later = html.find(&format!(r#"<script src="{user}"></script>"#));
        assert!(later.is_some_and(|at| live < at), "{page}");
    }
}

fn resolve_import(from: &str, spec: &str) -> String {
    if spec.starts_with('/') {
        return spec.to_string();
    }
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for seg in spec.split('/') {
        match seg {
            "." => {}
            ".." => {
                parts.pop();
            }
            seg => parts.push(seg),
        }
    }
    parts.join("/")
}

#[tokio::test]
async fn every_module_a_page_imports_is_served() {
    let r = rig();
    let c = cookie(&r.app).await;
    let import = regex::Regex::new(r#"\bfrom\s*["']([^"']+)["']"#).unwrap();
    for page in ["dashboard", "dispatch"] {
        let html = String::from_utf8(
            Assets::get(&format!("{page}.html"))
                .unwrap()
                .data
                .into_owned(),
        )
        .unwrap();
        let script = format!(r#"<script type="module" src="/{page}.js"></script>"#);
        assert!(html.contains(&script), "{page}");
        let mut queue = vec![format!("/{page}.js")];
        let mut seen = std::collections::HashSet::new();
        while let Some(path) = queue.pop() {
            if !seen.insert(path.clone()) {
                continue;
            }
            let req = Request::get(&path)
                .header(header::COOKIE, c.clone())
                .body(Body::empty())
                .unwrap();
            let (status, headers, body) = send(&r.app, req).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert_eq!(
                headers[header::CONTENT_TYPE],
                "text/javascript; charset=utf-8",
                "{path}"
            );
            for spec in import.captures_iter(&body) {
                queue.push(resolve_import(&path, &spec[1]));
            }
        }
        assert!(
            seen.contains("/vendor/lit-html/directive-helpers.js"),
            "{page}: {seen:?}"
        );
    }
}

#[tokio::test]
async fn the_phone_app_polls_its_notifications() {
    let r = rig();
    let get = |path: &str, c: Option<&str>| {
        let req = Request::get(path).header(header::ACCEPT, "application/json");
        let req = match c {
            Some(c) => req.header(header::COOKIE, c),
            None => req,
        };
        req.body(Body::empty()).unwrap()
    };
    let (status, _, _) = send(&r.app, get("/app/notifications", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let c = cookie(&r.app).await;
    let (status, _, body) = send(&r.app, get("/app/notifications", Some(&c))).await;
    assert_eq!(status, StatusCode::OK);
    let start: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(start["notes"], json!([]));
    r.app.phone.inbox.add(&[crate::phone::Push {
        title: "hp: claude is waiting".into(),
        message: "yardbell".into(),
        tags: Vec::new(),
        priority: 3,
        click: None,
    }]);
    let path = format!(
        "/app/notifications?boot={}&after={}",
        start["boot"].as_str().unwrap(),
        start["next"]
    );
    let (status, _, body) = send(&r.app, get(&path, Some(&c))).await;
    assert_eq!(status, StatusCode::OK);
    let page: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(page["notes"][0]["title"], "hp: claude is waiting");
}

#[tokio::test]
async fn the_theme_script_loads_before_login_and_on_every_page() {
    let r = rig();
    let (status, _, body) = send(
        &r.app,
        Request::get("/theme.js").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("yardbell.theme"));
    for page in [
        "dashboard.html",
        "workspace.html",
        "dispatch.html",
        "settings.html",
        "add.html",
        "login.html",
        "term.html",
    ] {
        let html = String::from_utf8(Assets::get(page).unwrap().data.to_vec()).unwrap();
        assert!(
            html.contains(r#"<script src="/theme.js"></script>"#),
            "{page}"
        );
    }
}

#[tokio::test]
async fn state_says_where_the_server_runs() {
    let r = rig();
    let c = cookie(&r.app).await;
    let req = Request::get("/state")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
    let view: Value = serde_json::from_str(&body).unwrap();
    let server = &view["server"];
    assert!(
        server["machine"].as_str().is_some_and(|m| !m.is_empty()),
        "{server}"
    );
    assert!(
        server["address"].as_str().is_some_and(|a| a.contains(':')),
        "{server}"
    );
    assert_eq!(server["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn about_needs_a_login() {
    let r = rig();
    for path in ["/app/about", "/app/about/updates"] {
        let req = Request::get(path)
            .header(header::ACCEPT, "application/json")
            .body(Body::empty())
            .unwrap();
        let (status, _, _) = send(&r.app, req).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }
    assert_eq!(
        r.releases_asked.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[tokio::test]
async fn about_says_which_yardbell_runs_where_and_for_how_long() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.advance(90_061);
    let req = Request::get("/app/about")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
    let about: Value = serde_json::from_str(&body).unwrap();
    let version = env!("CARGO_PKG_VERSION");
    assert_eq!(about["version"], version);
    assert_eq!(about["build"], page_build());
    assert_eq!(about["uptime_secs"], 90_061);
    assert_eq!(about["arch"], std::env::consts::ARCH);
    assert!(about["os"].as_str().is_some_and(|os| !os.is_empty()));
    assert!(about["machine"].as_str().is_some_and(|m| !m.is_empty()));
    assert!(about["config"]
        .as_str()
        .is_some_and(|p| p.ends_with("yardbell.yml")));
    assert_eq!(
        about["links"]["release"],
        format!("https://github.com/hbasheer/yardbell/releases/tag/v{version}")
    );
    assert_eq!(
        r.releases_asked.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the figures never wait on GitHub"
    );
}

#[tokio::test]
async fn the_update_check_asks_github_once_an_hour() {
    let r = rig();
    let c = cookie(&r.app).await;
    let check = || {
        Request::get("/app/about/updates")
            .header(header::COOKIE, c.clone())
            .body(Body::empty())
            .unwrap()
    };
    let (status, _, body) = send(&r.app, check()).await;
    assert_eq!(status, StatusCode::OK);
    let answer: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        answer,
        json!({
            "state": "available",
            "latest": "99.0.0",
            "url": "https://github.com/hbasheer/yardbell/releases/tag/v99.0.0",
        })
    );
    send(&r.app, check()).await;
    let asked = || r.releases_asked.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(asked(), 1);
    r.advance(3600);
    send(&r.app, check()).await;
    assert_eq!(asked(), 2);
}

#[tokio::test]
async fn workspace_is_served_and_linked_from_every_sidebar() {
    let r = rig();
    let (status, headers, _) = send(
        &r.app,
        Request::get("/workspace").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "/login");
    let c = cookie(&r.app).await;
    for (path, needle) in [
        ("/workspace", r#"<script src="/workspace.js"></script>"#),
        ("/workspace.js", "ws-picking"),
    ] {
        let req = Request::get(path)
            .header(header::COOKIE, c.clone())
            .body(Body::empty())
            .unwrap();
        let (status, _, body) = send(&r.app, req).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(body.contains(needle), "{path}");
    }
    for page in [
        "dashboard.html",
        "dispatch.html",
        "settings.html",
        "add.html",
    ] {
        let html = String::from_utf8(Assets::get(page).unwrap().data.into_owned()).unwrap();
        assert!(html.contains(r#"href="/workspace""#), "{page}");
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
    assert_eq!(r.refreshed(), [None]);
    let (status, _, _) = send(
        &r.app,
        Request::post("/refresh").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.refreshed(), [None]);
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

async fn save_phone(r: &Rig, c: &str, changes: serde_json::Value) -> (StatusCode, String) {
    let mut form = json!({
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

#[tokio::test]
async fn phone_settings_are_saved_and_validated() {
    let r = rig();
    let c = cookie(&r.app).await;
    let (before, _) = get_settings(&r, &c).await;
    assert_eq!(
        before["phone"],
        json!({
            "app_connected": false,
            "wait_minutes": 2,
            "agent_waiting": true,
            "session_ended": true,
            "machines": true,
            "memory": true,
        })
    );
    let (status, body) = save_phone(
        &r,
        &c,
        json!({
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
            "app_connected": false,
            "wait_minutes": 7,
            "agent_waiting": false,
            "session_ended": false,
            "machines": false,
            "memory": false,
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
async fn settings_say_when_the_phone_app_is_connected() {
    let r = rig();
    let c = cookie(&r.app).await;
    r.app.phone.inbox.page(None, 0, std::time::Instant::now());
    let (settings, _) = get_settings(&r, &c).await;
    assert_eq!(settings["phone"]["app_connected"], true);
}

#[tokio::test]
async fn phone_settings_need_a_login_and_the_page_origin() {
    let r = rig();
    let c = cookie(&r.app).await;
    let url = "/api/settings/phone";
    let anonymous = Request::post(url)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(send(&r.app, anonymous).await.0, StatusCode::UNAUTHORIZED);
    let foreign = Request::post(url)
        .header(header::HOST, "localhost:4000")
        .header(header::ORIGIN, "http://localhost:13020")
        .header(header::COOKIE, c.clone())
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(send(&r.app, foreign).await.0, StatusCode::FORBIDDEN);
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
            "stop_session",
            "review_session",
            "scan_folder",
            "start_group",
            "remove_worktree",
            "integrate_branches",
            "push_branch",
            "move_session",
            "read_settings",
            "list_conversations",
            "read_conversation",
            "list_tasks",
            "read_task",
            "list_pipelines",
            "read_pipeline",
            "list_runs",
            "read_run"
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
    assert_eq!(r.refreshed(), [Some("hp".to_string())]);
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

async fn dispatch_conversation(r: &Rig) -> String {
    let script = r._dir.path().join("claude");
    std::fs::write(
        &script,
        "#!/bin/sh\necho '{\"type\":\"result\",\"is_error\":false,\"result\":\"ok\"}'\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    r.fake.stub(
        "command -v claude",
        Output::ok_with(&format!("{}\n", script.display())),
    );
    let (id, mut rx) = r
        .app
        .dispatch
        .ask(
            None,
            "fix the inbox",
            4000,
            &crate::config::DispatchSettings::default(),
            None,
        )
        .await
        .unwrap();
    while rx.recv().await.is_some() {}
    id
}

async fn dispatch_tool(
    r: &Rig,
    conversation: Option<&str>,
    name: &str,
    args: serde_json::Value,
) -> serde_json::Value {
    let mut req = Request::post("/mcp")
        .header(header::HOST, "localhost:4000")
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", r.app.dispatch.token()),
        );
    if let Some(conversation) = conversation {
        req = req.header(crate::dispatch::CONVERSATION_HEADER, conversation);
    }
    let body = rpc("tools/call", json!({ "name": name, "arguments": args }));
    let res = router(r.app.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["result"].clone()
}

async fn step_post(
    r: &Rig,
    cookie: &str,
    url: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = Request::post(url)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (
        status,
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
    )
}

fn last_event(r: &Rig, id: &str) -> serde_json::Value {
    r.app.dispatch.get(id).unwrap()["events"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone()
}

fn ran(r: &Rig, command: &str) -> bool {
    r.fake
        .calls()
        .iter()
        .any(|call| call.join(" ").contains(command))
}

#[tokio::test]
async fn dispatch_steps_wait_for_approval_then_run_once() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    let start = json!({ "machine": "hp", "folder": "slot2", "prompt": "fix the inbox" });
    let result = dispatch_tool(&r, Some(&id), "start_session", start.clone()).await;
    assert_eq!(result["isError"], false, "{result}");
    let note = result["content"][0]["text"].as_str().unwrap();
    assert!(
        note.starts_with("Not run yet. This is now proposal "),
        "{note}"
    );
    assert!(
        !ran(&r, "tmux new"),
        "nothing runs before the person approves"
    );
    let step = last_event(&r, &id);
    assert_eq!(
        (&step["role"], &step["status"], &step["by"], &step["input"]),
        (
            &json!("action"),
            &json!("pending"),
            &json!("dispatch"),
            &start
        )
    );
    let step_id = step["id"].as_str().unwrap().to_string();

    let mistake = dispatch_tool(
        &r,
        Some(&id),
        "start_session",
        json!({ "machine": "hp", "folder": "nope" }),
    )
    .await;
    assert_eq!(mistake["isError"], true);
    assert_eq!(mistake["content"][0]["text"], "hp has no folder nope");
    let lost = dispatch_tool(
        &r,
        None,
        "stop_session",
        json!({ "machine": "hp", "name": "x" }),
    )
    .await;
    assert_eq!(lost["isError"], true);
    assert_eq!(
        r.app.dispatch.pending(&id),
        std::slice::from_ref(&step_id),
        "neither became a step"
    );

    r.fake.stub("tmux new", Output::ok_with("hp-eng-1301\n"));
    let url = format!("/dispatch/conversations/{id}/actions/{step_id}");
    let (status, done) = step_post(&r, &c, &url, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["status"], "approved");
    assert_eq!(done["result"]["ok"], true);
    assert_eq!(done["result"]["session"]["name"], "hp-eng-1301");
    assert!(ran(&r, "fix the inbox"));
    assert_eq!(r.refreshed(), [Some("hp".to_string())]);
    assert_eq!(
        r.app.dispatch.get(&id).unwrap()["sessions"][0]["name"],
        "hp-eng-1301"
    );
    let (status, again) = step_post(&r, &c, &url, json!({ "decision": "approve" })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(again["error"], "this step was already approved");
    for bad in [
        "/dispatch/conversations/{id}/actions/../x",
        "/dispatch/conversations/{id}/actions/abc",
    ] {
        let (status, _) = step_post(
            &r,
            &c,
            &bad.replace("{id}", &id),
            json!({ "decision": "approve" }),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
    }
}

#[tokio::test]
async fn dispatch_steps_can_be_edited_rejected_or_approved_together() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    let propose = |name: &'static str, args: serde_json::Value| {
        let (r, id) = (&r, id.clone());
        async move {
            dispatch_tool(r, Some(&id), name, args).await;
            last_event(r, &id)["id"].as_str().unwrap().to_string()
        }
    };
    let start = propose(
        "start_session",
        json!({ "machine": "hp", "folder": "slot2", "prompt": "fix the inbox" }),
    )
    .await;
    let answer = propose(
        "send_to_session",
        json!({ "machine": "hp", "name": "hp-eng-1301", "text": "yes" }),
    )
    .await;
    let url = |step: &str| format!("/dispatch/conversations/{id}/actions/{step}");

    let (status, body) = step_post(
        &r,
        &c,
        &url(&start),
        json!({ "decision": "approve", "input": { "machine": "nope", "folder": "slot2" } }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "no machine named nope");
    assert_eq!(
        r.app.dispatch.pending(&id).len(),
        2,
        "a bad edit decides nothing"
    );

    r.fake.stub("tmux new", Output::ok_with("hp-eng-1301\n"));
    let edited =
        json!({ "machine": "hp", "folder": "slot2", "prompt": "fix the inbox and add a test" });
    let (status, done) = step_post(
        &r,
        &c,
        &url(&start),
        json!({ "decision": "approve", "input": edited }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["status"], "edited");
    assert_eq!(done["original"]["prompt"], "fix the inbox");
    assert!(ran(&r, "fix the inbox and add a test"));

    let (status, rejected) =
        step_post(&r, &c, &url(&answer), json!({ "decision": "reject" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rejected["status"], "rejected");
    assert!(!ran(&r, "send-keys"), "a rejected step never runs");
    let (status, _) = step_post(&r, &c, &url(&answer), json!({ "decision": "maybe" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    r.fake.stub("kill-session", Output::ok_with(""));
    for name in ["hp-a", "hp-b"] {
        propose("stop_session", json!({ "machine": "hp", "name": name })).await;
    }
    let (status, all) = step_post(
        &r,
        &c,
        &format!("/dispatch/conversations/{id}/actions"),
        json!({ "decision": "approve" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{all}");
    assert_eq!(all.as_array().unwrap().len(), 2);
    assert!(all
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["result"]["ok"] == true));
    assert!(ran(&r, "kill-session -t '=hp-a'") && ran(&r, "kill-session -t '=hp-b'"));
    assert_eq!(r.app.dispatch.list()[0]["waiting"], 0);
}

#[tokio::test]
async fn with_approval_off_dispatch_steps_run_at_once_and_are_recorded() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    r.app
        .settings
        .set_dispatch(crate::config::DispatchSettings {
            approval: crate::config::Approval::Allow,
            ..Default::default()
        })
        .unwrap();
    r.fake.stub("tmux new", Output::ok_with("hp-eng-1301\n"));
    let result = dispatch_tool(
        &r,
        Some(&id),
        "start_session",
        json!({ "machine": "hp", "folder": "slot2", "prompt": "fix the inbox" }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    let started: serde_json::Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(started["name"], "hp-eng-1301");
    let step = last_event(&r, &id);
    assert_eq!(
        (&step["status"], &step["told"]),
        (&json!("auto"), &json!(true))
    );
    assert_eq!(step["result"]["session"]["name"], "hp-eng-1301");
    assert!(r.app.dispatch.pending(&id).is_empty());
}

fn set_rules(r: &Rig, approval: &str, rules: serde_json::Value) {
    let settings = serde_json::from_value(json!({ "approval": approval, "rules": rules })).unwrap();
    r.app.settings.set_dispatch(settings).unwrap();
}

fn event_count(r: &Rig, id: &str) -> usize {
    r.app.dispatch.get(id).unwrap()["events"]
        .as_array()
        .unwrap()
        .len()
}

#[tokio::test]
async fn dispatch_rules_allow_prompt_or_deny_a_step() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    set_rules(
        &r,
        "ask",
        json!([
            { "action": "start_session", "machine": "hp", "folder": "slot*", "approval": "allow" },
            { "action": "stop_session", "approval": "deny" },
        ]),
    );
    r.fake.stub("tmux new", Output::ok_with("hp-eng-1301\n"));
    let start = json!({ "machine": "hp", "folder": "slot2", "prompt": "fix the inbox" });
    let allowed = dispatch_tool(&r, Some(&id), "start_session", start).await;
    assert_eq!(allowed["isError"], false, "{allowed}");
    assert!(ran(&r, "fix the inbox"), "an allowed step runs at once");
    let step = last_event(&r, &id);
    assert_eq!(
        (&step["status"], &step["result"]["ok"]),
        (&json!("auto"), &json!(true))
    );
    assert_eq!(step["rule"]["folder"], "slot*");

    let before = event_count(&r, &id);
    let stop = json!({ "machine": "hp", "name": "hp-eng-1301" });
    let denied = dispatch_tool(&r, Some(&id), "stop_session", stop).await;
    assert_eq!(denied["isError"], true);
    let text = denied["content"][0]["text"].as_str().unwrap();
    assert!(
        text.starts_with(
            "Refused, not run: the user's Dispatch rule \"deny stop_session on any machine\" refuses it."
        ),
        "{text}"
    );
    assert!(!ran(&r, "kill-session"), "a denied step never runs");
    assert_eq!(event_count(&r, &id), before, "a denied step is no step");

    let answer = json!({ "machine": "hp", "name": "hp-eng-1301", "text": "yes" });
    let asked = dispatch_tool(&r, Some(&id), "send_to_session", answer.clone()).await;
    assert!(asked["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Not run yet."));
    let step = last_event(&r, &id);
    assert_eq!(step["status"], "pending");
    assert!(step.get("rule").is_none(), "the default asked, not a rule");

    set_rules(
        &r,
        "auto",
        json!([
            { "action": "send_to_session", "folder": "/r/slots/slot2", "approval": "prompt" },
            { "action": "stop_session", "folder": "slot2", "approval": "deny" },
            { "action": "review_session", "machine": "hp", "approval": "deny" },
        ]),
    );
    dispatch_tool(&r, Some(&id), "send_to_session", answer).await;
    let step = last_event(&r, &id);
    assert_eq!(step["status"], "pending");
    assert_eq!(
        step["rule"],
        json!({ "action": "send_to_session", "machine": "any", "folder": "/r/slots/slot2", "approval": "prompt" })
    );
    assert!(!ran(&r, "send-keys"));

    let before = event_count(&r, &id);
    let unknown = dispatch_tool(
        &r,
        Some(&id),
        "stop_session",
        json!({ "machine": "hp", "name": "hp-gone" }),
    )
    .await;
    assert_eq!(unknown["isError"], true);
    assert!(unknown["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("because Yardbell cannot tell which folder the session is in"));
    let review = dispatch_tool(
        &r,
        Some(&id),
        "review_session",
        json!({ "machine": "hp", "name": "hp-eng-1301" }),
    )
    .await;
    assert!(review["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("\"deny review_session on hp\""));
    assert_eq!(event_count(&r, &id), before);
    assert!(!ran(&r, "kill-session"));

    set_rules(&r, "deny", json!([]));
    let refused = dispatch_tool(
        &r,
        None,
        "start_session",
        json!({ "machine": "hp", "folder": "slot2" }),
    )
    .await;
    assert!(refused["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("refuse steps that change something unless a rule allows them"));
}

fn group_args(children: serde_json::Value) -> serde_json::Value {
    json!({ "title": "Fix the inbox three ways", "children": children })
}

#[tokio::test]
async fn a_group_starts_each_child_as_the_rules_say() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    set_rules(
        &r,
        "ask",
        json!([
            { "action": "start_session", "machine": "hp", "folder": "slot*", "approval": "allow" },
            { "action": "start_session", "machine": "pro", "approval": "deny" },
        ]),
    );
    r.fake.stub("tmux new", Output::ok_with("hp-eng-1301\n"));
    let result = dispatch_tool(
        &r,
        Some(&id),
        "start_group",
        group_args(json!([
            { "label": "Slot", "machine": "hp", "folder": "slot2", "prompt": "fix the inbox in slot2" },
            { "label": "App", "machine": "hp", "path": "/r/app", "prompt": "fix the inbox in app" },
            { "label": "Pro", "machine": "pro", "path": "/r/app", "prompt": "fix the inbox on pro" },
        ])),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    let note = result["content"][0]["text"].as_str().unwrap();
    assert!(
        note.contains("1) Slot: started as hp-eng-1301 on hp."),
        "{note}"
    );
    assert!(note.contains("2) App: proposal "), "{note}");
    assert!(
        note.contains("3) Pro: refused, not run: the user's Dispatch rule \"deny start_session on pro\" refuses it."),
        "{note}"
    );
    assert!(note.contains("You hear the results with the user's next message."));
    assert!(
        ran(&r, "fix the inbox in slot2"),
        "the allowed child runs at once"
    );
    assert!(
        ran(&r, "YARDBELL RESULT"),
        "with the result block asked for"
    );
    assert!(!ran(&r, "fix the inbox in app") && !ran(&r, "fix the inbox on pro"));

    let events = r.app.dispatch.get(&id).unwrap()["events"].clone();
    let group = events
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["role"] == "group")
        .unwrap()
        .clone();
    assert_eq!(
        group["children"][2]["refused"],
        "the user's Dispatch rule \"deny start_session on pro\" refuses it"
    );
    assert_eq!(group["children"][2]["rule"]["machine"], "pro");
    let slot = r
        .app
        .dispatch
        .step(&id, group["children"][0]["step"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        (
            &slot["status"],
            &slot["rule"]["folder"],
            &slot["result"]["ok"]
        ),
        (&json!("auto"), &json!("slot*"), &json!(true))
    );
    assert_eq!(
        slot["input"]["prompt"], "fix the inbox in slot2",
        "the card shows the task as given"
    );
    let app_step = group["children"][1]["step"].as_str().unwrap().to_string();
    assert_eq!(r.app.dispatch.pending(&id), std::slice::from_ref(&app_step));

    let url = |step: &str| format!("/dispatch/conversations/{id}/actions/{step}");
    let (status, body) = step_post(
        &r,
        &c,
        &url(&app_step),
        json!({ "decision": "approve", "input": { "machine": "hp", "folder": "slot2", "prompt": "fix the inbox in app" } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"],
        "another child of this group already works in /r/slots/slot2 on hp on its current branch, give this one its own branch"
    );
    let group_id = group["id"].as_str().unwrap();
    let (status, decided) = step_post(
        &r,
        &c,
        &format!("/dispatch/conversations/{id}/groups/{group_id}"),
        json!({ "decision": "approve" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{decided}");
    assert_eq!(decided.as_array().unwrap().len(), 1);
    assert_eq!(decided[0]["id"], json!(app_step));
    assert!(ran(&r, "fix the inbox in app"));
    let (status, _) = step_post(
        &r,
        &c,
        &format!("/dispatch/conversations/{id}/groups/zzzzzzzz"),
        json!({ "decision": "approve" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let cfg = r.app.config().unwrap();
    let view = r.app.state.view(&cfg, r.app.ports.as_ref(), "localhost");
    let late = chrono::Local::now() + chrono::Duration::minutes(61);
    assert!(r
        .app
        .dispatch
        .due_at(&view, chrono::Local::now())
        .is_empty());
    let due = r.app.dispatch.due_at(&view, late);
    assert_eq!(due.len(), 1);
    assert!(!r.app.dispatch.gathered(&due[0], &[None, None]));
    let results = last_event(&r, &id);
    assert_eq!(results["role"], "results");
    let card = event_count(&r, &id) - 1;
    let (status, review) = step_post(
        &r,
        &c,
        &format!("/dispatch/conversations/{id}/reviews"),
        json!({ "card": card, "child": 0 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{review}");
    assert_eq!(review["review"]["name"], "hp-eng-1301");
    assert_eq!(review["status"], "pending");
    let (status, _) = step_post(
        &r,
        &c,
        &format!("/dispatch/conversations/{id}/reviews"),
        json!({ "card": card, "child": 2 }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a child that did not start has nothing to review"
    );
}

#[tokio::test]
async fn a_group_is_checked_before_anything_starts() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let before = event_count(&r, &id);
    let error = |result: serde_json::Value| {
        assert_eq!(result["isError"], true, "{result}");
        result["content"][0]["text"].as_str().unwrap().to_string()
    };
    let same = group_args(json!([
        { "label": "One", "machine": "hp", "folder": "slot2", "prompt": "a" },
        { "label": "Two", "machine": "hp", "path": "/r/slots/slot2/", "prompt": "b" },
    ]));
    assert_eq!(
        error(dispatch_tool(&r, Some(&id), "start_group", same).await),
        "children 1 and 2 would both work in /r/slots/slot2 on hp on its current branch, give each its own branch"
    );
    let nope = group_args(json!([
        { "label": "One", "machine": "hp", "folder": "slot2", "prompt": "a" },
        { "label": "Two", "machine": "hp", "folder": "nope", "prompt": "b" },
    ]));
    assert_eq!(
        error(dispatch_tool(&r, Some(&id), "start_group", nope).await),
        "child 2 (Two): hp has no folder nope"
    );
    let one = group_args(json!([{ "machine": "hp", "folder": "slot2" }]));
    assert!(
        error(dispatch_tool(&r, Some(&id), "start_group", one).await)
            .starts_with("a group has 2 to 6 children")
    );
    let fine = group_args(json!([
        { "label": "One", "machine": "hp", "folder": "slot2", "prompt": "a" },
        { "label": "Two", "machine": "hp", "path": "/r/app", "prompt": "b" },
    ]));
    assert!(
        error(dispatch_tool(&r, None, "start_group", fine.clone()).await)
            .starts_with("Yardbell cannot tell which Dispatch conversation")
    );
    set_rules(&r, "deny", json!([]));
    let refused = error(dispatch_tool(&r, Some(&id), "start_group", fine).await);
    assert!(
        refused.starts_with("Refused, not run: the user's rules refuse every child of this group. 1) One: the user's Dispatch settings refuse steps"),
        "{refused}"
    );
    assert_eq!(event_count(&r, &id), before, "nothing became a card");
    mcp_on(&r);
    let other = tool_call(&r, "start_group", group_args(json!([]))).await;
    assert!(error(other).starts_with("only Dispatch can start a group"));
    assert!(!ran(&r, "tmux new"));
}

#[tokio::test]
async fn a_review_is_requested_approved_and_its_findings_sent_back() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    let finished = |name: &str, review: Option<crate::dispatch::ReviewOf>, screen: &str| {
        r.app.dispatch.report(
            &crate::dispatch::Change {
                conversation: id.clone(),
                machine: "hp".into(),
                name: name.into(),
                path: "/r/slots/slot2".into(),
                state: "idle",
                review,
            },
            screen,
        );
        r.app.dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .len()
            - 1
    };
    let card = finished("hp-eng-1301", None, "Done.");
    let (status, step) = step_post(
        &r,
        &c,
        &format!("/dispatch/conversations/{id}/reviews"),
        json!({ "card": card }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{step}");
    assert_eq!(
        (&step["by"], &step["status"]),
        (&json!("you"), &json!("pending"))
    );
    let folder = step["review"]["evidence"].as_str().unwrap().to_string();
    assert_eq!(
        folder.len(),
        12,
        "slot2 has a running app, so screenshots are offered"
    );
    assert_eq!(
        step["review"],
        json!({ "machine": "hp", "name": "hp-eng-1301", "path": "/r/slots/slot2", "branch": "eng-1301-inbox", "evidence": folder })
    );
    assert_eq!(step["input"]["path"], "/r/slots/slot2");
    let prompt = step["input"]["prompt"].as_str().unwrap();
    assert!(prompt.starts_with("Review the work on branch eng-1301-inbox in this folder"));
    assert!(prompt.contains("The app is running at http://localhost:3020 (rails)."));
    assert!(prompt.contains(&format!("yardbell-review/{folder}")));
    let (status, _) = step_post(
        &r,
        &c,
        &format!("/dispatch/conversations/{id}/reviews"),
        json!({ "card": 0 }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the first event is a message"
    );

    r.fake.stub("tmux new", Output::ok_with("hp-eng-1301-2\n"));
    let (status, started) = step_post(
        &r,
        &c,
        &format!(
            "/dispatch/conversations/{id}/actions/{}",
            step["id"].as_str().unwrap()
        ),
        json!({ "decision": "approve" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let tracked = r.app.dispatch.get(&id).unwrap()["sessions"].clone();
    assert_eq!(tracked[0]["name"], "hp-eng-1301-2");
    assert_eq!(tracked[0]["review"]["name"], "hp-eng-1301");

    let of: crate::dispatch::ReviewOf = serde_json::from_value(step["review"].clone()).unwrap();
    let screen = "⏺ YARDBELL REVIEW\n  verdict: changes needed\n  summary: Two problems.\n  - high: src/inbox.rs:40: The unread count can go negative.\n  - low: README.md: Mention the new flag.\n  END REVIEW";
    let review = finished("hp-eng-1301-2", Some(of), screen);
    let url = format!("/dispatch/conversations/{id}/reviews/{review}");
    let (status, _) = step_post(&r, &c, &url, json!({ "decision": "send", "findings": [] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = step_post(&r, &c, &url, json!({ "decision": "send", "findings": [7] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    r.fake.stub("load-buffer", Output::ok_with(""));
    let (status, sent) =
        step_post(&r, &c, &url, json!({ "decision": "send", "findings": [0] })).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["outcome"]["decision"], "sent",);
    assert_eq!(sent["outcome"]["to"], "hp-eng-1301");
    let calls = r.fake.calls();
    let at = calls
        .iter()
        .position(|c| c.join(" ").contains("load-buffer"))
        .unwrap();
    let command = calls[at].join(" ");
    assert!(command.contains("'=hp-eng-1301:'"), "{command}");
    assert!(!command.contains("unread count"), "{command}");
    let typed = r.fake.inputs()[at].clone().unwrap();
    assert!(typed.contains("found this problem. Fix it,"), "{typed}");
    assert!(
        typed.contains("The unread count can go negative."),
        "{typed}"
    );
    assert!(!typed.contains("Mention the new flag"), "{typed}");
    let (status, _) = step_post(&r, &c, &url, json!({ "decision": "dismiss" })).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_review_card_shows_its_diff_and_screenshots() {
    const MB: &str = "1111111111111111111111111111111111111111";
    const HEAD: &str = "2222222222222222222222222222222222222222";
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    let mut image = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    image.extend(320u32.to_be_bytes());
    image.extend(200u32.to_be_bytes());
    image.extend([0u8; 32]);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&image);
    r.fake.stub(
        "yardbell-review/abcdef123456",
        Output::ok_with(&format!(
            "HEAD\t{HEAD}\nBASE\tmain\nMB\t{MB}\nDIR\t/r/.git/yardbell-review/abcdef123456\nFILE\tlogin.png\n{encoded}\nEND\n"
        )),
    );
    let of = crate::dispatch::ReviewOf {
        machine: "hp".into(),
        name: "hp-eng-1301".into(),
        path: "/r/slots/slot2".into(),
        branch: "eng-1301-inbox".into(),
        evidence: "abcdef123456".into(),
        scan: String::new(),
    };
    let screen = "⏺ YARDBELL REVIEW\n  verdict: changes needed\n  base: main\n  summary: One.\n  - high: src/inbox.rs:2: The count is wrong. [screenshot: login.png]\n  END REVIEW";
    let cfg = r.app.config().unwrap();
    let m = cfg.machine("hp").unwrap().clone();
    let change = crate::dispatch::Change {
        conversation: id.clone(),
        machine: "hp".into(),
        name: "hp-eng-1301-2".into(),
        path: "/r/slots/slot2".into(),
        state: "idle",
        review: Some(of),
    };
    r.app
        .dispatch
        .report_from(&change, screen, &r.app.folders, &m)
        .await;
    let review = last_event(&r, &id);
    let card = r.app.dispatch.get(&id).unwrap()["events"]
        .as_array()
        .unwrap()
        .len()
        - 1;
    assert_eq!(
        review["diff"],
        json!({ "base": "main", "merge_base": MB, "head": HEAD })
    );
    let file = review["evidence"][0]["file"].as_str().unwrap().to_string();
    assert_eq!(review["evidence"][0]["width"], 320);

    let get = |url: String, cookie: Option<&str>| {
        let mut req = Request::get(url).header(header::ACCEPT, "application/json");
        if let Some(cookie) = cookie {
            req = req.header(header::COOKIE, cookie);
        }
        send(&r.app, req.body(Body::empty()).unwrap())
    };
    let base = format!("/dispatch/conversations/{id}/reviews/{card}");
    let (status, headers, body) = get(format!("{base}/evidence/{file}"), Some(&c)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(body.len(), String::from_utf8_lossy(&image).len());
    let (status, _, _) = get(format!("{base}/evidence/{file}"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "behind the login");
    for other in ["aaaaaaaaaaaaaaaa.png", "..%2F..%2Fconversations", "x"] {
        let (status, _, _) = get(format!("{base}/evidence/{other}"), Some(&c)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{other}");
    }

    let listing = format!(
        "HEAD\t{HEAD}\nBASE\tmain\nMB\t{MB}\n@@YB-TRACKED@@\n:100644 100644 a b M\0src/inbox.rs\x003\t1\tsrc/inbox.rs\0\n@@YB-UNTRACKED@@\nU\t1\t0\tnotes.md\n"
    );
    r.fake.stub("@@YB-TRACKED@@", Output::ok_with(&listing));
    r.fake.stub(
        "--no-textconv -M",
        Output::ok_with("@@ -1,2 +1,2 @@\n a\n-b\n+c\n"),
    );
    let (status, _, body) = get(format!("{base}/diff"), Some(&c)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let list: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(list["files"][0]["path"], "src/inbox.rs");
    assert_eq!(list["files"][0]["added"], 3);
    assert_eq!(list["files"][1]["untracked"], true);
    assert_eq!(
        (&list["moved"], &list["merge_base"]),
        (&json!(false), &json!(MB))
    );
    assert!(
        ran(&r, &format!("mb='{MB}'")),
        "the diff starts where the review did"
    );

    let calls = r.fake.calls().len();
    for bad in ["..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "a%0Ab"] {
        let (status, _, _) = get(format!("{base}/diff?file={bad}"), Some(&c)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
    }
    assert_eq!(r.fake.calls().len(), calls, "nothing ran for a bad path");
    let (status, _, body) = get(format!("{base}/diff?file=src%2Fother.rs"), Some(&c)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body.contains("src/other.rs is not in this review's changes"),
        "{body}"
    );
    let (status, _, body) = get(format!("{base}/diff?file=src%2Finbox.rs&line=2"), Some(&c)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let page: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        page["lines"][3],
        json!({ "k": "add", "o": null, "n": 2, "t": "c" })
    );
    assert!(ran(&r, &format!("-M {MB} -- 'src/inbox.rs'")));
    let (status, _, _) = get(
        format!("/dispatch/conversations/{id}/reviews/0/diff"),
        Some(&c),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "event 0 is not a review");

    r.fake.stub("load-buffer", Output::ok_with(""));
    let (status, sent) = step_post(
        &r,
        &c,
        &base,
        json!({ "decision": "send", "findings": [0] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    let at = r
        .fake
        .calls()
        .iter()
        .position(|c| c.join(" ").contains("load-buffer"))
        .unwrap();
    let typed = r.fake.inputs()[at].clone().unwrap();
    assert!(
        typed.contains("(screenshot: /r/.git/yardbell-review/abcdef123456/login.png)"),
        "{typed}"
    );

    r.app.dispatch.delete(&id).unwrap();
    assert!(!r._dir.path().join("dispatch/evidence").join(&id).exists());
}

#[tokio::test]
async fn dispatch_can_ask_for_a_review_of_a_running_session() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let result = dispatch_tool(
        &r,
        Some(&id),
        "review_session",
        json!({ "machine": "hp", "name": "hp-eng-1301", "focus": "the unread count" }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    let step = last_event(&r, &id);
    assert_eq!(step["tool"], "start_session");
    assert_eq!(step["review"]["branch"], "eng-1301-inbox");
    assert!(step["input"]["prompt"]
        .as_str()
        .unwrap()
        .contains("Pay special attention to this: the unread count"));
    let missing = dispatch_tool(
        &r,
        Some(&id),
        "review_session",
        json!({ "machine": "hp", "name": "hp-nope" }),
    )
    .await;
    assert_eq!(
        missing["content"][0]["text"],
        "no session named hp-nope on hp"
    );
}

#[tokio::test]
async fn an_answer_to_a_waiting_session_is_kept_in_the_conversation() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    r.app.dispatch.report(
        &crate::dispatch::Change {
            conversation: id.clone(),
            machine: "hp".into(),
            name: "hp-eng-1301".into(),
            path: "/r/slots/slot2".into(),
            state: "blocked",
            review: None,
        },
        "Run the migration?\n ❯ 1. Yes\n   2. No",
    );
    let card = r.app.dispatch.get(&id).unwrap()["events"]
        .as_array()
        .unwrap()
        .len()
        - 1;
    let url = format!("/dispatch/conversations/{id}/answers");
    let (status, _) = step_post(&r, &c, &url, json!({ "card": card, "key": "7" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    r.fake.stub("send-keys", Output::ok_with(""));
    let (status, answered) = step_post(&r, &c, &url, json!({ "card": card, "key": "2" })).await;
    assert_eq!(status, StatusCode::OK, "{answered}");
    assert_eq!(answered["answer"]["label"], "No");
    assert!(ran(&r, "send-keys -t '=hp-eng-1301:' -l '2'"));
    let (status, again) = step_post(&r, &c, &url, json!({ "card": card, "key": "1" })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(again["error"], "it was already answered with No");
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
        save(r#"{"servers":[{"name":"gh","command":"npx gh-mcp","env":{"GITHUB_TOKEN":"ghp_secret"}}]}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(r.app.settings.can_undo());

    r.fake.stub("tmux new", Output::ok_with(""));
    r.fake.stub(
        "yardbell/mcp",
        Output::ok_with("/home/u/.cache/yardbell/mcp/mcp-1.json\n"),
    );
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
    let start = call.last().unwrap();
    assert!(start.contains("--mcp-config"), "{start}");
    assert!(
        start.contains("/home/u/.cache/yardbell/mcp/mcp-1.json"),
        "{start}"
    );
    for call in r.fake.calls() {
        assert!(!call.join(" ").contains("ghp_secret"), "{call:?}");
    }
    assert!(r
        .fake
        .inputs()
        .iter()
        .flatten()
        .any(|input| input.contains("gh-mcp") && input.contains("ghp_secret")));
}

#[tokio::test]
async fn dispatch_settings_are_saved_and_checked() {
    let r = rig();
    let c = cookie(&r.app).await;
    let save = |body: &'static str| {
        Request::post("/api/settings/dispatch")
            .header(header::COOKIE, &c)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    };
    let (status, _, body) = send(&r.app, save(r#"{"agent":"nope"}"#)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("dispatch.agent"), "{body}");
    let (status, _, body) = send(
        &r.app,
        save(r#"{"instructions":"  devbox gets acme/web \n","agent":"codex","model":"haiku"}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let saved = r.app.config().unwrap().dispatch;
    assert_eq!(saved.instructions, "devbox gets acme/web");
    assert_eq!(
        (saved.agent.as_str(), saved.model.as_str()),
        ("codex", "haiku")
    );
    let (_, _, body) = send(
        &r.app,
        Request::get("/api/settings")
            .header(header::COOKIE, &c)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    let shown: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(shown["dispatch"]["agent"], "codex");
    assert!(shown["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["name"] == "codex"));
    assert_eq!(shown["dispatch_runs_on"], json!(["claude", "codex"]));
}

#[tokio::test]
async fn dispatch_says_which_agent_and_model_it_runs_on() {
    let r = rig();
    let c = cookie(&r.app).await;
    let runs_on = || async {
        let (status, _, body) = send(
            &r.app,
            Request::get("/dispatch/runs-on")
                .header(header::COOKIE, &c)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        serde_json::from_str::<serde_json::Value>(&body).unwrap()
    };
    assert_eq!(
        runs_on().await,
        json!({
            "runs_on": "claude",
            "label": "Claude Code",
            "model": "",
            "agents": {
                "claude": { "label": "Claude Code", "model": "" },
                "codex": { "label": "Codex", "model": "" },
            },
        }),
        "nothing set keeps Claude Code on its own default model"
    );

    let mut cfg = Config::load(&r.app.cfg_path).unwrap();
    cfg.dispatch.runs_on = crate::config::RunsOn::Codex;
    cfg.dispatch.model = "haiku".into();
    cfg.dispatch.codex_model = "gpt-6.1-sol".into();
    cfg.agents.push(crate::agents::Agent {
        name: "codex".into(),
        label: Some("Codex CLI".into()),
        command: "codex".into(),
        resume: "codex resume --last".into(),
        process: None,
        prompt_arg: None,
    });
    cfg.save(&r.app.cfg_path).unwrap();
    assert_eq!(
        runs_on().await,
        json!({
            "runs_on": "codex",
            "label": "Codex CLI",
            "model": "gpt-6.1-sol",
            "agents": {
                "claude": { "label": "Claude Code", "model": "haiku" },
                "codex": { "label": "Codex CLI", "model": "gpt-6.1-sol" },
            },
        }),
        "the label is the one sessions show for the agent"
    );
}

#[tokio::test]
async fn a_pairing_code_logs_a_phone_in_once_within_five_minutes() {
    let r = rig();
    let c = cookie(&r.app).await;
    let new_code = || {
        Request::post("/api/settings/pair")
            .header(header::COOKIE, &c)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap()
    };
    let (status, _, body) = send(&r.app, new_code()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let pair: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(pair["server"], "http://100.64.0.10:4000");
    assert_eq!(pair["expires_in"], 300);
    assert!(pair["qr_svg"].as_str().unwrap().starts_with("<?xml"));
    let link = pair["link"].as_str().unwrap();
    let prefix = "yardbell://pair?server=http%3A%2F%2F100.64.0.10%3A4000&code=";
    assert!(link.starts_with(prefix), "{link}");
    let code = &link[prefix.len()..];
    assert_eq!(code.len(), 32);

    let redeem = |code: &str| {
        Request::post(format!("/app/pair/{code}"))
            .body(Body::empty())
            .unwrap()
    };
    let (status, headers, _) = send(&r.app, redeem(code)).await;
    assert_eq!(status, StatusCode::OK);
    let phone = headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let (status, _, _) = send(
        &r.app,
        Request::get("/state")
            .header(header::COOKIE, &phone)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the phone is logged in");

    let (status, _, body) = send(&r.app, redeem(code)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a code works once");
    assert!(body.contains("used or expired"), "{body}");
    let (status, _, _) = send(&r.app, redeem("not-a-real-code")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (_, _, body) = send(&r.app, new_code()).await;
    let pair: serde_json::Value = serde_json::from_str(&body).unwrap();
    let late = pair["link"].as_str().unwrap()[prefix.len()..].to_string();
    r.advance(301);
    let (status, _, _) = send(&r.app, redeem(&late)).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "codes expire after five minutes"
    );
}

#[tokio::test]
async fn stop_process_ends_only_agents_outside_tmux() {
    let r = rig();
    r.fake.stub("kill ", Output::ok_with(""));
    let c = cookie(&r.app).await;
    let stop = |pid: u32| {
        Request::post(format!("/sessions/hp/{pid}/stop-process"))
            .header(header::COOKIE, &c)
            .body(Body::empty())
            .unwrap()
    };
    let (status, _, body) = send(&r.app, stop(77)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let call = r.fake.calls().pop().unwrap().join(" ");
    assert!(
        call.contains("kill 77") && call.contains("kill -CONT 77"),
        "{call}"
    );
    let (status, _, body) = send(&r.app, stop(9)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "pid 9 runs in tmux");
    assert!(body.contains("already runs in tmux"), "{body}");
    let (status, _, _) = send(&r.app, stop(4242)).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "an unknown pid is never killed"
    );
    assert_eq!(
        r.fake
            .calls()
            .iter()
            .filter(|c| c.join(" ").contains("kill "))
            .count(),
        1
    );
}

#[tokio::test]
async fn actions_check_their_machine_again_without_waiting_for_it() {
    let r = rig();
    r.fake.stub("kill-session", Output::ok_with(""));
    let c = cookie(&r.app).await;
    let stop = Request::post("/sessions/hp/hp-eng-1301/stop")
        .header(header::COOKIE, &c)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&r.app, stop).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(r.rechecked().await, [Some("hp".to_string())]);

    let r = rig();
    r.fake.stub("send-keys", Output::ok_with(""));
    let c = cookie(&r.app).await;
    let keys = Request::post("/sessions/hp/hp-eng-1301/keys")
        .header(header::COOKIE, &c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"keys":"1"}"#))
        .unwrap();
    let (status, _, body) = send(&r.app, keys).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(r.rechecked().await, [Some("hp".to_string())]);
}

#[tokio::test]
async fn a_failed_stop_checks_nothing() {
    let r = rig();
    r.fake
        .stub("kill-session", Output::failed(1, "can't find session"));
    let c = cookie(&r.app).await;
    let req = Request::post("/sessions/hp/hp-x/stop")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(r.rechecked().await.is_empty());
}

#[tokio::test]
async fn a_new_session_can_wait_until_its_machine_was_checked() {
    let r = rig();
    r.fake.stub("tmux new", Output::ok_with(""));
    let (status, body) = post_session(&r, r#"{"machine":"hp","folder":"slot2","wait":true}"#).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(r.refreshed(), [Some("hp".to_string())], "answered first");

    let r = rig();
    r.fake.stub("tmux new", Output::ok_with(""));
    let (status, body) = post_session(&r, r#"{"machine":"hp","folder":"slot2"}"#).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(r.rechecked().await, [Some("hp".to_string())]);
}

#[tokio::test]
async fn forgetting_an_ended_session_tells_open_pages() {
    let r = rig();
    let changes = r.app.state.changes();
    let c = cookie(&r.app).await;
    let req = Request::post("/ended/hp:hp-x/forget")
        .header(header::COOKIE, c)
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(&r.app, req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(changes.has_changed().unwrap());
}

async fn serve(r: &Rig) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let svc = router(r.app.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, svc).await });
    addr
}

async fn open_live(
    addr: SocketAddr,
    cookie: &str,
    origin: &str,
) -> (String, tokio::net::TcpStream) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET /state/live HTTP/1.1\r\nHost: {addr}\r\nOrigin: {origin}\r\nCookie: {cookie}\r\n\
         Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    socket.write_all(req.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        socket.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    (String::from_utf8_lossy(&head).into_owned(), socket)
}

async fn next_text(socket: &mut tokio::net::TcpStream) -> String {
    use tokio::io::AsyncReadExt;
    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await.unwrap();
    assert_eq!(head[0], 0x81, "a whole text frame");
    let mut body = vec![0u8; (head[1] & 0x7f) as usize];
    socket.read_exact(&mut body).await.unwrap();
    String::from_utf8(body).unwrap()
}

#[tokio::test]
async fn open_pages_hear_about_changes_on_a_socket() {
    let r = rig();
    let c = cookie(&r.app).await;
    let addr = serve(&r).await;
    let page = format!("http://{addr}");
    let (head, _) = open_live(addr, "", &page).await;
    assert!(!head.starts_with("HTTP/1.1 101"), "{head}");
    let (head, _) = open_live(addr, &c, "http://elsewhere.example").await;
    assert!(head.starts_with("HTTP/1.1 403"), "{head}");
    let (head, mut socket) = open_live(addr, &c, &page).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    r.app.state.forget("hp:hp-x");
    let text = tokio::time::timeout(Duration::from_secs(2), next_text(&mut socket))
        .await
        .expect("no message after the state changed");
    assert!(text.parse::<u64>().is_ok(), "{text}");
}

async fn settings_post(
    r: &Rig,
    c: &str,
    url: &str,
    body: serde_json::Value,
) -> (StatusCode, String) {
    let req = Request::post(url)
        .header(header::COOKIE, c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, _, text) = send(&r.app, req).await;
    (status, text)
}

async fn settings_shown(r: &Rig, c: &str) -> String {
    let (status, _, body) = send(
        &r.app,
        Request::get("/api/settings")
            .header(header::COOKIE, c)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[tokio::test]
async fn secrets_are_set_listed_by_name_only_and_reach_new_sessions() {
    let r = rig();
    let c = cookie(&r.app).await;
    let linear = json!([{ "name": "linear", "url": "https://mcp.linear.app/mcp",
        "headers": { "Authorization": "Bearer ${secret:linear}" } }]);
    let (status, body) = settings_post(
        &r,
        &c,
        "/api/settings/mcp/servers",
        json!({ "servers": linear }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let shown: serde_json::Value = serde_json::from_str(&settings_shown(&r, &c).await).unwrap();
    assert_eq!(
        shown["secrets"]["missing"],
        json!([{ "server": "linear", "name": "linear" }])
    );
    r.fake.stub("tmux new", Output::ok_with(""));
    r.fake.stub(
        "yardbell/mcp",
        Output::ok_with("/home/u/.cache/yardbell/mcp/mcp-1.json\n"),
    );
    let start = || {
        Request::post("/sessions")
            .header(header::COOKIE, &c)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"machine":"hp","folder":"slot2"}"#))
            .unwrap()
    };
    let (status, _, body) = send(&r.app, start()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.contains("needs the secret linear, which is not set"),
        "{body}"
    );
    assert!(
        r.fake.calls().is_empty(),
        "nothing started without the secret"
    );

    let (status, body) = settings_post(
        &r,
        &c,
        "/api/settings/secrets",
        json!({ "name": "linear", "value": "lin_api_TOPSECRET" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = settings_post(
        &r,
        &c,
        "/api/settings/secrets",
        json!({ "name": "yardbell-mcp-token", "value": "x" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let text = settings_shown(&r, &c).await;
    assert!(!text.contains("lin_api_TOPSECRET"), "{text}");
    let shown: serde_json::Value = serde_json::from_str(&text).unwrap();
    let listed = &shown["secrets"]["list"][0];
    assert_eq!(listed["name"], "linear");
    assert_eq!(listed["used_by"], json!(["linear"]));
    assert!(
        listed["updated"].as_str().unwrap().ends_with('Z'),
        "{listed}"
    );
    assert_eq!(shown["secrets"]["missing"], json!([]));

    let (status, _, body) = send(&r.app, start()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for call in r.fake.calls() {
        assert!(!call.join(" ").contains("TOPSECRET"), "{call:?}");
    }
    assert!(r
        .fake
        .inputs()
        .iter()
        .flatten()
        .any(|input| input.contains("Bearer lin_api_TOPSECRET")));
    let saved = std::fs::read_to_string(&r.app.cfg_path).unwrap();
    assert!(!saved.contains("TOPSECRET"), "{saved}");
    let mode = std::os::unix::fs::PermissionsExt::mode(
        &std::fs::metadata(r.app.settings.secrets_path())
            .unwrap()
            .permissions(),
    );
    assert_eq!(mode & 0o777, 0o600);

    let (status, _) = settings_post(
        &r,
        &c,
        "/api/settings/secrets/delete",
        json!({ "name": "linear" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = settings_post(
        &r,
        &c,
        "/api/settings/secrets/delete",
        json!({ "name": "linear" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("there is no secret called linear"), "{body}");
}

#[tokio::test]
async fn inline_values_move_into_secrets_without_losing_any() {
    let r = rig();
    let c = cookie(&r.app).await;
    mcp_on(&r);
    let mut cfg = r.app.config().unwrap();
    cfg.mcp_token = Some("yb_secret".into());
    cfg.cookie_key = Some("a2V5".into());
    cfg.mcp_servers = serde_json::from_value(json!([
        { "name": "linear", "url": "https://mcp.linear.app/mcp",
          "headers": { "Authorization": "Bearer lin_api_ONE" } },
        { "name": "github", "command": "npx gh-mcp",
          "env": { "GITHUB_TOKEN": "ghp_TWO", "GITHUB_HOST": "github.com" } },
    ]))
    .unwrap();
    cfg.save(&r.app.cfg_path).unwrap();
    r.app
        .settings
        .set_secret("linear", "something else")
        .unwrap();

    let shown: serde_json::Value = serde_json::from_str(&settings_shown(&r, &c).await).unwrap();
    let inline = shown["secrets"]["inline"].as_array().unwrap();
    assert_eq!(inline.len(), 5, "{inline:?}");
    let ticked: Vec<_> = inline
        .iter()
        .filter(|i| i["secret"] == true)
        .map(|i| i["label"].as_str().unwrap())
        .collect();
    assert_eq!(
        ticked,
        [
            "linear: header Authorization",
            "github: GITHUB_TOKEN",
            "Yardbell's MCP token",
            "Yardbell's login cookie key"
        ]
    );
    let picked: Vec<_> = inline
        .iter()
        .filter(|i| i["key"] != "GITHUB_HOST")
        .cloned()
        .collect();
    let (status, body) = settings_post(
        &r,
        &c,
        "/api/settings/secrets/move",
        json!({ "items": picked }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let saved = std::fs::read_to_string(&r.app.cfg_path).unwrap();
    for value in ["lin_api_ONE", "ghp_TWO", "yb_secret", "a2V5"] {
        assert!(!saved.contains(value), "{value} left in {saved}");
    }
    let cfg = r.app.config().unwrap();
    assert_eq!(
        cfg.mcp_servers[0].headers["Authorization"],
        "Bearer ${secret:linear-2}"
    );
    assert_eq!(cfg.mcp_servers[1].env["GITHUB_TOKEN"], "${secret:github}");
    assert_eq!(cfg.mcp_servers[1].env["GITHUB_HOST"], "github.com");
    let store = r.app.secrets().unwrap();
    assert_eq!(store.get("linear"), Some("something else"));
    assert_eq!(store.get("linear-2"), Some("lin_api_ONE"));
    assert_eq!(store.get("github"), Some("ghp_TWO"));
    assert_eq!(cfg.mcp_token(&store).unwrap().as_deref(), Some("yb_secret"));
    assert_eq!(cfg.cookie_key(&store).unwrap().as_deref(), Some("a2V5"));
    let (status, body) = mcp(&r.app, Some("yb_secret"), None, rpc("ping", json!({}))).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the moved MCP token still works: {body}"
    );

    let (status, body) = settings_post(
        &r,
        &c,
        "/api/settings/secrets/move",
        json!({ "items": picked }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("already secrets"), "{body}");
}

#[tokio::test]
async fn a_move_that_cannot_write_the_secrets_leaves_yardbell_yml_alone() {
    let r = rig();
    let c = cookie(&r.app).await;
    let mut cfg = r.app.config().unwrap();
    cfg.mcp_servers = serde_json::from_value(json!([
        { "name": "linear", "url": "https://mcp.linear.app/mcp",
          "headers": { "Authorization": "Bearer lin_api_ONE" } },
    ]))
    .unwrap();
    cfg.save(&r.app.cfg_path).unwrap();
    std::fs::create_dir(r.app.settings.secrets_path().with_extension("yml.tmp")).unwrap();
    let item = json!([{ "kind": "header", "server": "linear", "key": "Authorization" }]);
    let (status, body) = settings_post(
        &r,
        &c,
        "/api/settings/secrets/move",
        json!({ "items": item }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!body.contains("lin_api_ONE"), "{body}");
    let saved = r.app.config().unwrap();
    assert_eq!(
        saved.mcp_servers[0].headers["Authorization"],
        "Bearer lin_api_ONE"
    );
}

#[tokio::test]
async fn mcp_send_to_session_types_through_stdin() {
    let r = rig();
    mcp_on(&r);
    r.fake.stub("load-buffer", Output::ok_with(""));
    let result = tool_call(
        &r,
        "send_to_session",
        json!({ "machine": "hp", "name": "hp-eng-1301", "text": "the password is hunter2" }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    let calls = r.fake.calls();
    let at = calls
        .iter()
        .position(|c| c.join(" ").contains("load-buffer"))
        .unwrap();
    assert_eq!(calls[at][0], "ssh");
    for call in &calls {
        assert!(!call.join(" ").contains("hunter2"), "{call:?}");
    }
    assert_eq!(
        r.fake.inputs()[at].as_deref(),
        Some("the password is hunter2")
    );
}

#[tokio::test]
async fn send_to_session_on_a_pull_request_card_follows_the_dispatch_rules() {
    let r = rig();
    let c = cookie(&r.app).await;
    let instruction = "CI failed on test for pull request #12: boom. Fix it and push.";
    let card = json!({
        "role": "pull", "kind": "ci", "key": "ci:u:a",
        "machine": "hp", "name": "hp-eng-1301", "path": "/r/slots/slot2", "branch": "eng-1301-inbox",
        "pull": { "number": 12, "url": "u", "title": "Inbox" },
        "checks": [{ "name": "test", "url": "u" }], "notes": [],
        "instruction": instruction,
    });
    let id = r
        .app
        .dispatch
        .post_pull(
            "hp",
            "hp-eng-1301",
            "/r/slots/slot2",
            "Pull request #12: Inbox",
            card,
        )
        .unwrap();
    let url = format!("/dispatch/conversations/{id}/pulls");
    r.fake.stub("load-buffer", Output::ok_with(""));

    set_rules(
        &r,
        "ask",
        json!([{ "action": "send_to_session", "folder": "slot2", "approval": "deny" }]),
    );
    let (status, body) = step_post(&r, &c, &url, json!({ "card": 0 })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body["error"].as_str().unwrap().starts_with(
        "Not sent: your Dispatch rule \"deny send_to_session on any machine in slot2\""
    ));
    assert!(!ran(&r, "load-buffer"));

    set_rules(&r, "ask", json!([]));
    let (status, body) = step_post(&r, &c, &url, json!({ "card": 0 })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let step = body["step"].clone();
    assert_eq!(
        (&step["status"], &step["by"]),
        (&json!("pending"), &json!("you"))
    );
    assert_eq!(step["input"]["text"], instruction);
    assert_eq!(body["card"]["sent"]["step"], step["id"]);
    assert!(!ran(&r, "load-buffer"), "waits for approval");
    let (status, _) = step_post(&r, &c, &url, json!({ "card": 0 })).await;
    assert_eq!(status, StatusCode::CONFLICT, "sent once");

    let step_url = format!(
        "/dispatch/conversations/{id}/actions/{}",
        step["id"].as_str().unwrap()
    );
    step_post(&r, &c, &step_url, json!({ "decision": "reject" })).await;
    set_rules(
        &r,
        "ask",
        json!([{ "action": "send_to_session", "machine": "hp", "approval": "allow" }]),
    );
    let (status, body) =
        step_post(&r, &c, &url, json!({ "card": 0, "text": "Fix the test." })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["step"]["status"], "approved");
    assert_eq!(body["step"]["result"]["ok"], true);
    let at = r
        .fake
        .calls()
        .iter()
        .position(|c| c.join(" ").contains("load-buffer"))
        .unwrap();
    assert_eq!(r.fake.inputs()[at].as_deref(), Some("Fix the test."));

    let (status, _) = step_post(
        &r,
        &c,
        &format!("/dispatch/conversations/{id}/pulls"),
        json!({ "card": 5 }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn triggers_are_saved_checked_and_turned_off_from_settings() {
    let r = rig();
    let c = cookie(&r.app).await;
    let get = || {
        Request::get("/api/triggers")
            .header(header::COOKIE, &c)
            .body(Body::empty())
            .unwrap()
    };
    let (status, _, body) = send(&r.app, get()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(v["zone"].as_str().unwrap().contains("UTC"), "{body}");
    assert!(v["tasks"]
        .as_array()
        .unwrap()
        .contains(&json!("What's going on?")));
    assert_eq!(v["triggers"], json!([]));

    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/api/triggers",
        r#"{"triggers":[{"name":"Morning","task":"No such task","schedule":"daily 09:00"}]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("which is not one of your tasks"), "{body}");
    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/api/triggers",
        r#"{"triggers":[{"name":"Morning","task":"What's going on?","schedule":"daily 9am"}]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body.contains(r#"invalid config: trigger \"Morning\": schedule \"daily 9am\""#),
        "{body}"
    );
    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/api/triggers",
        r#"{"triggers":[{"name":" Morning ","task":"What's going on?","schedule":"daily  09:00"},
            {"name":"Tickets","task":"Plan my Linear tickets","linear":{"assigned":false,"states":[" Todo ",""]}}]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["triggers"][0]["trigger"]["name"], "Morning");
    assert_eq!(v["triggers"][0]["describe"], "Daily at 09:00");
    assert!(v["triggers"][0]["next"].is_string());
    assert_eq!(
        v["triggers"][1]["trigger"]["linear"]["states"],
        json!(["Todo"])
    );
    assert!(
        v["triggers"][1]["problem"]
            .as_str()
            .unwrap()
            .contains("the secret linear is not set"),
        "{body}"
    );
    assert!(r.app.settings.can_undo());

    let (status, _, body) = post_json(
        &r.app,
        &c,
        "/api/triggers/enable",
        r#"{"name":"Morning","enabled":false}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let cfg = r.app.config().unwrap();
    assert!(!cfg.triggers[0].enabled);
    assert!(cfg.triggers[1].enabled);
    let (status, _, body) =
        post_json(&r.app, &c, "/api/triggers/run", r#"{"name":"Tickets"}"#).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body.contains("the secret linear is not set"), "{body}");
    let (status, _, _) = post_json(&r.app, &c, "/api/triggers/run", r#"{"name":"Nope"}"#).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn scan_folder_is_checked_and_follows_the_rules() {
    let r = rig();
    let id = dispatch_conversation(&r).await;
    let before = event_count(&r, &id);
    for (args, error) in [
        (
            json!({ "machine": "hp", "kind": "lint", "folder": "slot2" }),
            "kind must be dead_code, test_gaps or security",
        ),
        (
            json!({ "machine": "hp", "kind": "security" }),
            "give a folder from list_folders, or a path",
        ),
        (
            json!({ "machine": "hp", "kind": "security", "folder": "nope" }),
            "hp has no folder nope",
        ),
        (
            json!({ "machine": "hp", "kind": "security", "path": "slots/slot2" }),
            "slots/slot2 is not an absolute path; give one, or a folder from list_folders",
        ),
        (
            json!({ "machine": "hp", "kind": "security", "path": "/" }),
            "scanning / is not supported; give a folder",
        ),
        (
            json!({ "machine": "hp", "kind": "security", "folder": "slot2", "agent": "nope" }),
            "no agent named nope",
        ),
    ] {
        let result = dispatch_tool(&r, Some(&id), "scan_folder", args).await;
        assert_eq!(result["isError"], true, "{result}");
        assert_eq!(result["content"][0]["text"], error);
    }
    assert_eq!(event_count(&r, &id), before, "a mistake is no step");

    let asked = dispatch_tool(
        &r,
        Some(&id),
        "scan_folder",
        json!({ "machine": "hp", "kind": "security", "folder": "slot2", "focus": "the login form" }),
    )
    .await;
    assert!(asked["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Not run yet."));
    let step = last_event(&r, &id);
    assert_eq!(
        (&step["tool"], &step["status"], &step["by"]),
        (
            &json!("start_session"),
            &json!("pending"),
            &json!("dispatch")
        )
    );
    assert_eq!(
        step["review"],
        json!({ "machine": "hp", "name": "", "path": "/r/slots/slot2", "branch": "eng-1301-inbox", "scan": "security" })
    );
    let prompt = step["input"]["prompt"].as_str().unwrap();
    assert!(prompt.starts_with("Run a security scan of this folder."));
    assert!(prompt.contains("Pay special attention to this: the login form"));
    assert!(prompt.contains("This scan is read-only."));
    assert!(
        !prompt.contains("screenshot"),
        "a scan is not offered screenshots"
    );
    let inside = dispatch_tool(
        &r,
        Some(&id),
        "scan_folder",
        json!({ "machine": "hp", "kind": "dead-code", "path": "/r/slots/slot2/app/" }),
    )
    .await;
    assert_eq!(inside["isError"], false, "{inside}");
    let step = last_event(&r, &id);
    assert_eq!(step["input"]["path"], "/r/slots/slot2/app");
    assert_eq!(step["review"]["scan"], "dead_code");

    set_rules(
        &r,
        "ask",
        json!([
            { "action": "scan_folder", "folder": "slot2", "approval": "deny" },
            { "action": "scan_folder", "folder": "/r/other", "approval": "allow" },
        ]),
    );
    let before = event_count(&r, &id);
    let denied = dispatch_tool(
        &r,
        Some(&id),
        "scan_folder",
        json!({ "machine": "hp", "kind": "test_gaps", "path": "/r/slots/slot2/app" }),
    )
    .await;
    assert_eq!(denied["isError"], true);
    assert!(denied["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("\"deny scan_folder on any machine in slot2\""));
    assert_eq!(event_count(&r, &id), before);
    assert!(!ran(&r, "tmux new"));

    r.fake.stub("tmux new", Output::ok_with("hp-other\n"));
    let allowed = dispatch_tool(
        &r,
        Some(&id),
        "scan_folder",
        json!({ "machine": "hp", "kind": "test_gaps", "path": "/r/other" }),
    )
    .await;
    assert_eq!(allowed["isError"], false, "{allowed}");
    let step = last_event(&r, &id);
    assert_eq!(step["status"], "auto");
    assert_eq!(step["review"]["scan"], "test_gaps");
    assert!(ran(&r, "Run a test gap scan of this folder"));
    let tracked = r.app.dispatch.get(&id).unwrap()["sessions"].clone();
    assert_eq!(tracked[0]["review"]["scan"], "test_gaps");
}

fn finished_scan(r: &Rig, id: &str, of: crate::dispatch::ReviewOf, screen: &str) -> usize {
    r.app.dispatch.report(
        &crate::dispatch::Change {
            conversation: id.to_string(),
            machine: "hp".into(),
            name: "hp-eng-1301-2".into(),
            path: of.path.clone(),
            state: "idle",
            review: Some(of),
        },
        screen,
    );
    event_count(r, id) - 1
}

#[tokio::test]
async fn a_scan_starts_from_a_session_card_or_a_folder() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    r.app.dispatch.report(
        &crate::dispatch::Change {
            conversation: id.clone(),
            machine: "hp".into(),
            name: "hp-eng-1301".into(),
            path: "/r/slots/slot2".into(),
            state: "idle",
            review: None,
        },
        "Done.",
    );
    let card = event_count(&r, &id) - 1;
    let (status, body) = step_post(
        &r,
        &c,
        "/dispatch/scans",
        json!({ "conversation": id, "card": card, "kind": "security" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversation"], id.as_str());
    let step = &body["step"];
    assert_eq!(
        (&step["by"], &step["status"]),
        (&json!("you"), &json!("pending"))
    );
    assert_eq!(step["review"]["name"], "hp-eng-1301");
    assert_eq!(step["review"]["scan"], "security");
    assert_eq!(step["input"]["path"], "/r/slots/slot2");
    let (status, _) = step_post(
        &r,
        &c,
        "/dispatch/scans",
        json!({ "conversation": id, "card": 0, "kind": "security" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the first event is a message"
    );

    let (status, body) = step_post(
        &r,
        &c,
        "/dispatch/scans",
        json!({ "machine": "hp", "folder": "slot2", "inside": "src/api/", "kind": "dead_code" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let fresh = body["conversation"].as_str().unwrap();
    assert_ne!(fresh, id);
    let convo = r.app.dispatch.get(fresh).unwrap();
    assert_eq!(convo["title"], "Dead code scan of slot2/src/api");
    assert_eq!(
        convo["events"][0]["review"]["path"],
        "/r/slots/slot2/src/api"
    );
    assert_eq!(convo["events"][0]["review"]["name"], "");
    let (status, body) = step_post(
        &r,
        &c,
        "/dispatch/scans",
        json!({ "machine": "hp", "folder": "slot2", "path": "/r/slots/slot2-worktrees/eng-9/", "branch": "eng-9", "inside": "web", "kind": "security" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let convo = r
        .app
        .dispatch
        .get(body["conversation"].as_str().unwrap())
        .unwrap();
    assert_eq!(convo["title"], "Security scan of slot2-worktrees/eng-9/web");
    let picked = &convo["events"][0];
    assert_eq!(
        picked["input"]["path"],
        "/r/slots/slot2-worktrees/eng-9/web"
    );
    assert_eq!(
        picked["review"]["branch"], "eng-9",
        "a worktree picked as the branch"
    );
    for (body, error) in [
        (
            json!({ "machine": "hp", "folder": "slot2", "inside": "../x", "kind": "security" }),
            "the folder inside must be a relative path without . or .. parts",
        ),
        (
            json!({ "machine": "hp", "folder": "slot2", "kind": "everything" }),
            "kind must be dead_code, test_gaps or security",
        ),
        (
            json!({ "card": 1, "kind": "security" }),
            "a session card belongs to a conversation",
        ),
    ] {
        let (status, answer) = step_post(&r, &c, "/dispatch/scans", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(answer["error"], error);
    }
    let (status, body) = step_post(
        &r,
        &c,
        "/dispatch/scans",
        json!({ "machine": "hp", "folder": "slot2", "kind": "test_gaps" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let titled = r
        .app
        .dispatch
        .get(body["conversation"].as_str().unwrap())
        .unwrap();
    assert_eq!(titled["title"], "Test gap scan of slot2");
}

#[tokio::test]
async fn a_scan_card_shows_the_files_its_findings_name_and_sends_them() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    let of = crate::dispatch::ReviewOf {
        machine: "hp".into(),
        name: String::new(),
        path: "/r/slots/slot2".into(),
        branch: "eng-1301-inbox".into(),
        evidence: String::new(),
        scan: "security".into(),
    };
    let screen = "⏺ YARDBELL SCAN\n  verdict: 2 issues found\n  summary: A token and an injection.\n  - high: config/deploy.yml:3: A token is committed.\n  - medium: src/run.rs:2: The branch goes into sh -c.\n  END SCAN";
    let card = finished_scan(&r, &id, of.clone(), screen);
    let scan = last_event(&r, &id);
    assert_eq!(
        (&scan["role"], &scan["verdict"]),
        (&json!("review"), &json!("issues"))
    );
    assert!(scan.get("diff").is_none() && scan.get("base").is_none());

    let get = |url: String| {
        let req = Request::get(url)
            .header(header::ACCEPT, "application/json")
            .header(header::COOKIE, &c);
        send(&r.app, req.body(Body::empty()).unwrap())
    };
    let base = format!("/dispatch/conversations/{id}/reviews/{card}");
    let (status, _, body) = get(format!("{base}/files")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let list: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(list["files"], json!(["config/deploy.yml", "src/run.rs"]));
    assert_eq!(list["folder"], "/r/slots/slot2");

    let calls = r.fake.calls().len();
    for bad in [
        "..%2F..%2Fetc%2Fpasswd",
        "%2Fetc%2Fpasswd",
        "a%0Ab",
        "src%2Fother.rs",
        "src%2F.%2Frun.rs",
    ] {
        let (status, _, body) = get(format!("{base}/files?file={bad}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
        assert!(body.contains("no finding points at"), "{body}");
    }
    assert_eq!(
        r.fake.calls().len(),
        calls,
        "nothing ran for a refused path"
    );
    r.fake.stub(
        "@@YB-FILE@@",
        Output::ok_with("@@YB-FILE@@\nfn run(branch: &str) {\n    sh(branch);\n}\n"),
    );
    let (status, _, body) = get(format!("{base}/files?file=src%2Frun.rs&line=2")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let page: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        page["lines"][1],
        json!({ "k": "ctx", "o": null, "n": 2, "t": "    sh(branch);" })
    );
    assert!(ran(&r, "cd '/r/slots/slot2'") && ran(&r, "f='src/run.rs'"));
    r.fake
        .restub("@@YB-FILE@@", Output::ok_with("ERR outside\n"));
    let (status, _, body) = get(format!("{base}/files?file=config%2Fdeploy.yml")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body.contains("config/deploy.yml is outside the scanned folder"),
        "{body}"
    );
    let (status, _, _) = get(format!("/dispatch/conversations/{id}/reviews/0/files")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "event 0 is not a scan");

    let (status, _, body) = get(format!("{base}/sessions")).await;
    assert_eq!(status, StatusCode::OK);
    let targets: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(targets["sessions"][0]["name"], "hp-eng-1301");
    assert_eq!(
        targets["sessions"].as_array().unwrap().len(),
        1,
        "only tmux sessions in the folder"
    );

    let (status, answer) = step_post(
        &r,
        &c,
        &base,
        json!({ "decision": "send", "findings": [0] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(answer["error"], "pick a session to send the findings to");
    let (status, answer) = step_post(
        &r,
        &c,
        &base,
        json!({ "decision": "send", "findings": [0], "to": "hp-elsewhere" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        answer["error"],
        "hp-elsewhere is not a session in the scanned folder"
    );
    r.fake.stub("load-buffer", Output::ok_with(""));
    let (status, sent) = step_post(
        &r,
        &c,
        &base,
        json!({ "decision": "send", "findings": [1], "to": "hp-eng-1301" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["outcome"]["to"], "hp-eng-1301");
    let at = r
        .fake
        .calls()
        .iter()
        .position(|c| c.join(" ").contains("load-buffer"))
        .unwrap();
    let typed = r.fake.inputs()[at].clone().unwrap();
    assert!(
        typed.starts_with("A security scan of /r/slots/slot2 found this problem. Fix it,"),
        "{typed}"
    );
    assert!(typed.contains("1) medium src/run.rs:2: The branch goes into sh -c."));

    let second = finished_scan(
        &r,
        &id,
        of,
        &screen.replace("A token and an injection.", "Again."),
    );
    let url = format!("/dispatch/conversations/{id}/reviews/{second}");
    let (status, started) = step_post(
        &r,
        &c,
        &url,
        json!({ "decision": "start", "findings": [0, 1] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    assert_eq!(started["card"]["outcome"]["decision"], "started");
    let step = &started["step"];
    assert_eq!(
        (&step["by"], &step["status"]),
        (&json!("you"), &json!("pending"))
    );
    assert_eq!(step["input"]["path"], "/r/slots/slot2");
    assert!(step.get("review").is_none(), "the fixer is no scanner");
    assert!(step["input"]["prompt"]
        .as_str()
        .unwrap()
        .starts_with("A security scan of /r/slots/slot2 found these 2 problems."));
    assert_eq!(started["card"]["outcome"]["step"], step["id"]);
    let (status, _) = step_post(&r, &c, &url, json!({ "decision": "dismiss" })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let review_url = format!("/dispatch/conversations/{id}/reviews/{}", card + 100);
    let (status, _) = step_post(
        &r,
        &c,
        &review_url,
        json!({ "decision": "start", "findings": [0] }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

fn last_start(r: &Rig) -> String {
    r.fake
        .calls()
        .iter()
        .rev()
        .find(|c| c.join(" ").contains("tmux new"))
        .map(|c| c.join(" "))
        .unwrap_or_default()
}

#[tokio::test]
async fn reviewers_and_scanners_start_unable_to_edit_files() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    set_rules(&r, "auto", json!([]));
    r.fake.stub("tmux new", Output::ok_with("hp-x\n"));
    let claude_off =
        |cmd: &str| cmd.contains("--disallowed-tools") && cmd.contains("Edit,Write,NotebookEdit");

    let review = dispatch_tool(
        &r,
        Some(&id),
        "review_session",
        json!({ "machine": "hp", "name": "hp-eng-1301" }),
    )
    .await;
    assert_eq!(review["isError"], false, "{review}");
    let cmd = last_start(&r);
    assert!(claude_off(&cmd), "{cmd}");
    assert!(!cmd.contains("read-only by instruction"));

    let scan = dispatch_tool(
        &r,
        Some(&id),
        "scan_folder",
        json!({ "machine": "hp", "kind": "security", "folder": "slot2", "agent": "codex" }),
    )
    .await;
    assert_eq!(scan["isError"], false, "{scan}");
    let cmd = last_start(&r);
    assert!(cmd.contains("--sandbox read-only"), "{cmd}");

    let (status, _) = step_post(
        &r,
        &c,
        "/sessions",
        json!({ "machine": "hp", "folder": "slot2", "agent": "codex", "resume": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cmd = last_start(&r);
    assert!(
        cmd.contains("codex resume --last --sandbox read-only"),
        "resuming the scanner stays read-only: {cmd}"
    );

    let normal = dispatch_tool(
        &r,
        Some(&id),
        "start_session",
        json!({ "machine": "hp", "folder": "slot2", "agent": "codex", "prompt": "fix the inbox" }),
    )
    .await;
    assert_eq!(normal["isError"], false, "{normal}");
    let cmd = last_start(&r);
    assert!(
        cmd.contains("fix the inbox") && !cmd.contains("--sandbox"),
        "{cmd}"
    );
    let (status, _) = step_post(
        &r,
        &c,
        "/sessions",
        json!({ "machine": "hp", "folder": "slot2", "agent": "codex", "resume": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cmd = last_start(&r);
    assert!(
        cmd.contains("codex resume --last") && !cmd.contains("--sandbox"),
        "after a normal session, a resume is normal: {cmd}"
    );
    let (status, _) = step_post(
        &r,
        &c,
        "/sessions",
        json!({ "machine": "hp", "folder": "slot2", "prompt": "plain" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!last_start(&r).contains("--disallowed-tools"));

    let other = dispatch_tool(
        &r,
        Some(&id),
        "scan_folder",
        json!({ "machine": "hp", "kind": "dead_code", "folder": "slot2", "agent": "gemini" }),
    )
    .await;
    assert_eq!(other["isError"], false, "{other}");
    let cmd = last_start(&r);
    assert!(
        !cmd.contains("--sandbox") && !cmd.contains("--disallowed-tools"),
        "{cmd}"
    );
    let step = last_event(&r, &id);
    assert!(step["input"]["prompt"]
        .as_str()
        .unwrap()
        .ends_with(crate::mcp::READ_ONLY_BY_INSTRUCTION));
}

#[tokio::test]
async fn an_approved_review_stays_read_only_even_when_edited() {
    let r = rig();
    let c = cookie(&r.app).await;
    let id = dispatch_conversation(&r).await;
    let asked = dispatch_tool(
        &r,
        Some(&id),
        "scan_folder",
        json!({ "machine": "hp", "kind": "security", "folder": "slot2" }),
    )
    .await;
    assert!(asked["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Not run yet."));
    let step = last_event(&r, &id);
    assert_eq!(step["input"]["read_only"], true);
    let mut edited = step["input"].clone();
    edited.as_object_mut().unwrap().remove("read_only");
    edited["prompt"] = json!("scan, and also fix what you find");
    r.fake.stub("tmux new", Output::ok_with("hp-x\n"));
    let (status, ran) = step_post(
        &r,
        &c,
        &format!(
            "/dispatch/conversations/{id}/actions/{}",
            step["id"].as_str().unwrap()
        ),
        json!({ "decision": "approve", "input": edited }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ran}");
    let cmd = last_start(&r);
    assert!(cmd.contains("--disallowed-tools"), "{cmd}");
}

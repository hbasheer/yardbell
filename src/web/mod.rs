use crate::auth::{Auth, Clock, Verdict};
use crate::config::{Config, Machine};
use crate::folders::Folders;
use crate::mesh::HostMesh;
use crate::onboarding::Onboarding;
use crate::phone::Phone;
use crate::sessions::Sessions;
use crate::settings::Settings;
use crate::snapshot;
use crate::state::{PortStatus, State};
use crate::term;
use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as UrlPath, Request, State as AxState};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Form, Json, Router};
use axum_extra::extract::cookie::{Cookie, Key, SameSite, SignedCookieJar};
use base64::Engine;
use futures::StreamExt;
use rand::Rng;
use serde::Deserialize;
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const COOKIE: &str = "yardbell_session";
pub const COOKIE_TTL_SECS: u64 = 2_592_000;
const HANDOFF_TTL: Duration = Duration::from_secs(30);
const HANDOFF_MAX: usize = 16;

#[derive(rust_embed::RustEmbed)]
#[folder = "assets/"]
struct Assets;

pub struct AppState {
    pub cfg_path: PathBuf,
    pub state: State,
    pub ports: Arc<dyn PortStatus + Send + Sync>,
    pub sessions: Sessions,
    pub onboarding: Arc<Onboarding>,
    pub host_mesh: HostMesh,
    pub folders: Folders,
    pub settings: Settings,
    pub phone: Arc<Phone>,
    pub auth: Auth,
    pub key: std::sync::RwLock<Key>,
    pub handoff: std::sync::Mutex<Vec<(String, Instant)>>,
    refresh: Refresh,
    clock: Clock,
}

pub type Refresh = Arc<dyn Fn() -> futures::future::BoxFuture<'static, ()> + Send + Sync>;

pub struct Services {
    pub state: State,
    pub ports: Arc<dyn PortStatus + Send + Sync>,
    pub sessions: Sessions,
    pub onboarding: Arc<Onboarding>,
    pub host_mesh: HostMesh,
    pub folders: Folders,
    pub settings: Settings,
    pub phone: Arc<Phone>,
    pub refresh: Refresh,
}

impl AppState {
    pub fn new(cfg_path: PathBuf, services: Services, cfg: &Config, clock: Clock) -> AppState {
        let Services {
            state,
            ports,
            sessions,
            onboarding,
            host_mesh,
            folders,
            settings,
            phone,
            refresh,
        } = services;
        AppState {
            cfg_path,
            state,
            ports,
            sessions,
            onboarding,
            host_mesh,
            folders,
            settings,
            phone,
            auth: Auth::new(cfg.passcode_hash.clone().unwrap_or_default(), clock.clone()),
            key: std::sync::RwLock::new(cookie_key(cfg)),
            handoff: std::sync::Mutex::new(Vec::new()),
            refresh,
            clock,
        }
    }

    pub fn config(&self) -> Result<Config, ApiError> {
        Config::load(&self.cfg_path)
            .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    }

    pub fn jar(&self, headers: &HeaderMap) -> SignedCookieJar {
        SignedCookieJar::from_headers(headers, self.key.read().expect("key lock").clone())
    }
}

pub fn cookie_key(cfg: &Config) -> Key {
    cfg.cookie_key
        .as_deref()
        .and_then(|k| base64::engine::general_purpose::STANDARD.decode(k).ok())
        .filter(|bytes| bytes.len() >= 64)
        .map(|bytes| Key::from(&bytes))
        .unwrap_or_else(Key::generate)
}

#[derive(Clone, Copy)]
pub struct ClientIp(pub IpAddr);

pub fn error(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn gateway(msg: String) -> ApiError {
        ApiError(StatusCode::BAD_GATEWAY, msg)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error(self.0, &self.1)
    }
}

pub fn page_host(headers: &HeaderMap) -> String {
    let raw = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let host = raw.rsplit_once(':').map(|(host, _)| host).unwrap_or(raw);
    if host.is_empty() {
        return "localhost".into();
    }
    host.to_string()
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn logged_in(jar: &SignedCookieJar) -> bool {
    jar.get(COOKIE)
        .and_then(|c| {
            c.value()
                .strip_prefix("v1:")
                .and_then(|t| t.parse::<u64>().ok())
        })
        .is_some_and(|issued| now_secs().saturating_sub(issued) < COOKIE_TTL_SECS)
}

fn wants_json(req: &Request) -> bool {
    let accept = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    req.method() != Method::GET || accept.contains("json") || req.uri().path() == "/state"
}

async fn guard(AxState(app): AxState<Arc<AppState>>, mut req: Request, next: Next) -> Response {
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]));
    req.extensions_mut().insert(ClientIp(ip));
    if req.method() != Method::GET && !term::origin_ok(req.headers()) {
        return error(
            StatusCode::FORBIDDEN,
            "request did not come from the Yardbell page",
        );
    }
    let path = req.uri().path();
    let public_handoff = req.method() == Method::GET && path.starts_with("/app/handoff/");
    if path == "/login"
        || path == "/style.css"
        || public_handoff
        || logged_in(&app.jar(req.headers()))
    {
        return next.run(req).await;
    }
    if wants_json(&req) {
        return error(StatusCode::UNAUTHORIZED, "log in first");
    }
    (StatusCode::FOUND, [(header::LOCATION, "/login")]).into_response()
}

pub fn asset(name: &str) -> Response {
    let Some(file) = Assets::get(name) else {
        return error(StatusCode::NOT_FOUND, "not found");
    };
    let mime = match name.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        _ => "application/octet-stream",
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        file.data.into_owned(),
    )
        .into_response()
}

pub fn router(app: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(|| async { asset("dashboard.html") }))
        .route("/login", get(|| async { asset("login.html") }).post(login))
        .route("/logout", post(logout))
        .route("/app/handoff", post(handoff_new))
        .route("/app/handoff/{code}", get(handoff_redeem))
        .route("/style.css", get(|| async { asset("style.css") }))
        .route("/dashboard.js", get(|| async { asset("dashboard.js") }))
        .route("/nav.js", get(|| async { asset("nav.js") }))
        .route("/state", get(state_json))
        .route("/sessions", post(new_session))
        .route("/sessions/{machine}/{name}/stop", post(stop_session))
        .route("/refresh", post(refresh_now))
        .route("/machines/{machine}/shell", post(open_shell))
        .route("/sessions/{machine}/{pid}/move-to-tmux", post(move_to_tmux))
        .route(
            "/sessions/{machine}/{name}/host-terminal",
            post(host_terminal),
        )
        .route("/ended/{id}/forget", post(forget))
        .route("/mesh/on", post(mesh_on))
        .route("/machines/{machine}/browse", get(browse))
        .route("/machines/{machine}/branches", get(branches))
        .route("/term.js", get(|| async { asset("term.js") }))
        .route("/add", get(|| async { asset("add.html") }))
        .route("/add.js", get(|| async { asset("add.js") }))
        .route("/onboarding/peers", get(onboarding_peers))
        .route("/onboarding/{step}", post(onboarding_step))
        .route("/machines/{name}/remove", post(remove_machine))
        .route(
            "/term/{machine}/{name}",
            get(|| async { asset("term.html") }),
        )
        .route("/term/{machine}/{name}/ws", get(term_ws))
        .route("/settings", get(|| async { asset("settings.html") }))
        .route("/settings.js", get(|| async { asset("settings.js") }))
        .merge(settings_api::routes())
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

#[derive(Deserialize)]
struct LoginForm {
    passcode: String,
}

async fn login(
    AxState(app): AxState<Arc<AppState>>,
    Extension(ClientIp(ip)): Extension<ClientIp>,
    headers: HeaderMap,
    Form(form): Form<LoginForm>,
) -> Response {
    match app.auth.verify(&form.passcode, ip) {
        Verdict::Locked => error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts, try again in 5 minutes",
        ),
        Verdict::Wrong => error(StatusCode::UNAUTHORIZED, "wrong passcode"),
        Verdict::Ok => (
            app.jar(&headers).add(login_cookie()),
            Json(json!({ "ok": true })),
        )
            .into_response(),
    }
}

fn session_cookie() -> Cookie<'static> {
    Cookie::build((COOKIE, format!("v1:{}", now_secs())))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/")
        .build()
}

fn login_cookie() -> Cookie<'static> {
    let mut cookie = session_cookie();
    cookie.set_max_age(time::Duration::seconds(COOKIE_TTL_SECS as i64));
    cookie
}

async fn handoff_new(AxState(app): AxState<Arc<AppState>>) -> Response {
    let code: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();
    let mut codes = app.handoff.lock().expect("handoff lock");
    codes.push((code.clone(), (app.clock)()));
    if codes.len() > HANDOFF_MAX {
        codes.remove(0);
    }
    Json(json!({ "code": code })).into_response()
}

async fn handoff_redeem(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(code): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    let now = (app.clock)();
    let issued = {
        let mut codes = app.handoff.lock().expect("handoff lock");
        codes
            .iter()
            .position(|(c, _)| *c == code)
            .map(|i| codes.remove(i).1)
    };
    if !issued.is_some_and(|at| now.saturating_duration_since(at) <= HANDOFF_TTL) {
        return (StatusCode::FOUND, [(header::LOCATION, "/login")]).into_response();
    }
    (
        // The app's webview writes a cookie that has an expiry to disk in plain
        // text, and it signs in again with a fresh handoff on every launch.
        app.jar(&headers).add(session_cookie()),
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        r#"<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta http-equiv="refresh" content="0;url=/"><style>html{background:#ffffff}@media (prefers-color-scheme: dark){html{background:#0a0a0b}}</style><script>location.replace("/")</script>"#,
    )
        .into_response()
}

async fn logout(AxState(app): AxState<Arc<AppState>>, headers: HeaderMap) -> Response {
    let jar = app.jar(&headers).remove(Cookie::build(COOKIE).path("/"));
    (jar, Json(json!({ "ok": true }))).into_response()
}

async fn state_json(
    AxState(app): AxState<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let mut view = app
        .state
        .view(&cfg, app.ports.as_ref(), &page_host(&headers));
    view.mesh = Some(app.host_mesh.check(&cfg).await);
    Ok(Json(view).into_response())
}

pub fn find_machine(cfg: &Config, name: &str) -> Result<Machine, ApiError> {
    cfg.machine(name)
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no machine named {name}")))
}

#[derive(Deserialize)]
struct NewSession {
    machine: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    new_branch: bool,
    #[serde(default)]
    base: String,
    #[serde(default)]
    resume: bool,
    #[serde(default)]
    agent: String,
}

fn label_of(path: &str) -> String {
    let parts: Vec<&str> = path.trim_end_matches('/').rsplit('/').take(2).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

async fn new_session(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<NewSession>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &req.machine)?;
    let agent_name = if req.agent.is_empty() {
        cfg.default_agent()
    } else {
        &req.agent
    };
    let agent = cfg.agent(agent_name).ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            format!("no agent named {agent_name}"),
        )
    })?;
    let snap = app.state.snapshot(&m.name).unwrap_or_default();
    let repo = if req.path.trim().is_empty() {
        snap.folder_paths.get(&req.folder).cloned().ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                format!("{} has no folder {}", m.name, req.folder),
            )
        })?
    } else {
        req.path.trim().to_string()
    };
    let (path, branch) = if req.branch.is_empty() {
        let known = snap
            .folder_paths
            .iter()
            .find(|(_, p)| **p == repo)
            .and_then(|(label, _)| snap.folders.get(label).cloned())
            .unwrap_or_default();
        (repo.clone(), known)
    } else {
        let current = app
            .folders
            .branches(&m, &repo)
            .await
            .map_err(ApiError::gateway)?
            .current;
        let pick = crate::folders::Pick {
            branch: req.branch.clone(),
            new_branch: req.new_branch,
            base: req.base.clone(),
        };
        let path = app
            .folders
            .prepare(&m, &repo, &pick, &current)
            .await
            .map_err(ApiError::gateway)?;
        (path, req.branch.clone())
    };
    let ticket = snapshot::ticket(&branch, cfg.ticket_regex().as_ref());
    let name = app
        .sessions
        .create(&m, &path, &ticket, &label_of(&path), &agent, req.resume)
        .await
        .map_err(ApiError::gateway)?;
    remember(&app, &m.name, &repo);
    Ok(Json(json!({ "name": name, "path": path })).into_response())
}

fn remember(app: &AppState, machine: &str, path: &str) {
    let Ok(mut cfg) = Config::load(&app.cfg_path) else {
        return;
    };
    let Some(m) = cfg.machines.iter_mut().find(|m| m.name == machine) else {
        return;
    };
    m.recent.retain(|p| p != path);
    m.recent.insert(0, path.to_string());
    m.recent.truncate(8);
    if let Err(e) = cfg.save(&app.cfg_path) {
        tracing::warn!(error = %e, "could not remember folder");
    }
}

#[derive(Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(serde::Serialize)]
struct BrowseResponse {
    #[serde(flatten)]
    listing: crate::folders::Listing,
    recent: Vec<String>,
}

async fn browse(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    axum::extract::Query(q): axum::extract::Query<PathQuery>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    let path = if q.path.is_empty() {
        m.root.clone()
    } else {
        q.path
    };
    let listing = app
        .folders
        .browse(&m, &path)
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(BrowseResponse {
        listing,
        recent: m.recent,
    })
    .into_response())
}

async fn branches(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    axum::extract::Query(q): axum::extract::Query<PathQuery>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    let b = app
        .folders
        .branches(&m, &q.path)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(b).into_response())
}

async fn stop_session(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, name)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    app.sessions
        .stop(&m, &name)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn move_to_tmux(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, pid)): UrlPath<(String, u32)>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    let s = app
        .state
        .snapshot(&m.name)
        .unwrap_or_default()
        .sessions
        .into_iter()
        .find(|s| s.pid == pid)
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                format!("no agent with pid {pid} on {}", m.name),
            )
        })?;
    if s.attachable() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "that session already runs in tmux".into(),
        ));
    }
    let agent = cfg.agent(&s.agent).ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            format!("no agent named {}", s.agent),
        )
    })?;
    app.sessions
        .stop_pid(&m, pid)
        .await
        .map_err(ApiError::gateway)?;
    let name = app
        .sessions
        .create(&m, &s.cwd, &s.ticket, &label_of(&s.cwd), &agent, true)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "name": name, "path": s.cwd })).into_response())
}

async fn refresh_now(AxState(app): AxState<Arc<AppState>>) -> Response {
    if tokio::time::timeout(Duration::from_secs(20), (app.refresh)())
        .await
        .is_err()
    {
        tracing::warn!("refresh did not finish within 20 seconds");
    }
    Json(json!({ "ok": true })).into_response()
}

async fn open_shell(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    let name = app
        .sessions
        .open_shell(&m)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "name": name })).into_response())
}

async fn host_terminal(
    AxState(app): AxState<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath((machine, name)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let host = page_host(&headers);
    if host != "localhost" && host != "127.0.0.1" {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "only available on the host machine".into(),
        ));
    }
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    let argv = app.sessions.attach_argv(&m, &name);
    app.sessions
        .open_on_host(cfg.host_terminal, &argv)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn mesh_on(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let message = app
        .host_mesh
        .turn_on(&cfg)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "ok": true, "message": message })).into_response())
}

async fn forget(AxState(app): AxState<Arc<AppState>>, UrlPath(id): UrlPath<String>) -> Response {
    app.state.forget(&id);
    Json(json!({ "ok": true })).into_response()
}

async fn term_ws(
    AxState(app): AxState<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath((machine, name)): UrlPath<(String, String)>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !term::origin_ok(&headers) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "origin does not match host".into(),
        ));
    }
    let argv = if machine == "_onboarding" {
        app.onboarding.take_terminal(&name).ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "this setup terminal has expired, retry the step".into(),
            )
        })?
    } else {
        let cfg = app.config()?;
        let m = find_machine(&cfg, &machine)?;
        app.sessions.attach_argv(&m, &name)
    };
    let exit_message = if machine == "_onboarding" {
        "done, go back to the Add machine tab and press Check again"
    } else {
        term::EXIT_MESSAGE
    };
    Ok(ws.on_upgrade(move |socket| run_terminal(socket, argv, exit_message)))
}

pub async fn run_terminal(socket: WebSocket, argv: Vec<String>, exit_message: &'static str) {
    let (tx, rx) = socket.split();
    let rx = rx.filter_map(|msg| std::future::ready(msg.ok()));
    match term::spawn(&argv, 24, 80) {
        Ok(pty) => term::bridge(tx, rx, pty, exit_message).await,
        Err(e) => tracing::error!(error = %e, "terminal spawn failed"),
    }
}

#[derive(Deserialize, Default)]
struct StepInput {
    #[serde(default)]
    name: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    ip: String,
    #[serde(default)]
    root: String,
}

async fn onboarding_peers(AxState(app): AxState<Arc<AppState>>) -> Response {
    Json(app.onboarding.peers().await).into_response()
}

async fn onboarding_step(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(step): UrlPath<String>,
    Json(input): Json<StepInput>,
) -> Result<Response, ApiError> {
    let ob = &app.onboarding;
    let StepInput {
        name,
        user,
        ip,
        root,
    } = input;
    let result = match step.as_str() {
        "reachable" => ob.reachable(&ip).await,
        "key_auth" => ob.key_auth(&user, &ip).await,
        "ssh_config_preview" => ob.ssh_config_preview(&name, &user, &ip).await,
        "write_ssh_config" => ob.write_ssh_config(&name, &user, &ip).await,
        "detect" => ob.detect(&name).await,
        "save" => ob.save(&name, &ip, &root).await,
        _ => {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                format!("unknown step {step}"),
            ))
        }
    };
    Ok(Json(result).into_response())
}

async fn remove_machine(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
) -> Response {
    Json(app.onboarding.remove(&name).await).into_response()
}

mod settings_api;

#[cfg(test)]
mod tests;

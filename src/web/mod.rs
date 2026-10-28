use crate::auth::{Auth, Clock, Verdict};
use crate::config::{Config, Machine};
use crate::dispatch::Dispatch;
use crate::folders::Folders;
use crate::mesh::HostMesh;
use crate::onboarding::Onboarding;
use crate::phone::Phone;
use crate::secrets::Secrets;
use crate::sessions::{Launch, Sessions, Start};
use crate::settings::Settings;
use crate::snapshot;
use crate::state::{PortStatus, State};
use crate::term;
use crate::viewers::{Plan, Viewers};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
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
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const COOKIE: &str = "yardbell_session";
pub const COOKIE_TTL_SECS: u64 = 2_592_000;
const APP_POLL: Duration = Duration::from_secs(50);
const HANDOFF_TTL: Duration = Duration::from_secs(30);
const HANDOFF_MAX: usize = 16;
pub const PAIRING_TTL: Duration = Duration::from_secs(300);
const PAIRING_MAX: usize = 4;

#[derive(rust_embed::RustEmbed)]
#[folder = "assets/"]
struct Assets;

const BUILD_HEADER: &str = "x-yardbell-build";

// Open pages compare this with the build they loaded from and reload when it changes, so a
// restarted server never leaves a tab running page code that no longer matches it.
fn page_build() -> &'static str {
    static BUILD: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BUILD.get_or_init(|| {
        use std::hash::{DefaultHasher, Hash, Hasher};
        let mut names: Vec<_> = Assets::iter().collect();
        names.sort();
        let mut hasher = DefaultHasher::new();
        for name in names {
            name.hash(&mut hasher);
            if let Some(file) = Assets::get(&name) {
                file.metadata.sha256_hash().hash(&mut hasher);
            }
        }
        format!("{:016x}", hasher.finish())
    })
}

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
    pub dispatch: Arc<Dispatch>,
    pub auth: Auth,
    pub key: std::sync::RwLock<Key>,
    pub handoff: std::sync::Mutex<Vec<(String, Instant)>>,
    pub pairing: std::sync::Mutex<Vec<(String, Instant)>>,
    pub viewers: Viewers,
    installed: std::sync::Mutex<HashMap<String, (Instant, Vec<String>)>>,
    servers: tokio::sync::Mutex<Option<(Instant, Vec<crate::discover::Found>)>>,
    refresh: Refresh,
    updates: crate::about::Updates,
    started: Instant,
    started_at: u64,
    clock: Clock,
}

// Checks one machine again, or every machine when given none.
pub type Refresh =
    Arc<dyn Fn(Option<String>) -> futures::future::BoxFuture<'static, ()> + Send + Sync>;

pub struct Services {
    pub state: State,
    pub ports: Arc<dyn PortStatus + Send + Sync>,
    pub sessions: Sessions,
    pub onboarding: Arc<Onboarding>,
    pub host_mesh: HostMesh,
    pub folders: Folders,
    pub settings: Settings,
    pub phone: Arc<Phone>,
    pub dispatch: Arc<Dispatch>,
    pub refresh: Refresh,
    pub releases: crate::about::Fetch,
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
            dispatch,
            refresh,
            releases,
        } = services;
        let key = match Secrets::for_config(&cfg_path) {
            Ok(secrets) => cookie_key(cfg, &secrets),
            Err(e) => {
                tracing::warn!(error = %e, "every login cookie is refused until the key can be read");
                Key::generate()
            }
        };
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
            dispatch,
            auth: Auth::new(cfg.passcode_hash.clone().unwrap_or_default(), clock.clone()),
            key: std::sync::RwLock::new(key),
            handoff: std::sync::Mutex::new(Vec::new()),
            pairing: std::sync::Mutex::new(Vec::new()),
            viewers: Viewers::default(),
            installed: std::sync::Mutex::new(HashMap::new()),
            servers: tokio::sync::Mutex::new(None),
            refresh,
            updates: crate::about::Updates::new(releases, clock.clone()),
            started: clock(),
            started_at: now_secs(),
            clock,
        }
    }

    pub fn forget_installed(&self) {
        self.installed.lock().expect("installed lock").clear();
    }

    pub fn config(&self) -> Result<Config, ApiError> {
        Config::load(&self.cfg_path)
            .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    }

    pub fn secrets(&self) -> Result<Secrets, ApiError> {
        Secrets::for_config(&self.cfg_path)
            .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    }

    pub async fn refresh(&self) {
        settle((self.refresh)(None)).await;
    }

    pub async fn check(&self, machine: &str) {
        settle((self.refresh)(Some(machine.to_string()))).await;
    }

    // An action changes one machine, and every open page shows it once that machine is checked
    // again, without waiting for the next poll or holding up the answer to the action.
    pub fn recheck(&self, machine: &str) {
        tokio::spawn((self.refresh)(Some(machine.to_string())));
    }

    pub fn jar(&self, headers: &HeaderMap) -> SignedCookieJar {
        SignedCookieJar::from_headers(headers, self.key.read().expect("key lock").clone())
    }
}

async fn settle(check: futures::future::BoxFuture<'static, ()>) {
    if tokio::time::timeout(Duration::from_secs(20), check)
        .await
        .is_err()
    {
        tracing::warn!("refresh did not finish within 20 seconds");
    }
}

pub fn cookie_key(cfg: &Config, secrets: &Secrets) -> Key {
    cfg.cookie_key(secrets)
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "every login cookie is refused until the key can be read");
            None
        })
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

    pub fn internal(msg: String) -> ApiError {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, msg)
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
    // Agents call /mcp without a browser cookie or Origin; the handler checks a bearer token.
    // A browser always sends Origin, so a page on another site is still turned away here.
    if req.uri().path() == "/mcp" {
        if req.headers().contains_key(header::ORIGIN) && !term::origin_ok(req.headers()) {
            return error(StatusCode::FORBIDDEN, "request came from another site");
        }
        return next.run(req).await;
    }
    if req.method() != Method::GET && !term::origin_ok(req.headers()) {
        return error(
            StatusCode::FORBIDDEN,
            "request did not come from the Yardbell page",
        );
    }
    let path = req.uri().path();
    let public_handoff = (req.method() == Method::GET
        && (path.starts_with("/app/handoff/") || path == "/app/hello" || path == "/app/servers"))
        || (req.method() == Method::POST && path.starts_with("/app/pair/"));
    if path == "/login"
        || path == "/style.css"
        || path == "/theme.js"
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
        .route("/app/pair/{code}", post(pair_redeem))
        .route("/app/notifications", get(app_notifications))
        .route("/app/hello", get(app_hello))
        .route("/app/servers", get(app_servers))
        .route("/app/about", get(app_about))
        .route("/app/about/updates", get(app_updates))
        .route("/style.css", get(|| async { asset("style.css") }))
        .route("/theme.js", get(|| async { asset("theme.js") }))
        .route("/side.js", get(|| async { asset("side.js") }))
        .route("/dashboard.js", get(|| async { asset("dashboard.js") }))
        .route(
            "/vendor/lit-html/lit-html.js",
            get(|| async { asset("vendor/lit-html/lit-html.js") }),
        )
        .route(
            "/vendor/lit-html/directive.js",
            get(|| async { asset("vendor/lit-html/directive.js") }),
        )
        .route(
            "/vendor/lit-html/directive-helpers.js",
            get(|| async { asset("vendor/lit-html/directive-helpers.js") }),
        )
        .route(
            "/vendor/lit-html/directives/repeat.js",
            get(|| async { asset("vendor/lit-html/directives/repeat.js") }),
        )
        .route("/nav.js", get(|| async { asset("nav.js") }))
        .route("/live.js", get(|| async { asset("live.js") }))
        .route("/newsession.js", get(|| async { asset("newsession.js") }))
        .route("/state", get(state_json))
        .route("/state/live", get(state_live))
        .route("/workspace", get(|| async { asset("workspace.html") }))
        .route("/workspace.js", get(|| async { asset("workspace.js") }))
        .route("/dispatch", get(|| async { asset("dispatch.html") }))
        .route("/dispatch.js", get(|| async { asset("dispatch.js") }))
        .route("/composer.js", get(|| async { asset("composer.js") }))
        .route("/dispatch/conversations", get(dispatch_list))
        .route("/dispatch/conversations/{id}", get(dispatch_get))
        .route("/dispatch/conversations/{id}/stop", post(dispatch_stop))
        .route("/dispatch/conversations/{id}/delete", post(dispatch_delete))
        .route("/dispatch/clear", post(dispatch_clear))
        .route(
            "/dispatch/tasks",
            get(dispatch_tasks).post(dispatch_save_task),
        )
        .route("/dispatch/tasks/delete", post(dispatch_delete_task))
        .route("/dispatch/tasks/restore", post(dispatch_restore_tasks))
        .route("/dispatch/usage", get(dispatch_usage))
        .route("/dispatch/usage/refresh", post(dispatch_usage_refresh))
        .route(
            "/dispatch/conversations/{id}/actions",
            post(dispatch_decide_all),
        )
        .route(
            "/dispatch/conversations/{id}/actions/{action}",
            post(dispatch_decide),
        )
        .route(
            "/dispatch/conversations/{id}/reviews",
            post(dispatch_request_review),
        )
        .route(
            "/dispatch/conversations/{id}/reviews/{card}",
            post(dispatch_review_outcome),
        )
        .route(
            "/dispatch/conversations/{id}/answers",
            post(dispatch_answer),
        )
        .route(
            "/dispatch-review.js",
            get(|| async { asset("dispatch-review.js") }),
        )
        .route("/sessions/{machine}/{name}/keys", post(session_keys))
        .route("/dispatch/ask", post(dispatch_ask))
        .route(
            "/mcp",
            post(crate::mcp::handle).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
        )
        .route("/sessions", post(new_session))
        .route("/sessions/{machine}/{name}/stop", post(stop_session))
        .route("/refresh", post(refresh_now))
        .route("/machines/{machine}/shell", post(open_shell))
        .route("/sessions/{machine}/{pid}/move-to-tmux", post(move_to_tmux))
        .route("/sessions/{machine}/{pid}/stop-process", post(stop_process))
        .route(
            "/sessions/{machine}/{name}/host-terminal",
            post(host_terminal),
        )
        .route("/ended/{id}/forget", post(forget))
        .route("/mesh/on", post(mesh_on))
        .route("/machines/{machine}/browse", get(browse))
        .route("/machines/{machine}/agents", get(installed_agents))
        .route("/machines/{machine}/recent/forget", post(forget_recent))
        .route("/machines/{machine}/branches", get(branches))
        .route("/term.js", get(|| async { asset("term.js") }))
        .route("/add", get(|| async { asset("add.html") }))
        .route("/add.js", get(|| async { asset("add.js") }))
        .route("/onboarding/peers", get(onboarding_peers))
        .route("/onboarding/browse", get(onboarding_browse))
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

fn random_code(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

pub fn new_pairing(app: &AppState) -> String {
    let code = random_code(32);
    let mut codes = app.pairing.lock().expect("pairing lock");
    codes.push((code.clone(), (app.clock)()));
    if codes.len() > PAIRING_MAX {
        codes.remove(0);
    }
    code
}

// A paired phone gets the same login a passcode gives. The code works once, for five minutes.
async fn pair_redeem(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(code): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    let now = (app.clock)();
    let issued = {
        let mut codes = app.pairing.lock().expect("pairing lock");
        codes
            .iter()
            .position(|(c, _)| *c == code)
            .map(|i| codes.remove(i).1)
    };
    if !issued.is_some_and(|at| now.saturating_duration_since(at) <= PAIRING_TTL) {
        return error(
            StatusCode::UNAUTHORIZED,
            "this pairing code is used or expired, show a new one in Settings",
        );
    }
    (
        app.jar(&headers).add(login_cookie()),
        Json(json!({ "ok": true })),
    )
        .into_response()
}

async fn handoff_new(AxState(app): AxState<Arc<AppState>>) -> Response {
    let code = random_code(32);
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
    view.server = Some(server_view(&cfg));
    Ok(([(BUILD_HEADER, page_build())], Json(view)).into_response())
}

const LIVE_SETTLE: Duration = Duration::from_millis(100);

async fn state_live(
    AxState(app): AxState<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !term::origin_ok(&headers) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "origin does not match host".into(),
        ));
    }
    let changes = app.state.changes();
    Ok(ws.on_upgrade(move |socket| live(socket, changes)))
}

// Tells an open page that the state changed, and the page fetches /state as it always did. The
// machines of one poll finish close together, so a short pause lets one message cover them.
async fn live(mut socket: WebSocket, mut changes: tokio::sync::watch::Receiver<u64>) {
    loop {
        tokio::select! {
            changed = changes.changed() => {
                if changed.is_err() {
                    return;
                }
                tokio::time::sleep(LIVE_SETTLE).await;
                let version = *changes.borrow_and_update();
                if socket.send(Message::Text(version.to_string().into())).await.is_err() {
                    return;
                }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
        }
    }
}

async fn app_hello(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let server = server_view(&app.config()?);
    Ok(
        Json(json!({ "app": "yardbell", "machine": server.machine, "address": server.address }))
            .into_response(),
    )
}

async fn app_about(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let server = server_view(&app.config()?);
    let version = crate::about::VERSION;
    Ok(Json(json!({
        "version": version,
        "build": page_build(),
        "machine": server.machine,
        "address": server.address,
        "os": crate::about::os_name(),
        "arch": std::env::consts::ARCH,
        "container": crate::about::in_container(),
        "started_at": app.started_at,
        "uptime_secs": (app.clock)().saturating_duration_since(app.started).as_secs(),
        "config": app.cfg_path,
        "state": crate::cli::state_dir(),
        "links": {
            "release": crate::about::release_notes(version),
            "changelog": crate::about::changelog(),
            "docs": crate::about::docs(version),
        },
    }))
    .into_response())
}

async fn app_updates(AxState(app): AxState<Arc<AppState>>) -> Response {
    Json(app.updates.check(crate::about::VERSION).await).into_response()
}

const SERVERS_FOR: Duration = Duration::from_secs(60);

// Lets the apps offer the servers on the mesh, so signing in takes only the passcode. Each
// probe is a request to a mesh peer, so the list is kept a minute and built by one caller at a
// time.
async fn app_servers(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let mut cache = app.servers.lock().await;
    if let Some((_, list)) = cache.as_ref().filter(|(at, _)| at.elapsed() < SERVERS_FOR) {
        return Ok(Json(list.clone()).into_response());
    }
    let mut ips: Vec<String> = cfg
        .machines
        .iter()
        .filter_map(|m| m.mesh_ip.clone())
        .collect();
    if let Ok(peers) = app
        .onboarding
        .list_peers(crate::mesh::host_provider(&cfg))
        .await
    {
        ips.extend(peers.into_iter().filter(|p| p.online).map(|p| p.ip));
    }
    let own = server_view(&cfg);
    let mut found = crate::discover::probe_all(crate::discover::addresses(ips, cfg.port)).await;
    found.push(crate::discover::Found {
        machine: own.machine,
        address: own.address,
    });
    let list = crate::discover::dedupe(found);
    *cache = Some((Instant::now(), list.clone()));
    Ok(Json(list).into_response())
}

// The address other machines and phones use, which is not always the one this page was opened at.
fn server_view(cfg: &Config) -> crate::state::ServerView {
    let address = crate::phone::base_url(cfg)
        .and_then(|url| url.strip_prefix("http://").map(str::to_string))
        .unwrap_or_else(|| format!("localhost:{}", cfg.port));
    let machine = cfg.host().map(|m| m.name.clone()).unwrap_or_else(hostname);
    crate::state::ServerView {
        machine,
        address,
        version: crate::about::VERSION.into(),
    }
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "this machine".into())
}

async fn dispatch_usage(AxState(app): AxState<Arc<AppState>>) -> Response {
    Json(app.dispatch.usage()).into_response()
}

async fn dispatch_usage_refresh(AxState(app): AxState<Arc<AppState>>) -> Response {
    match app
        .dispatch
        .refresh_usage_now(&reqwest::Client::new())
        .await
    {
        Ok(usage) => Json(usage).into_response(),
        Err(message) => error(StatusCode::BAD_GATEWAY, &message),
    }
}

async fn dispatch_tasks(AxState(app): AxState<Arc<AppState>>) -> Response {
    Json(app.dispatch.tasks()).into_response()
}

#[derive(Deserialize)]
struct TaskInput {
    name: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    replacing: Option<String>,
}

async fn dispatch_save_task(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<TaskInput>,
) -> Result<Response, ApiError> {
    let tasks = app
        .dispatch
        .save_task(&req.name, &req.text, req.replacing.as_deref())
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(tasks).into_response())
}

async fn dispatch_restore_tasks(
    AxState(app): AxState<Arc<AppState>>,
) -> Result<Response, ApiError> {
    let tasks = app
        .dispatch
        .restore_default_tasks()
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(tasks).into_response())
}

async fn dispatch_delete_task(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<TaskInput>,
) -> Result<Response, ApiError> {
    let tasks = app
        .dispatch
        .delete_task(&req.name)
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(tasks).into_response())
}

#[derive(Deserialize)]
struct KeysInput {
    keys: String,
}

fn plain_keys(keys: &str) -> Result<(), ApiError> {
    if keys.is_empty() || keys.chars().count() > 8 || keys.chars().any(char::is_control) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "keys must be up to 8 plain characters".into(),
        ));
    }
    Ok(())
}

async fn session_keys(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, name)): UrlPath<(String, String)>,
    Json(req): Json<KeysInput>,
) -> Result<Response, ApiError> {
    plain_keys(&req.keys)?;
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    app.sessions
        .send_keys(&m, &name, &req.keys)
        .await
        .map_err(ApiError::gateway)?;
    app.recheck(&m.name);
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn dispatch_list(AxState(app): AxState<Arc<AppState>>) -> Response {
    Json(app.dispatch.list()).into_response()
}

fn conversation_id(id: &str) -> Result<&str, ApiError> {
    if crate::dispatch::valid_id(id) {
        return Ok(id);
    }
    Err(ApiError(
        StatusCode::NOT_FOUND,
        "no such conversation".into(),
    ))
}

async fn dispatch_get(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    app.dispatch
        .get(conversation_id(&id)?)
        .map(|c| Json(c).into_response())
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no such conversation".into()))
}

#[derive(Deserialize)]
struct DispatchAsk {
    #[serde(default)]
    conversation: Option<String>,
    text: String,
}

async fn dispatch_ask(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<DispatchAsk>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let conversation = req
        .conversation
        .as_deref()
        .map(conversation_id)
        .transpose()?;
    let host_mcp = match cfg.host() {
        Some(m) => cfg
            .mcp_config_for(&m.name, &app.secrets()?)
            .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?,
        None => None,
    };
    let (id, rx) = app
        .dispatch
        .ask(
            conversation,
            &req.text,
            cfg.port,
            &cfg.dispatch,
            host_mcp.as_deref(),
        )
        .await
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    let first = json!({ "role": "conversation", "id": id });
    let lines = futures::stream::once(async move { first })
        .chain(futures::stream::unfold(rx, |mut rx| async move {
            let event = rx.recv().await?;
            Some((event, rx))
        }))
        .map(|event| Ok::<_, std::convert::Infallible>(format!("{event}\n")));
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        axum::body::Body::from_stream(lines),
    )
        .into_response())
}

async fn dispatch_stop(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    app.dispatch.stop(conversation_id(&id)?);
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn dispatch_delete(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    app.dispatch
        .delete(conversation_id(&id)?)
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn dispatch_clear(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let kept = app
        .dispatch
        .clear()
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "kept": kept })).into_response())
}

fn refused(r: crate::dispatch::Refusal) -> ApiError {
    match r {
        crate::dispatch::Refusal::Missing(m) => ApiError(StatusCode::NOT_FOUND, m),
        crate::dispatch::Refusal::Taken(m) => ApiError(StatusCode::CONFLICT, m),
    }
}

fn step_id(id: &str) -> Result<&str, ApiError> {
    if crate::dispatch::valid_action_id(id) {
        return Ok(id);
    }
    Err(ApiError(StatusCode::NOT_FOUND, "no such step".into()))
}

#[derive(Deserialize)]
struct Decision {
    decision: String,
    #[serde(default)]
    input: Option<Value>,
}

// Work that must finish and be recorded even when the page that asked for it goes away, like a
// phone losing its connection while a session starts.
async fn detached<T: Send + 'static>(
    work: impl std::future::Future<Output = Result<T, ApiError>> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::spawn(work)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

async fn decide(
    app: &Arc<AppState>,
    id: &str,
    action: &str,
    req: &Decision,
) -> Result<Value, ApiError> {
    match req.decision.as_str() {
        "reject" => app.dispatch.reject(id, action).map_err(refused),
        "approve" => {
            if let Some(input) = &req.input {
                let step = app
                    .dispatch
                    .step(id, action)
                    .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no such step".into()))?;
                let tool = step["tool"].as_str().unwrap_or_default();
                crate::mcp::check(app, &app.config()?, tool, input)?;
            }
            let (tool, input) = app
                .dispatch
                .approve(id, action, req.input.clone())
                .map_err(refused)?;
            let (app, id, action) = (app.clone(), id.to_string(), action.to_string());
            detached(async move {
                let outcome = crate::mcp::perform(&app, &tool, input)
                    .await
                    .map_err(|ApiError(_, message)| message);
                app.dispatch.ran(&id, &action, &outcome).map_err(refused)
            })
            .await
        }
        _ => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "decision must be approve or reject".into(),
        )),
    }
}

async fn dispatch_decide(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((id, action)): UrlPath<(String, String)>,
    Json(req): Json<Decision>,
) -> Result<Response, ApiError> {
    let event = decide(&app, conversation_id(&id)?, step_id(&action)?, &req).await?;
    Ok(Json(event).into_response())
}

// One at a time, in the order they were proposed: two sessions in the same repository must not
// set up their worktrees at once.
async fn dispatch_decide_all(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
    Json(req): Json<Decision>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    if req.input.is_some() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "edit steps one at a time".into(),
        ));
    }
    let mut decided = Vec::new();
    for action in app.dispatch.pending(id) {
        match decide(&app, id, &action, &req).await {
            Ok(event) => decided.push(event),
            Err(ApiError(StatusCode::CONFLICT, _)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(Json(decided).into_response())
}

#[derive(Deserialize)]
struct CardInput {
    card: usize,
    #[serde(default)]
    key: String,
}

fn card_of(app: &AppState, id: &str, index: usize, role: &str) -> Result<Value, ApiError> {
    app.dispatch
        .event(id, index)
        .filter(|e| e["role"] == role)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no such {role} card")))
}

// Review branch on a session card: the reviewer waits for the person to start it, so they can
// pick its agent or change its instructions first.
async fn dispatch_request_review(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
    Json(req): Json<CardInput>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    let card = card_of(&app, id, req.card, "session")?;
    let text = |k: &str| card[k].as_str().unwrap_or_default().to_string();
    let cfg = app.config()?;
    let (input, of) = crate::mcp::review_plan(
        &app,
        &cfg,
        &text("machine"),
        &text("name"),
        &text("path"),
        "",
        "",
    )?;
    let event = app
        .dispatch
        .propose(
            id,
            "start_session",
            input,
            crate::dispatch::By::You,
            Some(of),
            None,
        )
        .map_err(refused)?;
    Ok(Json(event).into_response())
}

#[derive(Deserialize)]
struct ReviewDecision {
    decision: String,
    #[serde(default)]
    findings: Vec<usize>,
}

async fn dispatch_review_outcome(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((id, card)): UrlPath<(String, usize)>,
    Json(req): Json<ReviewDecision>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    let review = card_of(&app, id, card, "review")?;
    if review["outcome"].is_object() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "this review was already handled".into(),
        ));
    }
    let outcome = match req.decision.as_str() {
        "dismiss" => json!({ "decision": "dismissed" }),
        "send" => {
            let all = review["findings"].as_array().cloned().unwrap_or_default();
            let mut picked = req.findings.clone();
            picked.sort_unstable();
            picked.dedup();
            if picked.is_empty() || picked.iter().any(|i| *i >= all.len()) {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "pick the findings to send".into(),
                ));
            }
            let chosen: Vec<Value> = picked.iter().map(|i| all[*i].clone()).collect();
            let of = &review["of"];
            let (machine, name) = (
                of["machine"].as_str().unwrap_or_default(),
                of["name"].as_str().unwrap_or_default(),
            );
            let cfg = app.config()?;
            let m = find_machine(&cfg, machine)?;
            let (app, id, name) = (app.clone(), id.to_string(), name.to_string());
            let event = detached(async move {
                app.sessions
                    .send(&m, &name, &crate::dispatch::fix_request(&chosen))
                    .await
                    .map_err(|e| ApiError::gateway(format!("could not send to {name}: {e}")))?;
                let outcome = json!({ "decision": "sent", "findings": picked, "to": name });
                app.dispatch
                    .review_outcome(&id, card, outcome)
                    .map_err(refused)
            })
            .await?;
            return Ok(Json(event).into_response());
        }
        _ => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "decision must be send or dismiss".into(),
            ))
        }
    };
    let event = app
        .dispatch
        .review_outcome(id, card, outcome)
        .map_err(refused)?;
    Ok(Json(event).into_response())
}

// Picking a choice on a session card answers the session and keeps the answer in the
// conversation, so the card still shows it after a reload or on another device.
async fn dispatch_answer(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
    Json(req): Json<CardInput>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    plain_keys(&req.key)?;
    let card = card_of(&app, id, req.card, "session")?;
    if let Some(earlier) = card["answer"]["label"].as_str() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!("it was already answered with {earlier}"),
        ));
    }
    let label = card["options"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|o| o["key"] == req.key.as_str())
        .and_then(|o| o["label"].as_str())
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "not one of its choices".into()))?
        .to_string();
    let (machine, name) = (
        card["machine"].as_str().unwrap_or_default(),
        card["name"].as_str().unwrap_or_default(),
    );
    let cfg = app.config()?;
    let m = find_machine(&cfg, machine)?;
    let (name, id, card) = (name.to_string(), id.to_string(), req.card);
    let event = detached(async move {
        app.sessions
            .send_keys(&m, &name, &req.key)
            .await
            .map_err(ApiError::gateway)?;
        app.dispatch
            .answered(&id, card, &req.key, &label)
            .map_err(refused)
    })
    .await?;
    Ok(Json(event).into_response())
}

pub fn find_machine(cfg: &Config, name: &str) -> Result<Machine, ApiError> {
    cfg.machine(name)
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no machine named {name}")))
}

#[derive(Deserialize)]
pub struct NewSession {
    pub machine: String,
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
    #[serde(default)]
    prompt: String,
    // Answer only once the machine was checked again, so /state already lists the session.
    #[serde(default)]
    wait: bool,
}

impl NewSession {
    // The mistakes worth catching before a person is asked to approve the step.
    pub fn check(&self, app: &AppState, cfg: &Config) -> Result<(), ApiError> {
        let m = find_machine(cfg, &self.machine)?;
        let bad = |m: String| ApiError(StatusCode::BAD_REQUEST, m);
        if !self.agent.is_empty() && cfg.agent(&self.agent).is_none() {
            return Err(bad(format!("no agent named {}", self.agent)));
        }
        if self.new_branch && self.branch.trim().is_empty() {
            return Err(bad("a new branch needs a name".into()));
        }
        if !self.path.trim().is_empty() {
            return Ok(());
        }
        if self.folder.is_empty() {
            return Err(bad("give a folder from list_folders, or a path".into()));
        }
        let snap = app.state.snapshot(&m.name).unwrap_or_default();
        if !snap.folder_paths.contains_key(&self.folder) {
            return Err(bad(format!("{} has no folder {}", m.name, self.folder)));
        }
        Ok(())
    }
}

fn label_of(path: &str) -> String {
    let parts: Vec<&str> = path.trim_end_matches('/').rsplit('/').take(2).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

async fn new_session(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<NewSession>,
) -> Result<Response, ApiError> {
    let (machine, wait) = (req.machine.clone(), req.wait);
    let started = start_session(&app, req).await?;
    if wait {
        app.check(&machine).await;
    } else {
        app.recheck(&machine);
    }
    Ok(Json(started).into_response())
}

pub async fn start_session(app: &AppState, req: NewSession) -> Result<Value, ApiError> {
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
    let mcp_config = mcp_config(&cfg, &m, &agent, &app.secrets()?)?;
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
    let start = match (req.resume, req.prompt.trim()) {
        (true, _) => Start::Resume,
        (false, "") => Start::New,
        (false, prompt) => Start::Task(prompt),
    };
    let name = app
        .sessions
        .create(
            &m,
            Launch {
                folder_path: &path,
                ticket: &ticket,
                folder_label: &label_of(&path),
                agent: &agent,
                start,
                mcp_config: mcp_config.as_deref(),
            },
        )
        .await
        .map_err(ApiError::gateway)?;
    remember(app, &m.name, &repo);
    Ok(json!({ "machine": m.name, "name": name, "path": path }))
}

fn mcp_config(
    cfg: &Config,
    m: &Machine,
    agent: &crate::agents::Agent,
    secrets: &Secrets,
) -> Result<Option<String>, ApiError> {
    if agent.process_name() != "claude" {
        return Ok(None);
    }
    cfg.mcp_config_for(&m.name, secrets)
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))
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

#[derive(Deserialize)]
struct ForgetRecent {
    path: String,
}

async fn forget_recent(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Json(req): Json<ForgetRecent>,
) -> Result<Response, ApiError> {
    let mut cfg = app.config()?;
    let m = cfg
        .machines
        .iter_mut()
        .find(|m| m.name == machine)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no machine named {machine}")))?;
    m.recent.retain(|p| *p != req.path);
    let recent = m.recent.clone();
    cfg.save(&app.cfg_path).map_err(|e| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not save the config: {e}"),
        )
    })?;
    Ok(Json(json!({ "recent": recent })).into_response())
}

#[derive(serde::Serialize)]
struct BrowseResponse {
    #[serde(flatten)]
    listing: crate::folders::Listing,
    recent: Vec<String>,
}

const INSTALLED_FOR: Duration = Duration::from_secs(5 * 60);

// Checking a machine for agents takes a login shell over ssh, and the New session dialog asks
// every time it opens, so the answer is kept a few minutes.
async fn installed_agents(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    let cached = app
        .installed
        .lock()
        .expect("installed lock")
        .get(&m.name)
        .filter(|(at, _)| at.elapsed() < INSTALLED_FOR)
        .map(|(_, names)| names.clone());
    let names = match cached {
        Some(names) => names,
        None => {
            let names = app
                .sessions
                .installed_agents(&m, &cfg.agents())
                .await
                .map_err(ApiError::gateway)?;
            app.installed
                .lock()
                .expect("installed lock")
                .insert(m.name.clone(), (Instant::now(), names.clone()));
            names
        }
    };
    Ok(Json(json!({ "installed": names })).into_response())
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
    app.recheck(&m.name);
    Ok(Json(json!({ "ok": true })).into_response())
}

// Only a process the last machine check listed as an agent outside tmux can be stopped by pid.
fn loose_session(
    app: &AppState,
    cfg: &Config,
    machine: &str,
    pid: u32,
) -> Result<(Machine, crate::snapshot::Session), ApiError> {
    let m = find_machine(cfg, machine)?;
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
    Ok((m, s))
}

async fn stop_process(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, pid)): UrlPath<(String, u32)>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let (m, _) = loose_session(&app, &cfg, &machine, pid)?;
    app.sessions
        .stop_pid(&m, pid)
        .await
        .map_err(ApiError::gateway)?;
    app.recheck(&m.name);
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn move_to_tmux(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, pid)): UrlPath<(String, u32)>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let (m, s) = loose_session(&app, &cfg, &machine, pid)?;
    let agent = cfg.agent(&s.agent).ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            format!("no agent named {}", s.agent),
        )
    })?;
    let mcp_config = mcp_config(&cfg, &m, &agent, &app.secrets()?)?;
    app.sessions
        .stop_pid(&m, pid)
        .await
        .map_err(ApiError::gateway)?;
    let created = app
        .sessions
        .create(
            &m,
            Launch {
                folder_path: &s.cwd,
                ticket: &s.ticket,
                folder_label: &label_of(&s.cwd),
                agent: &agent,
                start: Start::Resume,
                mcp_config: mcp_config.as_deref(),
            },
        )
        .await;
    app.recheck(&m.name);
    let name = created.map_err(|e| {
        ApiError::gateway(format!(
            "{e}. {} was stopped; start it again from its folder.",
            agent.display()
        ))
    })?;
    Ok(Json(json!({ "name": name, "path": s.cwd })).into_response())
}

async fn refresh_now(AxState(app): AxState<Arc<AppState>>) -> Response {
    app.refresh().await;
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct InboxQuery {
    boot: Option<String>,
    #[serde(default)]
    after: u64,
}

async fn app_notifications(
    AxState(app): AxState<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<InboxQuery>,
) -> Response {
    let page = app
        .phone
        .inbox
        .wait(q.boot.as_deref(), q.after, APP_POLL)
        .await;
    Json(page).into_response()
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
    let (argv, control) = if machine == "_onboarding" {
        let argv = app.onboarding.take_terminal(&name).ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "this setup terminal has expired, retry the step".into(),
            )
        })?;
        (argv, None)
    } else {
        let cfg = app.config()?;
        let m = find_machine(&cfg, &machine)?;
        let viewer = format!("{:016x}", rand::random::<u64>());
        let argv = app.sessions.viewer_argv(&m, &name, &viewer);
        (argv, Some(control(app.clone(), m, name, viewer)))
    };
    let exit_message = if machine == "_onboarding" {
        "done, go back to the Add machine tab and press Check again"
    } else {
        term::EXIT_MESSAGE
    };
    Ok(ws.on_upgrade(move |socket| run_terminal(socket, argv, exit_message, control)))
}

// A swipe arrives as many small scroll frames, and each one is an ssh round trip, so whatever
// piles up while one runs is sent as a single scroll. The same task tells tmux which viewer of the
// session owns its size, and only when that changes.
fn control(app: Arc<AppState>, m: Machine, name: String, viewer: String) -> term::Control {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<term::Job>();
    tokio::spawn(async move {
        let mut applied: Option<Plan> = None;
        while let Some(first) = rx.recv().await {
            let mut lines = 0;
            let mut bottom = Vec::new();
            let mut plan = None;
            for job in std::iter::once(first).chain(std::iter::from_fn(|| rx.try_recv().ok())) {
                match job {
                    term::Job::Lines(n) => lines += n,
                    term::Job::Bottom(done) => bottom.push(done),
                    term::Job::View(on) => {
                        plan = Some(app.viewers.set(&m.name, &name, &viewer, on))
                    }
                    term::Job::Typed => plan = Some(app.viewers.claim(&m.name, &name, &viewer)),
                }
            }
            if let Some(plan) = plan.filter(|plan| applied.as_ref() != Some(plan)) {
                if let Err(e) = app.sessions.size_viewers(&m, &name, &plan).await {
                    tracing::debug!(error = %e, session = %name, "sizing viewers failed");
                }
                applied = Some(plan);
            }
            let result = if !bottom.is_empty() {
                app.sessions.leave_copy_mode(&m, &name).await
            } else if lines != 0 {
                app.sessions.scroll(&m, &name, lines).await
            } else {
                Ok(())
            };
            if let Err(e) = result {
                tracing::debug!(error = %e, session = %name, "scroll failed");
            }
            for done in bottom {
                let _ = done.send(());
            }
        }
        let plan = app.viewers.leave(&m.name, &name, &viewer);
        if plan.owner.is_some() {
            let _ = app.sessions.size_viewers(&m, &name, &plan).await;
        }
        let _ = app.sessions.forget_viewer(&m, &name, &viewer).await;
    });
    tx
}

pub async fn run_terminal(
    socket: WebSocket,
    argv: Vec<String>,
    exit_message: &'static str,
    control: Option<term::Control>,
) {
    let (tx, rx) = socket.split();
    let rx = rx.filter_map(|msg| std::future::ready(msg.ok()));
    match term::spawn(&argv, 24, 80) {
        Ok(pty) => term::bridge(tx, rx, pty, exit_message, control).await,
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

#[derive(Deserialize)]
struct CandidateQuery {
    name: String,
    #[serde(default)]
    path: String,
}

async fn onboarding_browse(
    AxState(app): AxState<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<CandidateQuery>,
) -> Result<Response, ApiError> {
    let listing = app
        .onboarding
        .browse(&app.folders, &q.name, &q.path)
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(listing).into_response())
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

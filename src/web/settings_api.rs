use super::{error, find_machine, now_secs, ApiError, AppState, COOKIE, COOKIE_TTL_SECS};
use crate::config::MeshProvider;
use crate::mcp_client::oauth::Auth;
use crate::mcp_client::{holds_own_token, is_own_server};
use crate::secrets::Secrets;
use crate::settings::{propose, AgentEdit, MachineEdit, PhoneEdit};
use axum::extract::{Path as UrlPath, State as AxState};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, Key, SameSite};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/settings", get(show))
        .route("/api/settings/mesh/preview", post(mesh_preview))
        .route("/api/settings/mesh/apply", post(mesh_apply))
        .route("/api/settings/machines/{name}", post(machine))
        .route("/api/settings/phone", post(phone_save))
        .route("/api/settings/pull-requests", post(pull_requests_save))
        .route("/api/settings/pull-requests/folders", get(pull_folders))
        .route("/api/settings/agents", post(add_agent))
        .route("/api/settings/mcp/on", post(mcp_on))
        .route("/api/settings/mcp/off", post(mcp_off))
        .route("/api/settings/mcp/servers", post(mcp_servers))
        .route("/api/settings/secrets", post(secret_set))
        .route("/api/settings/secrets/delete", post(secret_delete))
        .route("/api/settings/secrets/move", post(secrets_move))
        .route("/api/settings/dispatch", post(dispatch))
        .route("/api/settings/pair", post(pair))
        .route("/api/settings/passcode", post(passcode))
        .route("/api/settings/logout-all", post(logout_all))
        .route("/api/settings/undo", post(undo))
        .route("/api/settings/restart", post(restart))
}

fn bad(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

async fn show(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let machines: Vec<_> = cfg
        .machines
        .iter()
        .map(|m| {
            json!({
                "name": m.name,
                "local": m.local,
                "ssh": m.ssh,
                "mesh_ip": m.mesh_ip,
                "port_prefix": m.port_prefix,
                "root": m.root,
                "mesh": m.mesh,
            })
        })
        .collect();
    let phone = &cfg.phone_notifications;
    let mcp_auth: BTreeMap<&str, &str> = app.secrets().map_or_else(
        |_| BTreeMap::new(),
        |store| {
            cfg.mcp_servers
                .iter()
                .map(|s| (s.name.as_str(), Auth::status(s, &store)))
                .collect()
        },
    );
    let (secrets, token) = match app.secrets() {
        Ok(store) => {
            let token = cfg.mcp_token(&store).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "the MCP token cannot be read");
                None
            });
            (secrets_view(&cfg, &store), token)
        }
        Err(e) => (
            json!({ "list": [], "missing": [], "inline": [], "error": e.1 }),
            None,
        ),
    };
    Ok(Json(json!({
        "mesh": cfg.mesh,
        "port": cfg.port,
        "machines": machines,
        "phone": {
            "app_connected": app.phone.inbox.listening(std::time::Instant::now()),
            "wait_minutes": phone.wait_minutes,
            "agent_waiting": phone.agent_waiting,
            "session_ended": phone.session_ended,
            "machines": phone.machines,
            "memory": phone.memory,
            "pipeline_waiting": phone.pipeline_waiting,
            "pipeline_finished": phone.pipeline_finished,
            "proposals": phone.proposals,
        },
        "mcp_servers": cfg.mcp_servers,
        "mcp_auth": mcp_auth,
        "secrets": secrets,
        "dispatch": cfg.dispatch,
        "codex_models": app.dispatch.codex_models(),
        "dispatch_runs_on": crate::config::RunsOn::ALL.map(|r| r.name()),
        "agents": cfg
            .agents()
            .iter()
            .map(|a| json!({ "name": a.name, "label": a.display() }))
            .collect::<Vec<_>>(),
        "default_agent": cfg.default_agent(),
        "mcp": {
            "token": token,
            "urls": cfg
                .bind_addresses()
                .iter()
                .map(|ip| format!("http://{ip}:{}/mcp", cfg.port))
                .collect::<Vec<_>>(),
        },
                        "pull_requests": {
            "value": crate::mcp_read::shown_area(&app, &cfg, "pull_requests"),
            "status": app.state.pull_health(),
        },
        "can_undo": app.settings.can_undo(),
        "undo_note": app.settings.undo_note(),
        "service_installed": crate::service::installed(),
    }))
    .into_response())
}

// Names and dates only: a secret's value never leaves the server once it is set.
fn secrets_view(cfg: &crate::config::Config, store: &Secrets) -> serde_json::Value {
    let used_by = |name: &str| -> Vec<&str> {
        let mut users: Vec<&str> = cfg
            .mcp_servers
            .iter()
            .filter(|s| s.secret_names().iter().any(|n| n == name))
            .map(|s| s.name.as_str())
            .collect();
        if name == crate::triggers::LINEAR_SECRET && cfg.triggers.iter().any(|t| t.linear.is_some())
        {
            users.push("Linear triggers");
        }
        let holds = |text: &str| crate::secrets::references(text).is_ok_and(|r| r.contains(&name));
        users.extend(
            cfg.connectors
                .iter()
                .filter(|c| c.headers.values().any(|v| holds(v)))
                .map(|c| c.name.as_str()),
        );
        if holds(&cfg.pull_requests.github_token) {
            users.push("GitHub");
        }
        if cfg.pull_requests.gitlab.iter().any(|g| holds(&g.token)) {
            users.push("GitLab");
        }
        users
    };
    let list: Vec<_> = store
        .list()
        .into_iter()
        .filter(|i| !crate::secrets::is_own(&i.name) && !crate::secrets::is_reserved(&i.name))
        .map(|i| json!({ "name": i.name, "updated": i.updated, "used_by": used_by(&i.name) }))
        .collect();
    let missing: Vec<_> = cfg
        .mcp_servers
        .iter()
        .flat_map(|s| {
            s.secret_names()
                .into_iter()
                .filter(|n| !store.contains(n))
                .map(|n| json!({ "server": s.name, "name": n }))
        })
        .collect();
    let inline: Vec<_> = cfg
        .inline_values()
        .into_iter()
        .map(|i| {
            json!({
                "kind": i.kind,
                "server": i.server,
                "key": i.key,
                "label": i.label(),
                "secret": i.looks_secret(),
            })
        })
        .collect();
    json!({
        "file": store.path().display().to_string(),
        "list": list,
        "missing": missing,
        "inline": inline,
    })
}

#[derive(Deserialize)]
struct SecretReq {
    name: String,
    #[serde(default)]
    value: String,
}

async fn secret_set(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<SecretReq>,
) -> Result<Response, ApiError> {
    app.settings
        .set_secret(req.name.trim(), &req.value)
        .map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn secret_delete(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<SecretReq>,
) -> Result<Response, ApiError> {
    app.settings.delete_secret(&req.name).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
struct MoveReq {
    items: Vec<crate::config::Inline>,
}

async fn secrets_move(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<MoveReq>,
) -> Result<Response, ApiError> {
    let moved = app.settings.move_to_secrets(&req.items).map_err(bad)?;
    Ok(Json(json!({ "moved": moved })).into_response())
}

#[derive(Deserialize)]
struct ProviderReq {
    provider: MeshProvider,
}

async fn mesh_preview(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<ProviderReq>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let (all, message) = match app.onboarding.list_peers(req.provider).await {
        Ok(peers) => (peers, None),
        Err(msg) => (Vec::new(), Some(msg)),
    };
    Ok(Json(json!({
        "proposals": propose(&cfg, &all),
        "peers": all,
        "message": message,
        "label": crate::mesh::label(req.provider),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct ApplyReq {
    provider: MeshProvider,
    #[serde(default)]
    addresses: BTreeMap<String, String>,
}

async fn mesh_apply(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<ApplyReq>,
) -> Result<Response, ApiError> {
    let addresses: BTreeMap<String, String> = req
        .addresses
        .into_iter()
        .map(|(k, v)| (k, v.trim().to_string()))
        .filter(|(_, v)| !v.is_empty())
        .collect();
    let out = app
        .settings
        .apply_mesh(req.provider, &addresses)
        .map_err(bad)?;
    Ok(Json(out).into_response())
}

async fn machine(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(name): UrlPath<String>,
    Json(edit): Json<MachineEdit>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    find_machine(&cfg, &name)?;
    app.settings.update_machine(&name, &edit).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

// Saved as tools save it, so a token shown as (hidden) stays what it was, and Undo reverses it.
async fn pull_requests_save(
    AxState(app): AxState<Arc<AppState>>,
    Json(value): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let saved = crate::mcp_read::saved_values(&app);
    crate::mcp_change::apply(&app.settings, "pull_requests", value, &saved).map_err(bad)?;
    app.state.touch();
    Ok(Json(json!({ "saved": true })).into_response())
}

const FOLDER_REMOTES_TIMEOUT: crate::shell::Duration = crate::shell::Duration::from_secs(20);

// Which service each folder's origin is on. Asked when the section opens, not on a timer.
async fn pull_folders(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let listed: Vec<String> = cfg
        .pull_requests
        .gitlab
        .iter()
        .map(|g| g.host.trim().to_ascii_lowercase())
        .collect();
    let app = &app;
    let answers = futures::future::join_all(cfg.machines.iter().map(|m| async move {
        let up = app.state.status(&m.name).is_some_and(|s| s.up);
        let paths = app.state.snapshot(&m.name).unwrap_or_default().folder_paths;
        if !up || paths.is_empty() {
            return (
                m,
                paths,
                up.then(String::new).ok_or("not connected".to_string()),
            );
        }
        let list: Vec<&str> = paths.values().map(String::as_str).collect();
        let asked = app
            .folders
            .exec(
                m,
                &crate::pulls::folder_remotes_command(&list),
                FOLDER_REMOTES_TIMEOUT,
            )
            .await;
        (m, paths, asked)
    }))
    .await;
    let mut folders = Vec::new();
    let mut unreachable = Vec::new();
    for (m, paths, asked) in answers {
        let out = match asked {
            Ok(out) => out,
            Err(e) => {
                unreachable.push(json!({ "machine": m.name, "why": e }));
                continue;
            }
        };
        let remotes: std::collections::HashMap<_, _> = crate::pulls::parse_folder_remotes(&out)
            .into_iter()
            .collect();
        for (label, path) in &paths {
            let repo = remotes.get(path).cloned().flatten();
            folders.push(json!({
                "machine": m.name,
                "folder": label,
                "host": repo.as_ref().map(|r| r.host.as_str()),
                "project": repo.as_ref().map(|r| r.project.as_str()),
                "service": repo.as_ref().map_or("none", |r| crate::pulls::service_of(&r.host, &listed)),
            }));
        }
    }
    Ok(Json(json!({ "folders": folders, "unreachable": unreachable })).into_response())
}

async fn phone_save(
    AxState(app): AxState<Arc<AppState>>,
    Json(edit): Json<PhoneEdit>,
) -> Result<Response, ApiError> {
    app.settings.update_phone(&edit).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn mcp_on(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let token = crate::mcp::new_token();
    app.settings
        .set_mcp_token(Some(token.clone()))
        .map_err(bad)?;
    Ok(Json(json!({ "token": token })).into_response())
}

async fn add_agent(
    AxState(app): AxState<Arc<AppState>>,
    Json(edit): Json<AgentEdit>,
) -> Result<Response, ApiError> {
    let agent = app.settings.add_agent(&edit).map_err(bad)?;
    app.forget_installed();
    Ok(Json(json!({ "name": agent.name, "label": agent.display() })).into_response())
}

async fn dispatch(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<crate::config::DispatchSettings>,
) -> Result<Response, ApiError> {
    let rules = req
        .rules
        .into_iter()
        .map(|rule| crate::dispatch::Rule {
            folder: rule.folder.trim().to_string(),
            ..rule
        })
        .collect();
    let settings = crate::config::DispatchSettings {
        instructions: req.instructions.trim().to_string(),
        rules,
        ..req
    };
    app.settings.set_dispatch(settings).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
struct McpServersReq {
    servers: Vec<crate::config::McpServer>,
}

async fn mcp_servers(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<McpServersReq>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let secrets = app.secrets()?;
    if let Some(own) = req.servers.iter().find(|s| {
        !s.url.is_empty() && (is_own_server(&s.url, &cfg) || holds_own_token(s, &cfg, &secrets))
    }) {
        return Err(bad(super::mcp_auth_api::own_server_error(&own.name)));
    }
    let gone: Vec<&str> = cfg
        .connectors
        .iter()
        .filter(|c| !c.server.is_empty() && !req.servers.iter().any(|s| s.name == c.server))
        .map(|c| c.id.as_str())
        .collect();
    if let Some(used) = super::connectors_api::pipeline_using(&app, &gone) {
        return Err(bad(format!(
            "{used} uses this connection, so it cannot be removed"
        )));
    }
    app.settings
        .set_mcp_servers(req.servers.clone())
        .map_err(bad)?;
    if !gone.is_empty() {
        let kept = cfg
            .connectors
            .iter()
            .filter(|c| !gone.contains(&c.id.as_str()));
        app.settings
            .set_connectors(kept.cloned().collect())
            .map_err(bad)?;
    }
    for old in cfg.mcp_servers.iter().filter(|old| !old.url.is_empty()) {
        if req
            .servers
            .iter()
            .any(|s| s.name == old.name && s.url == old.url)
        {
            continue;
        }
        let forgot = app.pipelines.mcp_auth().sign_out(old, &app.settings).await;
        if let Err(e) = forgot {
            tracing::warn!(error = %e, server = %old.name, "could not forget a sign-in");
        }
    }
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn mcp_off(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    app.settings.set_mcp_token(None).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

pub fn pairing_link(server: &str, code: &str) -> String {
    let enc: String = server
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("yardbell://pair?server={enc}&code={code}")
}

async fn pair(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let Some(ip) = cfg
        .bind_addresses()
        .into_iter()
        .find(|ip| ip != "127.0.0.1")
    else {
        return Err(bad(
            "this server has no mesh address yet, so a phone cannot reach it. Set this machine's mesh address under Machines first".into(),
        ));
    };
    let server = format!("http://{ip}:{}", cfg.port);
    let link = pairing_link(&server, &super::new_pairing(&app));
    let qr = qrcode::QrCode::new(link.as_bytes())
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    Ok(Json(json!({
        "server": server,
        "link": link,
        "qr_svg": qr,
        "expires_in": super::PAIRING_TTL.as_secs(),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct PasscodeReq {
    current: String,
    new: String,
}

async fn passcode(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<PasscodeReq>,
) -> Result<Response, ApiError> {
    let hash = app
        .settings
        .change_passcode(&req.current, &req.new)
        .map_err(bad)?;
    app.auth.set_hash(hash);
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn logout_all(
    AxState(app): AxState<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let encoded = app.settings.rotate_cookie_key().map_err(bad)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| bad(e.to_string()))?;
    *app.key.write().expect("key lock") = Key::from(&bytes);
    let cookie = Cookie::build((COOKIE, format!("v1:{}", now_secs())))
        .http_only(true)
        .same_site(SameSite::Strict)
        .path("/")
        .max_age(time::Duration::seconds(COOKIE_TTL_SECS as i64));
    Ok((app.jar(&headers).add(cookie), Json(json!({ "ok": true }))).into_response())
}

async fn undo(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    app.settings.undo().map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn restart(AxState(_app): AxState<Arc<AppState>>) -> Response {
    if !crate::service::installed() {
        return error(
            StatusCode::BAD_REQUEST,
            "Yardbell is not running as a service. Stop it and run yardbell serve again.",
        );
    }
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let argv = crate::service::restart_argv();
        if let Err(e) = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .spawn()
        {
            tracing::error!(error = %e, "restart failed");
        }
    });
    Json(json!({ "ok": true, "message": "Restarting, the page reconnects in a few seconds" }))
        .into_response()
}

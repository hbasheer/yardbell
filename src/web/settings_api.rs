use super::{error, find_machine, now_secs, ApiError, AppState, COOKIE, COOKIE_TTL_SECS};
use crate::config::MeshProvider;
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
        .route("/api/settings/agents", post(add_agent))
        .route("/api/settings/mcp/on", post(mcp_on))
        .route("/api/settings/mcp/off", post(mcp_off))
        .route("/api/settings/mcp/servers", post(mcp_servers))
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
        },
        "mcp_servers": cfg.mcp_servers,
        "dispatch": cfg.dispatch,
        "agents": cfg
            .agents()
            .iter()
            .map(|a| json!({ "name": a.name, "label": a.display() }))
            .collect::<Vec<_>>(),
        "default_agent": cfg.default_agent(),
        "mcp": {
            "token": cfg.mcp_token,
            "urls": cfg
                .bind_addresses()
                .iter()
                .map(|ip| format!("http://{ip}:{}/mcp", cfg.port))
                .collect::<Vec<_>>(),
        },
        "can_undo": app.settings.can_undo(),
        "service_installed": crate::service::installed(),
    }))
    .into_response())
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
    let settings = crate::config::DispatchSettings {
        instructions: req.instructions.trim().to_string(),
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
    app.settings.set_mcp_servers(req.servers).map_err(bad)?;
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

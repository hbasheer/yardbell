use super::{error, find_machine, now_secs, ApiError, AppState, COOKIE, COOKIE_TTL_SECS};
use crate::config::MeshProvider;
use crate::phone::ntfy::Target;
use crate::settings::{propose, MachineEdit, PhoneEdit};
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
        .route("/api/settings/phone/setup", post(phone_setup))
        .route("/api/settings/phone", post(phone_save))
        .route("/api/settings/phone/test", post(phone_test))
        .route("/api/settings/phone/off", post(phone_off))
        .route("/api/settings/mcp/on", post(mcp_on))
        .route("/api/settings/mcp/off", post(mcp_off))
        .route("/api/settings/mcp/servers", post(mcp_servers))
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
    let status = app.phone.status();
    Ok(Json(json!({
        "mesh": cfg.mesh,
        "port": cfg.port,
        "machines": machines,
        "phone": {
            "on": phone.on(),
            "server": phone.server,
            "topic": phone.topic,
            "wait_minutes": phone.wait_minutes,
            "agent_waiting": phone.agent_waiting,
            "session_ended": phone.session_ended,
            "machines": phone.machines,
            "memory": phone.memory,
            "token_set": !phone.token.is_empty(),
            "last_sent": status.last_sent,
            "last_error": status.last_error,
            "last_error_at": status.last_error_at,
        },
        "mcp_servers": cfg.mcp_servers,
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

async fn phone_setup(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    app.settings.phone_setup().map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn phone_save(
    AxState(app): AxState<Arc<AppState>>,
    Json(edit): Json<PhoneEdit>,
) -> Result<Response, ApiError> {
    app.settings.update_phone(&edit).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn phone_test(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let phone = &cfg.phone_notifications;
    if !phone.on() {
        return Err(bad("Set up phone notifications first".into()));
    }
    let host = cfg.host().map_or("Yardbell", |m| m.name.as_str());
    app.phone
        .test(&Target::from_settings(phone), host)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn phone_off(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    app.settings.phone_off().map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn mcp_on(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let token = crate::mcp::new_token();
    app.settings
        .set_mcp_token(Some(token.clone()))
        .map_err(bad)?;
    Ok(Json(json!({ "token": token })).into_response())
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

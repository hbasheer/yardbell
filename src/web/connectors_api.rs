use super::{ApiError, AppState};
use crate::connectors::client::{Client, Vars};
use crate::connectors::{client_for, host_of, map, template, templates, Connector};
use axum::extract::{Path, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/settings/connectors", get(list).post(save))
        .route("/api/settings/connectors/import", post(import))
        .route("/api/settings/connectors/{id}", delete(remove))
        .route("/api/settings/connectors/{id}/test", post(test))
        .route("/api/settings/connectors/{id}/share", get(share))
}

fn bad(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

fn secret_names(c: &Connector) -> Vec<String> {
    c.headers
        .values()
        .filter_map(|v| crate::secrets::references(v).ok())
        .flatten()
        .map(str::to_string)
        .collect()
}

fn yaml_of<T: serde::Serialize>(value: &T) -> String {
    serde_yaml::to_string(value).unwrap_or_default()
}

fn view(app: &AppState, c: &Connector) -> Value {
    let store = app.secrets().ok();
    let missing: Vec<String> = secret_names(c)
        .into_iter()
        .filter(|n| !store.as_ref().is_some_and(|s| s.contains(n)))
        .collect();
    json!({
        "id": c.id,
        "name": c.name,
        "enabled": c.enabled,
        "base_url": c.base_url,
        "host": host_of(&c.base_url),
        "allow_private": c.allow_private,
        "headers": c.headers,
        "missing": missing,
        "params_yaml": if c.params.is_empty() { String::new() } else { yaml_of(&c.params) },
        "calls_yaml": yaml_of(&c.calls),
    })
}

async fn list(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let items: Vec<Value> = cfg.connectors.iter().map(|c| view(&app, c)).collect();
    let starters: BTreeMap<&str, Value> = templates()
        .into_iter()
        .filter_map(|name| template(name).map(|c| (name, view(&app, &c))))
        .collect();
    Ok(Json(json!({
        "list": items,
        "status": app.pipelines.connector_health().all(),
        "templates": templates(),
        "starters": starters,
    }))
    .into_response())
}

#[derive(Deserialize)]
struct SaveReq {
    id: String,
    #[serde(default)]
    was: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    enabled: bool,
    base_url: String,
    #[serde(default)]
    allow_private: bool,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    params_yaml: String,
    #[serde(default)]
    calls_yaml: String,
}

fn parse_yaml<T: serde::de::DeserializeOwned + Default>(
    what: &str,
    text: &str,
) -> Result<T, String> {
    if text.trim().is_empty() {
        return Ok(T::default());
    }
    serde_yaml::from_str(text).map_err(|e| format!("the {what} cannot be read: {e}"))
}

async fn save(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<SaveReq>,
) -> Result<Response, ApiError> {
    let connector = Connector {
        name: if req.name.trim().is_empty() {
            req.id.clone()
        } else {
            req.name.trim().to_string()
        },
        id: req.id.trim().to_string(),
        enabled: req.enabled,
        base_url: req.base_url.trim().to_string(),
        allow_private: req.allow_private,
        headers: req.headers,
        params: parse_yaml("params", &req.params_yaml).map_err(bad)?,
        calls: parse_yaml("calls", &req.calls_yaml).map_err(bad)?,
    };
    let mut all = app.config()?.connectors;
    let replaced = if req.was.is_empty() {
        &connector.id
    } else {
        &req.was
    };
    match all.iter().position(|c| &c.id == replaced) {
        Some(i) => all[i] = connector,
        None => all.push(connector),
    }
    app.settings.set_connectors(all).map_err(bad)?;
    app.state.touch();
    Ok(Json(json!({ "saved": true })).into_response())
}

async fn remove(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let mut all = app.config()?.connectors;
    let before = all.len();
    all.retain(|c| c.id != id);
    if all.len() == before {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("there is no connector {id}"),
        ));
    }
    app.settings.set_connectors(all).map_err(bad)?;
    app.state.touch();
    Ok(Json(json!({ "deleted": id })).into_response())
}

#[derive(Deserialize, Default)]
struct TestReq {
    #[serde(default)]
    params: BTreeMap<String, String>,
}

fn client(app: &AppState, id: &str) -> Result<Client, ApiError> {
    let cfg = app.config()?;
    let secrets = app.secrets().map_err(|e| e.1);
    let mut list = cfg.connectors;
    // Test works before a connector is switched on, which is when it is most wanted.
    for c in &mut list {
        c.enabled = true;
    }
    client_for(&list, id, &secrets, crate::mcp_read::saved_values(app)).map_err(bad)
}

async fn test(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<TestReq>,
) -> Result<Response, ApiError> {
    let client = client(&app, &id)?;
    let call = client.call_named("list").map_err(bad)?;
    if call.kind() == crate::connectors::CallKind::Change {
        return Err(bad(
            "Test only runs a call that reads. If list only reads, add kind: lookup to it".into(),
        ));
    }
    let mut vars = Vars(req.params);
    vars.0.entry("cursor".to_string()).or_default();
    let found = client.list(&vars).await;
    let status = crate::pipeline::run::status_of(&found);
    app.pipelines.connector_health().set(&id, status);
    let listed = found.map_err(bad)?;
    let first = client.call("list", &vars).await.map_err(bad)?;
    let rows = map::path(&first, &call.items).unwrap_or(Value::Null);
    let row = rows.get(0).unwrap_or(&Value::Null);
    Ok(Json(json!({
        "paths": map::paths_of(row),
        "items": listed.items.iter().take(20).collect::<Vec<_>>(),
        "count": listed.items.len(),
        "skipped": listed.skipped,
        "cut_off": listed.cut_off,
    }))
    .into_response())
}

fn found(app: &AppState, id: &str) -> Result<Connector, ApiError> {
    app.config()?
        .connectors
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("there is no connector {id}")))
}

async fn share(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let mut c = found(&app, &id)?;
    c.enabled = true;
    c.allow_private = false;
    Ok(Json(json!({ "text": yaml_of(&c) })).into_response())
}

#[derive(Deserialize)]
struct ImportReq {
    text: String,
}

// What comes in as text is someone else's: it starts switched off, and reaching a private address
// stays a choice made here.
async fn import(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<ImportReq>,
) -> Result<Response, ApiError> {
    let mut c: Connector = serde_yaml::from_str(&req.text)
        .map_err(|e| bad(format!("that text cannot be read: {e}")))?;
    c.enabled = false;
    c.allow_private = false;
    let mut all = app.config()?.connectors;
    let wanted = c.id.clone();
    let mut n = 1;
    while all.iter().any(|o| o.id == c.id) {
        n += 1;
        c.id = format!("{wanted}-{n}");
    }
    let names = secret_names(&c);
    let host = host_of(&c.base_url);
    let id = c.id.clone();
    all.push(c);
    app.settings.set_connectors(all).map_err(bad)?;
    app.state.touch();
    Ok(Json(json!({ "id": id, "host": host, "secrets": names })).into_response())
}

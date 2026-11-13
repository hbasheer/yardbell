use super::{find_machine, ApiError, AppState};
use crate::config::Config;
use crate::projects::{id_of, Project};
use crate::state::StateView;
use axum::extract::State as AxState;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/projects", get(list))
        .route("/api/projects/add", post(add))
        .route("/api/projects/import", post(import))
        .route("/api/projects/delete", post(delete))
        .route("/api/projects/rename", post(rename))
}

pub(super) fn group(cfg: &Config, view: &StateView) -> Vec<Project> {
    let machines: Vec<&str> = cfg.machines.iter().map(|m| m.name.as_str()).collect();
    crate::projects::group(&view.sessions, &machines, &cfg.projects)
}

fn current(app: &AppState) -> Result<Vec<Project>, ApiError> {
    let cfg = app.config()?;
    let view = app.state.view(&cfg, app.ports.as_ref(), "");
    Ok(group(&cfg, &view))
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn missing() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "there is no such project".into())
}

fn saved(
    app: &AppState,
    edit: impl FnOnce(&mut Config) -> Result<(), String>,
) -> Result<(), ApiError> {
    app.settings.change(edit).map_err(bad)?;
    app.state.touch();
    Ok(())
}

async fn list(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    Ok(Json(json!({ "projects": current(&app)? })).into_response())
}

#[derive(Deserialize)]
struct AddReq {
    machine: String,
    path: String,
}

async fn add(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<AddReq>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    find_machine(&cfg, &req.machine)?;
    let path = crate::projects::valid_path(&req.path).map_err(bad)?;
    let id = id_of(&req.machine, &path);
    if cfg.projects.get(&id).is_some() {
        return Ok(Json(json!({ "result": "listed", "id": id })).into_response());
    }
    saved(&app, |cfg| {
        cfg.projects.add(&req.machine, &path);
        Ok(())
    })?;
    app.check(&req.machine).await;
    Ok(Json(json!({ "result": "added", "id": id })).into_response())
}

#[derive(Deserialize)]
struct ImportReq {
    items: Vec<AddReq>,
}

// Projects a browser kept for itself before the list lived on the server; ones that no longer
// fit (a machine since removed, a path that is not a full one) are skipped rather than refused.
async fn import(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<ImportReq>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let mut fresh = Vec::new();
    for item in req.items {
        let Ok(path) = crate::projects::valid_path(&item.path) else {
            continue;
        };
        let known = cfg.machine(&item.machine).is_some();
        let listed = cfg.projects.get(&id_of(&item.machine, &path)).is_some();
        if known && !listed && !fresh.contains(&(item.machine.clone(), path.clone())) {
            fresh.push((item.machine, path));
        }
    }
    if !fresh.is_empty() {
        let items = fresh.clone();
        saved(&app, move |cfg| {
            for (machine, path) in &items {
                cfg.projects.add(machine, path);
            }
            Ok(())
        })?;
        let mut machines: Vec<&str> = fresh.iter().map(|(m, _)| m.as_str()).collect();
        machines.dedup();
        for machine in machines {
            app.check(machine).await;
        }
    }
    Ok(Json(json!({ "added": fresh.len() })).into_response())
}

#[derive(Deserialize)]
struct IdReq {
    id: String,
}

// Only the sidebar entry goes; the folder and its files stay where they are.
async fn delete(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<IdReq>,
) -> Result<Response, ApiError> {
    if app.config()?.projects.get(&req.id).is_none() {
        return Err(missing());
    }
    saved(&app, |cfg| {
        cfg.projects.delete(&req.id);
        Ok(())
    })?;
    Ok(Json(json!({ "deleted": req.id })).into_response())
}

#[derive(Deserialize)]
struct RenameReq {
    id: String,
    name: String,
}

async fn rename(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<RenameReq>,
) -> Result<Response, ApiError> {
    if app.config()?.projects.get(&req.id).is_none() {
        return Err(missing());
    }
    saved(&app, |cfg| cfg.projects.rename(&req.id, &req.name))?;
    let name = current(&app)?
        .into_iter()
        .find(|p| p.id == req.id)
        .map(|p| p.name)
        .ok_or_else(missing)?;
    Ok(Json(json!({ "name": name })).into_response())
}

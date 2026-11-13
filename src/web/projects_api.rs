use super::{find_machine, ApiError, AppState};
use crate::config::Config;
use crate::projects::{Listing, Project};
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
        .route("/api/projects/remove", post(remove))
        .route("/api/projects/rename", post(rename))
        .route("/api/projects/show", post(show))
}

pub(super) fn group(cfg: &Config, view: &StateView) -> Listing {
    let machines: Vec<&str> = cfg.machines.iter().map(|m| m.name.as_str()).collect();
    crate::projects::group(&view.folders, &view.sessions, &machines, &cfg.projects)
}

fn current(app: &AppState) -> Result<(Config, Listing), ApiError> {
    let cfg = app.config()?;
    let view = app.state.view(&cfg, app.ports.as_ref(), "");
    let listing = group(&cfg, &view);
    Ok((cfg, listing))
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn find<'a>(listing: &'a Listing, id: &str) -> Result<&'a Project, ApiError> {
    listing
        .projects
        .iter()
        .chain(&listing.hidden)
        .find(|p| p.id == id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "there is no such project".into()))
}

fn holding<'a>(projects: &'a [Project], machine: &str, path: &str) -> Option<&'a Project> {
    projects.iter().find(|p| {
        p.checkouts
            .iter()
            .any(|c| c.machine == machine && c.path == path)
    })
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
    let (_, listing) = current(&app)?;
    Ok(Json(json!({ "projects": listing.projects, "hidden": listing.hidden })).into_response())
}

#[derive(Deserialize)]
struct AddReq {
    machine: String,
    path: String,
}

// A folder the scan already finds is not added again; if its project was hidden, it shows again.
async fn add(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<AddReq>,
) -> Result<Response, ApiError> {
    let (cfg, listing) = current(&app)?;
    find_machine(&cfg, &req.machine)?;
    let path = crate::projects::valid_path(&req.path).map_err(bad)?;
    if let Some(p) = holding(&listing.hidden, &req.machine, &path) {
        let id = p.id.clone();
        saved(&app, |cfg| {
            cfg.projects.show(&id);
            Ok(())
        })?;
        return reply(&app, &req.machine, &path, "shown");
    }
    if holding(&listing.projects, &req.machine, &path).is_some() {
        return reply(&app, &req.machine, &path, "listed");
    }
    saved(&app, |cfg| {
        cfg.projects.add(&req.machine, &path);
        Ok(())
    })?;
    app.check(&req.machine).await;
    reply(&app, &req.machine, &path, "added")
}

fn reply(app: &AppState, machine: &str, path: &str, how: &str) -> Result<Response, ApiError> {
    let (_, listing) = current(app)?;
    let project = holding(&listing.projects, machine, path);
    let folder = project
        .and_then(|p| {
            p.checkouts
                .iter()
                .find(|c| c.machine == machine && c.path == path)
        })
        .map(|c| c.folder.clone());
    Ok(Json(json!({
        "result": how,
        "project": project.map(|p| p.id.clone()),
        "machine": machine,
        "folder": folder,
    }))
    .into_response())
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
    let (cfg, listing) = current(&app)?;
    let mut fresh = Vec::new();
    for item in req.items {
        let Ok(path) = crate::projects::valid_path(&item.path) else {
            continue;
        };
        let known = cfg.machine(&item.machine).is_some();
        let listed = holding(&listing.projects, &item.machine, &path).is_some();
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

async fn remove(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<IdReq>,
) -> Result<Response, ApiError> {
    let (_, listing) = current(&app)?;
    let project = find(&listing, &req.id)?.clone();
    let mut how = None;
    saved(&app, |cfg| {
        how = Some(cfg.projects.remove(&project));
        Ok(())
    })?;
    Ok(Json(json!({ "removed": how })).into_response())
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
    let (_, listing) = current(&app)?;
    let project = find(&listing, &req.id)?;
    let name = if req.name.trim() == project.repo {
        ""
    } else {
        req.name.as_str()
    };
    saved(&app, |cfg| cfg.projects.rename(&req.id, name))?;
    let (_, listing) = current(&app)?;
    Ok(Json(json!({ "name": find(&listing, &req.id)?.name })).into_response())
}

async fn show(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<IdReq>,
) -> Result<Response, ApiError> {
    saved(&app, |cfg| {
        if cfg.projects.show(&req.id) {
            Ok(())
        } else {
            Err("that project is not hidden".into())
        }
    })?;
    Ok(Json(json!({ "shown": req.id })).into_response())
}

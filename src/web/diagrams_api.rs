use super::{asset, find_machine, start_session, ApiError, AppState, NewSession};
use crate::config::Machine;
use crate::diagrams::{self, Diagram};
use crate::pipeline::record::Subject;
use crate::shell::{login_shell, Duration};
use axum::extract::{Query, State as AxState};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const STATUS_WAIT: Duration = Duration::from_secs(15);
const LIST_WAIT: Duration = Duration::from_secs(20);
const READ_WAIT: Duration = Duration::from_secs(30);
const INSTALL_WAIT: Duration = Duration::from_secs(180);
// A diagram is built from repository text, so it is treated as hostile: the sandbox gives it an
// origin of its own with no cookies or storage, and it can load nothing and call nothing.
const LOCKED_DOWN: &str =
    "sandbox allow-scripts allow-downloads allow-popups; default-src 'none'; \
     script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; \
     base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/diagrams", get(|| async { asset("diagrams.html") }))
        .route("/diagrams.js", get(|| async { asset("diagrams.js") }))
        .route("/diagrams/view", get(view_route))
        .route("/api/diagrams", get(list_route))
        .route("/api/diagrams/install", post(install_route))
        .route("/api/diagrams/remove", post(remove_route))
        .route("/api/diagrams/draw", post(draw_route))
        .route("/api/diagrams/delete", post(delete_route))
}

fn bad(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.to_string())
}

fn folder_path(app: &AppState, machine: &str, folder: &str) -> Result<String, ApiError> {
    app.state
        .snapshot(machine)
        .and_then(|snap| snap.folder_paths.get(folder).cloned())
        .ok_or_else(|| bad(&format!("{machine} has no folder {folder}")))
}

async fn machine_entry(app: &AppState, m: Machine) -> (Value, Vec<Diagram>) {
    let folders: Vec<(String, String)> = app
        .state
        .snapshot(&m.name)
        .map(|snap| snap.folder_paths.into_iter().collect())
        .unwrap_or_default();
    let labels: Vec<&String> = folders.iter().map(|(label, _)| label).collect();
    let status = app
        .sessions
        .script(&m, &login_shell(&diagrams::status_script()), STATUS_WAIT)
        .await;
    let setup = match status {
        Ok(text) => diagrams::parse_status(&text),
        Err(problem) => {
            let entry = json!({ "name": m.name, "state": "offline", "problem": problem, "folders": labels });
            return (entry, Vec::new());
        }
    };
    let listed = app
        .sessions
        .script(&m, &diagrams::list_script(&folders), LIST_WAIT)
        .await;
    let (found, problem) = match listed {
        Ok(text) => (diagrams::parse_list(&text), String::new()),
        Err(problem) => (Vec::new(), problem),
    };
    let entry = json!({
        "name": m.name,
        "state": setup.state(),
        "node": setup.node,
        "problem": problem,
        "folders": labels,
    });
    (entry, found)
}

pub(crate) async fn overview(app: &AppState) -> Result<(Vec<Value>, Vec<Value>), ApiError> {
    let cfg = app.config()?;
    let asked = cfg.machines.iter().cloned().map(|m| machine_entry(app, m));
    let answers = futures::future::join_all(asked).await;
    let mut machines = Vec::new();
    let mut found = Vec::new();
    for ((entry, listed), m) in answers.into_iter().zip(&cfg.machines) {
        machines.push(entry);
        for d in listed {
            let mut row = json!(d);
            row["machine"] = json!(m.name);
            found.push(row);
        }
    }
    Ok((machines, found))
}

#[derive(Deserialize)]
pub(crate) struct DiagramRef {
    pub machine: String,
    pub folder: String,
    pub dir: String,
}

pub(crate) async fn source(app: &AppState, d: &DiagramRef) -> Result<String, ApiError> {
    if !diagrams::safe_name(&d.dir) {
        return Err(bad("that is not a diagram"));
    }
    let cfg = app.config()?;
    let m = find_machine(&cfg, &d.machine)?;
    let path = folder_path(app, &m.name, &d.folder)?;
    let text = app
        .sessions
        .script(&m, &diagrams::source_script(&path, &d.dir), READ_WAIT)
        .await
        .map_err(ApiError::gateway)?;
    Ok(crate::mcp_read::scrubbed(
        &text,
        &crate::mcp_read::saved_values(app),
    ))
}

pub(crate) async fn subject(app: &AppState, d: &DiagramRef) -> Result<Subject, ApiError> {
    let text = source(app, d).await?;
    Ok(Subject {
        ticket: Some(diagrams::work_item(&d.machine, &d.folder, &d.dir, &text)),
        pr: None,
    })
}

async fn list_route(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let (machines, found) = overview(&app).await?;
    let agents: Vec<Value> = cfg
        .agents()
        .iter()
        .map(|a| json!({ "name": a.name, "label": a.display() }))
        .collect();
    Ok(Json(json!({
        "version": diagrams::ARCHIFY_VERSION,
        "machines": machines,
        "diagrams": found,
        "agents": agents,
        "default_agent": cfg.default_agent(),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct ViewQuery {
    machine: String,
    folder: String,
    dir: String,
    file: String,
}

async fn view_route(
    AxState(app): AxState<Arc<AppState>>,
    Query(q): Query<ViewQuery>,
) -> Result<Response, ApiError> {
    if !diagrams::safe_name(&q.dir) || !diagrams::safe_name(&q.file) || !q.file.ends_with(".html") {
        return Err(bad("that is not a diagram"));
    }
    let cfg = app.config()?;
    let m = find_machine(&cfg, &q.machine)?;
    let path = folder_path(&app, &m.name, &q.folder)?;
    let page = app
        .sessions
        .script(
            &m,
            &diagrams::read_script(&path, &q.dir, &q.file),
            READ_WAIT,
        )
        .await
        .map_err(ApiError::gateway)?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CONTENT_SECURITY_POLICY, LOCKED_DOWN),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        page,
    )
        .into_response())
}

#[derive(Deserialize)]
struct OnMachine {
    machine: String,
}

async fn install_route(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<OnMachine>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &req.machine)?;
    app.sessions
        .script(&m, &login_shell(&diagrams::install_script()), INSTALL_WAIT)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn remove_route(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<OnMachine>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &req.machine)?;
    app.sessions
        .script(&m, &diagrams::remove_script(), STATUS_WAIT)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct Draw {
    pub machine: String,
    pub folder: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub focus: String,
}

async fn draw_route(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<Draw>,
) -> Result<Response, ApiError> {
    Ok(Json(draw(&app, req).await?).into_response())
}

// The mistakes worth catching before a person is asked to approve the step.
pub(crate) fn check_draw(app: &AppState, req: &Draw) -> Result<(), ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &req.machine)?;
    folder_path(app, &m.name, &req.folder)?;
    if !req.agent.is_empty() && cfg.agent(&req.agent).is_none() {
        return Err(bad(&format!("no agent named {}", req.agent)));
    }
    Ok(())
}

pub(crate) async fn draw(app: &AppState, req: Draw) -> Result<Value, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &req.machine)?;
    let path = folder_path(app, &m.name, &req.folder)?;
    let status = app
        .sessions
        .script(&m, &login_shell(&diagrams::status_script()), STATUS_WAIT)
        .await
        .map_err(ApiError::gateway)?;
    match diagrams::parse_status(&status).state() {
        "installed" => {}
        "needs_node" => {
            return Err(bad(&format!(
                "{} needs Node 18 or later for Archify",
                m.name
            )))
        }
        _ => return Err(bad(&format!("Install Archify on {} first", m.name))),
    }
    if let Err(problem) = app
        .sessions
        .script(&m, &diagrams::exclude_script(&path), STATUS_WAIT)
        .await
    {
        tracing::warn!(machine = %m.name, %problem, "could not keep .archify out of git");
    }
    let session: NewSession = serde_json::from_value(json!({
        "machine": m.name,
        "folder": req.folder,
        "agent": req.agent,
        "prompt": diagrams::draw_prompt(&req.focus),
        "name_tag": "diagram",
    }))
    .map_err(|e| bad(&e.to_string()))?;
    let started = start_session(app, session).await?;
    app.recheck(&m.name);
    Ok(started)
}

#[derive(Deserialize)]
struct DeleteDiagram {
    machine: String,
    folder: String,
    dir: String,
}

async fn delete_route(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<DeleteDiagram>,
) -> Result<Response, ApiError> {
    if !diagrams::safe_name(&req.dir) {
        return Err(bad("that is not a diagram"));
    }
    let cfg = app.config()?;
    let m = find_machine(&cfg, &req.machine)?;
    let path = folder_path(&app, &m.name, &req.folder)?;
    app.sessions
        .script(&m, &diagrams::delete_script(&path, &req.dir), STATUS_WAIT)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

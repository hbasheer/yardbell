use super::{ApiError, AppState};
use crate::config::Config;
use crate::triggers::{Launch, Trigger};
use axum::extract::State as AxState;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/triggers", get(show).post(save))
        .route("/api/triggers/run", post(run))
        .route("/api/triggers/enable", post(enable))
}

fn bad(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

fn launch<'a>(app: &'a AppState, cfg: &'a Config) -> Launch<'a> {
    Launch::new(cfg, app.secrets().map_err(|e| e.1), &app.dispatch).with_pipeline(&app.pipeline)
}

fn view(app: &AppState, cfg: &Config) -> Value {
    let tasks: Vec<String> = app
        .dispatch
        .tasks()
        .into_iter()
        .filter(|t| !t.hidden)
        .map(|t| t.name)
        .collect();
    json!({
        "zone": crate::triggers::zone(),
        "now": chrono::Local::now().to_rfc3339(),
        "triggers": app.triggers.view(cfg, &launch(app, cfg), chrono::Local::now()),
        "tasks": tasks,
    })
}

async fn show(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    Ok(Json(view(&app, &cfg)).into_response())
}

#[derive(Deserialize)]
struct SaveReq {
    triggers: Vec<Trigger>,
}

async fn save(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<SaveReq>,
) -> Result<Response, ApiError> {
    let tasks = app.dispatch.tasks();
    let triggers: Vec<Trigger> = req
        .triggers
        .into_iter()
        .map(|t| Trigger {
            name: t.name.trim().to_string(),
            schedule: t.schedule.split_whitespace().collect::<Vec<_>>().join(" "),
            linear: t.linear.map(|mut w| {
                w.states = w
                    .states
                    .iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                w
            }),
            ..t
        })
        .collect();
    let before = app.config()?.triggers;
    for t in &triggers {
        let kept = before.iter().any(|b| b.name == t.name && b.task == t.task);
        if !t.pipeline() && !kept && !tasks.iter().any(|task| task.name == t.task && !task.hidden) {
            return Err(bad(format!(
                "the trigger {} runs the task {}, which is not one of your tasks in Dispatch",
                t.name, t.task
            )));
        }
    }
    app.settings.set_triggers(triggers).map_err(bad)?;
    let cfg = app.config()?;
    Ok(Json(view(&app, &cfg)).into_response())
}

#[derive(Deserialize)]
struct NameReq {
    name: String,
    #[serde(default)]
    enabled: bool,
}

async fn run(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<NameReq>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let out = app
        .triggers
        .run_now(&cfg, &req.name, &launch(&app, &cfg), chrono::Local::now())
        .await
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    app.state.touch();
    Ok(Json(out).into_response())
}

async fn enable(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<NameReq>,
) -> Result<Response, ApiError> {
    app.settings
        .set_trigger_enabled(&req.name, req.enabled)
        .map_err(bad)?;
    let cfg = app.config()?;
    Ok(Json(view(&app, &cfg)).into_response())
}

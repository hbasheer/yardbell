use super::{ApiError, AppState};
use crate::pipeline::record::{Record, Stage, Ticket};
use crate::triggers::LINEAR_SECRET;
use axum::extract::{Path, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/pipeline", get(show))
        .route("/api/pipeline/tickets", get(tickets))
        .route("/api/pipeline/runs", post(start))
        .route("/api/pipeline/tickets/{id}/answer", post(answer))
        .route("/api/pipeline/tickets/{id}/retry", post(retry))
        .route("/api/pipeline/tickets/{id}/drop", post(drop_ticket))
}

fn bad(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

fn runs(records: &[Record]) -> Vec<Value> {
    let mut by_run: BTreeMap<&str, Vec<&Record>> = BTreeMap::new();
    for r in records {
        by_run.entry(r.run.as_str()).or_default().push(r);
    }
    by_run
        .into_iter()
        .rev()
        .map(|(run, rs)| {
            let count = |s: Stage| rs.iter().filter(|r| r.stage == s).count();
            json!({
                "run": run,
                "started_by": rs[0].started_by,
                "done": count(Stage::Done),
                "parked": count(Stage::Parked),
                "failed": count(Stage::Failed),
                "dropped": count(Stage::Dropped),
                "active": rs.iter().filter(|r| r.stage.active() && r.stage != Stage::Parked).count(),
            })
        })
        .collect()
}

async fn show(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let mut records = app.pipeline.records();
    records.sort_by(|a, b| b.run.cmp(&a.run).then_with(|| a.id.cmp(&b.id)));
    Ok(Json(json!({
        "enabled": cfg.pipeline.is_some(),
        "test_machine": cfg.pipeline.as_ref().map(|p| p.test_machine.clone()),
        "runs": runs(&records),
        "records": records,
    }))
    .into_response())
}

async fn open(app: &AppState) -> Result<Vec<Ticket>, ApiError> {
    let secrets = app.secrets()?;
    let key = secrets.get(LINEAR_SECRET).ok_or_else(|| {
        bad(format!(
            "the secret {LINEAR_SECRET} is not set. Add your Linear API key under Settings, MCP servers, Secrets"
        ))
    })?;
    app.pipeline
        .linear()
        .open(key)
        .await
        .map_err(ApiError::gateway)
}

fn running(app: &AppState, id: &str) -> bool {
    app.pipeline.get(id).is_some_and(|r| r.stage.active())
}

async fn tickets(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let tickets: Vec<Value> = open(&app)
        .await?
        .into_iter()
        .map(|t| {
            let mut v = json!(t);
            v["running"] = json!(running(&app, &t.id));
            v
        })
        .collect();
    Ok(Json(json!({ "tickets": tickets })).into_response())
}

#[derive(Deserialize)]
struct StartReq {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    state: String,
}

async fn start(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<StartReq>,
) -> Result<Response, ApiError> {
    let all = open(&app).await?;
    let picked: Vec<Ticket> = if req.ids.is_empty() {
        let state = req.state.trim();
        if state.is_empty() {
            return Err(bad("pick the tickets to run, or a state".into()));
        }
        let picked: Vec<Ticket> = all
            .into_iter()
            .filter(|t| t.state.eq_ignore_ascii_case(state) && !running(&app, &t.id))
            .collect();
        if picked.is_empty() {
            return Err(bad(format!(
                "no open ticket of yours in {state} is waiting to run"
            )));
        }
        picked
    } else {
        let mut picked = Vec::new();
        for id in &req.ids {
            let t = all
                .iter()
                .find(|t| &t.id == id)
                .ok_or_else(|| bad(format!("{id} is not one of your open tickets in Linear")))?;
            picked.push(t.clone());
        }
        picked
    };
    let records = app
        .pipeline
        .add(&picked, "you")
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    app.state.touch();
    Ok(Json(json!({ "records": records })).into_response())
}

fn person(app: &AppState, out: Result<Record, String>) -> Result<Response, ApiError> {
    let r = out.map_err(|e| {
        let status = if e.ends_with("is not in the pipeline") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        ApiError(status, e)
    })?;
    app.state.touch();
    Ok(Json(json!(r)).into_response())
}

#[derive(Deserialize)]
struct AnswerReq {
    text: String,
}

async fn answer(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<AnswerReq>,
) -> Result<Response, ApiError> {
    person(&app, app.pipeline.answer(&id, &req.text))
}

async fn retry(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    person(&app, app.pipeline.retry(&id))
}

async fn drop_ticket(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    person(&app, app.pipeline.drop_ticket(&id))
}

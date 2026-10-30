use super::{detached, refused, ApiError, AppState, Decision};
use axum::extract::{Path, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/proposals", get(list))
        .route("/api/proposals/clear", post(clear))
        .route("/api/proposals/{id}", get(show).post(decide).delete(delete))
}

fn missing() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "there is no such proposal".into())
}

// Opening the list counts as seeing what waits, so the next proposal tells the phone at once.
async fn list(AxState(app): AxState<Arc<AppState>>) -> Response {
    app.proposals.seen();
    Json(json!({ "proposals": app.proposals.list(), "waiting": app.proposals.waiting() }))
        .into_response()
}

async fn show(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    Ok(Json(app.proposals.get(&id).ok_or_else(missing)?).into_response())
}

// Deleting a proposal that still waits discards it; nothing it asked for runs.
async fn delete(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    app.proposals.delete(&id).map_err(refused)?;
    app.state.touch();
    Ok(Json(json!({ "deleted": id })).into_response())
}

async fn clear(AxState(app): AxState<Arc<AppState>>) -> Response {
    let cleared = app.proposals.clear_decided();
    app.state.touch();
    Json(json!({ "cleared": cleared })).into_response()
}

async fn decide(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<Decision>,
) -> Result<Response, ApiError> {
    let now = chrono::Local::now();
    let decided = match req.decision.as_str() {
        "reject" => app.proposals.reject(&id, now).map_err(refused)?,
        "approve" => {
            let proposal = app.proposals.get(&id).ok_or_else(missing)?;
            if let Some(input) = &req.input {
                let tool = proposal["tool"].as_str().unwrap_or_default();
                crate::mcp::check(&app, &app.config()?, tool, input)?;
            }
            let (tool, input) = app
                .proposals
                .approve(&id, req.input.clone(), now)
                .map_err(refused)?;
            let app = app.clone();
            detached(async move {
                let outcome = crate::mcp::perform(&app, &tool, input)
                    .await
                    .map_err(|ApiError(_, message)| message);
                app.proposals.ran(&id, &outcome).map_err(refused)
            })
            .await?
        }
        _ => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "decision must be approve or reject".into(),
            ))
        }
    };
    app.state.touch();
    Ok(Json(decided).into_response())
}

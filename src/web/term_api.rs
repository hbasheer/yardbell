use super::{find_machine, ApiError, AppState};
use crate::dispatch::attachments::clean as clean_name;
use crate::dispatch::AttachmentKind;
use crate::snapshot::Activity;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Query, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub const UPLOAD_MAX: usize = 10 * 1024 * 1024;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/sessions/{machine}/{name}/agent",
            get(agent_state).post(agent_recheck),
        )
        .route(
            "/sessions/{machine}/{name}/upload",
            // A little over the cap, so a file just over it gets a reply that says so.
            post(upload).layer(DefaultBodyLimit::max(UPLOAD_MAX + 1024)),
        )
}

// What the phone's agent keys need: which agent, what its screen says it is doing, and the
// choices it offers when it waits. The screen's fingerprint tells a page whether the state was
// read again since a key was pressed.
async fn agent_state(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, name)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    let snap = app.state.snapshot(&m.name).unwrap_or_default();
    let Some(s) = snap
        .sessions
        .iter()
        .find(|s| s.tmux.as_deref() == Some(name.as_str()))
    else {
        return Ok(Json(json!({ "agent": null, "state": "unknown" })).into_response());
    };
    let id = s.id();
    let prompt = snap.prompts.get(&id);
    let state = match (s.activity, prompt) {
        (Activity::Active, _) => "working",
        (Activity::Idle, _) => "idle",
        (Activity::Blocked, Some(p)) => match p.kind {
            crate::detect::PromptKind::Permission => "permission",
            crate::detect::PromptKind::Question => "question",
        },
        (Activity::Blocked, None) => "blocked",
    };
    Ok(Json(json!({
        "agent": s.agent,
        "state": state,
        "choices": prompt.map(|p| p.choices.clone()).unwrap_or_default(),
        "screen": snap.screens.get(&id),
    }))
    .into_response())
}

async fn agent_recheck(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, _name)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    app.recheck(&m.name);
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(default)]
    name: String,
}

fn too_big() -> ApiError {
    ApiError(
        StatusCode::PAYLOAD_TOO_LARGE,
        format!("the file is over {} MB", UPLOAD_MAX / 1024 / 1024),
    )
}

pub fn upload_kind(bytes: &[u8]) -> Result<AttachmentKind, ApiError> {
    if bytes.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "the file is empty".into(),
        ));
    }
    if bytes.len() > UPLOAD_MAX {
        return Err(too_big());
    }
    AttachmentKind::of(bytes).ok_or_else(|| {
        ApiError(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "only images, PDFs and text files can be attached".into(),
        )
    })
}

// The file goes to the session's own machine, into a folder of the session's name under
// /tmp/yardbell-uploads, so an agent there can read it by its path.
async fn upload(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, name)): UrlPath<(String, String)>,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    let known = app
        .state
        .snapshot(&m.name)
        .unwrap_or_default()
        .sessions
        .iter()
        .any(|s| s.tmux.as_deref() == Some(name.as_str()));
    if !known {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("{name} is not a session Yardbell knows on {}", m.name),
        ));
    }
    let kind = upload_kind(&body)?;
    let file = clean_name(&q.name);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&body);
    let path = app
        .sessions
        .upload(&m, &clean_name(&name), &file, encoded)
        .await
        .map_err(|e| ApiError::gateway(format!("could not put the file on {}: {e}", m.name)))?;
    Ok(Json(json!({
        "path": path,
        "kind": kind.group(),
        "bytes": body.len(),
    }))
    .into_response())
}

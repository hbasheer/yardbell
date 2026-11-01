use super::{card_of, conversation_id, find_machine, ApiError, AppState};
use crate::dispatch::{
    pin_standing, read_pin, review_file, review_files, valid_review_path, ReviewAnchor, ReviewPin,
};
use axum::extract::{Path as UrlPath, Query, State as AxState};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/dispatch/conversations/{id}/reviews/{card}/diff",
            get(diff),
        )
        .route(
            "/dispatch/conversations/{id}/reviews/{card}/evidence/{file}",
            get(evidence),
        )
        .route(
            "/dispatch/conversations/{id}/reviews/{card}/commit",
            get(commit),
        )
}

// Where the code stands now against what the review read, read on the session's machine.
async fn commit(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((id, card)): UrlPath<(String, usize)>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    let review = card_of(&app, id, card, "review")?;
    let of = &review["of"];
    let read: ReviewPin = serde_json::from_value(of["pin"].clone()).map_err(|_| {
        ApiError(
            StatusCode::NOT_FOUND,
            "this review does not say which commit it read".into(),
        )
    })?;
    let cfg = app.config()?;
    let m = find_machine(&cfg, of["machine"].as_str().unwrap_or_default())?;
    let now = read_pin(&app.folders, &m, of["path"].as_str().unwrap_or_default()).await;
    let standing = pin_standing(&read, &now);
    Ok(Json(json!({ "standing": standing, "now": now })).into_response())
}

#[derive(Deserialize)]
struct DiffQuery {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    from: usize,
    #[serde(default)]
    line: Option<u64>,
}

fn not_in_diff(file: &str) -> ApiError {
    ApiError(
        StatusCode::NOT_FOUND,
        format!("{file} is not in this review's changes"),
    )
}

// The reviewed branch against the base its review started from, read from the folder as it is
// now. Without a file it lists the changed files; with one it gives a page of that file's diff.
async fn diff(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((id, card)): UrlPath<(String, usize)>,
    Query(q): Query<DiffQuery>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    let review = card_of(&app, id, card, "review")?;
    if let Some(file) = q.file.as_deref().filter(|f| !valid_review_path(f)) {
        return Err(not_in_diff(file));
    }
    let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let path = Some(text(&review["of"]["path"]))
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| text(&review["path"]));
    if path.is_empty() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "this review does not say which folder it read".into(),
        ));
    }
    let cfg = app.config()?;
    let m = find_machine(&cfg, &text(&review["machine"]))?;
    let anchor: Option<ReviewAnchor> = serde_json::from_value(review["diff"].clone()).ok();
    let listing = review_files(
        &app.folders,
        &m,
        &path,
        anchor.as_ref(),
        &text(&review["base"]),
    )
    .await
    .map_err(ApiError::gateway)?;
    let Some(file) = q.file else {
        let reviewed = anchor.map(|a| a.head);
        let moved = reviewed.as_ref().is_some_and(|h| *h != listing.head);
        let mut body = json!(listing);
        body["reviewed_head"] = json!(reviewed);
        body["moved"] = json!(moved);
        return Ok(Json(body).into_response());
    };
    if !listing.files.iter().any(|f| f.path == file) {
        return Err(not_in_diff(&file));
    }
    let page = review_file(&app.folders, &m, &path, &listing, &file, q.from, q.line)
        .await
        .map_err(ApiError::gateway)?;
    Ok(Json(page).into_response())
}

async fn evidence(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((id, card, file)): UrlPath<(String, usize, String)>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    let bytes = app
        .dispatch
        .evidence(id, card, &file)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no such screenshot".into()))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_SECURITY_POLICY, "default-src 'none'"),
        ],
        bytes,
    )
        .into_response())
}

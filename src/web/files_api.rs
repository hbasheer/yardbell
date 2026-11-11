use super::{find_machine, ApiError, AppState};
use crate::config::Machine;
use crate::files::{check_relative, check_root, within, FileError};
use crate::history;
use axum::extract::{Path as UrlPath, Query, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/machines/{machine}/files", get(list))
        .route("/machines/{machine}/file", get(read))
        .route("/machines/{machine}/files/search", get(search))
        .route("/machines/{machine}/history", get(past_sessions))
}

#[derive(Deserialize)]
struct FilesQuery {
    #[serde(default)]
    root: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    q: String,
    #[serde(default)]
    mode: String,
}

pub(super) fn refused(e: FileError, path: &str) -> ApiError {
    let status = match e {
        FileError::Refused(_) | FileError::Outside => StatusCode::BAD_REQUEST,
        FileError::Missing => StatusCode::NOT_FOUND,
        FileError::NotFolder | FileError::NotFile | FileError::NotRepo => {
            StatusCode::UNPROCESSABLE_ENTITY
        }
        FileError::Binary => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        FileError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
        FileError::Failed(_) => StatusCode::BAD_GATEWAY,
    };
    ApiError(status, e.message(path))
}

// A folder a session runs in, or one the last check found, is known; anything else must lie
// under the machine's root, which the machine itself checks once links are followed.
pub(super) fn known(app: &AppState, m: &Machine, root: &str) -> bool {
    let snap = app.state.snapshot(&m.name).unwrap_or_default();
    snap.folder_paths
        .values()
        .chain(snap.sessions.iter().map(|s| &s.cwd))
        .any(|k| within(root, k))
}

fn place(q: &FilesQuery) -> Result<String, ApiError> {
    check_root(&q.root).map_err(|e| refused(e, ""))?;
    check_relative(&q.path).map_err(|e| refused(e, &q.path))
}

async fn list(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Query(q): Query<FilesQuery>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    let path = place(&q)?;
    let listing = app
        .folders
        .list_files(&m, &q.root, &path, known(&app, &m, &q.root))
        .await
        .map_err(|e| refused(e, &path))?;
    Ok(Json(listing).into_response())
}

async fn read(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Query(q): Query<FilesQuery>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    let path = place(&q)?;
    if path.is_empty() {
        return Err(refused(FileError::NotFile, "that folder"));
    }
    let file = app
        .folders
        .read_file(&m, &q.root, &path, known(&app, &m, &q.root))
        .await
        .map_err(|e| refused(e, &path))?;
    Ok(Json(file).into_response())
}

async fn search(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Query(q): Query<FilesQuery>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    place(&q)?;
    let query = q.q.trim();
    if query.is_empty() || query.contains(['\0', '\n', '\r']) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "give something to search for".into(),
        ));
    }
    let contents = q.mode == "contents";
    let found = app
        .folders
        .search_files(&m, &q.root, query, contents, known(&app, &m, &q.root))
        .await
        .map_err(|e| refused(e, ""))?;
    Ok(Json(found).into_response())
}

#[derive(Deserialize)]
struct HistoryQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    scope: String,
}

async fn past_sessions(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Query(q): Query<HistoryQuery>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    let all = q.scope == "all";
    if !all {
        check_root(&q.path).map_err(|e| refused(e, ""))?;
    }
    let cmd = history::command((!all).then_some(q.path.as_str()));
    let text = app
        .sessions
        .script(&m, &cmd, history::WAIT)
        .await
        .map_err(|e| {
            ApiError::gateway(format!(
                "could not read Claude Code's history on {}: {e}",
                m.name
            ))
        })?;
    let read = history::parse(&text);
    Ok(Json(json!({
        "machine": m.name,
        "scope": if all { "all" } else { "folder" },
        "path": if all { "" } else { q.path.as_str() },
        "sessions": read.sessions,
        "scanned": read.scanned,
        "cut": read.cut,
    }))
    .into_response())
}

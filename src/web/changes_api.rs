use super::files_api::{known, refused};
use super::{find_machine, ApiError, AppState};
use crate::changes::{draft, Changes};
use crate::config::Machine;
use crate::dispatch::valid_review_path;
use crate::files::{check_relative, check_root, FileError};
use axum::extract::{Path as UrlPath, Query, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

const MESSAGE_MAX: usize = 64 * 1024;
const PATHS_MAX: usize = 500;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/machines/{machine}/changes", get(list))
        .route("/machines/{machine}/changes/diff", get(diff))
        .route("/machines/{machine}/changes/draft", get(draft_message))
        .route("/machines/{machine}/changes/commit", post(commit))
}

#[derive(Deserialize)]
struct ChangesQuery {
    #[serde(default)]
    root: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    staged: bool,
    #[serde(default)]
    context: Option<u32>,
    #[serde(default)]
    from: usize,
}

async fn changes_of(app: &AppState, m: &Machine, root: &str) -> Result<(Changes, bool), ApiError> {
    check_root(root).map_err(|e| refused(e, ""))?;
    let known = known(app, m, root);
    let changes = app
        .folders
        .changes(m, root, known)
        .await
        .map_err(|e| refused(e, ""))?;
    Ok((changes, known))
}

fn relative(path: &str) -> Result<String, ApiError> {
    let path = check_relative(path).map_err(|e| refused(e, path))?;
    if !valid_review_path(&path) {
        return Err(refused(
            FileError::Refused("that path is not allowed".into()),
            &path,
        ));
    }
    Ok(path)
}

async fn list(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Query(q): Query<ChangesQuery>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    let (changes, _) = changes_of(&app, &m, &q.root).await?;
    Ok(Json(changes).into_response())
}

async fn diff(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Query(q): Query<ChangesQuery>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    check_root(&q.root).map_err(|e| refused(e, ""))?;
    let path = relative(&q.path)?;
    let (changes, known) = changes_of(&app, &m, &q.root).await?;
    let change = changes.find(&path, q.staged).ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            format!(
                "{path} has no {} changes to show",
                if q.staged { "staged" } else { "unstaged" }
            ),
        )
    })?;
    let diff = app
        .folders
        .change_diff(&m, &q.root, known, change, q.context.unwrap_or(3), q.from)
        .await
        .map_err(|e| refused(e, &path))?;
    Ok(Json(diff).into_response())
}

async fn draft_message(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Query(q): Query<ChangesQuery>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    let (changes, _) = changes_of(&app, &m, &q.root).await?;
    if changes.files.is_empty() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "there are no changes to describe".into(),
        ));
    }
    Ok(Json(json!({ "message": draft(&changes.files), "from": "files" })).into_response())
}

#[derive(Deserialize)]
struct CommitInput {
    #[serde(default)]
    root: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    paths: Option<Vec<String>>,
}

async fn commit(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Json(req): Json<CommitInput>,
) -> Result<Response, ApiError> {
    let m = find_machine(&app.config()?, &machine)?;
    check_root(&req.root).map_err(|e| refused(e, ""))?;
    if req.message.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "write a commit message first".into(),
        ));
    }
    if req.message.len() > MESSAGE_MAX || req.message.contains('\0') {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "that commit message is too long or has a NUL in it".into(),
        ));
    }
    let wanted = match &req.paths {
        Some(paths) if paths.is_empty() => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "pick at least one file to commit".into(),
            ))
        }
        Some(paths) if paths.len() > PATHS_MAX => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                format!("commit at most {PATHS_MAX} files at a time"),
            ))
        }
        Some(paths) => paths
            .iter()
            .map(|p| relative(p))
            .collect::<Result<Vec<_>, _>>()?,
        None => Vec::new(),
    };
    let (changes, known) = changes_of(&app, &m, &req.root).await?;
    if changes.files.is_empty() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "there is nothing to commit".into(),
        ));
    }
    let mut paths: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    for want in &wanted {
        let found: Vec<_> = changes.files.iter().filter(|f| &f.path == want).collect();
        if found.is_empty() {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                format!("{want} has no changes to commit"),
            ));
        }
        for f in found {
            if f.status == "untracked" && !untracked.contains(&f.path) {
                untracked.push(f.path.clone());
            }
            for p in [Some(&f.path), f.old_path.as_ref()].into_iter().flatten() {
                if !paths.contains(p) {
                    paths.push(p.clone());
                }
            }
        }
    }
    let sha = app
        .folders
        .commit(&m, &req.root, known, &paths, &untracked, &req.message)
        .await
        .map_err(|e| match e {
            FileError::Failed(why) => ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("git did not commit: {why}"),
            ),
            e => refused(e, ""),
        })?;
    app.recheck(&m.name);
    Ok(Json(json!({ "sha": sha, "short": &sha[..sha.len().min(7)] })).into_response())
}

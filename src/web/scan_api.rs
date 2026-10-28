use super::{asset, card_of, conversation_id, detached, find_machine, refused, ApiError, AppState};
use crate::dispatch::{file_view, finding_files, valid_review_path, By, ScanKind};
use crate::mcp::{scan_plan, ScanTarget};
use axum::extract::{Path as UrlPath, Query, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/dispatch-scan.js",
            get(|| async { asset("dispatch-scan.js") }),
        )
        .route("/dispatch/scans", post(request))
        .route(
            "/dispatch/conversations/{id}/reviews/{card}/files",
            get(files),
        )
        .route(
            "/dispatch/conversations/{id}/reviews/{card}/sessions",
            get(sessions),
        )
}

fn bad(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

#[derive(Deserialize)]
struct ScanRequest {
    #[serde(default)]
    conversation: Option<String>,
    #[serde(default)]
    card: Option<usize>,
    #[serde(default)]
    machine: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    inside: String,
    // A checkout of the folder's repository, such as one of its worktrees, to scan instead of
    // the folder itself, and the branch it has out.
    #[serde(default)]
    path: String,
    #[serde(default)]
    branch: String,
    kind: String,
}

// Scan on a session card scans that session's folder, and a scan of a folder picked in Dispatch
// can narrow it to a folder inside. Either waits for the person to start it, like Review branch,
// in the open conversation or a new one named after the scan.
async fn request(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<ScanRequest>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let open = req
        .conversation
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(conversation_id)
        .transpose()?;
    let (machine, folder, path, session, named) = match req.card {
        Some(index) => {
            let id = open.ok_or_else(|| bad("a session card belongs to a conversation"))?;
            let card = card_of(&app, id, index, "session")?;
            let path = text(&card["path"]);
            if path.is_empty() {
                return Err(bad("this session card does not say which folder it is in"));
            }
            let named = last_parts(&path);
            (
                text(&card["machine"]),
                String::new(),
                path,
                text(&card["name"]),
                named,
            )
        }
        None => {
            let inside = req.inside.trim().trim_matches('/');
            let folder = req.folder.trim().to_string();
            let checkout = req.path.trim().trim_end_matches('/');
            if !inside.is_empty() && !valid_review_path(inside) {
                return Err(bad(
                    "the folder inside must be a relative path without . or .. parts",
                ));
            }
            if !checkout.is_empty() {
                let path = match inside {
                    "" => checkout.to_string(),
                    inside => format!("{checkout}/{inside}"),
                };
                let named = match inside {
                    "" => last_parts(checkout),
                    inside => format!("{}/{inside}", last_parts(checkout)),
                };
                (
                    req.machine.clone(),
                    String::new(),
                    path,
                    String::new(),
                    named,
                )
            } else if inside.is_empty() {
                let named = folder.clone();
                (
                    req.machine.clone(),
                    folder,
                    String::new(),
                    String::new(),
                    named,
                )
            } else {
                let m = find_machine(&cfg, &req.machine)?;
                let snap = app.state.snapshot(&m.name).unwrap_or_default();
                let top = snap.folder_paths.get(&folder).ok_or_else(|| {
                    ApiError(
                        StatusCode::BAD_REQUEST,
                        format!("{} has no folder {folder}", m.name),
                    )
                })?;
                let path = format!("{top}/{inside}");
                (
                    m.name,
                    String::new(),
                    path,
                    String::new(),
                    format!("{folder}/{inside}"),
                )
            }
        }
    };
    let target = ScanTarget {
        machine: &machine,
        folder: &folder,
        path: &path,
        session: &session,
    };
    let (input, mut of) = scan_plan(&app, &cfg, &target, &req.kind, "", "")?;
    if of.branch.is_empty() && req.card.is_none() {
        of.branch = req.branch.trim().to_string();
    }
    let id = match open {
        Some(id) => id.to_string(),
        None => {
            let kind = of.scan_kind().map_or("scan", ScanKind::name);
            let mut title = format!("{kind} of {named}");
            title[..1].make_ascii_uppercase();
            app.dispatch.open_conversation(&title)
        }
    };
    let step = app
        .dispatch
        .propose(&id, "start_session", input, By::You, Some(of), None)
        .map_err(refused)?;
    Ok(Json(json!({ "conversation": id, "step": step })).into_response())
}

fn last_parts(path: &str) -> String {
    let parts: Vec<&str> = path.trim_end_matches('/').rsplit('/').take(2).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

fn scan_card(app: &AppState, id: &str, card: usize) -> Result<Value, ApiError> {
    let scan = card_of(app, id, card, "review")?;
    if ScanKind::parse(scan["of"]["scan"].as_str().unwrap_or_default()).is_none() {
        return Err(ApiError(StatusCode::NOT_FOUND, "no such scan card".into()));
    }
    Ok(scan)
}

fn scanned(card: &Value) -> String {
    Some(text(&card["of"]["path"]))
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| text(&card["path"]))
}

#[derive(Deserialize)]
struct FileQuery {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    from: usize,
    #[serde(default)]
    line: Option<u64>,
}

// The files a scan's findings point at, read as they are now. Without a file it lists them; with
// one it gives a page of it. A scan has no branch diff to show instead.
async fn files(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((id, card)): UrlPath<(String, usize)>,
    Query(q): Query<FileQuery>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    let scan = scan_card(&app, id, card)?;
    let listed = finding_files(&scan);
    let Some(file) = q.file else {
        return Ok(Json(json!({ "folder": scanned(&scan), "files": listed })).into_response());
    };
    if !valid_review_path(&file) || !listed.contains(&file) {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("no finding points at {file}"),
        ));
    }
    let folder = scanned(&scan);
    if folder.is_empty() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "this scan does not say which folder it read".into(),
        ));
    }
    let cfg = app.config()?;
    let m = find_machine(&cfg, &text(&scan["machine"]))?;
    let page = file_view(&app.folders, &m, &folder, &scan, &file, q.from, q.line)
        .await
        .map_err(|e| {
            if e.starts_with("no finding points at") || e.contains("scanned folder") {
                ApiError(StatusCode::NOT_FOUND, e)
            } else {
                ApiError::gateway(e)
            }
        })?;
    Ok(Json(page).into_response())
}

fn related(a: &str, b: &str) -> bool {
    !a.is_empty()
        && !b.is_empty()
        && (a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/")))
}

// The sessions a scan's findings can go to: those working in the scanned folder, in a folder
// inside it, or in the checkout around it, apart from the scanner itself.
pub(super) fn targets(app: &AppState, scan: &Value) -> Vec<Value> {
    let machine = text(&scan["machine"]);
    let folder = scanned(scan);
    let scanner = text(&scan["name"]);
    let snap = app.state.snapshot(&machine).unwrap_or_default();
    snap.sessions
        .iter()
        .filter(|s| related(&s.cwd, &folder))
        .filter_map(|s| {
            let name = s.tmux.as_deref().filter(|n| *n != scanner)?;
            Some(json!({
                "machine": machine,
                "name": name,
                "agent": s.agent,
                "branch": s.branch,
                "path": s.cwd,
            }))
        })
        .collect()
}

async fn sessions(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((id, card)): UrlPath<(String, usize)>,
) -> Result<Response, ApiError> {
    let id = conversation_id(&id)?;
    let scan = scan_card(&app, id, card)?;
    Ok(
        Json(json!({ "sessions": targets(&app, &scan), "from": scan["of"]["name"] }))
            .into_response(),
    )
}

// Send on a scan card types the picked findings into a session in the scanned folder; Start a
// session prepares a new one there with them as its task, waiting for the person like a review.
pub(super) async fn settle(
    app: &Arc<AppState>,
    id: &str,
    card: usize,
    scan: &Value,
    decision: &str,
    picked: Vec<usize>,
    to: Option<String>,
) -> Result<Value, ApiError> {
    let chosen = crate::dispatch::review_picked(scan, &picked);
    let request = crate::dispatch::fix_request(&crate::dispatch::found_by(&scan["of"]), &chosen);
    let machine = text(&scan["machine"]);
    if decision == "start" {
        let input = json!({ "machine": machine, "path": scanned(scan), "prompt": request });
        let cfg = app.config()?;
        crate::mcp::check(app, &cfg, "start_session", &input)?;
        let step = app
            .dispatch
            .propose(id, "start_session", input, By::You, None, None)
            .map_err(refused)?;
        let outcome = json!({ "decision": "started", "findings": picked, "step": step["id"] });
        let card = app
            .dispatch
            .review_outcome(id, card, outcome)
            .map_err(refused)?;
        return Ok(json!({ "card": card, "step": step }));
    }
    let name = to
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| text(&scan["of"]["name"]));
    if name.is_empty() {
        return Err(bad("pick a session to send the findings to"));
    }
    if !targets(app, scan)
        .iter()
        .any(|t| t["name"] == name.as_str())
    {
        return Err(bad(&format!(
            "{name} is not a session in the scanned folder"
        )));
    }
    let cfg = app.config()?;
    let m = find_machine(&cfg, &machine)?;
    let (app, id) = (app.clone(), id.to_string());
    detached(async move {
        app.sessions
            .send(&m, &name, &request)
            .await
            .map_err(|e| ApiError::gateway(format!("could not send to {name}: {e}")))?;
        let outcome = json!({ "decision": "sent", "findings": picked, "to": name });
        app.dispatch
            .review_outcome(&id, card, outcome)
            .map_err(refused)
    })
    .await
}

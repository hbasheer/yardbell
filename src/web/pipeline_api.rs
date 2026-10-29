use super::{ApiError, AppState};
use crate::pipeline::definition::{Definition, Outcome};
use crate::pipeline::linear::Ticket;
use crate::pipeline::record::{PrRef, Run, RunState, Subject, TicketRef};
use crate::triggers::LINEAR_SECRET;
use axum::extract::{Path, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/pipelines", get(list).post(create))
        .route("/api/pipelines/tickets", get(tickets))
        .route("/api/pipelines/settings", put(settings))
        .route("/api/pipelines/{id}", get(show).put(save).delete(delete))
        .route("/api/pipelines/{id}/enabled", post(enabled))
        .route("/api/pipelines/{id}/history", get(history))
        .route("/api/pipelines/{id}/restore", post(restore))
        .route("/api/pipelines/{id}/runs", get(runs).post(start))
        .route("/api/runs", get(all_runs))
        .route("/api/runs/{id}/answer", post(answer))
        .route("/api/runs/{id}/retry", post(retry))
        .route("/api/runs/{id}/continue", post(continue_on))
        .route("/api/runs/{id}/drop", post(drop_run))
}

fn bad(msg: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg)
}

fn problems(list: Vec<String>) -> Response {
    let error = list.join("; ");
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": error, "problems": list })),
    )
        .into_response()
}

fn saved(app: &AppState, out: Result<Definition, Vec<String>>) -> Result<Response, ApiError> {
    Ok(match out {
        Ok(def) => {
            app.state.touch();
            Json(json!(def)).into_response()
        }
        Err(list) => problems(list),
    })
}

fn found(app: &AppState, id: &str) -> Result<Definition, ApiError> {
    app.pipelines
        .library()
        .get(id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("there is no pipeline {id}")))
}

fn newest_first(mut runs: Vec<Run>) -> Vec<Run> {
    runs.sort_by(|a, b| b.started.cmp(&a.started));
    runs
}

async fn list(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let runs = app.pipelines.runs();
    let pipelines: Vec<Value> = app
        .pipelines
        .library()
        .list()
        .into_iter()
        .map(|def| {
            let mine: Vec<&Run> = runs.iter().filter(|r| r.pipeline == def.id).collect();
            let count = |s: &[RunState]| mine.iter().filter(|r| s.contains(&r.state)).count();
            let problem = app.pipelines.watch().kept(&def.id).problem;
            json!({
                "definition": def,
                "runs": {
                    "running": count(&[RunState::Queued, RunState::Running]),
                    "waiting": count(&[RunState::Waiting]),
                    "done": count(&[RunState::Done]),
                },
                "problem": problem,
            })
        })
        .collect();
    let templates: Vec<String> = crate::pipeline::templates::all()
        .into_iter()
        .map(|t| t.name)
        .collect();
    let machines: Vec<&str> = cfg.machines.iter().map(|m| m.name.as_str()).collect();
    let agents: Vec<String> = cfg.agents().into_iter().map(|a| a.name).collect();
    let mcp_servers: Vec<&str> = cfg.mcp_servers.iter().map(|m| m.name.as_str()).collect();
    let gitlab_hosts: Vec<&str> = cfg
        .pull_requests
        .gitlab
        .iter()
        .map(|g| g.host.as_str())
        .collect();
    Ok(Json(json!({
        "pipelines": pipelines,
        "templates": templates,
        "settings": cfg.pipelines,
        "machines": machines,
        "agents": agents,
        "mcp_servers": mcp_servers,
        "gitlab_hosts": gitlab_hosts,
    }))
    .into_response())
}

#[derive(Deserialize)]
struct CreateReq {
    template: Option<String>,
    definition: Option<Definition>,
}

async fn create(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<CreateReq>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let library = app.pipelines.library();
    let out = match (req.template, req.definition) {
        (Some(name), None) => library.copy_template(&name, &cfg),
        (None, Some(mut def)) => {
            let taken: Vec<String> = library.list().into_iter().map(|d| d.id).collect();
            def.id = crate::pipeline::definition::slug(&def.name, &taken);
            def.version = 0;
            library.save(def, &cfg)
        }
        _ => return Err(bad("send a template name or a definition".into())),
    };
    saved(&app, out)
}

async fn show(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    Ok(Json(json!(found(&app, &id)?)).into_response())
}

async fn save(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    Json(mut def): Json<Definition>,
) -> Result<Response, ApiError> {
    found(&app, &id)?;
    def.id = id;
    let cfg = app.config()?;
    saved(&app, app.pipelines.library().save(def, &cfg))
}

async fn delete(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    found(&app, &id)?;
    app.pipelines.delete(&id).map_err(ApiError::internal)?;
    app.state.touch();
    Ok(Json(json!({ "deleted": id })).into_response())
}

#[derive(Deserialize)]
struct EnabledReq {
    enabled: bool,
}

async fn enabled(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<EnabledReq>,
) -> Result<Response, ApiError> {
    found(&app, &id)?;
    let cfg = app.config()?;
    saved(
        &app,
        app.pipelines.library().set_enabled(&id, req.enabled, &cfg),
    )
}

async fn history(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    found(&app, &id)?;
    let history: Vec<Value> = app
        .pipelines
        .library()
        .history(&id)
        .into_iter()
        .map(|(version, saved, definition)| {
            json!({ "version": version, "saved": saved, "definition": definition })
        })
        .collect();
    Ok(Json(json!({ "history": history })).into_response())
}

#[derive(Deserialize)]
struct RestoreReq {
    version: u32,
}

async fn restore(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<RestoreReq>,
) -> Result<Response, ApiError> {
    found(&app, &id)?;
    let cfg = app.config()?;
    saved(
        &app,
        app.pipelines.library().restore(&id, req.version, &cfg),
    )
}

async fn runs(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    found(&app, &id)?;
    let runs: Vec<Run> = app
        .pipelines
        .runs()
        .into_iter()
        .filter(|r| r.pipeline == id)
        .collect();
    Ok(Json(json!({ "runs": newest_first(runs) })).into_response())
}

async fn all_runs(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    Ok(Json(json!({ "runs": newest_first(app.pipelines.runs()) })).into_response())
}

async fn open(app: &AppState) -> Result<Vec<Ticket>, ApiError> {
    let secrets = app.secrets()?;
    let key = secrets.get(LINEAR_SECRET).ok_or_else(|| {
        bad(format!(
            "the secret {LINEAR_SECRET} is not set. Add your Linear API key under Settings, MCP servers, Secrets"
        ))
    })?;
    app.pipelines
        .linear()
        .open(key)
        .await
        .map_err(ApiError::gateway)
}

async fn tickets(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let runs = app.pipelines.runs();
    let tickets: Vec<Value> = open(&app)
        .await?
        .into_iter()
        .map(|t| {
            let key = format!("ticket:{}", t.id);
            let mut running_in: Vec<&str> = runs
                .iter()
                .filter(|r| r.key == key && r.state.active())
                .map(|r| r.pipeline.as_str())
                .collect();
            running_in.dedup();
            let mut v = json!(t);
            v["running_in"] = json!(running_in);
            v
        })
        .collect();
    Ok(Json(json!({ "tickets": tickets })).into_response())
}

#[derive(Deserialize)]
struct StartReq {
    #[serde(default)]
    tickets: Vec<String>,
    #[serde(default)]
    prs: Vec<String>,
}

async fn subjects(app: &AppState, req: StartReq) -> Result<Vec<Subject>, ApiError> {
    let mut out = Vec::new();
    if !req.tickets.is_empty() {
        let open = open(app).await?;
        for id in &req.tickets {
            let t = open
                .iter()
                .find(|t| t.id.eq_ignore_ascii_case(id.trim()))
                .ok_or_else(|| bad(format!("{id} is not one of your open tickets in Linear")))?;
            out.push(Subject {
                ticket: Some(TicketRef {
                    linear_id: t.linear_id.clone(),
                    id: t.id.clone(),
                    title: t.title.clone(),
                    url: t.url.clone(),
                }),
                pr: None,
            });
        }
    }
    for url in &req.prs {
        let pr = PrRef::parse(url).ok_or_else(|| {
            bad(format!(
                "{url} is not a GitHub pull request or GitLab merge request link"
            ))
        })?;
        out.push(Subject {
            ticket: None,
            pr: Some(pr),
        });
    }
    if out.is_empty() {
        out.push(Subject::default());
    }
    Ok(out)
}

async fn start(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    body: Option<Json<StartReq>>,
) -> Result<Response, ApiError> {
    found(&app, &id)?;
    let req = body.map(|Json(r)| r).unwrap_or(StartReq {
        tickets: Vec::new(),
        prs: Vec::new(),
    });
    let subjects = subjects(&app, req).await?;
    let runs = app
        .pipelines
        .start(&id, subjects, "you")
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    app.state.touch();
    Ok(Json(json!({ "runs": runs })).into_response())
}

fn acted(app: &AppState, out: Result<Run, String>) -> Result<Response, ApiError> {
    let run = out.map_err(|e| {
        let status = if e.ends_with("is not a run") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        ApiError(status, e)
    })?;
    app.state.touch();
    Ok(Json(json!(run)).into_response())
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
    acted(&app, app.pipelines.answer(&id, &req.text))
}

async fn retry(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    acted(&app, app.pipelines.retry(&id))
}

#[derive(Deserialize)]
struct ContinueReq {
    outcome: Outcome,
}

async fn continue_on(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<ContinueReq>,
) -> Result<Response, ApiError> {
    acted(&app, app.pipelines.continue_on(&id, req.outcome))
}

async fn drop_run(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    acted(&app, app.pipelines.drop_run(&id))
}

async fn settings(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<crate::config::Pipelines>,
) -> Result<Response, ApiError> {
    app.settings.set_pipelines(req.clone()).map_err(bad)?;
    app.state.touch();
    Ok(Json(json!(req)).into_response())
}

use super::{ApiError, AppState};
use crate::pipeline::definition::{Definition, Outcome, Trigger};
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
        .route("/api/pipelines/{id}/webhook-token", post(webhook_token))
        .route("/hooks/pipeline/{id}/{token}", post(hook).head(hook_head))
        .route("/api/runs", get(all_runs))
        .route("/api/runs/{id}", axum::routing::delete(delete_run))
        .route("/api/runs/{id}/answer", post(answer))
        .route("/api/runs/{id}/retry", post(retry))
        .route("/api/runs/{id}/continue", post(continue_on))
        .route("/api/runs/{id}/drop", post(drop_run))
        .route("/api/runs/{id}/stop-session", post(stop_session))
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
        "connectors": cfg.connectors.iter().map(|c| json!({
            "id": c.id,
            "name": c.name,
            "enabled": c.enabled,
            "params": c.params,
            "calls": c.calls.iter().map(|(name, call)| json!({
                "name": name,
                "kind": call.kind(),
                "needs": crate::connectors::client::needs_of(call),
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct CreateReq {
    #[serde(default)]
    empty: bool,
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
        (None, None) if req.empty => library.create_empty(&cfg),
        (Some(name), None) => library.copy_template(&name, &cfg),
        (None, Some(mut def)) => {
            let taken: Vec<String> = library.list().into_iter().map(|d| d.id).collect();
            def.id = crate::pipeline::definition::slug(&def.name, &taken);
            def.version = 0;
            library.save(def, &cfg)
        }
        _ => return Err(bad("send empty, a template name or a definition".into())),
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

// Each run with its live sessions, newest first, for the terminal on the run page. Steps sharing
// a session are named by the newest of them.
fn with_terminals(app: &AppState, runs: Vec<Run>) -> Result<Vec<Value>, ApiError> {
    let cfg = app.config()?;
    let view = app.state.view(&cfg, app.ports.as_ref(), "localhost");
    Ok(runs
        .into_iter()
        .map(|run| {
            let def = run.def();
            let mut steps: Vec<_> = run.steps.iter().collect();
            steps.sort_by_key(|(_, st)| std::cmp::Reverse(st.started.clone()));
            let current = run.steps.get(&run.step).map(|st| st.session.as_str());
            let mut seen = Vec::new();
            let mut terminals = Vec::new();
            for (id, st) in steps.into_iter().filter(|_| run.state.active()) {
                if st.session.is_empty() || seen.contains(&st.session.as_str()) {
                    continue;
                }
                let live = view
                    .sessions
                    .iter()
                    .find(|s| s.tmux.as_deref() == Some(st.session.as_str()));
                if let Some(live) = live {
                    seen.push(st.session.as_str());
                    terminals.push(json!({
                        "step": id,
                        "name": st.session,
                        "machine": live.machine,
                        "label": def.step(id).map_or(id.as_str(), |s| s.name.as_str()),
                        "current": current == Some(st.session.as_str()),
                    }));
                }
            }
            let mut out = json!(run);
            out["terminals"] = json!(terminals);
            out
        })
        .collect())
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
    Ok(Json(json!({ "runs": with_terminals(&app, newest_first(runs))? })).into_response())
}

async fn all_runs(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    let runs = newest_first(app.pipelines.runs());
    Ok(Json(json!({ "runs": with_terminals(&app, runs)? })).into_response())
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

async fn connector_subjects(
    app: &AppState,
    connector: &str,
    tickets: &[String],
) -> Result<Vec<Subject>, ApiError> {
    let cfg = app.config()?;
    let secrets = crate::secrets::Secrets::for_config(&app.cfg_path).map_err(|e| e.to_string());
    let client = crate::connectors::client_for(
        &cfg.connectors,
        connector,
        &secrets,
        crate::mcp_read::saved_values(app),
    )
    .map_err(bad)?;
    let mut out = Vec::new();
    for given in tickets {
        let given = given.trim().trim_end_matches('/');
        let id = given.rsplit('/').next().unwrap_or(given);
        let vars =
            crate::connectors::client::Vars([("item_id".to_string(), id.to_string())].into());
        let item = client
            .read(&vars)
            .await
            .map_err(|e| bad(format!("{given}: {e}")))?;
        out.push(crate::pipeline::triggers::item_subject(connector, &item));
    }
    Ok(out)
}

pub(crate) async fn subjects(
    app: &AppState,
    def: &Definition,
    tickets: &[String],
    prs: &[String],
) -> Result<Vec<Subject>, ApiError> {
    let connector = match &def.trigger {
        Trigger::Connector { connector, .. } => Some(connector),
        Trigger::Schedule { connector, .. } if !connector.is_empty() => Some(connector),
        _ => None,
    };
    let mut out = Vec::new();
    if let (Some(connector), false) = (connector, tickets.is_empty()) {
        out = connector_subjects(app, connector, tickets).await?;
    } else if !tickets.is_empty() {
        let open = open(app).await?;
        for id in tickets {
            let t = open
                .iter()
                .find(|t| t.id.eq_ignore_ascii_case(id.trim()))
                .ok_or_else(|| bad(format!("{id} is not one of your open tickets in Linear")))?;
            out.push(Subject {
                ticket: Some(TicketRef {
                    source: String::new(),
                    item_id: t.linear_id.clone(),
                    id: t.id.clone(),
                    title: t.title.clone(),
                    url: t.url.clone(),
                    description: String::new(),
                }),
                pr: None,
            });
        }
    }
    for url in prs {
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
    let def = found(&app, &id)?;
    if def.steps.is_empty() {
        return Err(bad(format!("{} has no steps yet", def.name)));
    }
    let req = body.map(|Json(r)| r).unwrap_or(StartReq {
        tickets: Vec::new(),
        prs: Vec::new(),
    });
    let subjects = subjects(&app, &def, &req.tickets, &req.prs).await?;
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

async fn delete_run(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    if !app.pipelines.delete_run(&id) {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("{id} is not a run"),
        ));
    }
    app.state.touch();
    Ok(Json(json!({ "deleted": id })).into_response())
}

async fn drop_run(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    acted(&app, app.pipelines.drop_run(&id))
}

#[derive(Deserialize)]
struct StopSessionReq {
    name: String,
}

async fn stop_session(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<StopSessionReq>,
) -> Result<Response, ApiError> {
    let cfg = app.config()?;
    let run = app.pipelines.session_stopped(&id, &req.name).map_err(bad)?;
    let machine = run
        .steps
        .values()
        .find(|s| s.session == req.name)
        .map(|s| s.machine.clone())
        .unwrap_or_default();
    let m = super::find_machine(&cfg, &machine)?;
    app.sessions
        .stop(&m, &req.name)
        .await
        .map_err(ApiError::gateway)?;
    app.recheck(&m.name);
    app.state.touch();
    Ok(Json(json!({ "ok": true })).into_response())
}

const HOOK_BODY_MAX: usize = 1024 * 1024;

fn hook_secret(id: &str) -> String {
    format!("pipeline_hook_{id}")
}

async fn webhook_token(
    AxState(app): AxState<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let def = found(&app, &id)?;
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    app.settings
        .set_secret(&hook_secret(&def.id), &token)
        .map_err(bad)?;
    let cfg = app.config()?;
    let url = crate::phone::base_url(&cfg)
        .map(|base| format!("{base}/hooks/pipeline/{}/{token}", def.id));
    Ok(Json(json!({ "url": url, "token": token })).into_response())
}

fn hook_error(status: StatusCode, error: String) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

// One answer for every way in that is not allowed, so a wrong token says nothing about a pipeline.
fn hook_pipeline(app: &AppState, id: &str, token: &str) -> Option<Definition> {
    let def = app.pipelines.library().get(id)?;
    if !def.enabled || !matches!(def.trigger, Trigger::Webhook { .. }) {
        return None;
    }
    let store = app.secrets().ok()?;
    let saved = store.get(&hook_secret(id))?;
    crate::connectors::net::same(saved, token).then_some(def)
}

async fn hook_head(
    AxState(app): AxState<Arc<AppState>>,
    Path((id, token)): Path<(String, String)>,
) -> StatusCode {
    match hook_pipeline(&app, &id, &token) {
        Some(_) => StatusCode::OK,
        None => StatusCode::NOT_FOUND,
    }
}

fn hook_subject(def: &Definition, body: &Value) -> Result<Subject, String> {
    let Trigger::Webhook { map } = &def.trigger else {
        return Err("this pipeline does not take webhooks".into());
    };
    let field = |name: &str| {
        let at = map.get(name).map_or(name, String::as_str);
        crate::connectors::map::path(body, at)
            .map(|v| crate::connectors::map::text_of(&v))
            .unwrap_or_default()
    };
    let (id, title) = (field("id"), field("title"));
    if id.trim().is_empty() {
        return Err("the body has no id".into());
    }
    if title.trim().is_empty() {
        return Err("the body has no title".into());
    }
    Ok(Subject {
        ticket: Some(TicketRef {
            source: crate::pipeline::run::WEBHOOK_SOURCE.to_string(),
            item_id: id.clone(),
            id,
            title,
            url: field("url"),
            description: field("description"),
        }),
        pr: None,
    })
}

async fn hook(
    AxState(app): AxState<Arc<AppState>>,
    Path((id, token)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Response {
    let Some(def) = hook_pipeline(&app, &id, &token) else {
        return hook_error(StatusCode::NOT_FOUND, "there is no such address".into());
    };
    if !app.pipelines.hook_allowed(&id, chrono::Local::now()) {
        return hook_error(StatusCode::TOO_MANY_REQUESTS, "too many requests".into());
    }
    if body.len() > HOOK_BODY_MAX {
        return hook_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "the body is over 1 MB".into(),
        );
    }
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        return hook_error(StatusCode::BAD_REQUEST, "the body is not JSON".into());
    };
    let subject = match hook_subject(&def, &value) {
        Ok(subject) => subject,
        Err(e) => return hook_error(StatusCode::BAD_REQUEST, e),
    };
    if app.pipelines.has_run_for(&id, &subject.key()) {
        return Json(json!({ "started": false })).into_response();
    }
    match app.pipelines.start(&id, vec![subject], "a webhook") {
        Ok(_) => {
            app.state.touch();
            (StatusCode::ACCEPTED, Json(json!({ "started": true }))).into_response()
        }
        Err(e) => hook_error(StatusCode::CONFLICT, e),
    }
}

async fn settings(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<crate::config::Pipelines>,
) -> Result<Response, ApiError> {
    app.settings.set_pipelines(req.clone()).map_err(bad)?;
    app.state.touch();
    Ok(Json(json!(req)).into_response())
}

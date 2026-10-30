use super::{asset, find_machine, label_of, mcp_config, ApiError, AppState};
use crate::config::{Config, Machine};
use crate::sessions::{Launch, Start};
use crate::worktrees::cleanup::RemoveError;
use crate::worktrees::integrate::Integration;
use crate::worktrees::setup::SetupRun;
use axum::extract::{Path as UrlPath, State as AxState};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const TOOLS: [&str; 4] = [
    "remove_worktree",
    "integrate_branches",
    "push_branch",
    "move_session",
];

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/worktree.js", get(|| async { asset("worktree.js") }))
        .route("/worktrees/{machine}/inspect", post(inspect_route))
        .route("/worktrees/{machine}/remove", post(remove_route))
        .route("/worktrees/{machine}/integrate", post(integrate_route))
        .route("/worktrees/{machine}/push", post(push_route))
        .route("/sessions/{machine}/{name}/move", post(move_route))
        .route("/sessions/{machine}/{name}/task", get(task_route))
        .route(
            "/api/settings/worktree-setup",
            get(setup_settings).post(save_setup_settings),
        )
}

async fn setup_settings(AxState(app): AxState<Arc<AppState>>) -> Result<Response, ApiError> {
    Ok(Json(json!({ "setups": app.config()?.worktree_setup })).into_response())
}

#[derive(Deserialize)]
struct SetupSettings {
    setups: Vec<crate::worktrees::setup::WorktreeSetup>,
}

async fn save_setup_settings(
    AxState(app): AxState<Arc<AppState>>,
    Json(req): Json<SetupSettings>,
) -> Result<Response, ApiError> {
    let setups = req
        .setups
        .into_iter()
        .map(|s| crate::worktrees::setup::WorktreeSetup {
            folder: s.folder.trim().to_string(),
            machine: s.machine.trim().to_string(),
            command: s.command.trim().to_string(),
            teardown: s.teardown.trim().to_string(),
            ..s
        })
        .collect();
    app.settings.set_worktree_setup(setups).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

fn bad(message: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message)
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Place {
    #[serde(default)]
    pub machine: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub path: String,
}

impl Place {
    pub fn resolve(&self, app: &AppState, m: &Machine) -> Result<String, ApiError> {
        match (self.path.trim(), self.folder.trim()) {
            ("", "") => Err(bad("give a folder from list_folders, or a path".into())),
            ("", folder) => app
                .state
                .snapshot(&m.name)
                .unwrap_or_default()
                .folder_paths
                .get(folder)
                .cloned()
                .ok_or_else(|| bad(format!("{} has no folder {folder}", m.name))),
            (path, _) if !path.starts_with('/') || path.chars().any(char::is_control) => Err(bad(
                format!("{path} is not an absolute path; give one, or a folder from list_folders"),
            )),
            (path, _) => Ok(path.trim_end_matches('/').to_string()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoveWorktree {
    #[serde(flatten)]
    pub at: Place,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub delete_branch: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IntegrateBranches {
    #[serde(flatten)]
    pub at: Place,
    #[serde(flatten)]
    pub plan: Integration,
}

fn origin() -> String {
    "origin".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct PushBranch {
    #[serde(flatten)]
    pub at: Place,
    pub branch: String,
    #[serde(default = "origin")]
    pub remote: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MoveSession {
    pub machine: String,
    pub name: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub stop_original: bool,
    // A tester that checks the work and changes nothing, such as the pipeline's QA.
    #[serde(default)]
    pub read_only: bool,
    // Where the work is when the session has already stopped, as a pipeline's copy step may find.
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub name_tag: String,
}

pub fn arg<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|e| bad(e.to_string()))
}

// The mistakes worth catching before a person is asked to approve one of these steps.
pub fn check(app: &AppState, cfg: &Config, tool: &str, input: &Value) -> Result<(), ApiError> {
    match tool {
        "remove_worktree" => {
            let r: RemoveWorktree = arg(input.clone())?;
            r.at.resolve(app, &find_machine(cfg, &r.at.machine)?)?;
        }
        "integrate_branches" => {
            let r: IntegrateBranches = arg(input.clone())?;
            r.at.resolve(app, &find_machine(cfg, &r.at.machine)?)?;
            r.plan.check().map_err(bad)?;
        }
        "push_branch" => {
            let r: PushBranch = arg(input.clone())?;
            r.at.resolve(app, &find_machine(cfg, &r.at.machine)?)?;
            if !crate::folders::valid_branch(&r.branch) {
                return Err(bad(format!(
                    "{:?} is not a branch name Yardbell accepts",
                    r.branch
                )));
            }
            if !crate::worktrees::scan::valid_remote(&r.remote) {
                return Err(bad(format!(
                    "{:?} is not a remote name Yardbell accepts",
                    r.remote
                )));
            }
        }
        "move_session" => {
            let r: MoveSession = arg(input.clone())?;
            find_machine(cfg, &r.machine)?;
            if !r.to.is_empty() && find_machine(cfg, &r.to)?.name == r.machine {
                return Err(bad("the session already runs on that machine".into()));
            }
            session_on(app, &r.machine, &r.name)?;
        }
        other => return Err(bad(format!("{other} is not a worktree step"))),
    }
    Ok(())
}

// Dispatch never forces a removal: work that would be lost is the person's call, in Yardbell.
pub async fn run_tool(app: &AppState, tool: &str, args: Value) -> Result<Value, ApiError> {
    match tool {
        "remove_worktree" => {
            let mut r: RemoveWorktree = arg(args)?;
            r.force = false;
            remove(app, &r).await.map_err(|(e, _)| e)
        }
        "integrate_branches" => integrate(app, &arg(args)?).await,
        "push_branch" => push(app, &arg(args)?).await,
        "move_session" => move_session(app, &arg(args)?).await,
        other => Err(bad(format!("unknown tool {other}"))),
    }
}

fn session_on(
    app: &AppState,
    machine: &str,
    name: &str,
) -> Result<crate::snapshot::Session, ApiError> {
    app.state
        .snapshot(machine)
        .unwrap_or_default()
        .sessions
        .into_iter()
        .find(|s| s.tmux.as_deref() == Some(name))
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                format!("no session named {name} on {machine}"),
            )
        })
}

// The names a repository goes by in setup patterns: its labels on the machine and its path.
fn names_of(app: &AppState, m: &Machine, repo: &str) -> Vec<String> {
    let snap = app.state.snapshot(&m.name).unwrap_or_default();
    let mut folders: Vec<String> = snap
        .folder_paths
        .iter()
        .filter(|(_, p)| p.as_str() == repo)
        .map(|(label, _)| label.clone())
        .collect();
    folders.push(repo.to_string());
    folders
}

// Runs the folder's setup command, if it has one, in a worktree Yardbell just created.
pub async fn run_setup(
    app: &AppState,
    cfg: &Config,
    m: &Machine,
    repo: &str,
    path: &str,
) -> Option<SetupRun> {
    let folders = names_of(app, m, repo);
    let setup =
        crate::worktrees::setup::pick(&cfg.worktree_setup, &m.name, &folders, |s| &s.command)?
            .clone();
    let run = app.worktrees.setup(m, path, &setup).await;
    if run.ok {
        tracing::info!(machine = %m.name, path, "worktree setup finished");
    } else {
        tracing::warn!(machine = %m.name, path, summary = %run.summary(), "worktree setup failed");
    }
    app.state.set_setup(&m.name, run.clone());
    Some(run)
}

// Runs the folder's teardown command, if it has one, when a pipeline run that used it ends.
pub async fn run_teardown(
    app: &AppState,
    cfg: &Config,
    m: &Machine,
    repo: &str,
    path: &str,
) -> Option<SetupRun> {
    let folders = names_of(app, m, repo);
    let setup =
        crate::worktrees::setup::pick(&cfg.worktree_setup, &m.name, &folders, |s| &s.teardown)?;
    let run = app.worktrees.teardown(m, path, setup).await;
    if !run.ok {
        tracing::warn!(machine = %m.name, path, summary = %run.summary(), "worktree teardown failed");
    }
    Some(run)
}

fn live_in(app: &AppState, machine: &str, path: &str) -> Vec<String> {
    app.state
        .snapshot(machine)
        .unwrap_or_default()
        .sessions
        .iter()
        .filter(|s| s.cwd == path || s.cwd.starts_with(&format!("{path}/")))
        .map(|s| {
            s.tmux
                .clone()
                .unwrap_or_else(|| format!("{} (pid {})", s.agent, s.pid))
        })
        .collect()
}

type Refused = (ApiError, Option<Value>);

pub async fn inspect(app: &AppState, at: &Place) -> Result<Value, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &at.machine)?;
    let path = at.resolve(app, &m)?;
    let ins = app
        .worktrees
        .inspect(&m, &path)
        .await
        .map_err(ApiError::gateway)?;
    let sessions = live_in(app, &m.name, &ins.path);
    Ok(json!({ "worktree": ins, "loss": ins.loss(), "sessions": sessions }))
}

pub async fn remove(app: &AppState, r: &RemoveWorktree) -> Result<Value, Refused> {
    let cfg = app.config().map_err(|e| (e, None))?;
    let m = find_machine(&cfg, &r.at.machine).map_err(|e| (e, None))?;
    let path = r.at.resolve(app, &m).map_err(|e| (e, None))?;
    let ins = app
        .worktrees
        .inspect(&m, &path)
        .await
        .map_err(|e| (ApiError::gateway(e), None))?;
    let running = live_in(app, &m.name, &ins.path);
    if !running.is_empty() {
        return Err((
            ApiError(
                StatusCode::CONFLICT,
                format!(
                    "{} still runs in {}; stop it first",
                    running.join(", "),
                    ins.path
                ),
            ),
            None,
        ));
    }
    let removed = app
        .worktrees
        .remove(&m, &ins, r.force, r.delete_branch)
        .await
        .map_err(|e| {
            let message = e.message();
            match e {
                RemoveError::MainCheckout(_) => (bad(message), None),
                RemoveError::AtRisk(ins) => (
                    ApiError(StatusCode::CONFLICT, message),
                    Some(json!({ "worktree": ins, "loss": ins.loss() })),
                ),
                RemoveError::Failed(_) => (ApiError::gateway(message), None),
            }
        })?;
    app.state.worktree_removed(&m.name, &ins.path);
    app.recheck(&m.name);
    Ok(json!({ "machine": m.name, "removed": removed }))
}

pub async fn integrate(app: &AppState, r: &IntegrateBranches) -> Result<Value, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &r.at.machine)?;
    let repo = r.at.resolve(app, &m)?;
    let done = app
        .worktrees
        .integrate(&app.folders, &m, &repo, &r.plan)
        .await
        .map_err(ApiError::gateway)?;
    app.recheck(&m.name);
    Ok(json!({ "machine": m.name, "integrated": done, "summary": done.summary() }))
}

pub async fn push(app: &AppState, r: &PushBranch) -> Result<Value, ApiError> {
    let cfg = app.config()?;
    let m = find_machine(&cfg, &r.at.machine)?;
    let path = r.at.resolve(app, &m)?;
    let secrets: Vec<(String, String)> = app
        .secrets()?
        .values()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    let pushed = app
        .worktrees
        .push(&m, &path, &r.branch, &r.remote, &secrets)
        .await
        .map_err(|e| {
            let status = if e.starts_with("Push blocked") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_GATEWAY
            };
            ApiError(status, e)
        })?;
    app.recheck(&m.name);
    Ok(json!({ "machine": m.name, "pushed": pushed }))
}

// The machine with the most room for agents among those that are up and have the repository.
fn roomiest(app: &AppState, cfg: &Config, from: &str, label: &str) -> Option<Machine> {
    cfg.machines
        .iter()
        .filter(|m| m.name != from)
        .filter(|m| app.state.status(&m.name).is_some_and(|s| s.up))
        .filter_map(|m| {
            let snap = app.state.snapshot(&m.name)?;
            snap.folder_paths.contains_key(label).then(|| {
                let room = snap.health.map(|h| h.room_kb()).unwrap_or(0);
                (room, m)
            })
        })
        .max_by_key(|(room, _)| *room)
        .map(|(_, m)| m.clone())
}

fn continued_note(from: &str, src: &crate::worktrees::handoff::Source, applied: bool) -> String {
    let changes = if applied {
        " and its uncommitted changes"
    } else {
        ""
    };
    format!(
        "Continued from {from}: this task was moved here from {from}, where it ran in {}. Branch \
{}{changes} came along; nothing was committed or pushed for the move. Pick up where that work \
left off.",
        src.top, src.branch
    )
}

pub async fn move_session(app: &AppState, r: &MoveSession) -> Result<Value, ApiError> {
    let cfg = app.config()?;
    let from = find_machine(&cfg, &r.machine)?;
    let (cwd, agent_name) = match session_on(app, &from.name, &r.name) {
        Ok(s) => (s.cwd, s.agent),
        Err(_) if !r.path.is_empty() && r.agent.is_empty() => {
            (r.path.clone(), cfg.default_agent().to_string())
        }
        Err(_) if !r.path.is_empty() => (r.path.clone(), r.agent.clone()),
        Err(e) => return Err(e),
    };
    let agent = cfg
        .agent(&agent_name)
        .ok_or_else(|| bad(format!("no agent named {agent_name}")))?;
    let src = app
        .worktrees
        .source(&from, &cwd)
        .await
        .map_err(ApiError::gateway)?;
    let snap = app.state.snapshot(&from.name).unwrap_or_default();
    let label = snap
        .folder_paths
        .iter()
        .find(|(_, p)| **p == src.main)
        .map(|(label, _)| label.clone())
        .unwrap_or_else(|| label_of(&src.main));
    let folder = if r.folder.trim().is_empty() {
        label.clone()
    } else {
        r.folder.trim().to_string()
    };
    let to = if r.to.is_empty() {
        roomiest(app, &cfg, &from.name, &folder).ok_or_else(|| {
            bad(format!(
                "no other machine that is up has the folder {folder}; give the machine and folder to move to"
            ))
        })?
    } else {
        find_machine(&cfg, &r.to)?
    };
    if to.name == from.name {
        return Err(bad("the session already runs on that machine".into()));
    }
    let repo = app
        .state
        .snapshot(&to.name)
        .unwrap_or_default()
        .folder_paths
        .get(&folder)
        .cloned()
        .ok_or_else(|| bad(format!("{} has no folder {folder}", to.name)))?;
    let landed = app
        .worktrees
        .deliver(&from, &src, &to, &repo)
        .await
        .map_err(ApiError::gateway)?;
    let setup = if landed.created {
        run_setup(app, &cfg, &to, &repo, &landed.path).await
    } else {
        None
    };
    let task = r
        .task
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| app.task_of(&from.name, &r.name))
        .unwrap_or_default();
    let mut parts = vec![
        task.trim().to_string(),
        continued_note(&from.name, &src, landed.applied),
    ];
    parts.extend(setup.as_ref().and_then(SetupRun::note_for_agent));
    parts.retain(|p| !p.is_empty());
    let prompt = parts.join("\n\n");
    let mcp = mcp_config(&cfg, &to, &agent, &app.secrets()?)?;
    let ticket = crate::snapshot::ticket(&src.branch, cfg.ticket_regex().as_ref());
    let ticket = crate::sessions::tagged(&ticket, &label_of(&landed.path), &r.name_tag);
    let name = app
        .sessions
        .create(
            &to,
            Launch {
                folder_path: &landed.path,
                ticket: &ticket,
                folder_label: &label_of(&landed.path),
                agent: &agent,
                start: Start::Task(&prompt),
                mcp_config: mcp.as_deref(),
                read_only: r.read_only,
            },
        )
        .await
        .map_err(|e| {
            ApiError::gateway(format!(
                "{e}. The work is on {} in {}, and the original still runs on {}.",
                to.name, landed.path, from.name
            ))
        })?;
    app.remember_task(&to.name, &name, &task);
    let stopped = if r.stop_original {
        app.sessions.stop(&from, &r.name).await.is_ok()
    } else {
        false
    };
    app.recheck(&from.name);
    app.recheck(&to.name);
    Ok(json!({
        "created": landed.created,
        "repo": repo,
        "machine": to.name,
        "name": name,
        "path": landed.path,
        "branch": src.branch,
        "changes_moved": landed.applied,
        "from": { "machine": from.name, "name": r.name, "stopped": stopped },
        "setup": setup,
    }))
}

fn with_machine(mut body: Value, machine: &str) -> Value {
    if let Some(obj) = body.as_object_mut() {
        obj.insert("machine".into(), json!(machine));
    }
    body
}

fn refused_response((err, details): Refused) -> Response {
    let mut body = json!({ "error": err.1 });
    if let Some(Value::Object(extra)) = details {
        body.as_object_mut().expect("object").extend(extra);
    }
    (err.0, Json(body)).into_response()
}

async fn inspect_route(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let at: Place = arg(with_machine(body, &machine))?;
    Ok(Json(inspect(&app, &at).await?).into_response())
}

async fn remove_route(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Json(body): Json<Value>,
) -> Response {
    let r: RemoveWorktree = match arg(with_machine(body, &machine)) {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };
    match remove(&app, &r).await {
        Ok(done) => Json(done).into_response(),
        Err(refused) => refused_response(refused),
    }
}

async fn integrate_route(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let r: IntegrateBranches = arg(with_machine(body, &machine))?;
    Ok(Json(integrate(&app, &r).await?).into_response())
}

async fn push_route(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath(machine): UrlPath<String>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let r: PushBranch = arg(with_machine(body, &machine))?;
    Ok(Json(push(&app, &r).await?).into_response())
}

async fn move_route(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, name)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let mut body = with_machine(body, &machine);
    body["name"] = json!(name);
    let r: MoveSession = arg(body)?;
    Ok(Json(move_session(&app, &r).await?).into_response())
}

async fn task_route(
    AxState(app): AxState<Arc<AppState>>,
    UrlPath((machine, name)): UrlPath<(String, String)>,
) -> Response {
    Json(json!({ "task": app.task_of(&machine, &name).unwrap_or_default() })).into_response()
}

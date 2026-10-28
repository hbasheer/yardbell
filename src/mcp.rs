use crate::config::{Approval, Config};
use crate::dispatch::{By, ReviewOf, Rule, Step};
use crate::web::{find_machine, start_session, ApiError, AppState, NewSession};
use axum::extract::State as AxState;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_READ_LINES: u32 = 2000;

const INSTRUCTIONS: &str = "Yardbell runs AI coding agents in tmux sessions on several machines. \
Use list_machines to see which machines are up and how much memory and load they have, \
list_folders to see which git checkouts each machine has, and start_session to start an agent \
in a folder with a task. read_session shows what a session's terminal shows now, \
send_to_session types a reply into it, and review_session starts a reviewer for a session's work.";

pub fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn new_token() -> String {
    use rand::Rng;
    let suffix: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();
    format!("yb_{suffix}")
}

// Dispatch's own Claude Code, which says which conversation it works for, or any other client
// holding the MCP token.
enum Caller {
    Dispatch(Option<String>),
    Client,
}

fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
}

#[derive(Deserialize)]
struct Rpc {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

pub async fn handle(
    AxState(app): AxState<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let cfg = match app.config() {
        Ok(cfg) => cfg,
        Err(e) => return e.into_response(),
    };
    let given = bearer(&headers);
    let dispatch = token_matches(app.dispatch.token(), given);
    if cfg.mcp_token.is_none() && !dispatch {
        return crate::web::error(
            StatusCode::NOT_FOUND,
            "the MCP server is off, turn it on in Settings",
        );
    }
    if !dispatch && !token_matches(cfg.mcp_token.as_deref().unwrap_or_default(), given) {
        return crate::web::error(StatusCode::UNAUTHORIZED, "wrong or missing MCP token");
    }
    let rpc: Rpc = match serde_json::from_slice(&body) {
        Ok(rpc) => rpc,
        Err(e) => {
            return reply(
                Value::Null,
                Err((-32700, format!("not a JSON-RPC request: {e}"))),
            )
        }
    };
    let Some(id) = rpc.id else {
        return StatusCode::ACCEPTED.into_response();
    };
    let caller = if dispatch {
        let conversation = headers
            .get(crate::dispatch::CONVERSATION_HEADER)
            .and_then(|v| v.to_str().ok())
            .filter(|id| crate::dispatch::valid_id(id))
            .map(str::to_string);
        Caller::Dispatch(conversation)
    } else {
        Caller::Client
    };
    let result = match rpc.method.as_str() {
        "initialize" => Ok(initialize(&rpc.params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        // A call that changes something finishes, and is recorded, even when the caller hangs up.
        "tools/call" => {
            let app = app.clone();
            tokio::spawn(async move { call(&app, &rpc.params, &caller).await })
                .await
                .map_err(|e| (-32603, e.to_string()))
        }
        other => Err((-32601, format!("unknown method {other}"))),
    };
    reply(id, result)
}

fn reply(id: Value, result: Result<Value, (i32, String)>) -> Response {
    let body = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    };
    Json(body).into_response()
}

fn initialize(params: &Value) -> Value {
    let asked = params["protocolVersion"].as_str().unwrap_or_default();
    let version = PROTOCOL_VERSIONS
        .iter()
        .find(|v| **v == asked)
        .unwrap_or(&PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "yardbell", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
    })
}

fn tools() -> Vec<Value> {
    let machine = json!({ "type": "string", "description": "Machine name from list_machines" });
    let session = json!({ "type": "string", "description": "tmux session name from list_sessions or start_session" });
    vec![
        tool(
            "list_machines",
            "Every machine: whether it is up (and why not), memory total and free in GB, the share used by agents, load average, CPU count and how many agent sessions run there.",
            json!({}),
            &[],
        ),
        tool(
            "list_sessions",
            "Agent sessions on every machine, or on one: agent, folder, ticket, branch, whether it is working or idle, and its tmux session name when it can be read or typed into.",
            json!({ "machine": machine }),
            &[],
        ),
        tool(
            "list_folders",
            "Git checkouts Yardbell knows on every machine, or on one, with their current branch, plus the folders recently used for new sessions.",
            json!({ "machine": machine }),
            &[],
        ),
        tool(
            "start_session",
            "Start an agent in a new tmux session on a machine. Give folder (a label from list_folders) or path. A branch other than the current one gets its own git worktree. prompt is the task the agent starts with.",
            json!({
                "machine": machine,
                "folder": { "type": "string", "description": "Folder label from list_folders" },
                "path": { "type": "string", "description": "Absolute path on the machine, instead of folder" },
                "branch": { "type": "string", "description": "Branch to work on; empty keeps the current one" },
                "new_branch": { "type": "boolean", "description": "Create branch from base" },
                "base": { "type": "string", "description": "Base branch for a new branch" },
                "agent": { "type": "string", "description": "Agent name, like claude or codex; empty uses the default" },
                "prompt": { "type": "string", "description": "The task to start the agent with" },
            }),
            &["machine"],
        ),
        tool(
            "read_session",
            "What a session's terminal shows now, including scrollback.",
            json!({
                "machine": machine,
                "name": session,
                "lines": { "type": "integer", "description": "Scrollback lines to include, default 80, at most 2000" },
            }),
            &["machine", "name"],
        ),
        tool(
            "send_to_session",
            "Type text into a session and press Enter, for example to answer an agent that is waiting.",
            json!({ "machine": machine, "name": session, "text": { "type": "string" } }),
            &["machine", "name", "text"],
        ),
        tool(
            "stop_session",
            "End a tmux session and the agent in it.",
            json!({ "machine": machine, "name": session }),
            &["machine", "name"],
        ),
        tool(
            "review_session",
            "Start a reviewer for a session's work: a new session in the same folder that reviews its branch against the branch it was made from, runs the tests, changes no files, and ends with a report of findings. name is the session to review.",
            json!({
                "machine": machine,
                "name": session,
                "agent": { "type": "string", "description": "Agent for the reviewer; empty uses the default" },
                "focus": { "type": "string", "description": "Anything the reviewer should look at closely" },
            }),
            &["machine", "name"],
        ),
    ]
}

async fn call(app: &AppState, params: &Value, caller: &Caller) -> Value {
    let name = params["name"].as_str().unwrap_or_default();
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let outcome = match caller {
        Caller::Dispatch(conversation) if crate::dispatch::changes_something(name) => {
            dispatch_step(app, conversation.as_deref(), name, args).await
        }
        _ => run_tool(app, name, args)
            .await
            .map(|value| serde_json::to_string_pretty(&value).unwrap_or_default()),
    };
    let (text, is_error) = match outcome {
        Ok(text) => (text, false),
        Err(ApiError(_, message)) => (message, true),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn proposal_note(id: &str) -> String {
    format!(
        "Not run yet. This is now proposal {id}, waiting in Dispatch for the user, who can \
approve it, edit it first, or reject it. Do not call it again and do not assume it ran. Once you \
have proposed everything you planned, end your reply with a sentence on what you proposed; the \
user's next message starts with what happened to it."
    )
}

// Dispatch's steps that change something run, wait for the person or are refused, as the
// approval setting and its rules say. Either way the step is checked first, so a mistake goes back
// to Dispatch to correct instead of to the person to approve.
async fn dispatch_step(
    app: &AppState,
    conversation: Option<&str>,
    name: &str,
    args: Value,
) -> Result<String, ApiError> {
    let cfg = app.config()?;
    let (tool, input, review) = plan(app, &cfg, name, args)?;
    let step = step_of(app, name, &input);
    let verdict = crate::dispatch::decide_step(cfg.dispatch.approval, &cfg.dispatch.rules, &step);
    match (verdict.approval, conversation) {
        (Approval::Deny, _) => Err(ApiError(
            StatusCode::FORBIDDEN,
            refusal(verdict.rule, &step),
        )),
        (Approval::Prompt, None) => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Yardbell cannot tell which Dispatch conversation this came from, so it did not run it"
                .into(),
        )),
        (Approval::Prompt, Some(conversation)) => {
            let event = app
                .dispatch
                .propose(
                    conversation,
                    &tool,
                    input,
                    By::Dispatch,
                    review,
                    verdict.rule,
                )
                .map_err(|e| ApiError(StatusCode::NOT_FOUND, e.message().to_string()))?;
            Ok(proposal_note(event["id"].as_str().unwrap_or_default()))
        }
        (Approval::Allow, conversation) => {
            let outcome = perform(app, &tool, input.clone()).await;
            if let Some(conversation) = conversation {
                let recorded = outcome.as_ref().map(Value::clone).map_err(|e| e.1.clone());
                app.dispatch
                    .record(conversation, &tool, input, review, verdict.rule, &recorded);
            }
            outcome.map(|value| serde_json::to_string_pretty(&value).unwrap_or_default())
        }
    }
}

fn refusal(rule: Option<&Rule>, step: &Step) -> String {
    let why = match rule {
        Some(rule) if step.folders.is_none() && !rule.folder.is_empty() => format!(
            "the user's Dispatch rule \"{}\" refuses it, because Yardbell cannot tell which folder \
the session is in",
            rule.describe()
        ),
        Some(rule) => format!(
            "the user's Dispatch rule \"{}\" refuses it",
            rule.describe()
        ),
        None => "the user's Dispatch settings refuse steps that change something unless a rule \
allows them, and no rule allows this one"
            .into(),
    };
    format!(
        "Refused, not run: {why}. Tell the user which rule stopped it; they can change it in \
Yardbell's Settings, under Dispatch. Do not try it again or reach the same result another way."
    )
}

// What the rules match a step on. The folder is the one the step works in: the folder it starts
// in, the folder of the session it reviews, or the folder of the session it stops or types into.
fn step_of(app: &AppState, called: &str, input: &Value) -> Step {
    let machine = input["machine"].as_str().unwrap_or_default().to_string();
    let snap = app.state.snapshot(&machine).unwrap_or_default();
    let text = |key: &str| input[key].as_str().unwrap_or_default().trim().to_string();
    let folders = match called {
        "start_session" | "review_session" => {
            let path = match text("path") {
                path if path.is_empty() => snap.folder_paths.get(&text("folder")).cloned(),
                path => Some(path),
            };
            path.map(|path| {
                let label = snap
                    .folder_paths
                    .iter()
                    .filter(|(_, p)| path == **p || path.starts_with(&format!("{p}/")))
                    .max_by_key(|(_, p)| p.len())
                    .map(|(label, _)| label.clone());
                label.into_iter().chain([path]).collect()
            })
        }
        _ => snap
            .sessions
            .iter()
            .find(|s| s.tmux.as_deref() == Some(text("name").as_str()))
            .map(|s| vec![s.folder.clone(), s.cwd.clone()]),
    };
    Step {
        action: called.to_string(),
        machine,
        folders,
    }
}

#[derive(Deserialize)]
struct ReviewArgs {
    machine: String,
    name: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    focus: String,
}

// What a step will run: review_session becomes the start_session that starts the reviewer.
fn plan(
    app: &AppState,
    cfg: &Config,
    name: &str,
    args: Value,
) -> Result<(String, Value, Option<ReviewOf>), ApiError> {
    if name == "review_session" {
        let r: ReviewArgs = arg(args)?;
        let (input, of) = review_plan(app, cfg, &r.machine, &r.name, "", &r.agent, &r.focus)?;
        return Ok(("start_session".into(), input, Some(of)));
    }
    check(app, cfg, name, &args)?;
    Ok((name.to_string(), args, None))
}

pub fn check(app: &AppState, cfg: &Config, tool: &str, input: &Value) -> Result<(), ApiError> {
    match tool {
        "start_session" => arg::<NewSession>(input.clone())?.check(app, cfg),
        "send_to_session" | "stop_session" => {
            let r: SessionRef = arg(input.clone())?;
            find_machine(cfg, &r.machine)?;
            if r.name.trim().is_empty() {
                return Err(ApiError(StatusCode::BAD_REQUEST, "name is empty".into()));
            }
            if tool == "send_to_session" && r.text.is_empty() {
                return Err(ApiError(StatusCode::BAD_REQUEST, "text is empty".into()));
            }
            Ok(())
        }
        other => Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("{other} is not a step that changes anything"),
        )),
    }
}

// The reviewer runs in the reviewed session's own folder, so it sees the branch as that session
// left it, uncommitted changes included. A session that has ended is found by its folder.
pub fn review_plan(
    app: &AppState,
    cfg: &Config,
    machine: &str,
    name: &str,
    path: &str,
    agent: &str,
    focus: &str,
) -> Result<(Value, ReviewOf), ApiError> {
    let m = find_machine(cfg, machine)?;
    let snap = app.state.snapshot(&m.name).unwrap_or_default();
    let running = snap
        .sessions
        .iter()
        .find(|s| s.tmux.as_deref() == Some(name));
    let path = running
        .map(|s| s.cwd.clone())
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or_else(|| path.to_string());
    if path.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("no session named {name} on {machine}"),
        ));
    }
    let branch = running.map(|s| s.branch.clone()).unwrap_or_else(|| {
        snap.folder_paths
            .iter()
            .find(|(_, p)| **p == path)
            .and_then(|(label, _)| snap.folders.get(label).cloned())
            .unwrap_or_default()
    });
    let agent = if agent.is_empty() {
        cfg.dispatch.agent.clone()
    } else {
        agent.to_string()
    };
    let mut input = json!({
        "machine": m.name,
        "path": path,
        "prompt": crate::dispatch::review_prompt(&branch, focus),
    });
    if !agent.is_empty() {
        input["agent"] = json!(agent);
    }
    let of = ReviewOf {
        machine: m.name.clone(),
        name: name.to_string(),
        path,
        branch,
    };
    Ok((input, of))
}

pub async fn perform(app: &AppState, tool: &str, input: Value) -> Result<Value, ApiError> {
    if !crate::dispatch::changes_something(tool) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("{tool} is not a step that changes anything"),
        ));
    }
    run_tool(app, tool, input).await
}

fn arg<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))
}

#[derive(Deserialize)]
struct MachineFilter {
    #[serde(default)]
    machine: String,
}

#[derive(Deserialize)]
struct SessionRef {
    machine: String,
    name: String,
    #[serde(default)]
    lines: Option<u32>,
    #[serde(default)]
    text: String,
}

async fn run_tool(app: &AppState, name: &str, args: Value) -> Result<Value, ApiError> {
    let cfg = app.config()?;
    let view = app.state.view(&cfg, app.ports.as_ref(), "localhost");
    let wanted = |m: &str, filter: &str| filter.is_empty() || m == filter;
    match name {
        "list_machines" => Ok(json!(view
            .machines
            .iter()
            .map(|m| {
                let sessions = view
                    .sessions
                    .iter()
                    .filter(|s| s.machine == m.name && !s.stale)
                    .count();
                let gb = |kb: u64| (kb as f64 / 1_048_576.0 * 10.0).round() / 10.0;
                json!({
                    "name": m.name,
                    "up": m.up,
                    "reason": m.reason,
                    "local": m.local,
                    "mem_total_gb": m.health.as_ref().map(|h| gb(h.mem_total_kb)),
                    "mem_free_gb": m.health.as_ref().map(|h| gb(h.room_kb())),
                    "mem_limit_gb": m.health.as_ref().filter(|h| h.limit_kb > 0).map(|h| gb(h.limit_kb)),
                    "mem_agents_gb": m.health.as_ref().map(|h| gb(h.agent_kb)),
                    "mem_mine_gb": m.health.as_ref().map(|h| gb(h.user_kb.max(h.agent_kb))),
                    "load1": m.health.as_ref().map(|h| h.load1),
                    "cpus": m.health.as_ref().map(|h| h.cpus),
                    "disk_total_gb": m.health.as_ref().map(|h| gb(h.disk_total_kb)),
                    "disk_free_gb": m.health.as_ref().map(|h| gb(h.disk_total_kb.saturating_sub(h.disk_used_kb))),
                    "agent_sessions": sessions,
                })
            })
            .collect::<Vec<_>>())),
        "list_sessions" => {
            let f: MachineFilter = arg(args)?;
            Ok(json!(view
                .sessions
                .iter()
                .filter(|s| wanted(&s.machine, &f.machine))
                .map(|s| json!({
                    "machine": s.machine,
                    "agent": s.agent,
                    "folder": s.folder,
                    "ticket": s.ticket,
                    "branch": s.branch,
                    "activity": s.activity,
                    "tmux": s.tmux,
                    "last_known": s.stale,
                }))
                .collect::<Vec<_>>()))
        }
        "list_folders" => {
            let f: MachineFilter = arg(args)?;
            let folders: Vec<_> = view
                .folders
                .iter()
                .filter(|d| wanted(&d.machine, &f.machine))
                .collect();
            let recent: Vec<_> = cfg
                .machines
                .iter()
                .filter(|m| wanted(&m.name, &f.machine))
                .map(|m| json!({ "machine": m.name, "root": m.root, "recent": m.recent }))
                .collect();
            Ok(json!({ "folders": folders, "machines": recent }))
        }
        "start_session" => {
            let req: NewSession = arg(args)?;
            let machine = req.machine.clone();
            let started = start_session(app, req).await?;
            app.check(&machine).await;
            Ok(started)
        }
        "review_session" => {
            let (_, input, _) = plan(app, &cfg, name, args)?;
            let started = start_session(app, arg(input)?).await?;
            app.refresh().await;
            Ok(started)
        }
        "read_session" | "send_to_session" | "stop_session" => {
            let r: SessionRef = arg(args)?;
            let m = find_machine(&cfg, &r.machine)?;
            let result = match name {
                "read_session" => {
                    let lines = r.lines.unwrap_or(80).clamp(1, MAX_READ_LINES);
                    app.sessions
                        .read(&m, &r.name, lines)
                        .await
                        .map(|text| json!({ "screen": text }))
                }
                "send_to_session" if r.text.is_empty() => {
                    return Err(ApiError(StatusCode::BAD_REQUEST, "text is empty".into()))
                }
                "send_to_session" => {
                    let sent = app.sessions.send(&m, &r.name, &r.text).await;
                    app.recheck(&m.name);
                    sent.map(|_| json!({ "sent": true }))
                }
                _ => {
                    let stopped = app.sessions.stop(&m, &r.name).await;
                    app.check(&m.name).await;
                    stopped.map(|_| json!({ "stopped": true }))
                }
            };
            result.map_err(ApiError::gateway)
        }
        other => Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("unknown tool {other}"),
        )),
    }
}

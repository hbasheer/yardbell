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
in a folder with a task. read_session shows what a session's terminal shows now, and \
send_to_session types a reply into it.";

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
    let relay = token_matches(app.relay.token(), given);
    if cfg.mcp_token.is_none() && !relay {
        return crate::web::error(
            StatusCode::NOT_FOUND,
            "the MCP server is off, turn it on in Settings",
        );
    }
    if !relay && !token_matches(cfg.mcp_token.as_deref().unwrap_or_default(), given) {
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
    let result = match rpc.method.as_str() {
        "initialize" => Ok(initialize(&rpc.params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call(&app, &rpc.params).await),
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
    ]
}

async fn call(app: &AppState, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or_default();
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let (text, is_error) = match run_tool(app, name, args).await {
        Ok(value) => (
            serde_json::to_string_pretty(&value).unwrap_or_default(),
            false,
        ),
        Err(ApiError(_, message)) => (message, true),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
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
                    "mem_free_gb": m.health.as_ref().map(|h| gb(h.mem_total_kb.saturating_sub(h.mem_used_kb))),
                    "mem_agents_gb": m.health.as_ref().map(|h| gb(h.agent_kb)),
                    "load1": m.health.as_ref().map(|h| h.load1),
                    "cpus": m.health.as_ref().map(|h| h.cpus),
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
            let started = start_session(app, req).await?;
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
                "send_to_session" => app
                    .sessions
                    .send(&m, &r.name, &r.text)
                    .await
                    .map(|_| json!({ "sent": true })),
                _ => {
                    let stopped = app.sessions.stop(&m, &r.name).await;
                    app.refresh().await;
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

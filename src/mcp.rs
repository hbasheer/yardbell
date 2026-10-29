use crate::config::{Approval, Config};
use crate::dispatch::{By, ChildStart, MemoryChange, ReviewOf, Rule, Step};
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
send_to_session types a reply into it, review_session starts a reviewer for a session's work, \
scan_folder starts a read-only scan of a folder for dead code, test gaps or security problems, \
start_group starts several sessions as one group whose results Dispatch gathers, \
integrate_branches merges several branches into a new one, push_branch pushes a branch after a \
secret scan, remove_worktree removes a finished worktree, and move_session moves a session's \
branch, uncommitted changes and task to another machine.";

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
    let token = match app
        .secrets()
        .and_then(|s| cfg.mcp_token(&s).map_err(ApiError::internal))
    {
        Ok(token) => token,
        Err(e) if dispatch => {
            tracing::warn!(error = %e.1, "the MCP token cannot be read");
            None
        }
        Err(e) => return e.into_response(),
    };
    if token.is_none() && !dispatch {
        return crate::web::error(
            StatusCode::NOT_FOUND,
            "the MCP server is off, turn it on in Settings",
        );
    }
    if !dispatch && !token_matches(token.as_deref().unwrap_or_default(), given) {
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
        if let Some(id) = &conversation {
            app.dispatch.reached(id);
        }
        Caller::Dispatch(conversation)
    } else {
        Caller::Client
    };
    let result = match rpc.method.as_str() {
        "initialize" => Ok(initialize(&rpc.params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools()
            .into_iter()
            .filter(|t| dispatch || t["name"] != "remember")
            .collect::<Vec<_>>() })),
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
    let mut all = vec![
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
        tool(
            "scan_folder",
            "Start a read-only scan of a folder: a new session there looks through all of its code (not a branch's changes) for one kind of problem, changes no files, and ends with a report of findings. kind is dead_code (unused functions, modules, routes, assets and config), test_gaps (important code without tests; it runs the project's tests) or security (secrets in the repository, injection, unsafe deserialization, missing auth checks, dependency advisories). Give folder (a label from list_folders) or path (a checkout, or a folder inside one, to scan only that part).",
            json!({
                "machine": machine,
                "kind": { "type": "string", "enum": ["dead_code", "test_gaps", "security"], "description": "What to look for" },
                "folder": { "type": "string", "description": "Folder label from list_folders" },
                "path": { "type": "string", "description": "Absolute path on the machine, instead of folder" },
                "agent": { "type": "string", "description": "Agent for the scanner; empty uses the default" },
                "focus": { "type": "string", "description": "Anything the scanner should look at closely" },
            }),
            &["machine", "kind"],
        ),
        tool(
            "start_group",
            "Start several sessions as one group, for example three approaches to the same bug, or the same task in two repositories. Each child is what start_session takes (machine, folder or path, branch, new_branch, base, agent, prompt) plus a short label. Children in the same checkout need different branches. The user's rules decide each child's start on its own, so some may run at once, wait for approval or be refused. Each child's task is told to end with a YARDBELL RESULT block. When every child that started is done (idle after working, or ended), or timeout_minutes after the last one was decided, Yardbell reads each child's result and posts them together as one Results card. gather is what you will do with the combined results, like comparing them and recommending one: when given, Yardbell starts one more turn of yours as soon as the results are in. Leave it empty when the user only wants to see the results; you then hear them with the user's next message. Only Dispatch can start a group.",
            json!({
                "title": { "type": "string", "description": "What the group is for, shown on its card" },
                "children": {
                    "type": "array",
                    "minItems": crate::dispatch::GROUP_MIN,
                    "maxItems": crate::dispatch::GROUP_MAX,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": { "type": "string", "description": "A few words that tell this child from the others, like \"Patch the guard\"" },
                            "machine": machine,
                            "folder": { "type": "string", "description": "Folder label from list_folders" },
                            "path": { "type": "string", "description": "Absolute path on the machine, instead of folder" },
                            "branch": { "type": "string", "description": "Branch to work on; empty keeps the current one" },
                            "new_branch": { "type": "boolean", "description": "Create branch from base" },
                            "base": { "type": "string", "description": "Base branch for a new branch" },
                            "agent": { "type": "string", "description": "Agent name; empty uses the default" },
                            "prompt": { "type": "string", "description": "The task this child starts with" },
                        },
                        "required": ["label", "machine", "prompt"],
                    },
                },
                "gather": { "type": "string", "description": "What you will do with the combined results; starts a turn of yours when they are in. Empty waits for the user's next message" },
                "timeout_minutes": { "type": "integer", "minimum": 1, "maximum": crate::dispatch::GROUP_MAX_MINUTES, "description": "Gather after this long even if some children are not done, default 60" },
            }),
            &["children"],
        ),
        tool(
            "remove_worktree",
            "Remove a git worktree that Yardbell or anyone made, with git worktree remove and prune. It never removes a repository's main checkout, refuses while a session runs in it, and refuses when it has uncommitted changes or commits that no remote or other branch has; only the user can remove those, in Yardbell. delete_branch also deletes its branch when that is merged.",
            json!({
                "machine": machine,
                "path": { "type": "string", "description": "Absolute path of the worktree" },
                "folder": { "type": "string", "description": "Folder label from list_folders, instead of path" },
                "delete_branch": { "type": "boolean", "description": "Also delete the branch if it is merged" },
            }),
            &["machine"],
        ),
        tool(
            "integrate_branches",
            "Bring several branches made from the same base together on a new branch, in its own worktree: one at a time in the order given, by merge or by rebase (each branch's commits replayed on top). It stops at the first conflict, undoes it, and reports the branch and the conflicting files. Nothing is pushed. folder or path is the repository's main checkout.",
            json!({
                "machine": machine,
                "folder": { "type": "string", "description": "Folder label from list_folders" },
                "path": { "type": "string", "description": "Absolute path of the repository, instead of folder" },
                "base": { "type": "string", "description": "The branch they were made from, like main or origin/main" },
                "branches": { "type": "array", "items": { "type": "string" }, "description": "Branches to integrate, in order" },
                "into": { "type": "string", "description": "Name of the new integration branch" },
                "method": { "type": "string", "enum": ["merge", "rebase"], "description": "merge (the default) or rebase" },
            }),
            &["machine", "base", "branches", "into"],
        ),
        tool(
            "push_branch",
            "Push a branch to a remote, never forced. First every commit it would push is scanned for keys, tokens and the values of the user's saved secrets; a hit blocks the push and names file and line, never the value.",
            json!({
                "machine": machine,
                "folder": { "type": "string", "description": "Folder label from list_folders" },
                "path": { "type": "string", "description": "Absolute path of a checkout or worktree that has the branch" },
                "branch": { "type": "string" },
                "remote": { "type": "string", "description": "Remote name, default origin" },
            }),
            &["machine", "branch"],
        ),
        tool(
            "move_session",
            "Move a session's work to another machine without committing or pushing: its branch and uncommitted changes go over ssh into a worktree there, and the same agent starts there with the original task and a note that it continued from this machine. to defaults to the machine with the most free memory that has the repository. stop_original also stops the session here once the new one runs.",
            json!({
                "machine": machine,
                "name": session,
                "to": { "type": "string", "description": "Machine to move to; empty picks the one with the most room" },
                "folder": { "type": "string", "description": "The repository's folder label on the target, when it differs" },
                "task": { "type": "string", "description": "The task for the agent there; empty reuses the original task when Yardbell knows it" },
                "stop_original": { "type": "boolean", "description": "Stop the original session after the move" },
            }),
            &["machine", "name"],
        ),
        tool(
            "remember",
            "Propose a change to your memory, the notes the user keeps with you across conversations, shown in your instructions between the memory tags. change is add (entry is the new note), replace (old is an entry exactly as it is in memory, entry is what it becomes) or forget (old is the entry to drop). reason is what the user said or did that makes it worth keeping. Unless the user's rules say otherwise, it becomes a step the user approves, edits or rejects, and nothing is saved before that. Keep an entry to one short sentence, and never store a secret.",
            json!({
                "change": { "type": "string", "enum": ["add", "replace", "forget"] },
                "entry": { "type": "string", "description": "The note to add, or what the old one becomes; not used to forget" },
                "old": { "type": "string", "description": "For replace and forget: the entry exactly as it is in memory" },
                "reason": { "type": "string", "description": "What the user said or did that makes this worth remembering" },
            }),
            &["change", "reason"],
        ),
    ];
    all.extend(crate::mcp_read::tools());
    all
}

async fn call(app: &AppState, params: &Value, caller: &Caller) -> Value {
    let name = params["name"].as_str().unwrap_or_default();
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let outcome = match caller {
        Caller::Dispatch(conversation) if name == "start_group" => {
            dispatch_group(app, conversation.as_deref(), args).await
        }
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
    let verdict = if name == "remember" {
        crate::dispatch::decide_memory(cfg.dispatch.approval, &cfg.dispatch.rules)
    } else {
        crate::dispatch::decide_step(cfg.dispatch.approval, &cfg.dispatch.rules, &step)
    };
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
    format!(
        "Refused, not run: {}. Tell the user which rule stopped it; they can change it in \
Yardbell's Settings, under Dispatch. Do not try it again or reach the same result another way.",
        why_refused(rule, step)
    )
}

fn why_refused(rule: Option<&Rule>, step: &Step) -> String {
    match rule {
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
    }
}

// Where each child would work, as the clash check compares them: a folder is its path on the
// machine, when Yardbell knows it.
pub fn group_places(app: &AppState, inputs: &[Value]) -> Vec<crate::dispatch::GroupPlace> {
    inputs
        .iter()
        .map(|input| {
            let text = |key: &str| input[key].as_str().unwrap_or_default().trim().to_string();
            let machine = text("machine");
            let repo = match text("path") {
                path if path.is_empty() => {
                    let folder = text("folder");
                    app.state
                        .snapshot(&machine)
                        .and_then(|snap| snap.folder_paths.get(&folder).cloned())
                        .unwrap_or(folder)
                }
                path => path.trim_end_matches('/').to_string(),
            };
            crate::dispatch::GroupPlace {
                machine,
                repo,
                branch: text("branch"),
            }
        })
        .collect()
}

pub fn group_clash(app: &AppState, inputs: &[Value]) -> Result<(), ApiError> {
    let places = group_places(app, inputs);
    match crate::dispatch::group_clash(&places) {
        Some(pair) => Err(bad(crate::dispatch::group_clash_message(&places, pair))),
        None => Ok(()),
    }
}

// A group is checked as a whole first, then each child's start is decided by the rules on its
// own: the ones allowed start now, one after another, the ones that ask wait in the group's card,
// and a refused one stays there with the reason while the others go on.
async fn dispatch_group(
    app: &AppState,
    conversation: Option<&str>,
    args: Value,
) -> Result<String, ApiError> {
    let cfg = app.config()?;
    let plan = crate::dispatch::plan_group(args).map_err(bad)?;
    for (i, child) in plan.children.iter().enumerate() {
        check(app, &cfg, "start_session", &child.input).map_err(|ApiError(status, m)| {
            ApiError(status, format!("child {} ({}): {m}", i + 1, child.label))
        })?;
    }
    let inputs: Vec<Value> = plan.children.iter().map(|c| c.input.clone()).collect();
    group_clash(app, &inputs)?;
    let Some(conversation) = conversation else {
        return Err(bad(
            "Yardbell cannot tell which Dispatch conversation this came from, so it started nothing"
                .into(),
        ));
    };
    let starts: Vec<ChildStart> = plan
        .children
        .iter()
        .map(|child| {
            let step = step_of(app, "start_session", &child.input);
            let verdict =
                crate::dispatch::decide_step(cfg.dispatch.approval, &cfg.dispatch.rules, &step);
            let rule = verdict.rule.cloned();
            match verdict.approval {
                Approval::Deny => ChildStart::Refuse {
                    reason: why_refused(verdict.rule, &step),
                    rule,
                },
                Approval::Prompt => ChildStart::Ask(rule),
                Approval::Allow => ChildStart::Run(rule),
            }
        })
        .collect();
    if starts
        .iter()
        .all(|s| matches!(s, ChildStart::Refuse { .. }))
    {
        let why: Vec<String> = plan
            .children
            .iter()
            .zip(&starts)
            .enumerate()
            .filter_map(|(i, (child, start))| match start {
                ChildStart::Refuse { reason, .. } => {
                    Some(format!("{}) {}: {reason}.", i + 1, child.label))
                }
                _ => None,
            })
            .collect();
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            format!(
                "Refused, not run: the user's rules refuse every child of this group. {} Tell the \
user which rules stopped them; they can change them in Yardbell's Settings, under Dispatch. Do not \
try again or reach the same result another way.",
                why.join(" ")
            ),
        ));
    }
    let crate::dispatch::GroupOpened {
        group,
        steps,
        follows,
    } = app
        .dispatch
        .open_group(conversation, &plan, &starts)
        .map_err(|e| ApiError(StatusCode::NOT_FOUND, e.message().to_string()))?;
    let mut lines = Vec::new();
    for (i, ((child, start), step)) in plan.children.iter().zip(&starts).zip(&steps).enumerate() {
        let n = i + 1;
        let label = &child.label;
        let line = match (start, step) {
            (ChildStart::Refuse { reason, .. }, _) => {
                format!("{n}) {label}: refused, not run: {reason}. Tell the user.")
            }
            (ChildStart::Ask(_), Some(step)) => {
                format!("{n}) {label}: proposal {step}, waiting for the user's approval.")
            }
            (ChildStart::Run(_), Some(step)) => {
                let input = app
                    .dispatch
                    .run_input(conversation, step, child.input.clone());
                let outcome = perform(app, "start_session", input)
                    .await
                    .map_err(|ApiError(_, message)| message);
                let _ = app.dispatch.ran(conversation, step, &outcome);
                match outcome {
                    Ok(v) => format!(
                        "{n}) {label}: started as {} on {}.",
                        v["name"].as_str().unwrap_or_default(),
                        v["machine"].as_str().unwrap_or_default()
                    ),
                    Err(e) => format!("{n}) {label}: failed to start: {e}"),
                }
            }
            (_, None) => continue,
        };
        lines.push(line);
    }
    let then = match (follows, plan.gather.is_empty()) {
        (true, _) => "Yardbell then starts a turn of yours with them and your gather instruction.",
        (false, true) => "You hear the results with the user's next message.",
        (false, false) => {
            "This group was started in a turn Yardbell sent, so it starts no turn of its own: you \
hear the results, and act on your gather instruction, with the user's next message."
        }
    };
    Ok(format!(
        "Group {group} \"{}\":\n{}\n\nDo not call start_group or start_session again for these \
children. When every child that started is done, or {} minutes after the last one was decided, \
Yardbell posts their results in one card. {then} End your reply with a sentence on what you \
started or proposed.",
        plan.title,
        lines.join("\n"),
        plan.minutes
    ))
}

// What the rules match a step on. The folder is the one the step works in: the folder it starts
// in or scans, the folder of the session it reviews, or the folder of the session it stops or
// types into.
pub(crate) fn step_of(app: &AppState, called: &str, input: &Value) -> Step {
    if called == "remember" {
        return Step {
            action: called.to_string(),
            machine: String::new(),
            folders: Some(Vec::new()),
        };
    }
    let machine = input["machine"].as_str().unwrap_or_default().to_string();
    let snap = app.state.snapshot(&machine).unwrap_or_default();
    let text = |key: &str| input[key].as_str().unwrap_or_default().trim().to_string();
    let folders = match called {
        "start_session" | "review_session" | "scan_folder" | "remove_worktree"
        | "integrate_branches" | "push_branch" => {
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
struct ScanArgs {
    machine: String,
    kind: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    focus: String,
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

// What a step will run: review_session and scan_folder become the start_session that starts the
// reviewer or the scanner.
pub(crate) fn plan(
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
    if name == "scan_folder" {
        let s: ScanArgs = arg(args)?;
        let target = ScanTarget {
            machine: &s.machine,
            folder: &s.folder,
            path: &s.path,
            session: "",
        };
        let (input, of) = scan_plan(app, cfg, &target, &s.kind, &s.agent, &s.focus)?;
        return Ok(("start_session".into(), input, Some(of)));
    }
    if name == "remember" {
        let change: MemoryChange = arg(args)?;
        check_memory(app, &change)?;
        return Ok((name.to_string(), json!(change), None));
    }
    check(app, cfg, name, &args)?;
    Ok((name.to_string(), args, None))
}

fn check_memory(app: &AppState, change: &MemoryChange) -> Result<(), ApiError> {
    app.dispatch
        .memory()
        .check(change, By::Dispatch)
        .map_err(bad)
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
        "remember" => check_memory(app, &arg(input.clone())?),
        tool if crate::web::worktrees_api::TOOLS.contains(&tool) => {
            crate::web::worktrees_api::check(app, cfg, tool, input)
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
    let shots = screenshots(&snap, running.map(|s| s.folder.as_str()), &path);
    let prompt = crate::dispatch::review_prompt(&branch, focus, shots.as_ref());
    let mut input = json!({
        "machine": m.name,
        "path": path,
        "prompt": read_only_prompt(cfg, &agent, prompt),
        "read_only": true,
    });
    if !agent.is_empty() {
        input["agent"] = json!(agent);
    }
    let of = ReviewOf {
        machine: m.name.clone(),
        name: name.to_string(),
        path,
        branch,
        evidence: shots.map(|s| s.folder).unwrap_or_default(),
        scan: String::new(),
    };
    Ok((input, of))
}

pub struct ScanTarget<'a> {
    pub machine: &'a str,
    pub folder: &'a str,
    pub path: &'a str,
    // The session the scan was started from, which its findings go back to by default.
    pub session: &'a str,
}

fn bad(message: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message)
}

// The scanner runs in the folder it scans, which can be a whole checkout or a folder inside one.
pub fn scan_plan(
    app: &AppState,
    cfg: &Config,
    target: &ScanTarget,
    kind: &str,
    agent: &str,
    focus: &str,
) -> Result<(Value, ReviewOf), ApiError> {
    let m = find_machine(cfg, target.machine)?;
    let kind = crate::dispatch::ScanKind::parse(kind)
        .ok_or_else(|| bad("kind must be dead_code, test_gaps or security".into()))?;
    let snap = app.state.snapshot(&m.name).unwrap_or_default();
    let path = match (target.path.trim(), target.folder.trim()) {
        ("", "") => return Err(bad("give a folder from list_folders, or a path".into())),
        ("", folder) => snap
            .folder_paths
            .get(folder)
            .cloned()
            .ok_or_else(|| bad(format!("{} has no folder {folder}", m.name)))?,
        (path, _) if !path.starts_with('/') || path.chars().any(char::is_control) => {
            return Err(bad(format!(
                "{path} is not an absolute path; give one, or a folder from list_folders"
            )))
        }
        (path, _) => path.trim_end_matches('/').to_string(),
    };
    if path.is_empty() {
        return Err(bad("scanning / is not supported; give a folder".into()));
    }
    let branch = snap
        .folder_paths
        .iter()
        .find(|(_, p)| **p == path)
        .and_then(|(label, _)| snap.folders.get(label).cloned())
        .unwrap_or_default();
    let agent = if agent.is_empty() {
        cfg.dispatch.agent.clone()
    } else {
        agent.to_string()
    };
    if !agent.is_empty() && cfg.agent(&agent).is_none() {
        return Err(bad(format!("no agent named {agent}")));
    }
    let prompt = crate::dispatch::scan_prompt(kind, focus);
    let mut input = json!({
        "machine": m.name,
        "path": path,
        "prompt": read_only_prompt(cfg, &agent, prompt),
        "read_only": true,
    });
    if !agent.is_empty() {
        input["agent"] = json!(agent);
    }
    let of = ReviewOf {
        machine: m.name.clone(),
        name: target.session.to_string(),
        path,
        branch,
        evidence: String::new(),
        scan: kind.key().to_string(),
    };
    Ok((input, of))
}

// Claude Code and Codex start unable to edit files; any other agent is only asked not to, and is
// told so.
fn read_only_prompt(cfg: &Config, agent: &str, mut prompt: String) -> String {
    let name = if agent.is_empty() {
        cfg.default_agent()
    } else {
        agent
    };
    let enforced = cfg
        .agent(name)
        .is_some_and(|a| a.read_only_flags().is_some());
    if !enforced {
        prompt.push_str(&format!("\n\n{READ_ONLY_BY_INSTRUCTION}"));
    }
    prompt
}

pub const READ_ONLY_BY_INSTRUCTION: &str = "This session is read-only by instruction: Yardbell \
cannot turn off this agent's file editing, so it relies on you to change no files.";

// The reviewer runs on the reviewed session's machine, so it opens the app's ports there.
fn screenshots(
    snap: &crate::snapshot::Snapshot,
    folder: Option<&str>,
    path: &str,
) -> Option<crate::dispatch::Screenshots> {
    let folder = folder.map(str::to_string).or_else(|| {
        snap.folder_paths
            .iter()
            .find(|(_, p)| **p == path)
            .map(|(label, _)| label.clone())
    })?;
    let apps: Vec<String> = snap
        .ports
        .get(&folder)?
        .iter()
        .filter(|p| p.listening)
        .map(|p| {
            let host = p.host.as_deref().unwrap_or("localhost");
            format!("http://{host}:{} ({})", p.remote_port, p.service)
        })
        .collect();
    (!apps.is_empty()).then(|| crate::dispatch::Screenshots {
        folder: crate::dispatch::evidence_folder(),
        apps,
    })
}

pub async fn perform(app: &AppState, tool: &str, input: Value) -> Result<Value, ApiError> {
    if !crate::dispatch::changes_something(tool) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("{tool} is not a step that changes anything"),
        ));
    }
    if tool == "remember" {
        return app
            .dispatch
            .memory()
            .apply(&arg(input)?, By::Dispatch)
            .map_err(bad);
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
    if let Some(answer) = crate::mcp_read::read(app, name, &args).await {
        return answer;
    }
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
        "review_session" | "scan_folder" => {
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
        "start_group" => Err(bad(
            "only Dispatch can start a group, since it gathers the results; start each session \
with start_session"
                .into(),
        )),
        "remember" => Err(bad(
            "only Dispatch changes its memory, through a step the user approves; the user edits \
it in Yardbell's Settings, under Dispatch, Memory"
                .into(),
        )),
        tool if crate::web::worktrees_api::TOOLS.contains(&tool) => {
            crate::web::worktrees_api::run_tool(app, tool, args).await
        }
        other => Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("unknown tool {other}"),
        )),
    }
}

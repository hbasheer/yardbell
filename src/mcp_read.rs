use crate::config::Config;
use crate::web::{ApiError, AppState};
use axum::http::StatusCode;
use serde_json::{json, Map, Value};

pub const AREAS: [&str; 11] = [
    "dispatch",
    "triggers",
    "worktree_setup",
    "agents",
    "session_mcp_servers",
    "phone",
    "machines",
    "pipelines",
    "pull_requests",
    "security",
    "about",
];

const HIDDEN: &str = "(hidden)";
const CLIP: usize = 4000;
const TURNS: usize = 20;

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
    })
}

pub fn tools() -> Vec<Value> {
    vec![tool(
        "read_settings",
        "One area of Yardbell's settings as Settings shows it, with what it may be set to. Areas: \
dispatch, triggers, worktree_setup, agents, session_mcp_servers, phone, machines, pipelines, \
pull_requests, security, about. Secrets are never shown: a setting that uses one shows \
${secret:name}, and any other credential shows (hidden).",
        json!({ "area": { "type": "string", "enum": AREAS } }),
        &["area"],
    ),
    tool(
        "list_conversations",
        "Dispatch conversations, newest first, at most 50 (more counts the rest): id, title, when it last changed, how many steps wait for the user, and who started it (you, a trigger or a pipeline run).",
        json!({ "filter": { "type": "string", "enum": ["all", "waiting", "trigger", "pipeline"] } }),
        &[],
    ),
    tool(
        "read_conversation",
        "One Dispatch conversation's newest events (messages, tool calls and step cards), oldest first. Long text is clipped and the answer stays under about 30 000 characters; left_out counts the older events not returned.",
        json!({
            "id": { "type": "string", "description": "Conversation id from list_conversations" },
            "last": { "type": "integer", "minimum": 1, "maximum": 50, "description": "How many of the newest events, default 20" },
        }),
        &["id"],
    ),
    tool(
        "list_tasks",
        "The user's saved Dispatch tasks: name, how many versions it has, and its first line.",
        json!({}),
        &[],
    ),
    tool(
        "read_task",
        "One saved task's text and its versions.",
        json!({ "name": { "type": "string" } }),
        &["name"],
    ),
    tool(
        "list_pipelines",
        "The user's pipelines: id, name, on or off, version, trigger, step names in order, and how many runs are running, waiting and done.",
        json!({}),
        &[],
    ),
    tool(
        "read_pipeline",
        "One pipeline's whole definition and its saved versions, newest first.",
        json!({ "id": { "type": "string", "description": "Pipeline id from list_pipelines" } }),
        &["id"],
    ),
    tool(
        "list_runs",
        "Pipeline runs as summaries, newest first, at most 50 (more counts the rest): id, pipeline, subject, state, step and why it waits.",
        json!({
            "pipeline": { "type": "string", "description": "Only this pipeline's runs" },
            "state": { "type": "string", "enum": ["queued", "running", "waiting", "done", "dropped"] },
        }),
        &[],
    ),
    tool(
        "read_run",
        "One run in full: each step's outcome, report and session, what it waits for, its pull request and its final report.",
        json!({ "id": { "type": "string", "description": "Run id from list_runs" } }),
        &["id"],
    ),
    tool(
        "read_insights",
        "What the Insights page knows: for one session its timeline of working, waiting and idle time and the commands it ran; for a machine, every session Yardbell has seen there.",
        json!({
            "machine": { "type": "string", "description": "Machine name from list_machines" },
            "session": { "type": "string", "description": "tmux session name; leave out for the whole machine" },
        }),
        &["machine"],
    ),
    tool(
        "list_pulls",
        "Pull and merge requests for the branches Yardbell watches: number, title, state, review state, CI and the failing jobs.",
        json!({ "machine": { "type": "string", "description": "Only this machine" } }),
        &[],
    ),
    tool(
        "read_usage",
        "Claude and Codex usage as the sidebar shows it, and which of the two Dispatch runs on.",
        json!({}),
        &[],
    )]
}

fn bad(message: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message)
}

// The read tools' answers, or None for a tool this module does not own.
pub async fn read(app: &AppState, name: &str, args: &Value) -> Option<Result<Value, ApiError>> {
    let answer = answer(app, name, args).await?;
    let saved = saved_values(app);
    Some(answer.map(|v| sweep(v, &saved)))
}

async fn answer(app: &AppState, name: &str, args: &Value) -> Option<Result<Value, ApiError>> {
    match name {
        "read_settings" => Some(settings(app, args["area"].as_str().unwrap_or_default()).await),
        "list_conversations" => Some(Ok(capped(
            "conversations",
            conversations(app, args["filter"].as_str().unwrap_or("all")),
        ))),
        "read_conversation" => Some(conversation(app, args)),
        "list_tasks" => Some(Ok(tasks(app))),
        "read_task" => Some(task(app, args["name"].as_str().unwrap_or_default())),
        "list_pipelines" => Some(Ok(pipelines(app))),
        "read_pipeline" => Some(pipeline(app, args["id"].as_str().unwrap_or_default())),
        "list_runs" => Some(Ok(capped("runs", runs(app, args)))),
        "read_run" => Some(run(app, args["id"].as_str().unwrap_or_default())),
        "read_insights" => Some(insights(app, args)),
        "list_pulls" => Some(Ok(pulls(app, args["machine"].as_str().unwrap_or_default()))),
        "read_usage" => Some(
            app.config()
                .map(|cfg| app.dispatch.usage_card(cfg.dispatch.runs_on)),
        ),
        _ => None,
    }
}

fn credential(key: &str) -> bool {
    let key = key.to_lowercase();
    [
        "token", "secret", "password", "passcode", "auth", "cookie", "key",
    ]
    .iter()
    .any(|w| key.contains(w))
}

// A value that came from the person's config: a ${secret:name} reference stays as written,
// anything else that could be a credential does not leave Yardbell.
fn hide(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let mut rest = String::new();
    let mut refs = 0;
    let mut text = value;
    while let Some(at) = text.find("${secret:") {
        rest.push_str(&text[..at]);
        match text[at..].find('}') {
            Some(end) => {
                refs += 1;
                text = &text[at + end + 1..];
            }
            None => return HIDDEN.to_string(),
        }
    }
    rest.push_str(text);
    let scheme = ["", "bearer", "basic", "token"].contains(&rest.trim().to_lowercase().as_str());
    if refs > 0 && scheme {
        value.to_string()
    } else {
        HIDDEN.to_string()
    }
}

// Walks a settings section: credential fields and every env or header value are hidden; URLs and
// command lines keep their shape with only their credential parts hidden. Keys the person chose
// (QA note folders) are names, never credentials.
fn hidden(value: Value, under_credential: bool) -> Value {
    walk(value, under_credential, false)
}

fn walk(value: Value, under_credential: bool, free_keys: bool) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| {
                    let secret = under_credential
                        || (!free_keys && credential(&k))
                        || k == "env"
                        || k == "headers";
                    let v = match v {
                        Value::String(s)
                            if !secret && ["url", "command", "resume"].contains(&k.as_str()) =>
                        {
                            Value::String(mask(&s))
                        }
                        other => walk(other, secret, k == "qa_notes"),
                    };
                    (k, v)
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|v| walk(v, under_credential, false))
                .collect(),
        ),
        Value::String(s) if under_credential => Value::String(hide(&s)),
        other => other,
    }
}

static MASKS: std::sync::LazyLock<Vec<(regex::Regex, &'static str)>> = std::sync::LazyLock::new(
    || {
        [
        (r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s@]+@", "${1}(hidden)@"),
        (r#"([?&][^=&#\s"']+=)([^&#\s"'$][^&#\s"']*)"#, "${1}(hidden)"),
        (r#"(?i)\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH)[A-Z0-9_]*=)("[^"]*"|'[^']*'|[^\s$(&][^\s&]*)"#, "${1}(hidden)"),
        (r#"(?i)(\s--?[a-z-]*(?:token|key|secret|password|passwd|auth)[a-z-]*(?:=|\s+))("[^"]*"|'[^']*'|[^\s$(-][^\s]*)"#, "${1}(hidden)"),
        (r#"(?i)((?:\s--header|\s-H)(?:=|\s+))("[^"]*"|'[^']*'|[^\s$][^\s]*)"#, "${1}(hidden)"),
        (r#"(?i)\b(bearer|basic|token)\s+([^\s$"'][^\s"']*)"#, "${1} (hidden)"),
    ]
    .into_iter()
    .map(|(re, to)| (regex::Regex::new(re).expect("static regex"), to))
    .collect()
    },
);

// A URL or a command line with any credential written into it hidden; ${secret:...} stays.
fn mask(text: &str) -> String {
    MASKS.iter().fold(text.to_string(), |out, (re, to)| {
        re.replace_all(&out, *to).into_owned()
    })
}

// Every saved secret value, so an answer can be checked for one that slipped into free text.
fn saved_values(app: &AppState) -> Vec<String> {
    let Ok(store) = app.secrets() else {
        return Vec::new();
    };
    store
        .list()
        .into_iter()
        .filter_map(|i| store.get(&i.name).map(str::to_string))
        .filter(|v| v.len() >= 6)
        .collect()
}

// The last look over any answer: a saved secret value or a known token shape never leaves.
fn sweep(value: Value, saved: &[String]) -> Value {
    match value {
        Value::String(s) => {
            let mut s = crate::worktrees::scan::redact(&s);
            for secret in saved {
                if s.contains(secret.as_str()) {
                    s = s.replace(secret.as_str(), HIDDEN);
                }
            }
            Value::String(s)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(|v| sweep(v, saved)).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, sweep(v, saved))).collect())
        }
        other => other,
    }
}

fn shown<T: serde::Serialize>(value: &T) -> Value {
    hidden(serde_json::to_value(value).unwrap_or(Value::Null), false)
}

async fn settings(app: &AppState, area: &str) -> Result<Value, ApiError> {
    let cfg = app.config()?;
    let machines: Vec<&str> = cfg.machines.iter().map(|m| m.name.as_str()).collect();
    let agents: Vec<String> = cfg.agents().into_iter().map(|a| a.name).collect();
    let (value, choices) = match area {
        "dispatch" => (
            dispatch_view(&cfg),
            json!({
                "approval": ["allow", "prompt", "deny"],
                "agents": agents,
                "runs_on": crate::config::RunsOn::ALL,
                "models": crate::config::DISPATCH_MODELS,
            }),
        ),
        "triggers" => {
            let tasks: Vec<String> = app
                .dispatch
                .tasks()
                .into_iter()
                .filter(|t| !t.hidden)
                .map(|t| t.name)
                .collect();
            let mut triggers = shown(&cfg.triggers);
            for (t, set) in triggers
                .as_array_mut()
                .into_iter()
                .flatten()
                .zip(&cfg.triggers)
            {
                t["enabled"] = json!(set.enabled);
            }
            (
                triggers,
                json!({ "tasks": tasks, "kinds": ["schedule", "linear", "github"] }),
            )
        }
        "worktree_setup" => (shown(&cfg.worktree_setup), json!({ "machines": machines })),
        "agents" => (
            json!({ "default_agent": cfg.default_agent(), "custom": shown(&cfg.agents), "all": agents }),
            json!({}),
        ),
        "session_mcp_servers" => (shown(&cfg.mcp_servers), json!({ "machines": machines })),
        "phone" => (shown(&cfg.phone_notifications), json!({})),
        "machines" => (machines_of(&cfg), json!({})),
        "pipelines" => (shown(&cfg.pipelines), json!({})),
        "pull_requests" => (shown(&cfg.pull_requests), json!({})),
        "security" => (
            json!({
                "passcode_set": cfg.passcode_hash.is_some(),
                "mcp_on": cfg.mcp_token.is_some(),
                "mesh": cfg.mesh,
                "listen_ip": cfg.listen_ip,
                "change_in": "Settings, Security; these are never changed through tools",
            }),
            json!({}),
        ),
        "about" => {
            let version = env!("CARGO_PKG_VERSION");
            let latest = match app.updates.check(version).await {
                crate::about::Check::UpToDate { latest } => {
                    json!({ "newest": latest, "update_available": false })
                }
                crate::about::Check::Available { latest, url } => {
                    json!({ "newest": latest, "update_available": true, "url": url })
                }
                crate::about::Check::Unknown { reason } => {
                    json!({ "newest": null, "unknown": reason })
                }
            };
            (json!({ "version": version, "latest": latest }), json!({}))
        }
        _ => {
            return Err(bad(format!(
                "there is no settings area {area:?}; the areas are {}",
                AREAS.join(", ")
            )))
        }
    };
    Ok(json!({ "area": area, "value": value, "choices": choices }))
}

fn machines_of(cfg: &Config) -> Value {
    Value::Array(
        cfg.machines
            .iter()
            .map(|m| {
                hidden(
                    json!({
                        "name": m.name,
                        "local": m.local,
                        "ssh": m.ssh,
                        "mesh_ip": m.mesh_ip,
                        "port_prefix": m.port_prefix,
                        "root": m.root,
                        "mesh": m.mesh,
                    }),
                    false,
                )
            })
            .collect(),
    )
}

fn first_line(text: &str) -> String {
    text.lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .chars()
        .take(120)
        .collect()
}

fn conversations(app: &AppState, filter: &str) -> Value {
    let piped: Vec<String> = app
        .pipelines
        .runs()
        .into_iter()
        .map(|r| r.conversation)
        .filter(|c| !c.is_empty())
        .collect();
    let all = app.dispatch.list();
    let rows = all.as_array().cloned().unwrap_or_default();
    Value::Array(
        rows.into_iter()
            .map(|c| {
                let id = c["id"].as_str().unwrap_or_default().to_string();
                let started_by = if piped.contains(&id) {
                    "a pipeline run".to_string()
                } else if let Some(name) = c["trigger"].as_str() {
                    format!("the trigger {name}")
                } else {
                    "you".to_string()
                };
                json!({ "id": id, "title": c["title"], "updated": c["updated"], "waiting": c["waiting"], "busy": c["busy"], "started_by": started_by })
            })
            .filter(|c| match filter {
                "waiting" => c["waiting"].as_u64().unwrap_or(0) > 0,
                "trigger" => c["started_by"].as_str().unwrap_or_default().starts_with("the trigger"),
                "pipeline" => c["started_by"] == "a pipeline run",
                _ => true,
            })
            .collect(),
    )
}

// Shortens every long string inside, counting how many it shortened.
fn clipped(value: Value, count: &mut usize) -> Value {
    match value {
        Value::String(s) if s.chars().count() > CLIP => {
            *count += 1;
            let kept: String = s.chars().take(CLIP).collect();
            Value::String(format!(
                "{kept}\n[clipped: {} more characters]",
                s.chars().count() - CLIP
            ))
        }
        Value::Array(items) => Value::Array(items.into_iter().map(|v| clipped(v, count)).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, clipped(v, count)))
                .collect(),
        ),
        other => other,
    }
}

const LISTED: usize = 50;
const BUDGET: usize = 30_000;

// The first LISTED entries under `key`, and how many more there are.
fn capped(key: &str, all: Value) -> Value {
    let items = all.as_array().cloned().unwrap_or_default();
    let more = items.len().saturating_sub(LISTED);
    json!({ key: items.into_iter().take(LISTED).collect::<Vec<_>>(), "more": more })
}

fn conversation(app: &AppState, args: &Value) -> Result<Value, ApiError> {
    let id = args["id"].as_str().unwrap_or_default();
    let c = app.dispatch.get(id).ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            format!("there is no conversation {id}; list_conversations shows them"),
        )
    })?;
    let last = args["last"]
        .as_u64()
        .map_or(TURNS, |n| n.clamp(1, 50) as usize);
    let events = c["events"].as_array().cloned().unwrap_or_default();
    let mut count = 0;
    let mut kept: Vec<Value> = Vec::new();
    let mut used = 0;
    // Newest first until the answer would pass its budget; older events are counted as left out.
    for event in events.iter().rev().take(last) {
        let event = clipped(event.clone(), &mut count);
        let size = event.to_string().len();
        if !kept.is_empty() && used + size > BUDGET {
            break;
        }
        used += size;
        kept.push(event);
    }
    kept.reverse();
    let left_out = events.len() - kept.len();
    Ok(
        json!({ "id": id, "title": c["title"], "updated": c["updated"], "busy": c["busy"], "left_out": left_out, "clipped": count, "events": kept }),
    )
}

fn tasks(app: &AppState) -> Value {
    Value::Array(
        app.dispatch
            .tasks()
            .into_iter()
            .filter(|t| !t.hidden)
            .map(|t| {
                let versions = app
                    .dispatch
                    .task_history(&t.name)
                    .map_or(1, |h| h.versions.len());
                json!({ "name": t.name, "versions": versions, "summary": first_line(&t.text) })
            })
            .collect(),
    )
}

fn task(app: &AppState, name: &str) -> Result<Value, ApiError> {
    let found = app
        .dispatch
        .tasks()
        .into_iter()
        .find(|t| t.name == name && !t.hidden)
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                format!("there is no task called {name}; list_tasks shows them"),
            )
        })?;
    let history = app.dispatch.task_history(name).map_err(bad)?;
    let versions: Vec<Value> = history
        .versions
        .iter()
        .map(|v| json!({ "n": v.n, "saved": v.at }))
        .collect();
    Ok(
        json!({ "name": found.name, "text": found.text, "current": history.current, "versions": versions }),
    )
}

fn pipelines(app: &AppState) -> Value {
    use crate::pipeline::record::RunState;
    let runs = app.pipelines.runs();
    Value::Array(
        app.pipelines
            .library()
            .list()
            .into_iter()
            .map(|d| {
                let count = |s: &[RunState]| {
                    runs.iter()
                        .filter(|r| r.pipeline == d.id && s.contains(&r.state))
                        .count()
                };
                json!({
                    "id": d.id,
                    "name": d.name,
                    "enabled": d.enabled,
                    "version": d.version,
                    "trigger": d.trigger,
                    "steps": d.steps.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
                    "runs": {
                        "running": count(&[RunState::Queued, RunState::Running]),
                        "waiting": count(&[RunState::Waiting]),
                        "done": count(&[RunState::Done]),
                    },
                })
            })
            .collect(),
    )
}

fn pipeline(app: &AppState, id: &str) -> Result<Value, ApiError> {
    let library = app.pipelines.library();
    let def = library.get(id).ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            format!("there is no pipeline {id}; list_pipelines shows them"),
        )
    })?;
    let versions: Vec<Value> = library
        .history(id)
        .into_iter()
        .map(|(version, saved, _)| json!({ "version": version, "saved": saved }))
        .collect();
    Ok(json!({ "definition": def, "versions": versions }))
}

fn runs(app: &AppState, args: &Value) -> Value {
    let pipeline = args["pipeline"].as_str().unwrap_or_default();
    let state = args["state"].as_str().unwrap_or_default();
    let mut all = app.pipelines.runs();
    all.sort_by(|a, b| b.started.cmp(&a.started));
    Value::Array(
        all.into_iter()
            .filter(|r| pipeline.is_empty() || r.pipeline == pipeline)
            .filter(|r| {
                state.is_empty()
                    || serde_json::to_value(r.state)
                        .ok()
                        .as_ref()
                        .and_then(Value::as_str)
                        == Some(state)
            })
            .map(|r| {
                json!({
                    "id": r.id,
                    "pipeline": r.pipeline,
                    "subject": r.subject.label(),
                    "state": r.state,
                    "step": r.step,
                    "waiting_reason": r.waiting.as_ref().map(|w| w.reason.clone()),
                    "started": r.started,
                })
            })
            .collect(),
    )
}

fn run(app: &AppState, id: &str) -> Result<Value, ApiError> {
    let found = app.pipelines.run(id).ok_or_else(|| {
        ApiError(
            StatusCode::NOT_FOUND,
            format!("there is no run {id}; list_runs shows them"),
        )
    })?;
    let mut value = serde_json::to_value(&found).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut value {
        map.remove("definition");
        map.remove("pending");
    }
    let mut count = 0;
    Ok(clipped(value, &mut count))
}

fn insights(app: &AppState, args: &Value) -> Result<Value, ApiError> {
    let machine = args["machine"].as_str().unwrap_or_default();
    let now = chrono::Local::now();
    match args["session"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => {
            let record = app.insights.record(machine, name).ok_or_else(|| {
                ApiError(StatusCode::NOT_FOUND, format!("Yardbell has seen no session {name} on {machine}; read_insights without a session lists the ones it has seen"))
            })?;
            let mut count = 0;
            Ok(clipped(
                serde_json::to_value(record.timeline(now)).unwrap_or(Value::Null),
                &mut count,
            ))
        }
        None => {
            let mut count = 0;
            let mut seen = app.insights.timelines(machine, now);
            seen.sort_by(|a, b| b.since.cmp(&a.since));
            let sessions: Vec<Value> = seen
                .iter()
                .take(LISTED)
                .map(|t| json!({ "name": t.name, "agent": t.agent, "folder": t.folder, "branch": t.branch, "since": t.since, "ended": t.ended, "totals": t.totals }))
                .collect();
            let sessions = clipped(Value::Array(sessions), &mut count);
            Ok(
                json!({ "machine": machine, "sessions": sessions, "more": seen.len().saturating_sub(LISTED) }),
            )
        }
    }
}

fn pulls(app: &AppState, machine: &str) -> Value {
    Value::Array(
        app.state
            .pulls()
            .into_iter()
            .filter(|((m, _, _), _)| machine.is_empty() || m == machine)
            .map(|((m, path, branch), p)| {
                json!({
                    "machine": m,
                    "path": path,
                    "branch": branch,
                    "forge": p.forge,
                    "number": p.number,
                    "title": p.title,
                    "state": p.state,
                    "draft": p.draft,
                    "review": p.review,
                    "ci": p.ci,
                    "failing_jobs": p.failed,
                    "url": p.url,
                })
            })
            .collect(),
    )
}

fn approval_word(a: crate::config::Approval) -> &'static str {
    match a {
        crate::config::Approval::Allow => "allow",
        crate::config::Approval::Prompt => "prompt",
        crate::config::Approval::Deny => "deny",
    }
}

// Every field, defaults included, with the words Settings uses.
fn dispatch_view(cfg: &Config) -> Value {
    let d = &cfg.dispatch;
    let rules: Vec<Value> = d
        .rules
        .iter()
        .map(|r| json!({ "action": r.action, "machine": r.machine, "folder": r.folder, "approval": approval_word(r.approval) }))
        .collect();
    json!({
        "instructions": d.instructions,
        "approval": approval_word(d.approval),
        "rules": rules,
        "agent": if d.agent.is_empty() { cfg.default_agent().to_string() } else { d.agent.clone() },
        "runs_on": d.runs_on,
        "model": d.model,
        "codex_model": d.codex_model,
    })
}

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
    )]
}

fn bad(message: String) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message)
}

// The read tools' answers, or None for a tool this module does not own.
pub async fn read(app: &AppState, name: &str, args: &Value) -> Option<Result<Value, ApiError>> {
    match name {
        "read_settings" => Some(settings(app, args["area"].as_str().unwrap_or_default()).await),
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

// Walks a settings section, hiding credential fields and every env or header value.
fn hidden(value: Value, under_credential: bool) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| {
                    let secret = under_credential || credential(&k) || k == "env" || k == "headers";
                    (k, hidden(v, secret))
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|v| hidden(v, under_credential))
                .collect(),
        ),
        Value::String(s) if under_credential => Value::String(hide(&s)),
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
            shown(&cfg.dispatch),
            json!({ "approval": ["allow", "prompt", "deny"], "agents": agents }),
        ),
        "triggers" => {
            let tasks: Vec<String> = app
                .dispatch
                .tasks()
                .into_iter()
                .filter(|t| !t.hidden)
                .map(|t| t.name)
                .collect();
            (
                shown(&cfg.triggers),
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

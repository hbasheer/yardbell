use super::super::mcp_config::CONVERSATION_HEADER;
use super::{assistant, short, tool_text, Backend, Launch, TurnSpec, TOOLS};
use crate::config::RunsOn;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// The oldest Codex these flags, feature names and event shapes were checked against.
pub(in crate::dispatch) const MIN_VERSION: [u64; 3] = [0, 165, 0];
pub(in crate::dispatch) const TOKEN_ENV: &str = "YARDBELL_DISPATCH_TOKEN";
const SERVER: &str = "yardbell";
// Codex's own tools that act outside the read-only sandbox, so that Dispatch acts only through
// Yardbell's tools and their approvals. Code mode stays on: Codex's models call MCP tools through
// it. Codex refuses an unknown name, so a rename in a later release fails the turn instead of
// leaving a tool on.
const BUILT_IN: [&str; 14] = [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "browser_use",
    "browser_use_external",
    "in_app_browser",
    "computer_use",
    "image_generation",
    "view_image",
    "hooks",
    "tool_suggest",
    "goals",
    "sleep_tool",
];

pub(in crate::dispatch) struct Codex;

fn toml_str(text: &str) -> String {
    toml::Value::String(text.to_string()).to_string()
}

fn set(argv: &mut Vec<String>, key: &str, value: String) {
    argv.push("-c".into());
    argv.push(format!("{key}={value}"));
}

impl Backend for Codex {
    fn label(&self) -> &'static str {
        "Codex"
    }

    fn binary(&self) -> &'static str {
        "codex"
    }

    // The user's ~/.codex/config.toml is never read, so their own profiles and approval
    // settings play no part. Secrets go by environment, since argv is visible to every process
    // on the machine.
    fn launch(&self, mut argv: Vec<String>, turn: &TurnSpec) -> Result<Launch, String> {
        let mut env = vec![(TOKEN_ENV.to_string(), turn.token.to_string())];
        argv.push("exec".into());
        if turn.resume.is_some() {
            argv.push("resume".into());
        }
        argv.extend(
            [
                "--json",
                "--ignore-user-config",
                "--ignore-rules",
                "--skip-git-repo-check",
            ]
            .map(String::from),
        );
        for feature in BUILT_IN {
            argv.extend(["--disable".into(), feature.into()]);
        }
        set(&mut argv, "sandbox_mode", toml_str("read-only"));
        set(&mut argv, "web_search", toml_str("disabled"));
        set(&mut argv, "skills.include_instructions", "false".into());
        set(
            &mut argv,
            "developer_instructions",
            toml_str(turn.system_prompt),
        );
        let server = format!("mcp_servers.{SERVER}");
        set(
            &mut argv,
            &format!("{server}.url"),
            toml_str(&format!("http://127.0.0.1:{}/mcp", turn.port)),
        );
        set(
            &mut argv,
            &format!("{server}.bearer_token_env_var"),
            toml_str(TOKEN_ENV),
        );
        set(
            &mut argv,
            &format!("{server}.http_headers"),
            format!(
                "{{{}={}}}",
                toml_str(CONVERSATION_HEADER),
                toml_str(turn.conversation)
            ),
        );
        set(
            &mut argv,
            &format!("{server}.enabled_tools"),
            format!("[{}]", TOOLS.map(toml_str).join(","),),
        );
        // Yardbell's own gate decides every step, so Codex must not ask a second time: under
        // `codex exec` asking means refusing.
        set(
            &mut argv,
            &format!("{server}.default_tools_approval_mode"),
            toml_str("approve"),
        );
        set(&mut argv, &format!("{server}.required"), "true".into());
        user_servers(turn.extra, &mut argv, &mut env)?;
        let model = turn.settings.model_for(RunsOn::Codex);
        if !model.is_empty() {
            argv.extend(["-m".into(), model.to_string()]);
        }
        if let Some(thread) = turn.resume {
            argv.push(thread.to_string());
        }
        argv.push("-".into());
        Ok(Launch {
            argv,
            env,
            stdin: Some(turn.prompt.to_string()),
        })
    }

    fn session_of(&self, line: &Value) -> Option<String> {
        (line["type"] == "thread.started")
            .then(|| line["thread_id"].as_str().map(str::to_string))
            .flatten()
    }

    fn finished(&self, line: &Value) -> bool {
        matches!(
            line["type"].as_str(),
            Some("turn.completed" | "turn.failed")
        )
    }

    fn usage_of(&self, _line: &Value) -> Option<Value> {
        None
    }

    fn keeps_instructions(&self) -> bool {
        true
    }

    fn events_of(&self, line: &Value, tools: &mut HashMap<String, String>) -> Vec<Value> {
        match line["type"].as_str() {
            Some("item.started") => started(&line["item"], tools).into_iter().collect(),
            Some("item.completed") => completed(&line["item"], tools),
            Some("turn.failed") => vec![error(&line["error"]["message"])],
            Some("error") => vec![error(&line["message"])],
            _ => Vec::new(),
        }
    }
}

// The servers set under MCP servers in Settings, such as Linear, as Claude's Dispatch gets them.
// Their tools run without Yardbell's approval there too, and under `codex exec` a tool that asks
// is refused.
fn user_servers(
    extra: Option<&str>,
    argv: &mut Vec<String>,
    env: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let Some(extra) = extra else {
        return Ok(());
    };
    let config: Value = serde_json::from_str(extra)
        .map_err(|e| format!("Yardbell's MCP servers are not valid JSON: {e}"))?;
    let Some(servers) = config["mcpServers"].as_object() else {
        return Ok(());
    };
    let mut header_vars = 0;
    for (name, entry) in servers.iter().filter(|(name, _)| *name != SERVER) {
        let key = format!("mcp_servers.{name}");
        if let Some(url) = entry["url"].as_str() {
            if url.contains('?') || url.contains('@') {
                return Err(format!(
                    "MCP server {name} carries a query or a login in its URL, which Codex would show on the command line to every process on this machine. Move the credential into a header under MCP servers in Settings"
                ));
            }
            set(argv, &format!("{key}.url"), toml_str(url));
            let headers = entry["headers"].as_object().cloned().unwrap_or_default();
            let mut names = Vec::new();
            for (header, value) in &headers {
                let var = format!("YARDBELL_MCP_{header_vars}");
                header_vars += 1;
                env.push((var.clone(), value.as_str().unwrap_or_default().to_string()));
                names.push(format!("{}={}", toml_str(header), toml_str(&var)));
            }
            set(
                argv,
                &format!("{key}.env_http_headers"),
                format!("{{{}}}", names.join(",")),
            );
        } else {
            set(
                argv,
                &format!("{key}.command"),
                toml_str(entry["command"].as_str().unwrap_or_default()),
            );
            let args: Vec<String> = entry["args"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(toml_str)
                .collect();
            set(
                argv,
                &format!("{key}.args"),
                format!("[{}]", args.join(",")),
            );
            let vars = entry["env"].as_object().cloned().unwrap_or_default();
            for (var, value) in &vars {
                forward(name, var, value.as_str().unwrap_or_default(), env)?;
            }
            let names: Vec<String> = vars.keys().map(|v| toml_str(v)).collect();
            set(
                argv,
                &format!("{key}.env_vars"),
                format!("[{}]", names.join(",")),
            );
        }
        set(
            argv,
            &format!("{key}.default_tools_approval_mode"),
            toml_str("approve"),
        );
    }
    Ok(())
}

// Codex hands a stdio server variables from its own environment by name, so each one is set on
// Codex itself, where a name Codex reads would change how Codex runs.
fn forward(
    server: &str,
    var: &str,
    value: &str,
    env: &mut Vec<(String, String)>,
) -> Result<(), String> {
    if var == TOKEN_ENV
        || var.starts_with("YARDBELL_")
        || var.starts_with("CODEX_")
        || var.starts_with("OPENAI_")
    {
        return Err(format!(
            "MCP server {server} sets {var}, which Codex or Yardbell uses itself, so Codex cannot run it for Dispatch"
        ));
    }
    match env.iter().find(|(name, _)| name == var) {
        Some((_, set)) if set != value => Err(format!(
            "MCP servers give {var} two different values, and Codex can pass only one to its servers. Rename it in one of them under MCP servers in Settings"
        )),
        Some(_) => Ok(()),
        None => {
            env.push((var.to_string(), value.to_string()));
            Ok(())
        }
    }
}

fn error(message: &Value) -> Value {
    let text = message.as_str().unwrap_or("Codex reported an error");
    json!({ "role": "error", "text": text })
}

fn yardbell_call(item: &Value) -> Option<(&str, &str)> {
    if item["type"] != "mcp_tool_call" || item["server"] != SERVER {
        return None;
    }
    Some((item["id"].as_str()?, item["tool"].as_str()?))
}

fn started(item: &Value, tools: &mut HashMap<String, String>) -> Option<Value> {
    let (id, tool) = yardbell_call(item)?;
    tools.insert(id.to_string(), tool.to_string());
    Some(json!({ "role": "tool", "name": tool, "input": item["arguments"] }))
}

fn completed(item: &Value, tools: &mut HashMap<String, String>) -> Vec<Value> {
    match item["type"].as_str() {
        Some("agent_message") => item["text"]
            .as_str()
            .and_then(assistant)
            .into_iter()
            .collect(),
        Some("mcp_tool_call") => {
            let Some((id, tool)) = yardbell_call(item) else {
                return Vec::new();
            };
            let mut events = Vec::new();
            if !tools.contains_key(id) {
                events.extend(started(item, tools));
            }
            let result = &item["result"];
            let failed = item["status"] == "failed"
                || !item["error"].is_null()
                || result["isError"] == true
                || result["is_error"] == true;
            let text = match item["error"]["message"].as_str() {
                Some(message) => message.to_string(),
                None => tool_text(&result["content"]),
            };
            events.push(json!({
                "role": "tool_result",
                "name": tool,
                "text": short(&text),
                "is_error": failed,
            }));
            events
        }
        Some("error") => {
            tracing::warn!(
                message = item["message"].as_str().unwrap_or_default(),
                "Codex warned during a Dispatch turn"
            );
            Vec::new()
        }
        Some(other) => {
            tracing::debug!(kind = other, "ignoring a Codex item");
            Vec::new()
        }
        None => Vec::new(),
    }
}

// `codex --version` prints `codex-cli 0.165.0`.
pub(in crate::dispatch) fn check_version(printed: &str) -> Result<(), String> {
    let wanted = MIN_VERSION.map(|n| n.to_string()).join(".");
    let found = printed.split_whitespace().last().unwrap_or_default();
    let parts: Vec<u64> = found
        .split('.')
        .map_while(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .collect();
    if parts.len() < 3 {
        return Err(format!(
            "Dispatch needs Codex {wanted} or newer, and cannot tell which version this machine has (codex --version printed {:?})",
            printed.trim()
        ));
    }
    if parts[..3] < MIN_VERSION[..] {
        return Err(format!(
            "Dispatch needs Codex {wanted} or newer, and this machine has {found}. Update Codex, then send the message again"
        ));
    }
    Ok(())
}

// Codex runs on without a server it cannot reach, and only says so on stderr.
pub(in crate::dispatch) fn unreachable(stderr: &str) -> String {
    let said = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.to_lowercase().contains("mcp"))
        .map(|line| line.chars().take(300).collect::<String>());
    let base = "Codex could not reach Yardbell's tools, so Dispatch could not act on this message";
    match said {
        Some(said) => format!("{base}. Codex said: {said}"),
        None => base.to_string(),
    }
}

pub(in crate::dispatch) fn mentions_mcp(stderr: &str) -> bool {
    stderr.to_lowercase().contains("mcp")
}

pub(in crate::dispatch) fn home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(dir) => Some(PathBuf::from(dir)),
        None => Some(PathBuf::from(std::env::var_os("HOME")?).join(".codex")),
    }
}

// The models Codex offers this account, from the list it keeps for its own picker, as
// suggestions only: Yardbell accepts any well-formed name.
pub(in crate::dispatch) fn models(home: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(home.join("models_cache.json")) else {
        return Vec::new();
    };
    let Ok(cache) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    cache["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| m["slug"].as_str().map(str::to_string))
        .collect()
}

fn newest_first(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .collect();
    found.sort();
    found.reverse();
    found
}

// Codex keeps each thread in sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl, under the day it
// started, and appends to it when the thread is resumed.
fn rollout(home: &Path, thread: &str) -> Option<PathBuf> {
    let suffix = format!("-{thread}.jsonl");
    for year in newest_first(&home.join("sessions")) {
        for month in newest_first(&year) {
            for day in newest_first(&month) {
                let found = newest_first(&day).into_iter().find(|f| {
                    f.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
                });
                if found.is_some() {
                    return found;
                }
            }
        }
    }
    None
}

fn window_label(minutes: u64) -> String {
    match minutes {
        300 => "5-hour limit".into(),
        10080 => "Weekly limit".into(),
        m if m % 1440 == 0 => format!("{}-day limit", m / 1440),
        m if m % 60 == 0 => format!("{}-hour limit", m / 60),
        m => format!("{m}-minute limit"),
    }
}

// The plan limits Codex saw last in a thread, from the rate_limits of its last token_count. The
// rollout format is not documented, so anything unexpected means no figures, never an error.
pub(in crate::dispatch) fn usage_from_rollout(text: &str) -> Option<Value> {
    let (line, limits) = text.lines().rev().find_map(|line| {
        let line: Value = serde_json::from_str(line).ok()?;
        let payload = &line["payload"];
        if line["type"] != "event_msg" || payload["type"] != "token_count" {
            return None;
        }
        let limits = payload["rate_limits"].clone();
        limits.is_object().then_some((line, limits))
    })?;
    let reached = !limits["rate_limit_reached_type"].is_null();
    let windows: Vec<Value> = ["primary", "secondary"]
        .iter()
        .filter_map(|name| {
            let w = &limits[*name];
            let used = w["used_percent"].as_f64()? / 100.0;
            let minutes = w["window_minutes"].as_u64()?;
            let status = if reached && used >= 1.0 {
                "rejected"
            } else {
                "allowed"
            };
            Some(json!({
                "name": name,
                "label": window_label(minutes),
                "used": used.clamp(0.0, 1.0),
                "resets_at": w["resets_at"].as_i64(),
                "status": status,
            }))
        })
        .collect();
    if windows.is_empty() {
        return None;
    }
    let seen = line["timestamp"]
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&chrono::Local).to_rfc3339())
        .unwrap_or_else(|| chrono::Local::now().to_rfc3339());
    Some(json!({ "windows": windows, "seen": seen, "source": "codex" }))
}

pub(in crate::dispatch) async fn usage_after(home: PathBuf, thread: String) -> Option<Value> {
    tokio::task::spawn_blocking(move || {
        let path = rollout(&home, &thread)?;
        usage_from_rollout(&std::fs::read_to_string(path).ok()?)
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Lines a real `codex exec --json` printed (codex-cli 0.165.0) for a turn that called
    // Yardbell's list_machines, one that Codex refused to run, and the warnings it gives.
    const STARTED: &str =
        r#"{"type":"thread.started","thread_id":"01a1845f-7751-7683-bfbb-06eaae02bd31"}"#;
    const SAID: &str = r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll find and call the Yardbell `list_machines` tool once.\n"}}"#;
    const CALL: &str = r#"{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"yardbell","tool":"list_machines","arguments":{},"result":null,"error":null,"status":"in_progress"}}"#;
    const RESULT: &str = r#"{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"yardbell","tool":"list_machines","arguments":{},"result":{"content":[{"type":"text","text":"[\n  {\n    \"name\": \"hp\",\n    \"up\": true\n  }\n]"}],"structured_content":null},"error":null,"status":"completed"}}"#;
    const REFUSED: &str = r#"{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"yardbell","tool":"list_machines","arguments":{},"result":null,"error":{"message":"MCP tool call requires approval, but approval policy is never"},"status":"failed"}}"#;
    const WARNING: &str = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 2 unrecognized configuration settings."}}"#;
    const DONE: &str = r#"{"type":"turn.completed","usage":{"input_tokens":28882,"cached_input_tokens":12032,"cache_write_input_tokens":0,"output_tokens":268,"reasoning_output_tokens":48}}"#;

    fn line(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn codex_lines_become_chat_events() {
        let mut tools = HashMap::new();
        let codex = Codex;
        assert_eq!(
            codex.session_of(&line(STARTED)).as_deref(),
            Some("01a1845f-7751-7683-bfbb-06eaae02bd31")
        );
        assert_eq!(codex.session_of(&line(SAID)), None);
        assert_eq!(
            codex.events_of(&line(SAID), &mut tools),
            [
                json!({ "role": "assistant", "text": "I’ll find and call the Yardbell `list_machines` tool once.\n" })
            ]
        );
        assert_eq!(
            codex.events_of(&line(CALL), &mut tools),
            [json!({ "role": "tool", "name": "list_machines", "input": {} })]
        );
        assert_eq!(
            codex.events_of(&line(RESULT), &mut tools),
            [
                json!({ "role": "tool_result", "name": "list_machines", "text": "[\n  {\n    \"name\": \"hp\",\n    \"up\": true\n  }\n]", "is_error": false })
            ]
        );
        assert!(codex.events_of(&line(WARNING), &mut tools).is_empty());
        assert!(codex.events_of(&line(STARTED), &mut tools).is_empty());
        assert!(!codex.finished(&line(RESULT)));
        assert!(codex.finished(&line(DONE)));
        assert!(codex.events_of(&line(DONE), &mut tools).is_empty());
    }

    #[test]
    fn a_refused_or_failed_call_is_an_error_result() {
        let mut tools = HashMap::new();
        assert_eq!(
            Codex.events_of(&line(REFUSED), &mut tools),
            [
                json!({ "role": "tool", "name": "list_machines", "input": {} }),
                json!({ "role": "tool_result", "name": "list_machines", "text": "MCP tool call requires approval, but approval policy is never", "is_error": true }),
            ],
            "a call seen only when it ends still shows what was called"
        );
        let refused_by_yardbell = json!({"type": "item.completed", "item": {"id": "item_2", "type": "mcp_tool_call", "server": "yardbell", "tool": "read_session", "arguments": {}, "result": {"content": [{"type": "text", "text": "no such session"}], "isError": true}, "error": null, "status": "completed"}});
        assert_eq!(
            Codex.events_of(&refused_by_yardbell, &mut tools)[1]["is_error"],
            true
        );
    }

    #[test]
    fn other_servers_and_codex_failures() {
        let mut tools = HashMap::new();
        let linear = json!({"type": "item.started", "item": {"id": "item_3", "type": "mcp_tool_call", "server": "linear", "tool": "get_issue", "arguments": {}}});
        assert!(Codex.events_of(&linear, &mut tools).is_empty());
        let reasoning = json!({"type": "item.completed", "item": {"id": "item_4", "type": "reasoning", "text": "thinking"}});
        assert!(Codex.events_of(&reasoning, &mut tools).is_empty());
        let failed =
            json!({"type": "turn.failed", "error": {"message": "You've hit your usage limit."}});
        assert!(Codex.finished(&failed));
        assert_eq!(
            Codex.events_of(&failed, &mut tools),
            [json!({ "role": "error", "text": "You've hit your usage limit." })]
        );
        assert_eq!(
            Codex.events_of(
                &json!({"type": "error", "message": "stream disconnected"}),
                &mut tools
            ),
            [json!({ "role": "error", "text": "stream disconnected" })]
        );
    }

    type Env = Vec<(String, String)>;

    fn servers(extra: Value) -> Result<(Vec<String>, Env), String> {
        let (mut argv, mut env) = (Vec::new(), Vec::new());
        user_servers(Some(&extra.to_string()), &mut argv, &mut env)?;
        Ok((argv, env))
    }

    #[test]
    fn your_servers_come_along_with_their_secrets_kept_off_the_command_line() {
        let (argv, env) = servers(json!({ "mcpServers": {
            "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer lin_api_SECRET" } },
            "github": { "command": "npx", "args": ["-y", "gh-mcp"], "env": { "GITHUB_TOKEN": "ghp_SECRET", "LOG": "debug" } },
            "yardbell": { "type": "http", "url": "http://127.0.0.1:1/mcp", "headers": {} },
        }}))
        .unwrap();
        let args = argv.join("\n");
        assert!(!args.contains("SECRET"), "{args}");
        for wanted in [
            "mcp_servers.linear.url=\"https://mcp.linear.app/mcp\"",
            "mcp_servers.linear.env_http_headers={\"Authorization\"=\"YARDBELL_MCP_0\"}",
            "mcp_servers.linear.default_tools_approval_mode=\"approve\"",
            "mcp_servers.github.command=\"npx\"",
            "mcp_servers.github.args=[\"-y\",\"gh-mcp\"]",
            "mcp_servers.github.env_vars=[\"GITHUB_TOKEN\",\"LOG\"]",
            "mcp_servers.github.default_tools_approval_mode=\"approve\"",
        ] {
            assert!(
                argv.iter().any(|a| a == wanted),
                "{wanted} missing from {args}"
            );
        }
        assert!(
            !args.contains("127.0.0.1:1"),
            "Yardbell's own entry is set apart"
        );
        let env: HashMap<_, _> = env.into_iter().collect();
        assert_eq!(env["YARDBELL_MCP_0"], "Bearer lin_api_SECRET");
        assert_eq!(env["GITHUB_TOKEN"], "ghp_SECRET");
        assert_eq!(env["LOG"], "debug");
        assert_eq!(servers(json!({})).unwrap(), (Vec::new(), Vec::new()));
    }

    #[test]
    fn servers_codex_cannot_run_safely_are_refused_by_name() {
        let in_url = servers(json!({ "mcpServers": {
            "zap": { "type": "http", "url": "https://example.invalid/mcp?key=SECRET", "headers": {} },
        }}))
        .unwrap_err();
        assert!(
            in_url.starts_with("MCP server zap carries a query"),
            "{in_url}"
        );
        assert!(!in_url.contains("SECRET"));
        let login = servers(json!({ "mcpServers": {
            "zap": { "type": "http", "url": "https://me:SECRET@example.invalid/mcp", "headers": {} },
        }}))
        .unwrap_err();
        assert!(!login.contains("SECRET"), "{login}");
        let own = servers(json!({ "mcpServers": {
            "odd": { "command": "odd-mcp", "args": [], "env": { "OPENAI_API_KEY": "x" } },
        }}))
        .unwrap_err();
        assert_eq!(
            own,
            "MCP server odd sets OPENAI_API_KEY, which Codex or Yardbell uses itself, so Codex cannot run it for Dispatch"
        );
        let clash = servers(json!({ "mcpServers": {
            "a": { "command": "a-mcp", "args": [], "env": { "API_KEY": "one" } },
            "b": { "command": "b-mcp", "args": [], "env": { "API_KEY": "two" } },
        }}))
        .unwrap_err();
        assert!(
            clash.starts_with("MCP servers give API_KEY two different values"),
            "{clash}"
        );
        assert!(servers(json!({ "mcpServers": {
            "a": { "command": "a-mcp", "args": [], "env": { "API_KEY": "same" } },
            "b": { "command": "b-mcp", "args": [], "env": { "API_KEY": "same" } },
        }}))
        .is_ok());
    }

    #[test]
    fn instructions_survive_the_trip_through_toml() {
        let text = "Say \"hi\".\nThen '''stop''' and \"\"\"end\"\"\" \\ here\ttab";
        let encoded = toml_str(text);
        let parsed: toml::Table = toml::from_str(&format!("v = {encoded}")).unwrap();
        assert_eq!(parsed["v"].as_str(), Some(text));
    }

    #[test]
    fn versions_older_than_the_minimum_are_refused() {
        assert_eq!(check_version("codex-cli 0.165.0\n"), Ok(()));
        assert_eq!(check_version("codex-cli 0.166.2-alpha.1"), Ok(()));
        assert_eq!(check_version("codex-cli 1.0.0"), Ok(()));
        assert_eq!(
            check_version("codex-cli 0.164.9"),
            Err("Dispatch needs Codex 0.165.0 or newer, and this machine has 0.164.9. Update Codex, then send the message again".into())
        );
        assert!(check_version("")
            .unwrap_err()
            .contains("cannot tell which version"));
    }

    #[test]
    fn plan_limits_come_from_the_last_token_count_in_the_rollout() {
        let rollout = [
            r#"{"timestamp":"2026-10-28T21:16:52.664Z","type":"session_meta","payload":{"id":"t"}}"#,
            r#"{"timestamp":"2026-10-28T21:16:59.724Z","type":"event_msg","payload":{"type":"token_count","info":{},"rate_limits":{"limit_id":"codex","primary":{"used_percent":5.0,"window_minutes":300,"resets_at":1793226870},"secondary":{"used_percent":3.0,"window_minutes":10080,"resets_at":1793790405},"plan_type":"team","rate_limit_reached_type":null}}}"#,
            r#"{"timestamp":"2026-10-28T21:17:06.737Z","type":"event_msg","payload":{"type":"token_count","info":{},"rate_limits":{"limit_id":"codex","primary":{"used_percent":6.0,"window_minutes":300,"resets_at":1793226870},"secondary":{"used_percent":3.0,"window_minutes":10080,"resets_at":1793790405},"plan_type":"team","rate_limit_reached_type":null}}}"#,
            "not json",
            r#"{"timestamp":"2026-10-28T21:17:06.740Z","type":"event_msg","payload":{"type":"task_complete"}}"#,
        ]
        .join("\n");
        let usage = usage_from_rollout(&rollout).unwrap();
        assert_eq!(usage["source"], "codex");
        let windows = usage["windows"].as_array().unwrap();
        assert_eq!(windows[0]["label"], "5-hour limit");
        assert_eq!(windows[0]["used"], 0.06);
        assert_eq!(windows[0]["resets_at"], 1793226870);
        assert_eq!(windows[1]["label"], "Weekly limit");
        assert_eq!(windows[1]["status"], "allowed");
        assert!(usage["seen"].as_str().unwrap().starts_with("2026-10-"));

        let odd = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":100.0,"window_minutes":90},"secondary":{"used_percent":"x"},"rate_limit_reached_type":"primary"}}}"#;
        let usage = usage_from_rollout(odd).unwrap();
        assert_eq!(usage["windows"].as_array().unwrap().len(), 1);
        assert_eq!(usage["windows"][0]["label"], "90-minute limit");
        assert_eq!(usage["windows"][0]["status"], "rejected");
        assert_eq!(window_label(120), "2-hour limit");
        assert_eq!(window_label(2880), "2-day limit");

        assert_eq!(usage_from_rollout("garbage\n{}"), None);
        assert_eq!(
            usage_from_rollout(
                r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}"#
            ),
            None
        );
    }

    #[tokio::test]
    async fn the_rollout_is_found_by_its_thread_under_any_day() {
        let home = tempfile::tempdir().unwrap();
        let day = home.path().join("sessions/2026/10/27");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::create_dir_all(home.path().join("sessions/2026/10/29")).unwrap();
        let line = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":40.0,"window_minutes":300,"resets_at":1}}}}"#;
        std::fs::write(day.join("rollout-2026-10-27T10-00-00-thread-a.jsonl"), line).unwrap();
        std::fs::write(day.join("rollout-2026-10-27T11-00-00-thread-b.jsonl"), "{}").unwrap();
        let usage = usage_after(home.path().to_path_buf(), "thread-a".into())
            .await
            .unwrap();
        assert_eq!(usage["windows"][0]["used"], 0.4);
        assert_eq!(
            usage_after(home.path().to_path_buf(), "thread-b".into()).await,
            None
        );
        assert_eq!(
            usage_after(home.path().to_path_buf(), "missing".into()).await,
            None
        );
        assert_eq!(
            usage_after(home.path().join("nowhere"), "thread-a".into()).await,
            None
        );
    }

    #[test]
    fn listed_models_are_offered() {
        let home = tempfile::tempdir().unwrap();
        assert!(models(home.path()).is_empty());
        std::fs::write(
            home.path().join("models_cache.json"),
            r#"{"models":[{"slug":"gpt-6.1-sol","visibility":"list"},{"slug":"codex-auto-review","visibility":"hide"},{"visibility":"list"}]}"#,
        )
        .unwrap();
        assert_eq!(models(home.path()), ["gpt-6.1-sol"]);
        std::fs::write(home.path().join("models_cache.json"), "{").unwrap();
        assert!(models(home.path()).is_empty());
    }

    #[test]
    fn an_unreachable_server_is_explained() {
        let stderr = "2026-10-28T21:18:45Z ERROR rmcp::transport::worker: worker quit\nError: thread/start failed: required MCP servers failed to initialize: yardbell: handshaking failed\n";
        assert_eq!(
            unreachable(stderr),
            "Codex could not reach Yardbell's tools, so Dispatch could not act on this message. Codex said: Error: thread/start failed: required MCP servers failed to initialize: yardbell: handshaking failed"
        );
        assert!(mentions_mcp(stderr));
        assert_eq!(
            unreachable(""),
            "Codex could not reach Yardbell's tools, so Dispatch could not act on this message"
        );
    }
}

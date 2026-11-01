mod claude;
pub(super) mod codex;

use crate::config::{DispatchSettings, RunsOn};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

const RESULT_PREVIEW: usize = 4000;
pub(super) const TOOLS: [&str; 38] = [
    "save_connector",
    "list_machines",
    "list_sessions",
    "list_folders",
    "start_session",
    "read_session",
    "send_to_session",
    "stop_session",
    "review_session",
    "scan_folder",
    "draw_diagram",
    "list_diagrams",
    "read_diagram",
    "start_group",
    "remove_worktree",
    "integrate_branches",
    "push_branch",
    "move_session",
    "remember",
    "read_settings",
    "list_conversations",
    "read_conversation",
    "list_tasks",
    "read_task",
    "list_pipelines",
    "read_pipeline",
    "list_runs",
    "read_run",
    "read_insights",
    "list_pulls",
    "read_usage",
    "change_settings",
    "save_task",
    "run_trigger",
    "save_pipeline",
    "set_pipeline_enabled",
    "run_pipeline",
    "answer_run",
];

pub(super) struct TurnSpec<'a> {
    pub(super) prompt: &'a str,
    pub(super) system_prompt: &'a str,
    pub(super) settings: &'a DispatchSettings,
    pub(super) resume: Option<&'a str>,
    pub(super) port: u16,
    pub(super) conversation: &'a str,
    pub(super) token: &'a str,
    pub(super) mcp_config: Option<&'a Path>,
    pub(super) extra: Option<&'a str>,
}

pub(super) struct Launch {
    pub(super) argv: Vec<String>,
    pub(super) env: Vec<(String, String)>,
    pub(super) stdin: Option<String>,
}

pub(super) trait Backend: Sync {
    fn label(&self) -> &'static str;
    fn binary(&self) -> &'static str;
    fn launch(&self, binary: Vec<String>, turn: &TurnSpec) -> Result<Launch, String>;
    fn session_of(&self, line: &Value) -> Option<String>;
    fn finished(&self, line: &Value) -> bool;
    fn usage_of(&self, line: &Value) -> Option<Value>;
    fn tokens_of(&self, line: &Value) -> Option<crate::pipeline::tokens::Tokens>;
    // Whether a resumed session keeps the system prompt it started with instead of taking the
    // one given with each turn.
    fn keeps_instructions(&self) -> bool;
    // Translates one line of the agent's output into chat events. The shared loop drops the
    // steps that the MCP server records itself.
    fn events_of(&self, line: &Value, tools: &mut HashMap<String, String>) -> Vec<Value>;
}

pub(super) fn of(runs_on: RunsOn) -> &'static dyn Backend {
    match runs_on {
        RunsOn::Claude => &claude::Claude,
        RunsOn::Codex => &codex::Codex,
    }
}

pub(super) fn short(text: &str) -> String {
    if text.chars().count() <= RESULT_PREVIEW {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(RESULT_PREVIEW).collect();
    cut.push_str("\n…");
    cut
}

pub(super) fn tool_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(super) fn assistant(text: &str) -> Option<Value> {
    (!text.trim().is_empty()).then(|| json!({ "role": "assistant", "text": text }))
}

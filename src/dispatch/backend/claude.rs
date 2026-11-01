use super::super::mcp_config::extra_servers;
use super::super::usage;
use super::{assistant, short, tool_text, Backend, Launch, TurnSpec, TOOLS};
use crate::config::RunsOn;
use serde_json::{json, Value};
use std::collections::HashMap;

const TOOL_PREFIX: &str = "mcp__yardbell__";

pub(in crate::dispatch) struct Claude;

impl Backend for Claude {
    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn binary(&self) -> &'static str {
        "claude"
    }

    fn launch(&self, mut argv: Vec<String>, turn: &TurnSpec) -> Result<Launch, String> {
        let mut allowed: Vec<String> = TOOLS.iter().map(|t| format!("{TOOL_PREFIX}{t}")).collect();
        allowed.extend(
            extra_servers(turn.extra)
                .into_iter()
                .map(|name| format!("mcp__{name}")),
        );
        let config = turn
            .mcp_config
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        argv.extend(
            [
                "-p",
                turn.prompt,
                "--output-format",
                "stream-json",
                "--verbose",
                "--mcp-config",
                &config,
                "--strict-mcp-config",
                "--allowedTools",
                &allowed.join(","),
                "--append-system-prompt",
                turn.system_prompt,
            ]
            .map(String::from),
        );
        let model = turn.settings.model_for(RunsOn::Claude);
        if !model.is_empty() {
            argv.extend(["--model".into(), model.to_string()]);
        }
        if let Some(session) = turn.resume {
            argv.extend(["--resume".into(), session.to_string()]);
        }
        Ok(Launch {
            argv,
            env: Vec::new(),
            stdin: None,
        })
    }

    fn session_of(&self, line: &Value) -> Option<String> {
        line["session_id"].as_str().map(str::to_string)
    }

    fn finished(&self, line: &Value) -> bool {
        line["type"] == "result"
    }

    fn usage_of(&self, line: &Value) -> Option<Value> {
        usage::from_stream(line)
    }

    fn tokens_of(&self, line: &Value) -> Option<crate::pipeline::tokens::Tokens> {
        crate::pipeline::tokens::from_claude_result(line)
    }

    fn keeps_instructions(&self) -> bool {
        false
    }

    fn events_of(&self, message: &Value, tools: &mut HashMap<String, String>) -> Vec<Value> {
        let parts = message["message"]["content"].as_array();
        match message["type"].as_str() {
            Some("assistant") => parts
                .into_iter()
                .flatten()
                .filter_map(|part| match part["type"].as_str() {
                    Some("text") => part["text"].as_str().and_then(assistant),
                    Some("tool_use") => {
                        let name = part["name"].as_str()?.strip_prefix(TOOL_PREFIX)?;
                        if let Some(id) = part["id"].as_str() {
                            tools.insert(id.to_string(), name.to_string());
                        }
                        Some(json!({ "role": "tool", "name": name, "input": part["input"] }))
                    }
                    _ => None,
                })
                .collect(),
            Some("user") => parts
                .into_iter()
                .flatten()
                .filter(|part| part["type"] == "tool_result")
                .filter_map(|part| {
                    let name = tools.get(part["tool_use_id"].as_str()?)?;
                    Some(json!({
                        "role": "tool_result",
                        "name": name,
                        "text": short(&tool_text(&part["content"])),
                        "is_error": part["is_error"].as_bool().unwrap_or(false),
                    }))
                })
                .collect(),
            Some("result") if message["is_error"] == true => {
                let text = message["result"]
                    .as_str()
                    .unwrap_or("Claude Code reported an error");
                vec![json!({ "role": "error", "text": text })]
            }
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_json_becomes_chat_events() {
        let mut tools = HashMap::new();
        let call = json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": "Looking at your machines." },
            { "type": "tool_use", "id": "t1", "name": "mcp__yardbell__list_folders", "input": { "machine": "mini" } },
        ]}});
        assert_eq!(
            Claude.events_of(&call, &mut tools),
            [
                json!({ "role": "assistant", "text": "Looking at your machines." }),
                json!({ "role": "tool", "name": "list_folders", "input": { "machine": "mini" } }),
            ]
        );
        let result = json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": "[]" }] },
        ]}});
        assert_eq!(
            Claude.events_of(&result, &mut tools),
            [
                json!({ "role": "tool_result", "name": "list_folders", "text": "[]", "is_error": false })
            ]
        );
        let failed =
            json!({ "type": "result", "is_error": true, "result": "credit balance too low" });
        assert_eq!(
            Claude.events_of(&failed, &mut tools),
            [json!({ "role": "error", "text": "credit balance too low" })]
        );
        assert!(Claude
            .events_of(&json!({ "type": "system", "subtype": "init" }), &mut tools)
            .is_empty());
        let builtin = json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t2", "name": "ToolSearch", "input": {} },
        ]}});
        assert!(Claude.events_of(&builtin, &mut tools).is_empty());
        let builtin_result = json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t2", "content": "" },
        ]}});
        assert!(Claude.events_of(&builtin_result, &mut tools).is_empty());
        let step = json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t3", "name": "mcp__yardbell__start_session", "input": { "machine": "mini" } },
        ]}});
        assert_eq!(
            Claude.events_of(&step, &mut tools),
            [json!({ "role": "tool", "name": "start_session", "input": { "machine": "mini" } })],
            "the shared loop drops it, since the MCP server records a step itself"
        );
    }
}

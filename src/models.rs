use crate::shell::quote;
use serde::Serialize;
use serde_json::Value;

// Claude Code answers this control request with its own model picker without running a turn, so
// asking costs nothing. An older CLI answers with an error, which leaves the list empty.
pub const CLAUDE_LIST_REQUEST: &str = r#"{"type":"control_request","request_id":"yardbell-models","request":{"subtype":"list_models"}}"#;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Model {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub efforts: Vec<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
}

// Hooks and MCP servers stay off: the question is only which models this machine's CLI offers.
pub fn claude_list_script(program: &str) -> String {
    format!(
        "timeout 30 {} -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --settings '{{\"disableAllHooks\":true}}'",
        quote(program)
    )
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// The CLI lists both an alias and the versioned model it runs (opus and claude-opus-5-5), so each
// model it runs is listed once, under the first name it was given. Its "default" row is no model
// of its own: it marks which listed one a session that names no model gets.
pub fn parse_claude_models(stdout: &str) -> Vec<Model> {
    for line in stdout.lines().map(str::trim) {
        if !line.starts_with('{') || !line.contains("control_response") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let response = &parsed["response"];
        if parsed["type"] != "control_response" || response["subtype"] != "success" {
            continue;
        }
        let Some(rows) = response["response"]["models"].as_array() else {
            continue;
        };
        let runs = |row: &Value| text(row, "resolvedModel").or_else(|| text(row, "value"));
        let default_runs = rows
            .iter()
            .find(|r| r["value"] == "default")
            .and_then(|r| text(r, "resolvedModel"));
        let mut seen = Vec::new();
        let mut models = Vec::new();
        for row in rows {
            let Some(id) = text(row, "value").filter(|v| v != "default") else {
                continue;
            };
            if row["disabled"] == true {
                continue;
            }
            let model = runs(row).unwrap_or_else(|| id.clone());
            if seen.contains(&model) {
                continue;
            }
            let efforts = match (
                row["supportsEffort"].as_bool(),
                row["supportedEffortLevels"].as_array(),
            ) {
                (Some(true), Some(levels)) => levels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                _ => Vec::new(),
            };
            models.push(Model {
                label: text(row, "displayName").unwrap_or_else(|| id.clone()),
                description: text(row, "description"),
                efforts,
                default: default_runs.as_deref() == Some(model.as_str()),
                id,
            });
            seen.push(model);
        }
        if !models.is_empty() {
            return models;
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANSWER: &str = r#"{"type":"system","subtype":"init"}
{"type":"control_response","response":{"subtype":"success","request_id":"yardbell-models","response":{"models":[{"value":"default","resolvedModel":"claude-opus-5-5","displayName":"Default (recommended)","supportsEffort":true,"supportedEffortLevels":["low","high"]},{"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"For complex work","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"claude-opus-5-5","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5 pinned"},{"value":"claude-haiku-4-5-20251001","displayName":"Haiku 4.5"},{"value":"cc-update-required-1","displayName":"Update","disabled":true}]}}}"#;

    #[test]
    fn each_model_the_cli_runs_is_listed_once_with_its_efforts() {
        let models = parse_claude_models(ANSWER);
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["opus", "claude-haiku-4-5-20251001"]);
        assert_eq!(models[0].label, "Opus 5.5");
        assert_eq!(models[0].description.as_deref(), Some("For complex work"));
        assert_eq!(models[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert!(models[0].default);
        assert!(models[1].efforts.is_empty());
        assert!(!models[1].default);
    }

    #[test]
    fn an_older_cli_or_noise_gives_no_models() {
        assert!(parse_claude_models("").is_empty());
        assert!(parse_claude_models(
            r#"{"type":"control_response","response":{"subtype":"error","error":"unknown"}}"#
        )
        .is_empty());
        assert!(parse_claude_models("{not json control_response").is_empty());
    }

    #[test]
    fn the_probe_names_the_program_quoted() {
        assert!(claude_list_script("claude").starts_with("timeout 30 'claude' -p "));
    }
}

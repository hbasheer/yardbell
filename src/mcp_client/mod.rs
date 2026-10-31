pub mod http;
#[cfg(test)]
pub(crate) mod tests;

use serde_json::Value;

pub use http::{HttpClient, HttpOptions};

pub const PROTOCOL_OFFERED: &str = "2025-11-25";
pub const REPLY_MAX: usize = 4 * 1024 * 1024;
pub(crate) const PROTOCOLS_KNOWN: [&str; 4] =
    ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
pub(crate) const TOOL_PAGES_MAX: usize = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only_hint: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolReply {
    pub text: String,
    pub structured: Option<Value>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Challenge {
    pub resource_metadata: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    NeedsSignIn(Challenge),
    NeedsScope(Challenge),
    Other(String),
}

pub(crate) fn tool_of(value: &Value) -> Option<Tool> {
    Some(Tool {
        name: value["name"].as_str()?.to_string(),
        description: value["description"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        input_schema: value["inputSchema"].clone(),
        read_only_hint: value["annotations"]["readOnlyHint"] == true,
    })
}

pub(crate) fn reply_of(result: &Value) -> ToolReply {
    let text = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    ToolReply {
        text,
        structured: result.get("structuredContent").cloned(),
        is_error: result["isError"] == true,
    }
}

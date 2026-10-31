pub mod http;
pub mod oauth;
#[cfg(test)]
pub(crate) mod oauth_tests;
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

pub(crate) fn is_own_server(url: &str, cfg: &crate::config::Config) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.port_or_known_default() != Some(cfg.port) {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']);
    let local = ["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"];
    local.contains(&host) || cfg.bind_addresses().iter().any(|a| a == host)
}

pub(crate) fn holds_own_token(
    server: &crate::config::McpServer,
    cfg: &crate::config::Config,
    secrets: &crate::secrets::Secrets,
) -> bool {
    let Ok(Some(token)) = cfg.mcp_token(secrets) else {
        return false;
    };
    server.headers.values().any(|value| {
        secrets
            .resolve(value)
            .is_ok_and(|resolved| resolved.contains(&token))
    })
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

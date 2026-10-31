pub mod http;
pub mod oauth;
#[cfg(test)]
pub(crate) mod oauth_tests;
pub mod stdio;
#[cfg(test)]
pub(crate) mod stdio_tests;
#[cfg(test)]
pub(crate) mod tests;

use serde_json::Value;

pub use http::{HttpClient, HttpOptions};
pub use stdio::{StdioClient, StdioOptions};

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
    NotAllowed(String),
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

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<&String, Value> =
                map.iter().map(|(k, v)| (k, canonical(v))).collect();
            serde_json::to_value(sorted).unwrap_or(Value::Null)
        }
        Value::Array(list) => Value::Array(list.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

pub fn schema_hash(tool: &Tool) -> String {
    use sha2::{Digest, Sha256};
    let text = format!(
        "{}\0{}\0{}",
        tool.name,
        tool.description,
        canonical(&tool.input_schema)
    );
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub enum Client {
    Http(HttpClient),
    Stdio(StdioClient),
}

impl Client {
    pub async fn connect(&mut self) -> Result<String, Failure> {
        match self {
            Client::Http(c) => c.connect().await,
            Client::Stdio(c) => c.connect().await,
        }
    }

    pub async fn list_tools(&mut self) -> Result<Vec<Tool>, Failure> {
        match self {
            Client::Http(c) => c.list_tools().await,
            Client::Stdio(c) => c.list_tools().await,
        }
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<ToolReply, Failure> {
        match self {
            Client::Http(c) => c.call_tool(name, arguments).await,
            Client::Stdio(c) => c.call_tool(name, arguments).await,
        }
    }

    pub async fn close(&mut self) {
        match self {
            Client::Http(c) => c.close().await,
            Client::Stdio(c) => c.close().await,
        }
    }
}

fn resolved_all(
    pairs: &std::collections::BTreeMap<String, String>,
    secrets: &crate::secrets::Secrets,
) -> Result<Vec<(String, String)>, Failure> {
    pairs
        .iter()
        .map(|(key, value)| {
            secrets
                .resolve(value)
                .map(|value| (key.clone(), value))
                .map_err(|e| Failure::Other(e.to_string()))
        })
        .collect()
}

pub async fn client_for(
    server: &crate::config::McpServer,
    cfg: &crate::config::Config,
    secrets: &crate::secrets::Secrets,
    auth: &oauth::Auth,
    store: &crate::settings::Settings,
    saved: Vec<String>,
    timeout: std::time::Duration,
) -> Result<Client, Failure> {
    if server.url.is_empty() {
        let here = cfg
            .machines
            .iter()
            .find(|m| m.local)
            .map(|m| m.name.as_str());
        if !server.machines.is_empty()
            && !here.is_some_and(|h| server.machines.iter().any(|m| m == h))
        {
            return Err(Failure::NotAllowed(format!(
                "{} only runs on {}, so a step cannot call it here",
                server.name,
                server.machines.join(", ")
            )));
        }
        return Ok(Client::Stdio(StdioClient::new(StdioOptions {
            command: server.command.clone(),
            env: resolved_all(&server.env, secrets)?,
            saved,
            timeout,
        })));
    }
    let url = secrets
        .resolve(&server.url)
        .map_err(|e| Failure::Other(e.to_string()))?;
    if is_own_server(&url, cfg) || holds_own_token(server, cfg, secrets) {
        return Err(Failure::NotAllowed(format!(
            "{} is Yardbell itself, which a pipeline must not call",
            server.name
        )));
    }
    let bearer = auth.bearer(server, store).await?;
    let client = HttpClient::new(HttpOptions {
        url,
        headers: resolved_all(&server.headers, secrets)?,
        bearer,
        allow_private: server.allow_private,
        saved,
        timeout,
    })
    .map_err(Failure::Other)?;
    Ok(Client::Http(client))
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

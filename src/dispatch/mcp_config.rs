use super::store::write_private;
use super::Dispatch;
use serde_json::{json, Value};
use std::path::PathBuf;

pub const CONVERSATION_HEADER: &str = "x-yardbell-conversation";

impl Dispatch {
    pub(super) fn mcp_config_file(&self, id: &str) -> PathBuf {
        self.shared.dir.join("mcp").join(format!("{id}.json"))
    }

    // The user's own MCP servers, such as Linear, come along so Dispatch can read tickets. The
    // conversation header tells Yardbell's MCP server which conversation a proposal belongs to.
    pub(super) fn write_mcp_config(
        &self,
        port: u16,
        extra: Option<&str>,
        id: &str,
    ) -> Result<PathBuf, String> {
        let mut servers = extra
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|v| v["mcpServers"].as_object().cloned())
            .unwrap_or_default();
        servers.insert(
            "yardbell".into(),
            json!({
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp"),
                "headers": {
                    "Authorization": format!("Bearer {}", self.token),
                    CONVERSATION_HEADER: id,
                },
            }),
        );
        let config = json!({ "mcpServers": servers });
        let path = self.mcp_config_file(id);
        write_private(&path, config.to_string().as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        Ok(path)
    }
}

pub(super) fn extra_servers(extra: Option<&str>) -> Vec<String> {
    extra
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|v| {
            v["mcpServers"]
                .as_object()
                .map(|m| m.keys().cloned().collect())
        })
        .unwrap_or_default()
}

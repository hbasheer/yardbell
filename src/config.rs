use crate::agents::{self, Agent};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const PRIVATE_FILE: u32 = 0o600;

const EXAMPLE: &str = include_str!("../yardbell.example.yml");

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read {path}: {source}\n\nCreate it, for example:\n\n{EXAMPLE}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    #[error("cannot parse {path}: {source}")]
    Parse {
        path: String,
        source: serde_yaml::Error,
    },
    #[error("invalid config: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum HostTerminal {
    Iterm2,
    Terminal,
    #[default]
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MeshProvider {
    Nordvpn,
    Tailscale,
    Headscale,
    Netbird,
    Zerotier,
    #[default]
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Machine {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_prefix: Option<u8>,
    pub root: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<MeshProvider>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent: Vec<String>,
}

impl Machine {
    pub fn is_local(&self) -> bool {
        self.local
    }

    pub fn ssh_host(&self) -> &str {
        self.ssh.as_deref().unwrap_or(&self.name)
    }

    pub fn root_expanded(&self) -> PathBuf {
        expand_tilde(&self.root)
    }
}

pub fn expand_tilde(path: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if path == "~" {
        return PathBuf::from(home);
    }
    match path.strip_prefix("~/") {
        Some(rest) => Path::new(&home).join(rest),
        None => PathBuf::from(path),
    }
}

fn default_port() -> u16 {
    4000
}

fn default_poll() -> u64 {
    5
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PhoneNotifications {
    pub wait_minutes: u64,
    pub agent_waiting: bool,
    pub session_ended: bool,
    pub machines: bool,
    pub memory: bool,
}

impl Default for PhoneNotifications {
    fn default() -> Self {
        PhoneNotifications {
            wait_minutes: 2,
            agent_waiting: true,
            session_ended: true,
            machines: true,
            memory: true,
        }
    }
}

impl PhoneNotifications {
    pub fn is_default(&self) -> bool {
        *self == PhoneNotifications::default()
    }
}

pub const DISPATCH_MODELS: [&str; 3] = ["sonnet", "opus", "haiku"];
const DISPATCH_INSTRUCTIONS_MAX: usize = 4000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Approval {
    #[default]
    Ask,
    Auto,
}

impl Approval {
    fn is_default(&self) -> bool {
        *self == Approval::default()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchSettings {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "Approval::is_default")]
    pub approval: Approval,
}

impl DispatchSettings {
    fn is_default(&self) -> bool {
        *self == DispatchSettings::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub machines: Vec<String>,
}

impl McpServer {
    fn entry(&self) -> serde_json::Value {
        if !self.url.is_empty() {
            return serde_json::json!({ "type": "http", "url": self.url, "headers": self.headers });
        }
        let mut words = self.command.split_whitespace();
        serde_json::json!({
            "command": words.next().unwrap_or_default(),
            "args": words.collect::<Vec<_>>(),
            "env": self.env,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_poll")]
    pub poll_seconds: u64,
    #[serde(default)]
    pub host_terminal: HostTerminal,
    #[serde(default)]
    pub mesh: MeshProvider,
    #[serde(default)]
    pub ticket_pattern: String,
    #[serde(default)]
    pub forward_services: Vec<String>,
    #[serde(default)]
    pub workspaces: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<Agent>,
    #[serde(default, skip_serializing_if = "PhoneNotifications::is_default")]
    pub phone_notifications: PhoneNotifications,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<McpServer>,
    #[serde(default, skip_serializing_if = "DispatchSettings::is_default")]
    pub dispatch: DispatchSettings,
    pub machines: Vec<Machine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passcode_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_token: Option<String>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Config, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.display().to_string(),
            source,
        })?;
        let cfg: Config = serde_yaml::from_str(&text).map_err(|source| ConfigError::Parse {
            path: path.display().to_string(),
            source,
        })?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        self.validate()?;
        let text = serde_yaml::to_string(self).map_err(|source| ConfigError::Parse {
            path: path.display().to_string(),
            source,
        })?;
        let tmp = path.with_extension("yml.tmp");
        // It holds the cookie key, the passcode hash and MCP tokens.
        let write = || -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .mode(PRIVATE_FILE)
                .open(&tmp)?;
            file.set_permissions(std::fs::Permissions::from_mode(PRIVATE_FILE))?;
            file.write_all(text.as_bytes())?;
            std::fs::rename(&tmp, path)
        };
        write().map_err(|source| ConfigError::Read {
            path: path.display().to_string(),
            source,
        })
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        let invalid = |msg: String| Err(ConfigError::Invalid(msg));
        let name_re = Regex::new("^[a-z0-9-]+$").expect("static regex");
        let mut names = HashSet::new();
        let mut prefixes = HashSet::new();
        let mut locals = 0;
        for m in &self.machines {
            if !name_re.is_match(&m.name) {
                return invalid(format!("machine name {:?} must match [a-z0-9-]+", m.name));
            }
            if !names.insert(m.name.as_str()) {
                return invalid(format!("machine name {:?} is used twice", m.name));
            }
            if m.local {
                locals += 1;
                continue;
            }
            let Some(prefix) = m.port_prefix else {
                return invalid(format!(
                    "machine {:?} needs a port_prefix from 1 to 6",
                    m.name
                ));
            };
            if !(1..=6).contains(&prefix) {
                return invalid(format!(
                    "machine {:?} port_prefix {prefix} is outside 1 to 6",
                    m.name
                ));
            }
            if !prefixes.insert(prefix) {
                return invalid(format!("port_prefix {prefix} is used twice"));
            }
        }
        if locals > 1 {
            return invalid("only one machine can be local: true".into());
        }
        let process_re = Regex::new("^[A-Za-z0-9._-]+$").expect("static regex");
        let mut agent_names = HashSet::new();
        for a in &self.agents {
            if !name_re.is_match(&a.name) {
                return invalid(format!("agent name {:?} must match [a-z0-9-]+", a.name));
            }
            if !agent_names.insert(a.name.as_str()) {
                return invalid(format!("agent {:?} is listed twice", a.name));
            }
            if a.command.trim().is_empty() || a.resume.trim().is_empty() {
                return invalid(format!("agent {:?} needs a command and a resume", a.name));
            }
            if !process_re.is_match(&a.process_name()) {
                return invalid(format!(
                    "agent {:?} process {:?} must be a plain program name",
                    a.name,
                    a.process_name()
                ));
            }
        }
        if self.agent(self.default_agent()).is_none() {
            return invalid(format!(
                "default_agent {:?} is not a known agent",
                self.default_agent()
            ));
        }
        if !self.ticket_pattern.is_empty() {
            if let Err(e) = Regex::new(&self.ticket_pattern) {
                return invalid(format!("ticket_pattern does not compile: {e}"));
            }
        }
        if self.phone_notifications.wait_minutes > 60 {
            return invalid("phone_notifications.wait_minutes must be from 0 to 60".into());
        }
        self.validate_mcp_servers().map_err(ConfigError::Invalid)?;
        self.validate_dispatch().map_err(ConfigError::Invalid)
    }

    fn validate_dispatch(&self) -> Result<(), String> {
        let d = &self.dispatch;
        if d.instructions.chars().count() > DISPATCH_INSTRUCTIONS_MAX {
            return Err(format!(
                "dispatch.instructions must be at most {DISPATCH_INSTRUCTIONS_MAX} characters"
            ));
        }
        if !d.agent.is_empty() && self.agent(&d.agent).is_none() {
            return Err(format!(
                "dispatch.agent {:?} is not a built-in agent or one listed under agents",
                d.agent
            ));
        }
        if !d.model.is_empty() && !DISPATCH_MODELS.contains(&d.model.as_str()) {
            return Err(format!(
                "dispatch.model must be one of {}, or empty for Claude Code's default",
                DISPATCH_MODELS.join(", ")
            ));
        }
        Ok(())
    }

    fn validate_mcp_servers(&self) -> Result<(), String> {
        let name_re = Regex::new("^[A-Za-z0-9_-]+$").expect("static regex");
        let key_re = Regex::new("^[A-Za-z_][A-Za-z0-9_]*$").expect("static regex");
        let header_re = Regex::new("^[A-Za-z0-9-]+$").expect("static regex");
        let mut names = HashSet::new();
        for s in &self.mcp_servers {
            if !name_re.is_match(&s.name) {
                return Err(format!(
                    "MCP server name {:?} must use only letters, digits, - and _",
                    s.name
                ));
            }
            if !names.insert(s.name.as_str()) {
                return Err(format!("MCP server {:?} is listed twice", s.name));
            }
            match (s.command.trim().is_empty(), s.url.trim().is_empty()) {
                (true, true) | (false, false) => {
                    return Err(format!(
                        "MCP server {:?} needs either a command or a URL",
                        s.name
                    ))
                }
                (true, false)
                    if !s.url.starts_with("http://") && !s.url.starts_with("https://") =>
                {
                    return Err(format!(
                        "MCP server {:?} URL must start with http:// or https://",
                        s.name
                    ))
                }
                _ => {}
            }
            let bad_env = s.env.keys().find(|k| !key_re.is_match(k));
            let bad_header = s.headers.keys().find(|k| !header_re.is_match(k));
            if let Some(key) = bad_env.or(bad_header) {
                return Err(format!(
                    "MCP server {:?} has an invalid name {key:?}",
                    s.name
                ));
            }
            if let Some(m) = s.machines.iter().find(|m| self.machine(m).is_none()) {
                return Err(format!(
                    "MCP server {:?} lists machine {m:?}, which is not in Yardbell",
                    s.name
                ));
            }
        }
        Ok(())
    }

    pub fn mcp_config_for(&self, machine: &str) -> Option<String> {
        let servers: serde_json::Map<String, serde_json::Value> = self
            .mcp_servers
            .iter()
            .filter(|s| s.machines.is_empty() || s.machines.iter().any(|m| m == machine))
            .map(|s| (s.name.clone(), s.entry()))
            .collect();
        if servers.is_empty() {
            return None;
        }
        Some(serde_json::json!({ "mcpServers": servers }).to_string())
    }

    pub fn bind_addresses(&self) -> Vec<String> {
        let mut out = vec!["127.0.0.1".to_string()];
        let mesh = self
            .listen_ip
            .clone()
            .or_else(|| self.host().and_then(|m| m.mesh_ip.clone()));
        if let Some(ip) = mesh.filter(|ip| ip != "127.0.0.1") {
            out.push(ip);
        }
        out
    }

    pub fn host(&self) -> Option<&Machine> {
        self.machines.iter().find(|m| m.local)
    }

    pub fn remote_machines(&self) -> impl Iterator<Item = &Machine> {
        self.machines.iter().filter(|m| !m.local)
    }

    pub fn machine(&self, name: &str) -> Option<&Machine> {
        self.machines.iter().find(|m| m.name == name)
    }

    pub fn mesh_for(&self, m: &Machine) -> MeshProvider {
        m.mesh.unwrap_or(self.mesh)
    }

    pub fn workspaces_for<'a>(&'a self, m: &'a Machine) -> &'a [String] {
        m.workspaces.as_deref().unwrap_or(&self.workspaces)
    }

    pub fn agents(&self) -> Vec<Agent> {
        agents::merged(&self.agents)
    }

    pub fn agent(&self, name: &str) -> Option<Agent> {
        self.agents().into_iter().find(|a| a.name == name)
    }

    pub fn default_agent(&self) -> &str {
        self.default_agent.as_deref().unwrap_or("claude")
    }

    pub fn ticket_regex(&self) -> Option<Regex> {
        if self.ticket_pattern.is_empty() {
            return None;
        }
        RegexBuilder::new(&self.ticket_pattern)
            .case_insensitive(true)
            .build()
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture() -> Config {
        Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap()
    }

    fn load_str(yaml: &str) -> Result<Config, ConfigError> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        std::fs::write(&path, yaml).unwrap();
        Config::load(&path)
    }

    const BASE: &str = "machines:\n  - name: mini\n    local: true\n    root: /r\n";

    #[test]
    fn loads_fixture() {
        let cfg = fixture();
        assert_eq!(cfg.machines.len(), 3);
        assert_eq!(cfg.machine("hp").unwrap().port_prefix, Some(1));
        assert_eq!(cfg.host().unwrap().name, "mini");
        let remotes: Vec<&str> = cfg.remote_machines().map(|m| m.name.as_str()).collect();
        assert_eq!(remotes, vec!["hp", "pro"]);
        assert_eq!(cfg.port, 4000);
        assert_eq!(cfg.host_terminal, HostTerminal::Iterm2);
    }

    #[test]
    fn defaults_apply() {
        let cfg = load_str(BASE).unwrap();
        assert_eq!(cfg.port, 4000);
        assert_eq!(cfg.poll_seconds, 5);
        assert_eq!(cfg.host_terminal, HostTerminal::None);
        assert!(cfg.ticket_regex().is_none());
    }

    #[test]
    fn expands_tilde() {
        let cfg = fixture();
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            cfg.machine("hp").unwrap().root_expanded(),
            Path::new(&home).join("code/acme")
        );
    }

    #[test]
    fn ssh_host_falls_back_to_name() {
        let cfg = load_str("machines:\n  - name: hp\n    port_prefix: 1\n    root: /r\n").unwrap();
        assert_eq!(cfg.machine("hp").unwrap().ssh_host(), "hp");
        assert_eq!(fixture().machine("pro").unwrap().ssh_host(), "mac_pro");
    }

    #[test]
    fn missing_file_error_shows_example() {
        let err = Config::load(Path::new("/nope/yardbell.yml")).unwrap_err();
        assert!(err.to_string().contains("machines:"), "{err}");
    }

    #[test]
    fn rejects_invalid() {
        let cases = [
            "machines:\n  - {name: a, local: true, root: /r}\n  - {name: b, local: true, root: /r}\n",
            "machines:\n  - {name: a, port_prefix: 1, root: /r}\n  - {name: b, port_prefix: 1, root: /r}\n",
            "machines:\n  - {name: a, port_prefix: 7, root: /r}\n",
            "machines:\n  - {name: a, port_prefix: 0, root: /r}\n",
            "machines:\n  - {name: a, root: /r}\n",
            "machines:\n  - {name: Hp!, local: true, root: /r}\n",
            "machines:\n  - {name: a, local: true, root: /r}\n  - {name: a, port_prefix: 1, root: /r}\n",
            "ticket_pattern: '('\nmachines:\n  - {name: a, local: true, root: /r}\n",
        ];
        for yaml in cases {
            assert!(load_str(yaml).is_err(), "accepted: {yaml}");
        }
    }

    #[test]
    fn agents_default_to_builtin_with_claude() {
        let cfg = load_str(BASE).unwrap();
        assert_eq!(cfg.default_agent(), "claude");
        assert_eq!(cfg.agents().len(), crate::agents::builtin().len());
        assert_eq!(cfg.agent("codex").unwrap().resume, "codex resume --last");
        assert!(cfg.agent("nope").is_none());
    }

    #[test]
    fn custom_agents_and_default() {
        let cfg = load_str(&format!(
            "default_agent: amp\nagents:\n  - {{name: amp, command: amp, resume: amp threads continue}}\n{BASE}"
        ))
        .unwrap();
        assert_eq!(cfg.default_agent(), "amp");
        assert_eq!(cfg.agent("amp").unwrap().command, "amp");
        let saved = serde_yaml::to_string(&load_str(BASE).unwrap()).unwrap();
        assert!(!saved.contains("agents"), "{saved}");
    }

    #[test]
    fn rejects_invalid_agents() {
        let cases = [
            "default_agent: nope\n",
            "agents:\n  - {name: Bad!, command: x, resume: x}\n",
            "agents:\n  - {name: a, command: '', resume: x}\n",
            "agents:\n  - {name: a, command: x, resume: ' '}\n",
            "agents:\n  - {name: a, command: x, resume: x, process: 'a b'}\n",
            "agents:\n  - {name: a, command: x, resume: x}\n  - {name: a, command: y, resume: y}\n",
        ];
        for head in cases {
            let yaml = format!("{head}{BASE}");
            assert!(load_str(&yaml).is_err(), "accepted: {yaml}");
        }
    }

    #[test]
    fn machine_workspaces_override() {
        let cfg = load_str(
            "workspaces: [app]\nmachines:\n  - {name: a, local: true, root: /r, workspaces: [src]}\n  - {name: b, port_prefix: 1, root: /r}\n",
        )
        .unwrap();
        assert_eq!(
            cfg.workspaces_for(cfg.machine("a").unwrap()),
            ["src".to_string()]
        );
        assert_eq!(
            cfg.workspaces_for(cfg.machine("b").unwrap()),
            ["app".to_string()]
        );
    }

    #[test]
    fn bind_addresses_use_host_mesh_ip_or_listen_ip() {
        assert_eq!(fixture().bind_addresses(), vec!["127.0.0.1", "100.64.0.10"]);
        let mut cfg = load_str("machines:\n  - {name: hp, port_prefix: 1, root: /r}\n").unwrap();
        assert_eq!(cfg.bind_addresses(), vec!["127.0.0.1"]);
        cfg.listen_ip = Some("100.64.0.99".into());
        assert_eq!(cfg.bind_addresses(), vec!["127.0.0.1", "100.64.0.99"]);
    }

    #[test]
    fn mesh_provider_defaults_and_overrides() {
        let cfg = load_str(BASE).unwrap();
        assert_eq!(cfg.mesh, MeshProvider::None);
        let cfg = load_str(
            "mesh: nordvpn\nmachines:\n  - {name: a, local: true, root: /r}\n  - {name: b, port_prefix: 1, root: /r, mesh: tailscale}\n",
        )
        .unwrap();
        assert_eq!(cfg.mesh, MeshProvider::Nordvpn);
        assert_eq!(
            cfg.mesh_for(cfg.machine("a").unwrap()),
            MeshProvider::Nordvpn
        );
        assert_eq!(
            cfg.mesh_for(cfg.machine("b").unwrap()),
            MeshProvider::Tailscale
        );
        assert!(
            load_str("mesh: wireguard-ish\nmachines:\n  - {name: a, local: true, root: /r}\n")
                .is_err()
        );
    }

    #[test]
    fn ticket_regex_case_insensitive() {
        let re = fixture().ticket_regex().unwrap();
        assert!(re.is_match("ENG-12-x"));
    }

    #[test]
    fn save_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        let mut cfg = fixture();
        cfg.machines.push(Machine {
            name: "air".into(),
            ssh: Some("air".into()),
            mesh_ip: Some("100.1.1.1".into()),
            port_prefix: Some(3),
            root: "~/code/acme".into(),
            local: false,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        });
        cfg.save(&path).unwrap();
        let back = Config::load(&path).unwrap();
        assert_eq!(back.machine("air").unwrap().port_prefix, Some(3));
        assert_eq!(back.machine("air").unwrap().root, "~/code/acme");
        assert!(!dir.path().join("yardbell.yml.tmp").exists());
    }

    #[test]
    fn save_refuses_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fixture();
        cfg.machines[1].port_prefix = Some(9);
        assert!(cfg.save(&dir.path().join("yardbell.yml")).is_err());
    }

    #[test]
    fn save_is_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        let cfg = fixture();
        cfg.save(&path).unwrap();
        let reader_path = path.clone();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader_stop = stop.clone();
        let reader = std::thread::spawn(move || {
            let mut reads = 0;
            while !reader_stop.load(std::sync::atomic::Ordering::Relaxed) {
                Config::load(&reader_path).expect("reader saw a broken file");
                reads += 1;
            }
            reads
        });
        for _ in 0..50 {
            cfg.save(&path).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(reader.join().unwrap() > 0);
    }

    #[test]
    fn phone_notifications_default_when_missing() {
        let p = fixture().phone_notifications;
        assert_eq!(p, PhoneNotifications::default());
        assert_eq!(p.wait_minutes, 2);
        assert!(p.agent_waiting && p.session_ended && p.machines && p.memory);
    }

    #[test]
    fn phone_notifications_from_the_ntfy_days_still_load() {
        let cfg = load_str(&format!(
            "{BASE}phone_notifications:\n  server: https://ntfy.sh\n  topic: abc\n  token: tk\n  wait_minutes: 5\n"
        ))
        .unwrap();
        let p = cfg.phone_notifications;
        assert_eq!(p.wait_minutes, 5);
        assert!(p.agent_waiting && p.session_ended && p.machines && p.memory);
    }

    #[test]
    fn phone_notifications_round_trip_and_default_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        let mut cfg = fixture();
        cfg.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("phone_notifications"), "{text}");

        cfg.phone_notifications.wait_minutes = 0;
        cfg.phone_notifications.memory = false;
        cfg.save(&path).unwrap();
        assert_eq!(
            Config::load(&path).unwrap().phone_notifications,
            cfg.phone_notifications
        );
    }

    #[test]
    fn phone_notifications_wait_is_checked() {
        let refused = load_str(&format!("{BASE}phone_notifications:\n  wait_minutes: 61\n"));
        match refused {
            Err(ConfigError::Invalid(got)) => {
                assert_eq!(got, "phone_notifications.wait_minutes must be from 0 to 60")
            }
            other => panic!("61 minutes was not refused: {other:?}"),
        }
        for minutes in [0, 60] {
            let yaml = format!("{BASE}phone_notifications:\n  wait_minutes: {minutes}\n");
            assert!(load_str(&yaml).is_ok(), "refused: {minutes}");
        }
    }

    #[test]
    fn mcp_servers_build_a_config_per_machine() {
        let yaml = "mcp_servers:\n  - name: github\n    command: npx -y @modelcontextprotocol/server-github\n    env: {GITHUB_TOKEN: t}\n  - name: linear\n    url: https://mcp.linear.app/mcp\n    headers: {Authorization: Bearer x}\n    machines: [mini]\nmachines:\n  - {name: hp, local: true, root: /r}\n  - {name: mini, port_prefix: 1, root: /r}\n";
        let cfg = load_str(yaml).unwrap();
        let hp: serde_json::Value =
            serde_json::from_str(&cfg.mcp_config_for("hp").unwrap()).unwrap();
        assert_eq!(
            hp,
            serde_json::json!({ "mcpServers": { "github": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": { "GITHUB_TOKEN": "t" },
            }}})
        );
        let mini: serde_json::Value =
            serde_json::from_str(&cfg.mcp_config_for("mini").unwrap()).unwrap();
        assert_eq!(
            mini["mcpServers"]["linear"],
            serde_json::json!({ "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer x" } })
        );
        let none = load_str("machines:\n  - {name: hp, local: true, root: /r}\n").unwrap();
        assert_eq!(none.mcp_config_for("hp"), None);
    }

    #[test]
    fn dispatch_settings_are_validated() {
        let ok = load_str(&format!(
            "dispatch:\n  instructions: Frontend work goes to codex.\n  agent: codex\n  model: haiku\n{BASE}"
        ))
        .unwrap();
        assert_eq!(ok.dispatch.agent, "codex");
        assert_eq!(ok.dispatch.approval, Approval::Ask, "asking is the default");
        assert_eq!(
            load_str(BASE).unwrap().dispatch,
            DispatchSettings::default()
        );
        let auto = load_str(&format!("dispatch:\n  approval: auto\n{BASE}")).unwrap();
        assert_eq!(auto.dispatch.approval, Approval::Auto);
        assert!(load_str(&format!("dispatch:\n  approval: maybe\n{BASE}")).is_err());
        let cases = [
            ("agent: nope", "dispatch.agent \"nope\" is not a built-in agent or one listed under agents"),
            ("model: gpt-9", "dispatch.model must be one of sonnet, opus, haiku, or empty for Claude Code's default"),
        ];
        for (setting, message) in cases {
            match load_str(&format!("dispatch:\n  {setting}\n{BASE}")) {
                Err(ConfigError::Invalid(got)) => assert_eq!(got, message, "{setting}"),
                other => panic!("{setting}: {other:?}"),
            }
        }
        let long = format!("dispatch:\n  instructions: {}\n{BASE}", "a".repeat(4001));
        assert!(load_str(&long).is_err());
    }

    #[test]
    fn mcp_servers_are_validated() {
        let cases = [
            (
                "{name: a}",
                "MCP server \"a\" needs either a command or a URL",
            ),
            (
                "{name: a, command: x, url: 'https://y'}",
                "MCP server \"a\" needs either a command or a URL",
            ),
            (
                "{name: a, url: 'ftp://y'}",
                "MCP server \"a\" URL must start with http:// or https://",
            ),
            (
                "{name: 'a b', command: x}",
                "MCP server name \"a b\" must use only letters, digits, - and _",
            ),
            (
                "{name: a, command: x, machines: [nope]}",
                "MCP server \"a\" lists machine \"nope\", which is not in Yardbell",
            ),
            (
                "{name: a, command: x, env: {'1X': y}}",
                "MCP server \"a\" has an invalid name \"1X\"",
            ),
            (
                "{name: a, url: 'https://y', headers: {'a b': y}}",
                "MCP server \"a\" has an invalid name \"a b\"",
            ),
        ];
        for (server, message) in cases {
            let yaml = format!("mcp_servers:\n  - {server}\n{BASE}");
            match load_str(&yaml) {
                Err(ConfigError::Invalid(got)) => assert_eq!(got, message, "{server}"),
                other => panic!("{server}: {other:?}"),
            }
        }
    }
}

use crate::agents::{self, Agent};
use crate::secrets::{self, Secrets, SecretsError};
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

pub const PULL_POLL_MIN: u64 = 30;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PullRequests {
    pub enabled: bool,
    pub poll_seconds: u64,
    pub cards: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub gitlab: Vec<GitLabHost>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitLabHost {
    #[serde(default)]
    pub host: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(default)]
    pub token: String,
}

impl GitLabHost {
    pub fn api(&self) -> String {
        let base = if self.url.is_empty() {
            format!("https://{}", self.host)
        } else {
            self.url.trim_end_matches('/').to_string()
        };
        format!("{base}/api/v4")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pipeline {
    #[serde(default)]
    pub machines: Vec<String>,
    #[serde(default)]
    pub test_machine: String,
    #[serde(default = "default_per_machine")]
    pub per_machine: u32,
    #[serde(default = "default_review_rounds")]
    pub review_rounds: u32,
    #[serde(default = "default_qa_retries")]
    pub qa_retries: u32,
    #[serde(default = "default_stage_minutes")]
    pub stage_minutes: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub linear_state: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub qa_instructions: String,
}

fn default_per_machine() -> u32 {
    2
}

fn default_review_rounds() -> u32 {
    2
}

fn default_qa_retries() -> u32 {
    1
}

fn default_stage_minutes() -> u64 {
    120
}

fn plain_url(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return false;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    !rest.is_empty() && !rest.contains(['/', '?', '#']) && !rest.contains(char::is_whitespace)
}

impl Default for PullRequests {
    fn default() -> Self {
        PullRequests {
            enabled: true,
            poll_seconds: 120,
            cards: true,
            gitlab: Vec::new(),
        }
    }
}

impl PullRequests {
    pub fn is_default(&self) -> bool {
        *self == PullRequests::default()
    }

    fn validate_gitlab(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for (i, g) in self.gitlab.iter().enumerate() {
            let host = g.host.trim().to_ascii_lowercase();
            if host.is_empty() {
                return Err(format!("pull_requests.gitlab entry {} needs a host", i + 1));
            }
            if host.contains(['/', ':', '@']) || host.contains(char::is_whitespace) {
                return Err(format!(
                    "pull_requests.gitlab host {:?} must be a host name only, like git.example.com",
                    g.host
                ));
            }
            if !seen.insert(host.clone()) {
                return Err(format!("pull_requests.gitlab lists {host} twice"));
            }
            if g.token.trim().is_empty() {
                return Err(format!("pull_requests.gitlab {host} needs a token"));
            }
            if !g.url.is_empty() && !plain_url(&g.url) {
                return Err(format!(
                    "pull_requests.gitlab {host}: url must start with https:// or http:// and have no path"
                ));
            }
            secrets::references(&g.token)
                .map_err(|e| format!("pull_requests.gitlab {host}: {e}"))?;
        }
        Ok(())
    }
}

pub const DISPATCH_MODELS: [&str; 3] = ["sonnet", "opus", "haiku"];
const DISPATCH_INSTRUCTIONS_MAX: usize = 4000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunsOn {
    #[default]
    Claude,
    Codex,
}

impl RunsOn {
    pub const ALL: [RunsOn; 2] = [RunsOn::Claude, RunsOn::Codex];

    pub fn is_default(&self) -> bool {
        *self == RunsOn::default()
    }

    pub fn name(&self) -> &'static str {
        match self {
            RunsOn::Claude => "claude",
            RunsOn::Codex => "codex",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            RunsOn::Claude => "Claude Code",
            RunsOn::Codex => "Codex",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Approval {
    #[serde(alias = "auto")]
    Allow,
    #[default]
    #[serde(alias = "ask")]
    Prompt,
    Deny,
}

impl Approval {
    fn is_default(&self) -> bool {
        *self == Approval::default()
    }

    // The default is written with the names 0.7.0 reads, so a config stays readable by it.
    fn write_as_before<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(match self {
            Approval::Allow => "auto",
            Approval::Prompt => "ask",
            Approval::Deny => "deny",
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchSettings {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent: String,
    #[serde(default, skip_serializing_if = "RunsOn::is_default")]
    pub runs_on: RunsOn,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub codex_model: String,
    #[serde(
        default,
        skip_serializing_if = "Approval::is_default",
        serialize_with = "Approval::write_as_before"
    )]
    pub approval: Approval,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<crate::dispatch::Rule>,
}

impl DispatchSettings {
    fn is_default(&self) -> bool {
        *self == DispatchSettings::default()
    }

    // Each agent keeps its own model, so switching agents never hands one a model only the other
    // knows. Empty is the agent's own default.
    pub fn model_for(&self, runs_on: RunsOn) -> &str {
        match runs_on {
            RunsOn::Claude => &self.model,
            RunsOn::Codex => &self.codex_model,
        }
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
    fn entry(&self, secrets: &Secrets) -> Result<serde_json::Value, String> {
        let resolve = |text: &str| {
            secrets.resolve(text).map_err(|e| match e {
                SecretsError::Missing(name) => format!(
                    "MCP server {} needs the secret {name}, which is not set. Set it under MCP servers in Settings",
                    self.name
                ),
                other => format!("MCP server {}: {other}", self.name),
            })
        };
        let resolve_all = |pairs: &BTreeMap<String, String>| {
            pairs
                .iter()
                .map(|(k, v)| Ok((k.clone(), resolve(v)?)))
                .collect::<Result<BTreeMap<_, _>, String>>()
        };
        if !self.url.is_empty() {
            return Ok(serde_json::json!({
                "type": "http",
                "url": resolve(&self.url)?,
                "headers": resolve_all(&self.headers)?,
            }));
        }
        let mut words = self.command.split_whitespace();
        Ok(serde_json::json!({
            "command": words.next().unwrap_or_default(),
            "args": words.collect::<Vec<_>>(),
            "env": resolve_all(&self.env)?,
        }))
    }

    pub fn secret_names(&self) -> Vec<String> {
        std::iter::once(&self.url)
            .chain(self.headers.values())
            .chain(self.env.values())
            .flat_map(|text| secrets::references(text).unwrap_or_default())
            .map(str::to_string)
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InlineKind {
    Header,
    Env,
    McpToken,
    CookieKey,
}

// A value written into yardbell.yml itself that could live in the secrets file. It never carries
// the value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inline {
    pub kind: InlineKind,
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub key: String,
}

impl Inline {
    // Ticked by default and enough to offer the move; GITHUB_HOST=github.com is not worth a nag.
    pub fn looks_secret(&self) -> bool {
        let re =
            Regex::new("(?i)token|key|secret|pass|auth|cred|cookie|session|private|signature|pat$")
                .expect("static regex");
        match self.kind {
            InlineKind::Header | InlineKind::Env => re.is_match(&self.key),
            InlineKind::McpToken | InlineKind::CookieKey => true,
        }
    }

    pub fn label(&self) -> String {
        match self.kind {
            InlineKind::Header => format!("{}: header {}", self.server, self.key),
            InlineKind::Env => format!("{}: {}", self.server, self.key),
            InlineKind::McpToken => "Yardbell's MCP token".into(),
            InlineKind::CookieKey => "Yardbell's login cookie key".into(),
        }
    }
}

fn is_inline(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|v| !v.is_empty() && !secrets::has_reference(v))
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
    #[serde(default, skip_serializing_if = "PullRequests::is_default")]
    pub pull_requests: PullRequests,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<Pipeline>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub triggers: Vec<crate::triggers::Trigger>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worktree_setup: Vec<crate::worktrees::setup::WorktreeSetup>,
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
        if self.pull_requests.poll_seconds < PULL_POLL_MIN {
            return invalid(format!(
                "pull_requests.poll_seconds must be at least {PULL_POLL_MIN}"
            ));
        }
        self.pull_requests
            .validate_gitlab()
            .map_err(ConfigError::Invalid)?;
        self.validate_mcp_servers().map_err(ConfigError::Invalid)?;
        self.validate_dispatch().map_err(ConfigError::Invalid)?;
        self.validate_pipeline().map_err(ConfigError::Invalid)?;
        crate::worktrees::setup::validate(&self.worktree_setup, |m| self.machine(m).is_some())
            .map_err(ConfigError::Invalid)?;
        crate::triggers::validate(&self.triggers).map_err(ConfigError::Invalid)
    }

    fn validate_pipeline(&self) -> Result<(), String> {
        let Some(p) = &self.pipeline else {
            return Ok(());
        };
        if p.machines.is_empty() {
            return Err("pipeline.machines needs at least one machine".into());
        }
        for name in &p.machines {
            if self.machine(name).is_none() {
                return Err(format!(
                    "pipeline.machines names {name:?}, which is not a machine"
                ));
            }
        }
        if p.test_machine.trim().is_empty() {
            return Err("pipeline.test_machine needs the machine QA runs on".into());
        }
        if self.machine(&p.test_machine).is_none() {
            return Err(format!(
                "pipeline.test_machine names {:?}, which is not a machine",
                p.test_machine
            ));
        }
        let ranges: [(&str, u64, u64, u64); 4] = [
            ("per_machine", p.per_machine.into(), 1, 6),
            ("review_rounds", p.review_rounds.into(), 1, 5),
            ("qa_retries", p.qa_retries.into(), 0, 3),
            ("stage_minutes", p.stage_minutes, 10, 1440),
        ];
        for (key, value, low, high) in ranges {
            if !(low..=high).contains(&value) {
                return Err(format!("pipeline.{key} must be from {low} to {high}"));
            }
        }
        Ok(())
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
        let codex_model = Regex::new("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$").expect("static regex");
        if !d.codex_model.is_empty() && !codex_model.is_match(&d.codex_model) {
            return Err(format!(
                "dispatch.codex_model {:?} is not a Codex model name like gpt-6.1-sol: up to 64 letters, digits, dots, dashes and underscores, or empty for Codex's default",
                d.codex_model
            ));
        }
        crate::dispatch::validate_rules(&d.rules, |m| self.machine(m).is_some())
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
            let values = std::iter::once(("URL".to_string(), &s.url))
                .chain(s.headers.iter().map(|(k, v)| (format!("header {k}"), v)))
                .chain(s.env.iter().map(|(k, v)| (k.clone(), v)));
            for (what, value) in values {
                secrets::references(value)
                    .map_err(|e| format!("MCP server {:?} {what}: {e}", s.name))?;
            }
        }
        for (what, value) in [
            ("mcp_token", &self.mcp_token),
            ("cookie_key", &self.cookie_key),
        ] {
            secrets::references(value.as_deref().unwrap_or_default())
                .map_err(|e| format!("{what}: {e}"))?;
        }
        Ok(())
    }

    // Secrets are filled in here, on the way to the file the session reads, and nowhere else.
    pub fn mcp_config_for(
        &self,
        machine: &str,
        secrets: &Secrets,
    ) -> Result<Option<String>, String> {
        let servers = self
            .mcp_servers
            .iter()
            .filter(|s| s.machines.is_empty() || s.machines.iter().any(|m| m == machine))
            .map(|s| Ok((s.name.clone(), s.entry(secrets)?)))
            .collect::<Result<serde_json::Map<String, serde_json::Value>, String>>()?;
        if servers.is_empty() {
            return Ok(None);
        }
        Ok(Some(
            serde_json::json!({ "mcpServers": servers }).to_string(),
        ))
    }

    pub fn mcp_token(&self, secrets: &Secrets) -> Result<Option<String>, String> {
        self.own_secret(self.mcp_token.as_deref(), "MCP token", secrets)
    }

    pub fn cookie_key(&self, secrets: &Secrets) -> Result<Option<String>, String> {
        self.own_secret(self.cookie_key.as_deref(), "login cookie key", secrets)
    }

    fn own_secret(
        &self,
        value: Option<&str>,
        what: &str,
        secrets: &Secrets,
    ) -> Result<Option<String>, String> {
        value
            .map(|v| {
                secrets.resolve(v).map_err(|e| {
                    format!(
                        "Yardbell's {what} cannot be read from {}: {e}",
                        secrets.path().display()
                    )
                })
            })
            .transpose()
    }

    pub fn inline_values(&self) -> Vec<Inline> {
        let mut out = Vec::new();
        for s in &self.mcp_servers {
            let pairs = s
                .headers
                .iter()
                .map(|kv| (InlineKind::Header, kv))
                .chain(s.env.iter().map(|kv| (InlineKind::Env, kv)));
            for (kind, (key, value)) in pairs {
                if !value.trim().is_empty() && !secrets::has_reference(value) {
                    out.push(Inline {
                        kind,
                        server: s.name.clone(),
                        key: key.clone(),
                    });
                }
            }
        }
        for (kind, value) in [
            (InlineKind::McpToken, &self.mcp_token),
            (InlineKind::CookieKey, &self.cookie_key),
        ] {
            if is_inline(value) {
                out.push(Inline {
                    kind,
                    server: String::new(),
                    key: String::new(),
                });
            }
        }
        out
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
    fn pull_requests_default_on_and_poll_is_checked() {
        let cfg = load_str(BASE).unwrap();
        assert!(cfg.pull_requests.enabled && cfg.pull_requests.cards);
        assert_eq!(cfg.pull_requests.poll_seconds, 120);
        let off = load_str(&format!("{BASE}pull_requests:\n  cards: false\n")).unwrap();
        assert!(off.pull_requests.enabled && !off.pull_requests.cards);
        match load_str(&format!("{BASE}pull_requests:\n  poll_seconds: 5\n")) {
            Err(ConfigError::Invalid(got)) => {
                assert_eq!(got, "pull_requests.poll_seconds must be at least 30")
            }
            other => panic!("5 seconds was not refused: {other:?}"),
        }
    }

    fn pipeline(yaml: &str) -> Result<Config, ConfigError> {
        load_str(&format!("{BASE}pipeline:\n{yaml}"))
    }

    #[test]
    fn pipeline_defaults_fill_in() {
        let cfg = pipeline("  machines: [mini]\n  test_machine: mini\n").unwrap();
        let p = cfg.pipeline.unwrap();
        assert_eq!(p.machines, vec!["mini"]);
        assert_eq!(p.test_machine, "mini");
        assert_eq!(p.per_machine, 2);
        assert_eq!(p.review_rounds, 2);
        assert_eq!(p.qa_retries, 1);
        assert_eq!(p.stage_minutes, 120);
        assert_eq!(p.linear_state, "");
        assert_eq!(p.qa_instructions, "");
    }

    #[test]
    fn pipeline_names_an_unknown_machine() {
        let err = pipeline("  machines: [mini, nope]\n  test_machine: mini\n")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("pipeline.machines") && err.contains("nope"),
            "{err}"
        );
        let err = pipeline("  machines: [mini]\n  test_machine: devbox\n")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("pipeline.test_machine") && err.contains("devbox"),
            "{err}"
        );
    }

    #[test]
    fn pipeline_numbers_out_of_range() {
        let base = "  machines: [mini]\n  test_machine: mini\n";
        for (line, says) in [
            ("per_machine: 7", "pipeline.per_machine must be from 1 to 6"),
            (
                "review_rounds: 0",
                "pipeline.review_rounds must be from 1 to 5",
            ),
            ("qa_retries: 4", "pipeline.qa_retries must be from 0 to 3"),
            (
                "stage_minutes: 5",
                "pipeline.stage_minutes must be from 10 to 1440",
            ),
        ] {
            let err = pipeline(&format!("{base}  {line}\n"))
                .unwrap_err()
                .to_string();
            assert!(err.contains(says), "{line}: {err}");
        }
    }

    #[test]
    fn pipeline_needs_machines_and_a_test_machine() {
        let err = pipeline("  machines: []\n  test_machine: mini\n")
            .unwrap_err()
            .to_string();
        assert!(err.contains("pipeline.machines"), "{err}");
        let err = pipeline("  machines: [mini]\n").unwrap_err().to_string();
        assert!(err.contains("pipeline.test_machine"), "{err}");
    }

    #[test]
    fn no_pipeline_is_fine() {
        let cfg = load_str(BASE).unwrap();
        assert!(cfg.pipeline.is_none());
        cfg.validate().unwrap();
    }

    #[test]
    fn gitlab_hosts_load_and_name_their_api() {
        let cfg = load_str(&format!(
            "{BASE}pull_requests:\n  gitlab:\n    - {{host: git.commslayer.com, token: '${{secret:gitlab}}'}}\n    - {{host: gl.example.com, url: 'https://gl.example.com:8443/', token: abc}}\n"
        ))
        .unwrap();
        let hosts = &cfg.pull_requests.gitlab;
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].token, "${secret:gitlab}");
        assert_eq!(hosts[0].api(), "https://git.commslayer.com/api/v4");
        assert_eq!(hosts[1].api(), "https://gl.example.com:8443/api/v4");
    }

    #[test]
    fn gitlab_hosts_are_checked() {
        let cases = [
            ("{token: x}", "pull_requests.gitlab entry 1 needs a host"),
            (
                "{host: 'https://x/y', token: x}",
                "pull_requests.gitlab host \"https://x/y\" must be a host name only, like git.example.com",
            ),
            (
                "{host: Git.Example.com, token: x}\n    - {host: git.example.com, token: y}",
                "pull_requests.gitlab lists git.example.com twice",
            ),
            ("{host: git.example.com}", "pull_requests.gitlab git.example.com needs a token"),
            (
                "{host: git.example.com, url: 'ftp://x', token: x}",
                "pull_requests.gitlab git.example.com: url must start with https:// or http:// and have no path",
            ),
            (
                "{host: git.example.com, url: 'https://x/path', token: x}",
                "pull_requests.gitlab git.example.com: url must start with https:// or http:// and have no path",
            ),
        ];
        for (entry, message) in cases {
            match load_str(&format!("{BASE}pull_requests:\n  gitlab:\n    - {entry}\n")) {
                Err(ConfigError::Invalid(got)) => assert_eq!(got, message, "{entry}"),
                other => panic!("{entry} was not refused: {other:?}"),
            }
        }
    }

    #[test]
    fn an_empty_gitlab_list_is_not_written() {
        assert!(PullRequests::default().is_default());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        let mut cfg = fixture();
        cfg.pull_requests.cards = false;
        cfg.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("cards: false"), "{text}");
        assert!(!text.contains("gitlab"), "{text}");
    }

    #[test]
    fn mcp_servers_build_a_config_per_machine() {
        let yaml = "mcp_servers:\n  - name: github\n    command: npx -y @modelcontextprotocol/server-github\n    env: {GITHUB_TOKEN: t}\n  - name: linear\n    url: https://mcp.linear.app/mcp\n    headers: {Authorization: Bearer x}\n    machines: [mini]\nmachines:\n  - {name: hp, local: true, root: /r}\n  - {name: mini, port_prefix: 1, root: /r}\n";
        let cfg = load_str(yaml).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let none_set = Secrets::for_config(&dir.path().join("yardbell.yml")).unwrap();
        let config = |m: &str| cfg.mcp_config_for(m, &none_set).unwrap().unwrap();
        let hp: serde_json::Value = serde_json::from_str(&config("hp")).unwrap();
        assert_eq!(
            hp,
            serde_json::json!({ "mcpServers": { "github": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": { "GITHUB_TOKEN": "t" },
            }}})
        );
        let mini: serde_json::Value = serde_json::from_str(&config("mini")).unwrap();
        assert_eq!(
            mini["mcpServers"]["linear"],
            serde_json::json!({ "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer x" } })
        );
        let none = load_str("machines:\n  - {name: hp, local: true, root: /r}\n").unwrap();
        assert_eq!(none.mcp_config_for("hp", &none_set), Ok(None));
    }

    const WITH_REFS: &str = "mcp_servers:\n  - name: linear\n    url: https://mcp.linear.app/mcp\n    headers: {Authorization: 'Bearer ${secret:linear}'}\n  - name: github\n    command: npx gh-mcp\n    env: {GITHUB_TOKEN: '${secret:gh}', LOG: debug}\nmachines:\n  - {name: hp, local: true, root: /r}\n";

    #[test]
    fn secret_references_resolve_only_in_the_session_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        std::fs::write(&path, WITH_REFS).unwrap();
        let cfg = Config::load(&path).unwrap();
        let mut secrets = Secrets::for_config(&path).unwrap();
        let now = chrono::Utc::now();
        secrets.set("linear", "lin_api_SECRET", now).unwrap();
        secrets.set("gh", "ghp_SECRET", now).unwrap();
        let built: serde_json::Value =
            serde_json::from_str(&cfg.mcp_config_for("hp", &secrets).unwrap().unwrap()).unwrap();
        assert_eq!(
            built["mcpServers"]["linear"]["headers"]["Authorization"],
            "Bearer lin_api_SECRET"
        );
        assert_eq!(
            built["mcpServers"]["github"]["env"]["GITHUB_TOKEN"],
            "ghp_SECRET"
        );
        assert_eq!(built["mcpServers"]["github"]["env"]["LOG"], "debug");
        cfg.save(&path).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("${secret:linear}"), "{saved}");
        assert!(!saved.contains("SECRET"), "{saved}");
        assert!(!format!("{cfg:?}").contains("lin_api_SECRET"));
        assert_eq!(cfg.inline_values().len(), 1, "only LOG is written inline");
    }

    #[test]
    fn a_missing_secret_is_named_without_any_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        std::fs::write(&path, WITH_REFS).unwrap();
        let cfg = Config::load(&path).unwrap();
        let mut secrets = Secrets::for_config(&path).unwrap();
        secrets
            .set("linear", "lin_api_SECRET", chrono::Utc::now())
            .unwrap();
        let err = cfg.mcp_config_for("hp", &secrets).unwrap_err();
        assert_eq!(
            err,
            "MCP server github needs the secret gh, which is not set. Set it under MCP servers in Settings"
        );
    }

    #[test]
    fn malformed_secret_references_are_refused_on_load() {
        let cases = [
            ("{name: a, url: 'https://y', headers: {Authorization: 'Bearer ${secret:x'}}", "MCP server \"a\" header Authorization: a ${secret: reference is not closed with }"),
            ("{name: a, command: x, env: {T: '${secret:a b}'}}", "MCP server \"a\" T: in a ${secret:...} reference, secret name \"a b\" must be 1 to 64 letters, digits, - and _"),
        ];
        for (server, message) in cases {
            match load_str(&format!("mcp_servers:\n  - {server}\n{BASE}")) {
                Err(ConfigError::Invalid(got)) => assert_eq!(got, message, "{server}"),
                other => panic!("{server}: {other:?}"),
            }
        }
    }

    #[test]
    fn own_secrets_resolve_from_a_reference_or_stay_inline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        let mut secrets = Secrets::for_config(&path).unwrap();
        secrets
            .set(secrets::MCP_TOKEN, "yb_FROMFILE", chrono::Utc::now())
            .unwrap();
        let mut cfg = load_str(BASE).unwrap();
        assert_eq!(cfg.mcp_token(&secrets), Ok(None));
        cfg.mcp_token = Some("yb_inline".into());
        assert_eq!(cfg.mcp_token(&secrets), Ok(Some("yb_inline".into())));
        cfg.mcp_token = Some(secrets::reference(secrets::MCP_TOKEN));
        assert_eq!(cfg.mcp_token(&secrets), Ok(Some("yb_FROMFILE".into())));
        cfg.cookie_key = Some(secrets::reference(secrets::COOKIE_KEY));
        let err = cfg.cookie_key(&secrets).unwrap_err();
        assert!(
            err.contains("the secret yardbell-cookie-key is not set"),
            "{err}"
        );
    }

    #[test]
    fn dispatch_settings_are_validated() {
        let ok = load_str(&format!(
            "dispatch:\n  instructions: Frontend work goes to codex.\n  agent: codex\n  model: haiku\n{BASE}"
        ))
        .unwrap();
        assert_eq!(ok.dispatch.agent, "codex");
        assert_eq!(
            ok.dispatch.approval,
            Approval::Prompt,
            "asking is the default"
        );
        assert_eq!(
            load_str(BASE).unwrap().dispatch,
            DispatchSettings::default()
        );
        for (value, approval) in [
            ("ask", Approval::Prompt),
            ("auto", Approval::Allow),
            ("prompt", Approval::Prompt),
            ("allow", Approval::Allow),
            ("deny", Approval::Deny),
        ] {
            let cfg = load_str(&format!("dispatch:\n  approval: {value}\n{BASE}")).unwrap();
            assert_eq!(cfg.dispatch.approval, approval, "{value}");
            assert!(cfg.dispatch.rules.is_empty());
        }
        assert!(load_str(&format!("dispatch:\n  approval: maybe\n{BASE}")).is_err());
        let cases = [
            ("agent: nope", "dispatch.agent \"nope\" is not a built-in agent or one listed under agents"),
            ("model: gpt-9", "dispatch.model must be one of sonnet, opus, haiku, or empty for Claude Code's default"),
            ("codex_model: 'gpt 6; rm -rf'", "dispatch.codex_model \"gpt 6; rm -rf\" is not a Codex model name like gpt-6.1-sol: up to 64 letters, digits, dots, dashes and underscores, or empty for Codex's default"),
            ("codex_model: -m", "dispatch.codex_model \"-m\" is not a Codex model name like gpt-6.1-sol: up to 64 letters, digits, dots, dashes and underscores, or empty for Codex's default"),
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
    fn dispatch_can_run_on_codex_with_its_own_model() {
        let cfg = load_str(&format!(
            "dispatch:\n  runs_on: codex\n  model: haiku\n  codex_model: gpt-6.1-sol\n{BASE}"
        ))
        .unwrap();
        assert_eq!(cfg.dispatch.runs_on, RunsOn::Codex);
        assert_eq!(cfg.dispatch.model, "haiku", "the Claude model is kept");
        assert_eq!(cfg.dispatch.codex_model, "gpt-6.1-sol");
        assert_eq!(load_str(BASE).unwrap().dispatch.runs_on, RunsOn::Claude);
        match load_str(&format!("dispatch:\n  runs_on: gemini\n{BASE}")) {
            Err(ConfigError::Parse { source, .. }) => {
                let text = source.to_string();
                assert!(
                    text.contains(
                        "dispatch.runs_on: unknown variant `gemini`, expected `claude` or `codex`"
                    ),
                    "{text}"
                );
            }
            other => panic!("{other:?}"),
        }

        let defaults = serde_yaml::to_string(&DispatchSettings {
            runs_on: RunsOn::Claude,
            instructions: "x".into(),
            ..DispatchSettings::default()
        })
        .unwrap();
        assert_eq!(
            defaults, "instructions: x\n",
            "the defaults are not written, so 0.7.5 reads the file"
        );
        let codex = serde_yaml::to_string(&cfg.dispatch).unwrap();
        assert_eq!(
            codex,
            "runs_on: codex\nmodel: haiku\ncodex_model: gpt-6.1-sol\n"
        );
    }

    #[test]
    fn a_config_without_rules_saves_as_0_7_0_wrote_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        for (approval, written) in [
            (Approval::Prompt, None),
            (Approval::Allow, Some("auto")),
            (Approval::Deny, Some("deny")),
        ] {
            let mut cfg = fixture();
            cfg.dispatch.model = "haiku".into();
            cfg.dispatch.approval = approval;
            cfg.save(&path).unwrap();
            let text = std::fs::read_to_string(&path).unwrap();
            let expected = match written {
                Some(name) => format!("dispatch:\n  model: haiku\n  approval: {name}\n"),
                None => "dispatch:\n  model: haiku\n".to_string(),
            };
            assert!(text.contains(&expected), "{approval:?}: {text}");
            assert!(!text.contains("rules"), "{text}");
            assert_eq!(Config::load(&path).unwrap().dispatch.approval, approval);
        }
        let ask = serde_yaml::to_string(&DispatchSettings {
            approval: Approval::Prompt,
            instructions: "x".into(),
            ..DispatchSettings::default()
        })
        .unwrap();
        assert_eq!(
            ask, "instructions: x\n",
            "asking is the default and not written"
        );
    }

    #[test]
    fn dispatch_rules_load_save_and_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        let yaml = format!(
            "dispatch:\n  approval: auto\n  rules:\n    - {{action: stop_session, approval: deny}}\n    - {{action: start_session, machine: mini, folder: 'acme/*', approval: ask}}\n{BASE}"
        );
        std::fs::write(&path, yaml).unwrap();
        let cfg = Config::load(&path).unwrap();
        let rules = &cfg.dispatch.rules;
        assert_eq!(cfg.dispatch.approval, Approval::Allow);
        assert_eq!(
            (rules[0].action.as_str(), rules[0].machine.as_str()),
            ("stop_session", "any")
        );
        assert_eq!(
            (rules[1].folder.as_str(), rules[1].approval),
            ("acme/*", Approval::Prompt)
        );
        cfg.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("  approval: auto\n") && text.contains("    approval: prompt\n"),
            "{text}"
        );
        assert_eq!(Config::load(&path).unwrap().dispatch, cfg.dispatch);

        let cases = [
            (
                "{action: start_session, machine: hp, approval: deny}",
                "dispatch rule 1: machine \"hp\" is not in Yardbell",
            ),
            (
                "{approval: deny}",
                "dispatch rule 1 matches every step, set dispatch.approval to deny instead",
            ),
        ];
        for (rule, message) in cases {
            match load_str(&format!("dispatch:\n  rules:\n    - {rule}\n{BASE}")) {
                Err(ConfigError::Invalid(got)) => assert_eq!(got, message, "{rule}"),
                other => panic!("{rule}: {other:?}"),
            }
        }
        for rule in [
            "{action: stop_session}",
            "{action: stop_session, approval: never}",
            "{action: stop_session, machines: [mini], approval: deny}",
        ] {
            let yaml = format!("dispatch:\n  rules:\n    - {rule}\n{BASE}");
            assert!(
                matches!(load_str(&yaml), Err(ConfigError::Parse { .. })),
                "accepted: {rule}"
            );
        }
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

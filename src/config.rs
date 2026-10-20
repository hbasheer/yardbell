use crate::agents::{self, Agent};
use rand::Rng;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

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
    pub server: String,
    pub topic: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub token: String,
    pub wait_minutes: u64,
    pub agent_waiting: bool,
    pub session_ended: bool,
    pub machines: bool,
    pub memory: bool,
}

impl Default for PhoneNotifications {
    fn default() -> Self {
        PhoneNotifications {
            server: "https://ntfy.sh".into(),
            topic: String::new(),
            token: String::new(),
            wait_minutes: 2,
            agent_waiting: true,
            session_ended: true,
            machines: true,
            memory: true,
        }
    }
}

impl PhoneNotifications {
    pub fn on(&self) -> bool {
        !self.topic.is_empty()
    }

    pub fn is_default(&self) -> bool {
        *self == PhoneNotifications::default()
    }
}

pub fn new_topic() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    format!("yardbell-{suffix}")
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
    pub machines: Vec<Machine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passcode_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie_key: Option<String>,
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
        let write = || -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&tmp, text)?;
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
        let phone = &self.phone_notifications;
        let server_re =
            Regex::new(r"^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/\S*)?$").expect("static regex");
        if !server_re.is_match(&phone.server) {
            return invalid(
                "phone_notifications.server must be an http:// or https:// address".into(),
            );
        }
        let topic_re = Regex::new("^[-_A-Za-z0-9]{1,64}$").expect("static regex");
        if !phone.topic.is_empty() && !topic_re.is_match(&phone.topic) {
            return invalid(
                "phone_notifications.topic may only use letters, digits, - and _ (at most 64)"
                    .into(),
            );
        }
        if phone.wait_minutes > 60 {
            return invalid("phone_notifications.wait_minutes must be from 0 to 60".into());
        }
        if phone.token.len() > 200 || !phone.token.chars().all(|c| c.is_ascii_graphic()) {
            return invalid(
                "phone_notifications.token must be at most 200 characters without spaces".into(),
            );
        }
        Ok(())
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
        assert_eq!(
            (p.server.as_str(), p.wait_minutes, p.on()),
            ("https://ntfy.sh", 2, false)
        );
        assert!(p.agent_waiting && p.session_ended && p.machines && p.memory && p.token.is_empty());
    }

    #[test]
    fn phone_notifications_partial_block_fills_in_defaults() {
        let cfg = load_str(&format!("{BASE}phone_notifications:\n  topic: abc\n")).unwrap();
        let p = cfg.phone_notifications;
        assert_eq!(
            (p.topic.as_str(), p.server.as_str(), p.wait_minutes),
            ("abc", "https://ntfy.sh", 2)
        );
        assert!(p.agent_waiting && p.session_ended && p.machines && p.memory && p.on());
    }

    #[test]
    fn phone_notifications_round_trip_and_default_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yardbell.yml");
        let mut cfg = fixture();
        cfg.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("phone_notifications"), "{text}");

        cfg.phone_notifications.topic = "abc".into();
        cfg.phone_notifications.token = "tk_1".into();
        cfg.save(&path).unwrap();
        assert_eq!(
            Config::load(&path).unwrap().phone_notifications,
            cfg.phone_notifications
        );

        cfg.phone_notifications.token.clear();
        cfg.save(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("topic: abc"), "{text}");
        assert!(!text.contains("token:"), "{text}");
    }

    #[test]
    fn phone_notifications_validation() {
        let long_topic = format!("topic: {}", "a".repeat(65));
        let cases = [
            (
                "server: ftp://x",
                "phone_notifications.server must be an http:// or https:// address",
            ),
            (
                "server: https://",
                "phone_notifications.server must be an http:// or https:// address",
            ),
            (
                "topic: a b",
                "phone_notifications.topic may only use letters, digits, - and _ (at most 64)",
            ),
            (
                long_topic.as_str(),
                "phone_notifications.topic may only use letters, digits, - and _ (at most 64)",
            ),
            (
                "wait_minutes: 61",
                "phone_notifications.wait_minutes must be from 0 to 60",
            ),
            (
                "token: a b",
                "phone_notifications.token must be at most 200 characters without spaces",
            ),
        ];
        for (setting, message) in cases {
            let yaml = format!("{BASE}phone_notifications:\n  {setting}\n");
            match load_str(&yaml) {
                Err(ConfigError::Invalid(got)) => assert_eq!(got, message, "{setting}"),
                other => panic!("{setting} was not refused: {other:?}"),
            }
        }
    }

    #[test]
    fn phone_notifications_accepts_valid_values() {
        let accepted = [
            "server: http://100.64.0.5:8080".to_string(),
            "server: https://ntfy.example.com/alerts".to_string(),
            "topic: ''".to_string(),
            format!("topic: {}", "a".repeat(64)),
            "wait_minutes: 0".to_string(),
            "wait_minutes: 60".to_string(),
            format!("token: {}", "t".repeat(200)),
        ];
        for setting in accepted {
            let yaml = format!("{BASE}phone_notifications:\n  {setting}\n");
            assert!(load_str(&yaml).is_ok(), "refused: {setting}");
        }
    }

    #[test]
    fn phone_notifications_refuses_a_long_token() {
        let yaml = format!("{BASE}phone_notifications:\n  token: {}\n", "t".repeat(201));
        let err = load_str(&yaml).unwrap_err().to_string();
        assert!(
            err.contains("phone_notifications.token must be at most 200 characters without spaces"),
            "{err}"
        );
    }

    #[test]
    fn new_topic_is_valid_and_random() {
        let re = Regex::new("^yardbell-[A-Za-z0-9]{24}$").unwrap();
        let (a, b) = (new_topic(), new_topic());
        assert!(re.is_match(&a) && re.is_match(&b) && a != b);
        let mut cfg = fixture();
        cfg.phone_notifications.topic = a;
        assert!(cfg.validate().is_ok());
    }
}

use crate::agents::Agent;
use crate::config::{Config, Inline, InlineKind, MeshProvider};
use crate::onboarding::peers::Peer;
use crate::onboarding::valid_host;
use crate::secrets::{self, Secrets};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use base64::Engine;
use chrono::{DateTime, Local, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub type Clock = Arc<dyn Fn() -> DateTime<Local> + Send + Sync>;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Proposal {
    pub machine: String,
    pub old_ip: Option<String>,
    pub new_ip: Option<String>,
    pub peer: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MachineEdit {
    pub ssh: Option<String>,
    pub mesh_ip: Option<String>,
    pub port_prefix: Option<u8>,
    pub root: String,
    pub mesh: Option<MeshProvider>,
}

// What Settings checks when a machine is edited, shared with changes made through tools.
pub fn edit_machine(cfg: &mut Config, name: &str, edit: &MachineEdit) -> Result<(), String> {
    for host in [edit.ssh.as_deref(), edit.mesh_ip.as_deref()]
        .into_iter()
        .flatten()
    {
        if !valid_host(host) {
            return Err(format!("{host:?} is not a valid host or address"));
        }
    }
    if edit.root.trim().is_empty() || edit.root.contains('\n') {
        return Err("enter the project folder on that machine".into());
    }
    let m = cfg
        .machines
        .iter_mut()
        .find(|m| m.name == name)
        .ok_or_else(|| format!("no machine named {name}"))?;
    m.ssh = edit.ssh.clone().filter(|s| !s.is_empty());
    m.mesh_ip = edit.mesh_ip.clone().filter(|s| !s.is_empty());
    if !m.local {
        m.port_prefix = edit.port_prefix;
    }
    m.root = edit.root.trim().to_string();
    m.mesh = edit.mesh;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct AgentEdit {
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub resume: String,
}

fn agent_slug(label: &str) -> String {
    let slug: String = label
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    slug.split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[derive(Debug, Deserialize)]
pub struct PhoneEdit {
    pub wait_minutes: u64,
    pub agent_waiting: bool,
    pub session_ended: bool,
    pub machines: bool,
    pub memory: bool,
    #[serde(default = "on")]
    pub pipeline_waiting: bool,
    #[serde(default = "on")]
    pub pipeline_finished: bool,
    #[serde(default = "on")]
    pub proposals: bool,
}

fn on() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct MeshApply {
    pub restart_needed: bool,
    pub ssh_updated: Vec<String>,
}

struct Undo {
    config: PathBuf,
    ssh: Option<PathBuf>,
    // Who made the change, when it was not the person on the Settings page.
    note: Option<String>,
}

fn stamp(clock: &Clock) -> String {
    clock().format("%Y%m%d%H%M%S").to_string()
}

fn norm(s: &str) -> String {
    s.split('.').next().unwrap_or(s).to_lowercase()
}

pub fn propose(cfg: &Config, peers: &[Peer]) -> Vec<Proposal> {
    cfg.machines
        .iter()
        .map(|m| {
            let wanted = [norm(&m.name), norm(m.ssh_host())];
            let hit = peers.iter().find(|p| {
                let names = [
                    Some(norm(&p.hostname)),
                    p.nickname.as_deref().map(norm),
                    Some(p.suggested_name()),
                ];
                names.iter().flatten().any(|n| wanted.contains(n))
            });
            Proposal {
                machine: m.name.clone(),
                old_ip: m.mesh_ip.clone(),
                new_ip: hit.map(|p| p.ip.clone()),
                peer: hit.map(|p| p.nickname.clone().unwrap_or_else(|| p.hostname.clone())),
            }
        })
        .collect()
}

pub fn set_ssh_hostnames(
    path: &Path,
    changes: &[(String, String)],
    clock: &Clock,
) -> std::io::Result<Option<PathBuf>> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(None);
    };
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut changed = false;
    for (host, ip) in changes {
        let is_block_start = |l: &str| {
            let mut w = l.split_whitespace();
            matches!(w.next(), Some(k) if k.eq_ignore_ascii_case("host") || k.eq_ignore_ascii_case("match"))
        };
        let Some(start) = lines.iter().position(|l| {
            let mut w = l.split_whitespace();
            w.next().is_some_and(|k| k.eq_ignore_ascii_case("host"))
                && w.any(|n| n.eq_ignore_ascii_case(host))
        }) else {
            continue;
        };
        let end = lines[start + 1..]
            .iter()
            .position(|l| is_block_start(l))
            .map(|i| start + 1 + i)
            .unwrap_or(lines.len());
        let existing = (start + 1..end).find(|&i| {
            lines[i]
                .split_whitespace()
                .next()
                .is_some_and(|k| k.eq_ignore_ascii_case("hostname"))
        });
        match existing {
            Some(i) => {
                let indent: String = lines[i].chars().take_while(|c| c.is_whitespace()).collect();
                lines[i] = format!("{indent}HostName {ip}");
            }
            None => lines.insert(start + 1, format!("  HostName {ip}")),
        }
        changed = true;
    }
    if !changed {
        return Ok(None);
    }
    let backup = PathBuf::from(format!("{}.yardbell-{}", path.display(), stamp(clock)));
    std::fs::copy(path, &backup)?;
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(Some(backup))
}

pub fn set_ssh_hostname(
    path: &Path,
    host: &str,
    ip: &str,
    clock: &Clock,
) -> std::io::Result<Option<PathBuf>> {
    set_ssh_hostnames(path, &[(host.to_string(), ip.to_string())], clock)
}

pub struct Settings {
    cfg_path: PathBuf,
    ssh_path: PathBuf,
    clock: Clock,
    last: Mutex<Option<Undo>>,
    secrets: Mutex<()>,
}

// An Authorization header keeps its scheme in yardbell.yml, so it reads Bearer ${secret:linear}.
fn split_scheme<'a>(item: &Inline, value: &'a str) -> (&'a str, &'a str) {
    let auth = item.kind == InlineKind::Header
        && ["authorization", "proxy-authorization"].contains(&item.key.to_lowercase().as_str());
    if auth {
        if let Some((scheme, token)) = value.split_once(' ') {
            let token = token.trim_start();
            if !token.is_empty() && scheme.chars().all(|c| c.is_ascii_alphabetic()) {
                return (&value[..scheme.len() + 1], token);
            }
        }
    }
    ("", value)
}

// A name already holding the same value is shared rather than copied.
fn free_name(secrets: &Secrets, base: &str, value: &str) -> String {
    let base: String = base.chars().take(56).collect();
    let fits =
        |name: &str| !secrets::is_own(name) && secrets.get(name).is_none_or(|held| held == value);
    if fits(&base) {
        return base;
    }
    (2..)
        .map(|i| format!("{base}-{i}"))
        .find(|name| fits(name))
        .expect("an unused name")
}

impl Settings {
    pub fn new(cfg_path: PathBuf, ssh_path: PathBuf, clock: Clock) -> Settings {
        Settings {
            cfg_path,
            ssh_path,
            clock,
            last: Mutex::new(None),
            secrets: Mutex::new(()),
        }
    }

    pub fn secrets_path(&self) -> PathBuf {
        secrets::path_for(&self.cfg_path)
    }

    pub fn secrets(&self) -> Result<Secrets, String> {
        Secrets::for_config(&self.cfg_path).map_err(|e| e.to_string())
    }

    fn now_utc(&self) -> DateTime<Utc> {
        (self.clock)().with_timezone(&Utc)
    }

    pub fn set_secret(&self, name: &str, value: &str) -> Result<(), String> {
        if secrets::is_own(name) {
            return Err(format!("{name} is Yardbell's own, pick another name"));
        }
        let _lock = self.secrets.lock().expect("secrets lock");
        let mut store = self.secrets()?;
        store.set(name, value, self.now_utc())?;
        store.save().map_err(|e| e.to_string())
    }

    pub fn delete_secret(&self, name: &str) -> Result<(), String> {
        if secrets::is_own(name) {
            return Err(format!(
                "{name} is Yardbell's own and cannot be deleted here"
            ));
        }
        let _lock = self.secrets.lock().expect("secrets lock");
        let mut store = self.secrets()?;
        if !store.remove(name) {
            return Err(format!("there is no secret called {name}"));
        }
        store.save().map_err(|e| e.to_string())
    }

    // The secrets are written and read back before yardbell.yml changes, so a failure at any
    // step leaves every value in one file or the other. No backup is kept for undo, because it
    // would be a copy of the values this moves out.
    pub fn move_to_secrets(&self, picked: &[Inline]) -> Result<Vec<String>, String> {
        let _lock = self.secrets.lock().expect("secrets lock");
        let mut cfg = self.load()?;
        let mut store = self.secrets()?;
        let now = self.now_utc();
        let available = cfg.inline_values();
        let mut items: Vec<&Inline> = Vec::new();
        for item in picked {
            if available.contains(item) && !items.contains(&item) {
                items.push(item);
            }
        }
        if items.is_empty() {
            return Err("nothing to move, those values are already secrets".into());
        }
        let mut moved: Vec<(String, String)> = Vec::new();
        for item in &items {
            let failed = |e: String| format!("{}: {e}", item.label());
            let name = match item.kind {
                InlineKind::Header | InlineKind::Env => {
                    let several = items.iter().filter(|i| i.server == item.server).count() > 1;
                    let server = cfg
                        .mcp_servers
                        .iter_mut()
                        .find(|s| s.name == item.server)
                        .ok_or_else(|| format!("no MCP server called {}", item.server))?;
                    let base = if several {
                        format!("{}-{}", server.name, agent_slug(&item.key))
                    } else {
                        server.name.clone()
                    };
                    let pairs = if item.kind == InlineKind::Header {
                        &mut server.headers
                    } else {
                        &mut server.env
                    };
                    let value = pairs.get(&item.key).cloned().unwrap_or_default();
                    let (prefix, secret) = split_scheme(item, &value);
                    let name = free_name(&store, &base, secret);
                    store.set(&name, secret, now).map_err(failed)?;
                    moved.push((name.clone(), secret.to_string()));
                    pairs.insert(
                        item.key.clone(),
                        format!("{prefix}{}", secrets::reference(&name)),
                    );
                    name
                }
                InlineKind::McpToken | InlineKind::CookieKey => {
                    let (field, name) = if item.kind == InlineKind::McpToken {
                        (&mut cfg.mcp_token, secrets::MCP_TOKEN)
                    } else {
                        (&mut cfg.cookie_key, secrets::COOKIE_KEY)
                    };
                    let value = field.take().unwrap_or_default();
                    store.set(name, &value, now).map_err(failed)?;
                    moved.push((name.to_string(), value));
                    *field = Some(secrets::reference(name));
                    name.to_string()
                }
            };
            tracing::info!(secret = %name, "moved a value from yardbell.yml into secrets");
        }
        cfg.validate().map_err(|e| e.to_string())?;
        store.save().map_err(|e| e.to_string())?;
        let back = Secrets::load(store.path()).map_err(|e| e.to_string())?;
        if moved
            .iter()
            .any(|(name, value)| back.get(name) != Some(value.as_str()))
        {
            return Err(format!(
                "{} did not read back as written, so yardbell.yml was left unchanged",
                store.path().display()
            ));
        }
        cfg.save(&self.cfg_path).map_err(|e| e.to_string())?;
        *self.last.lock().expect("settings lock") = None;
        Ok(items.iter().map(|i| i.label()).collect())
    }

    fn store_own(&self, cfg: &mut Config, name: &str, value: Option<&str>) -> Result<(), String> {
        let _lock = self.secrets.lock().expect("secrets lock");
        let mut store = self.secrets()?;
        let field = if name == secrets::MCP_TOKEN {
            &mut cfg.mcp_token
        } else {
            &mut cfg.cookie_key
        };
        match value {
            Some(value) => {
                store.set(name, value, self.now_utc())?;
                store.save().map_err(|e| e.to_string())?;
                *field = Some(secrets::reference(name));
                cfg.save(&self.cfg_path).map_err(|e| e.to_string())
            }
            None => {
                *field = None;
                cfg.save(&self.cfg_path).map_err(|e| e.to_string())?;
                if store.remove(name) {
                    store.save().map_err(|e| e.to_string())?;
                }
                Ok(())
            }
        }
    }

    pub fn note_last(&self, note: &str) {
        if let Some(undo) = self.last.lock().expect("settings lock").as_mut() {
            undo.note = Some(note.to_string());
        }
    }

    pub fn undo_note(&self) -> Option<String> {
        self.last
            .lock()
            .expect("settings lock")
            .as_ref()
            .and_then(|u| u.note.clone())
    }

    pub fn can_undo(&self) -> bool {
        self.last.lock().expect("settings lock").is_some()
    }

    fn load(&self) -> Result<Config, String> {
        Config::load(&self.cfg_path).map_err(|e| e.to_string())
    }

    fn backup_config(&self) -> Result<PathBuf, String> {
        let backup = PathBuf::from(format!(
            "{}.bak-{}",
            self.cfg_path.display(),
            stamp(&self.clock)
        ));
        std::fs::copy(&self.cfg_path, &backup)
            .and_then(|_| {
                std::fs::set_permissions(
                    &backup,
                    std::os::unix::fs::PermissionsExt::from_mode(crate::config::PRIVATE_FILE),
                )
            })
            .map_err(|e| format!("cannot back up yardbell.yml: {e}"))?;
        Ok(backup)
    }

    fn save(&self, cfg: &Config, backup: PathBuf, ssh: Option<PathBuf>) -> Result<(), String> {
        cfg.save(&self.cfg_path).map_err(|e| e.to_string())?;
        *self.last.lock().expect("settings lock") = Some(Undo {
            config: backup,
            ssh,
            note: None,
        });
        Ok(())
    }

    pub fn apply_mesh(
        &self,
        provider: MeshProvider,
        addrs: &BTreeMap<String, String>,
    ) -> Result<MeshApply, String> {
        let mut cfg = self.load()?;
        for (name, ip) in addrs {
            if cfg.machine(name).is_none() {
                return Err(format!("no machine named {name}"));
            }
            if !valid_host(ip) {
                return Err(format!("{ip:?} is not a valid address for {name}"));
            }
        }
        let old_bind = cfg.bind_addresses();
        let backup = self.backup_config()?;
        cfg.mesh = provider;
        let mut ssh_changes = Vec::new();
        for m in cfg.machines.iter_mut() {
            let Some(ip) = addrs.get(&m.name) else {
                continue;
            };
            m.mesh_ip = Some(ip.clone());
            if !m.local {
                ssh_changes.push((m.ssh_host().to_string(), ip.clone()));
            }
        }
        cfg.validate().map_err(|e| e.to_string())?;
        let ssh_backup = set_ssh_hostnames(&self.ssh_path, &ssh_changes, &self.clock)
            .map_err(|e| format!("cannot update ~/.ssh/config: {e}"))?;
        let ssh_updated = if ssh_backup.is_some() {
            ssh_changes.into_iter().map(|(h, _)| h).collect()
        } else {
            Vec::new()
        };
        let restart_needed = cfg.bind_addresses() != old_bind;
        self.save(&cfg, backup, ssh_backup)?;
        Ok(MeshApply {
            restart_needed,
            ssh_updated,
        })
    }

    pub fn update_machine(&self, name: &str, edit: &MachineEdit) -> Result<(), String> {
        self.change(|cfg| edit_machine(cfg, name, edit))
    }

    // One change to the config: checked as a whole, saved once, so Undo reverses all of it.
    pub fn change(
        &self,
        edit: impl FnOnce(&mut Config) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut cfg = self.load()?;
        edit(&mut cfg)?;
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn set_agents(&self, default: Option<String>, agents: Vec<Agent>) -> Result<(), String> {
        self.change(|cfg| {
            cfg.default_agent = default;
            cfg.agents = agents;
            Ok(())
        })
    }

    pub fn set_pull_requests(
        &self,
        pull_requests: crate::config::PullRequests,
    ) -> Result<(), String> {
        self.change(|cfg| {
            cfg.pull_requests = pull_requests;
            Ok(())
        })
    }

    pub fn add_agent(&self, edit: &AgentEdit) -> Result<Agent, String> {
        let label = edit.label.trim();
        let command = edit.command.trim();
        if label.is_empty() || command.is_empty() {
            return Err("enter a name and the command that starts the agent".into());
        }
        let name = agent_slug(label);
        if name.is_empty() {
            return Err("use letters or digits in the name".into());
        }
        let mut cfg = self.load()?;
        if cfg.agents().iter().any(|a| a.name == name) {
            return Err(format!("there is already an agent called {name}"));
        }
        let resume = edit.resume.trim();
        let agent = Agent {
            name,
            label: Some(label.to_string()),
            command: command.to_string(),
            resume: if resume.is_empty() { command } else { resume }.to_string(),
            process: None,
            prompt_arg: None,
        };
        cfg.agents.push(agent.clone());
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)?;
        Ok(agent)
    }

    pub fn update_phone(&self, edit: &PhoneEdit) -> Result<(), String> {
        let mut cfg = self.load()?;
        let phone = &mut cfg.phone_notifications;
        phone.wait_minutes = edit.wait_minutes;
        phone.agent_waiting = edit.agent_waiting;
        phone.session_ended = edit.session_ended;
        phone.machines = edit.machines;
        phone.memory = edit.memory;
        phone.pipeline_waiting = edit.pipeline_waiting;
        phone.pipeline_finished = edit.pipeline_finished;
        phone.proposals = edit.proposals;
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn change_passcode(&self, current: &str, new: &str) -> Result<String, String> {
        let mut cfg = self.load()?;
        let stored = cfg.passcode_hash.clone().unwrap_or_default();
        let ok = PasswordHash::new(&stored)
            .map(|h| {
                Argon2::default()
                    .verify_password(current.as_bytes(), &h)
                    .is_ok()
            })
            .unwrap_or(false);
        if !ok {
            return Err("current passcode is wrong".into());
        }
        if new.chars().count() < 6 {
            return Err("use at least 6 characters".into());
        }
        let hash = crate::auth::hash(new);
        cfg.passcode_hash = Some(hash.clone());
        cfg.save(&self.cfg_path).map_err(|e| e.to_string())?;
        Ok(hash)
    }

    pub fn rotate_cookie_key(&self) -> Result<String, String> {
        let mut cfg = self.load()?;
        let mut key = [0u8; 64];
        rand::thread_rng().fill_bytes(&mut key);
        let encoded = base64::engine::general_purpose::STANDARD.encode(key);
        self.store_own(&mut cfg, secrets::COOKIE_KEY, Some(&encoded))?;
        Ok(encoded)
    }

    pub fn set_dispatch(&self, dispatch: crate::config::DispatchSettings) -> Result<(), String> {
        let mut cfg = self.load()?;
        cfg.dispatch = dispatch;
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn set_mcp_servers(&self, servers: Vec<crate::config::McpServer>) -> Result<(), String> {
        let mut cfg = self.load()?;
        cfg.mcp_servers = servers;
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn set_worktree_setup(
        &self,
        setups: Vec<crate::worktrees::setup::WorktreeSetup>,
    ) -> Result<(), String> {
        let mut cfg = self.load()?;
        cfg.worktree_setup = setups;
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn set_triggers(&self, triggers: Vec<crate::triggers::Trigger>) -> Result<(), String> {
        let mut cfg = self.load()?;
        cfg.triggers = triggers;
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn set_connectors(
        &self,
        connectors: Vec<crate::connectors::Connector>,
    ) -> Result<(), String> {
        let mut cfg = self.load()?;
        cfg.connectors = connectors;
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn set_pipelines(&self, pipelines: crate::config::Pipelines) -> Result<(), String> {
        let mut cfg = self.load()?;
        cfg.pipelines = pipelines;
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn set_trigger_enabled(&self, name: &str, enabled: bool) -> Result<(), String> {
        let mut cfg = self.load()?;
        let t = cfg
            .triggers
            .iter_mut()
            .find(|t| t.name == name)
            .ok_or("no such trigger")?;
        t.enabled = enabled;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn set_mcp_token(&self, token: Option<String>) -> Result<(), String> {
        let mut cfg = self.load()?;
        self.store_own(&mut cfg, secrets::MCP_TOKEN, token.as_deref())
    }

    pub fn undo(&self) -> Result<(), String> {
        let undo = self
            .last
            .lock()
            .expect("settings lock")
            .take()
            .ok_or("nothing to undo")?;
        std::fs::copy(&undo.config, &self.cfg_path)
            .map_err(|e| format!("cannot restore yardbell.yml: {e}"))?;
        if let Some(ssh) = undo.ssh {
            std::fs::copy(&ssh, &self.ssh_path)
                .map_err(|e| format!("cannot restore ~/.ssh/config: {e}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_names_come_from_the_label() {
        assert_eq!(agent_slug("Amp"), "amp");
        assert_eq!(agent_slug("  My Agent 2! "), "my-agent-2");
        assert_eq!(agent_slug("!!"), "");
    }
    use crate::onboarding::peers::Peer;
    use chrono::TimeZone;
    use std::path::Path;

    fn clock() -> Clock {
        Arc::new(|| {
            chrono::Local
                .with_ymd_and_hms(2026, 10, 19, 9, 30, 0)
                .unwrap()
        })
    }

    fn cfg() -> Config {
        Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap()
    }

    fn peer(hostname: &str, nickname: Option<&str>, ip: &str) -> Peer {
        Peer {
            hostname: hostname.into(),
            nickname: nickname.map(Into::into),
            ip: ip.into(),
            online: true,
            os: String::new(),
        }
    }

    #[test]
    fn set_hostname_edits_only_that_block_with_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        let before = "Host *\n  ServerAliveInterval 30\n\nHost hp hp-alt\n  HostName 100.64.0.11\n  User u\n\nHost pro\n  HostName 100.64.0.12\n";
        std::fs::write(&path, before).unwrap();
        let backup = set_ssh_hostname(&path, "hp", "100.101.1.2", &clock())
            .unwrap()
            .unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            after,
            before.replace("HostName 100.64.0.11", "HostName 100.101.1.2")
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), before);
        assert!(backup
            .to_string_lossy()
            .ends_with("config.yardbell-20261019093000"));
    }

    #[test]
    fn set_hostname_adds_missing_line_and_ignores_unknown_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, "Host mini\n  User u\n").unwrap();
        set_ssh_hostname(&path, "mini", "100.1.1.1", &clock()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "Host mini\n  HostName 100.1.1.1\n  User u\n"
        );
        assert!(set_ssh_hostname(&path, "nope", "1.1.1.1", &clock())
            .unwrap()
            .is_none());
        assert!(
            set_ssh_hostname(&dir.path().join("missing"), "mini", "1.1.1.1", &clock())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn proposals_match_peers_by_name() {
        let peers = vec![
            peer("hp", None, "100.101.0.2"),
            peer("user-andes.nord", Some("pro"), "100.101.0.3"),
            peer("stranger", None, "100.101.0.9"),
        ];
        let props = propose(&cfg(), &peers);
        let get = |n: &str| props.iter().find(|p| p.machine == n).unwrap().clone();
        assert_eq!(get("hp").new_ip.as_deref(), Some("100.101.0.2"));
        assert_eq!(get("pro").new_ip.as_deref(), Some("100.101.0.3"));
        assert_eq!(get("pro").old_ip.as_deref(), Some("100.64.0.12"));
        assert!(get("mini").new_ip.is_none());
    }

    #[test]
    fn apply_mesh_change_updates_config_and_ssh_and_can_undo() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("yardbell.yml");
        cfg().save(&cfg_path).unwrap();
        let ssh = dir.path().join("ssh_config");
        std::fs::write(&ssh, "Host hp\n  HostName 100.64.0.11\n").unwrap();
        let s = Settings::new(cfg_path.clone(), ssh.clone(), clock());
        let mut addrs = std::collections::BTreeMap::new();
        addrs.insert("hp".to_string(), "100.101.0.2".to_string());
        addrs.insert("mini".to_string(), "100.101.0.1".to_string());
        let out = s
            .apply_mesh(crate::config::MeshProvider::Tailscale, &addrs)
            .unwrap();
        assert!(out.restart_needed, "host mesh_ip changed");
        let saved = Config::load(&cfg_path).unwrap();
        assert_eq!(saved.mesh, crate::config::MeshProvider::Tailscale);
        assert_eq!(
            saved.machine("hp").unwrap().mesh_ip.as_deref(),
            Some("100.101.0.2")
        );
        assert_eq!(
            std::fs::read_to_string(&ssh).unwrap(),
            "Host hp\n  HostName 100.101.0.2\n"
        );
        s.undo().unwrap();
        assert_eq!(
            Config::load(&cfg_path).unwrap().mesh,
            crate::config::MeshProvider::None
        );
        assert_eq!(
            std::fs::read_to_string(&ssh).unwrap(),
            "Host hp\n  HostName 100.64.0.11\n"
        );
        assert!(s.undo().is_err(), "nothing left to undo");
    }

    #[test]
    fn a_readable_config_and_its_backup_become_private_on_save() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("yardbell.yml");
        cfg().save(&cfg_path).unwrap();
        std::fs::set_permissions(&cfg_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let s = Settings::new(cfg_path.clone(), dir.path().join("ssh"), clock());
        s.set_mcp_servers(vec![crate::config::McpServer {
            name: "linear".into(),
            command: String::new(),
            url: "https://mcp.linear.app/mcp".into(),
            env: BTreeMap::new(),
            headers: BTreeMap::from([("Authorization".into(), "Bearer lin_api_x".into())]),
            machines: Vec::new(),
        }])
        .unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&cfg_path), 0o600);
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().contains(".bak-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(mode(&backups[0]), 0o600);
    }

    #[test]
    fn apply_rejects_bad_address() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("yardbell.yml");
        cfg().save(&cfg_path).unwrap();
        let s = Settings::new(cfg_path, dir.path().join("ssh"), clock());
        let mut addrs = std::collections::BTreeMap::new();
        addrs.insert("hp".to_string(), "100.1.1.1\nProxyCommand x".to_string());
        assert!(s
            .apply_mesh(crate::config::MeshProvider::Tailscale, &addrs)
            .is_err());
    }

    #[test]
    fn update_machine_validates_and_saves() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("yardbell.yml");
        cfg().save(&cfg_path).unwrap();
        let s = Settings::new(cfg_path.clone(), dir.path().join("ssh"), clock());
        let edit = MachineEdit {
            ssh: Some("hp2".into()),
            mesh_ip: Some("100.64.0.99".into()),
            port_prefix: Some(3),
            root: "~/Code".into(),
            mesh: None,
        };
        s.update_machine("hp", &edit).unwrap();
        let m = Config::load(&cfg_path)
            .unwrap()
            .machine("hp")
            .unwrap()
            .clone();
        assert_eq!(
            (m.ssh.as_deref(), m.port_prefix, m.root.as_str()),
            (Some("hp2"), Some(3), "~/Code")
        );
        let clash = MachineEdit {
            port_prefix: Some(2),
            ..edit
        };
        assert!(s
            .update_machine("hp", &clash)
            .unwrap_err()
            .contains("used twice"));
    }

    #[test]
    fn passcode_change_requires_current() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("yardbell.yml");
        let mut c = cfg();
        c.passcode_hash = Some(crate::auth::hash("old-pass"));
        c.save(&cfg_path).unwrap();
        let s = Settings::new(cfg_path.clone(), dir.path().join("ssh"), clock());
        assert_eq!(
            s.change_passcode("wrong", "new-pass-1").unwrap_err(),
            "current passcode is wrong"
        );
        assert_eq!(
            s.change_passcode("old-pass", "short").unwrap_err(),
            "use at least 6 characters"
        );
        let hash = s.change_passcode("old-pass", "new-pass-1").unwrap();
        assert_eq!(
            Config::load(&cfg_path).unwrap().passcode_hash.unwrap(),
            hash
        );
    }

    #[test]
    fn rotate_key_writes_new_cookie_key() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("yardbell.yml");
        cfg().save(&cfg_path).unwrap();
        let s = Settings::new(cfg_path.clone(), dir.path().join("ssh"), clock());
        let a = s.rotate_cookie_key().unwrap();
        let b = s.rotate_cookie_key().unwrap();
        assert_ne!(a, b);
        let saved = Config::load(&cfg_path).unwrap();
        assert_eq!(
            saved.cookie_key.as_deref(),
            Some("${secret:yardbell-cookie-key}")
        );
        assert_eq!(
            saved.cookie_key(&s.secrets().unwrap()).unwrap(),
            Some(b.clone())
        );
        assert!(!std::fs::read_to_string(&cfg_path).unwrap().contains(&b));
    }
}

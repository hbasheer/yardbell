use crate::config::{new_topic, Config, MeshProvider};
use crate::onboarding::peers::Peer;
use crate::onboarding::valid_host;
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use base64::Engine;
use chrono::{DateTime, Local};
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

#[derive(Debug, Deserialize)]
pub struct PhoneEdit {
    pub server: String,
    pub wait_minutes: u64,
    pub agent_waiting: bool,
    pub session_ended: bool,
    pub machines: bool,
    pub memory: bool,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub clear_token: bool,
}

#[derive(Debug, Serialize)]
pub struct MeshApply {
    pub restart_needed: bool,
    pub ssh_updated: Vec<String>,
}

struct Undo {
    config: PathBuf,
    ssh: Option<PathBuf>,
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
}

impl Settings {
    pub fn new(cfg_path: PathBuf, ssh_path: PathBuf, clock: Clock) -> Settings {
        Settings {
            cfg_path,
            ssh_path,
            clock,
            last: Mutex::new(None),
        }
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
            .map_err(|e| format!("cannot back up yardbell.yml: {e}"))?;
        Ok(backup)
    }

    fn save(&self, cfg: &Config, backup: PathBuf, ssh: Option<PathBuf>) -> Result<(), String> {
        cfg.save(&self.cfg_path).map_err(|e| e.to_string())?;
        *self.last.lock().expect("settings lock") = Some(Undo {
            config: backup,
            ssh,
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
        let mut cfg = self.load()?;
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
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn phone_setup(&self) -> Result<(), String> {
        let mut cfg = self.load()?;
        if cfg.phone_notifications.on() {
            return Ok(());
        }
        cfg.phone_notifications.topic = new_topic();
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn update_phone(&self, edit: &PhoneEdit) -> Result<(), String> {
        let mut cfg = self.load()?;
        let phone = &mut cfg.phone_notifications;
        phone.server = edit.server.trim().to_string();
        phone.wait_minutes = edit.wait_minutes;
        phone.agent_waiting = edit.agent_waiting;
        phone.session_ended = edit.session_ended;
        phone.machines = edit.machines;
        phone.memory = edit.memory;
        let token = edit.token.as_deref().map(str::trim).unwrap_or_default();
        if !token.is_empty() {
            phone.token = token.to_string();
        } else if edit.clear_token {
            phone.token.clear();
        }
        cfg.validate().map_err(|e| e.to_string())?;
        let backup = self.backup_config()?;
        self.save(&cfg, backup, None)
    }

    pub fn phone_off(&self) -> Result<(), String> {
        let mut cfg = self.load()?;
        if !cfg.phone_notifications.on() {
            return Ok(());
        }
        cfg.phone_notifications.topic.clear();
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
        cfg.cookie_key = Some(encoded.clone());
        cfg.save(&self.cfg_path).map_err(|e| e.to_string())?;
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

    pub fn set_mcp_token(&self, token: Option<String>) -> Result<(), String> {
        let mut cfg = self.load()?;
        cfg.mcp_token = token;
        cfg.save(&self.cfg_path).map_err(|e| e.to_string())
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
        assert_eq!(Config::load(&cfg_path).unwrap().cookie_key.unwrap(), b);
    }
}

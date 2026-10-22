pub mod peers;
pub mod ssh_config;

use crate::config::{Config, Machine, MeshProvider};
use crate::probe::ping_argv;
use crate::shell::{login_shell, quote, Duration, Runner};
use crate::ssh::Ssh;
use crate::state::State;
use crate::tunnels::Tunnels;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use ssh_config::SshConfig;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const STEP_TIMEOUT: Duration = Duration::from_secs(5);
const TOKEN_TTL: Duration = Duration::from_secs(600);
const TOOLS: [&str; 3] = ["tmux", "git", "docker"];
const DEFAULT_ROOTS: [&str; 4] = ["~/code", "~/Projects", "~/src", "~/dev"];

#[derive(Debug, Serialize)]
pub struct Step {
    pub ok: bool,
    pub message: String,
    pub data: Value,
}

impl Step {
    fn ok(message: impl Into<String>, data: Value) -> Step {
        Step {
            ok: true,
            message: message.into(),
            data,
        }
    }

    fn fail(message: impl Into<String>) -> Step {
        Step {
            ok: false,
            message: message.into(),
            data: Value::Null,
        }
    }
}

enum SshEntry {
    Missing,
    Matches,
}

pub fn valid_host(host: &str) -> bool {
    if host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    let ok_char = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '.';
    !host.is_empty()
        && host.len() <= 253
        && host.chars().all(ok_char)
        && !host.starts_with(['-', '.'])
        && !host.ends_with(['-', '.'])
}

pub fn valid_user(user: &str) -> bool {
    let mut chars = user.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == '_');
    first_ok
        && user.len() <= 32
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
}

fn check_inputs(name: Option<&str>, user: Option<&str>, host: Option<&str>) -> Result<(), Step> {
    if name.is_some_and(|n| !valid_name(n)) {
        return Err(Step::fail("name must use only a-z, 0-9 and -"));
    }
    if user.is_some_and(|u| !valid_user(u)) {
        return Err(Step::fail("invalid username"));
    }
    if host.is_some_and(|h| !valid_host(h)) {
        return Err(Step::fail("invalid IP or hostname"));
    }
    Ok(())
}

pub fn next_prefix(cfg: &Config) -> Result<u8, String> {
    (1..=6u8)
        .find(|p| !cfg.machines.iter().any(|m| m.port_prefix == Some(*p)))
        .ok_or_else(|| "all 6 port prefixes are in use".to_string())
}

pub fn hint(os: &str, pacman: bool, tool: &str) -> String {
    match (tool, os) {
        ("docker", "Darwin") => "install Docker Desktop".into(),
        (_, "Darwin") => format!("brew install {tool}"),
        _ if pacman => format!("sudo pacman -S {tool}"),
        _ => format!("sudo apt install {tool}"),
    }
}

pub struct Onboarding {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
    pub cfg_path: PathBuf,
    ssh_config: SshConfig,
    pub tunnels: Arc<Tunnels>,
    state: State,
    key_path: PathBuf,
    terminals: Mutex<HashMap<String, (Vec<String>, Instant)>>,
}

impl Onboarding {
    pub fn new(
        runner: Arc<dyn Runner>,
        ssh: Ssh,
        cfg_path: PathBuf,
        ssh_config: SshConfig,
        tunnels: Arc<Tunnels>,
        state: State,
        key_path: PathBuf,
    ) -> Onboarding {
        Onboarding {
            runner,
            ssh,
            cfg_path,
            ssh_config,
            tunnels,
            state,
            key_path,
            terminals: Mutex::new(HashMap::new()),
        }
    }

    fn config(&self) -> Result<Config, Step> {
        Config::load(&self.cfg_path).map_err(|e| Step::fail(e.to_string()))
    }

    async fn run(&self, argv: Vec<String>) -> crate::shell::Output {
        self.runner.run(argv, None, STEP_TIMEOUT).await
    }

    pub async fn peers(&self) -> Step {
        match self.config() {
            Ok(cfg) => self.peers_for(crate::mesh::host_provider(&cfg)).await,
            Err(step) => step,
        }
    }

    pub async fn list_peers(&self, provider: MeshProvider) -> Result<Vec<peers::Peer>, String> {
        let candidates = match provider {
            MeshProvider::None => vec![
                MeshProvider::Nordvpn,
                MeshProvider::Tailscale,
                MeshProvider::Netbird,
            ],
            p => vec![p],
        };
        let mut missing_cli = false;
        for p in candidates {
            let Some(cmd) = crate::mesh::peers_argv(p) else {
                continue;
            };
            let out = self.run(cmd).await;
            missing_cli = out.status == Some(127);
            if let Some(found) = out
                .ok()
                .then(|| crate::mesh::parse_peers(p, &out.stdout))
                .flatten()
            {
                return Ok(found);
            }
        }
        Err(match provider {
            MeshProvider::Nordvpn if missing_cli => "NordVPN has no command line on this machine (the macOS app), so peers cannot be listed. Copy the IP from the Meshnet tab in the NordVPN app.",
            MeshProvider::Zerotier => "ZeroTier's command line does not list peer addresses. Copy the IP from ZeroTier Central.",
            _ => "could not read mesh peers, enter the IP manually",
        }
        .to_string())
    }

    pub async fn peers_for(&self, provider: MeshProvider) -> Step {
        let cfg = match self.config() {
            Ok(cfg) => cfg,
            Err(step) => return step,
        };
        let known: Vec<String> = cfg
            .machines
            .iter()
            .filter_map(|m| m.mesh_ip.clone())
            .collect();
        let found = match self.list_peers(provider).await {
            Ok(found) => found,
            Err(msg) => return Step::fail(msg),
        };
        let list: Vec<Value> = found
            .into_iter()
            .filter(|p| !known.contains(&p.ip))
            .map(|p| {
                let name = p.suggested_name();
                let mut v = serde_json::to_value(&p).unwrap_or(Value::Null);
                v["suggested_name"] = json!(name);
                v
            })
            .collect();
        Step::ok(
            format!("{} peers found", list.len()),
            json!({ "peers": list }),
        )
    }

    pub async fn reachable(&self, ip: &str) -> Step {
        if let Err(step) = check_inputs(None, None, Some(ip)) {
            return step;
        }
        if !self.run(ping_argv(ip)).await.ok() {
            return Step::fail("peer offline");
        }
        let probe = format!("echo > /dev/tcp/{ip}/22");
        if !self.run(argv(&["bash", "-c", &probe])).await.ok() {
            return Step::fail("port 22 closed: enable Remote Login / sshd on the machine");
        }
        Step::ok("reachable on port 22", Value::Null)
    }

    pub async fn key_auth(&self, user: &str, ip: &str) -> Step {
        if let Err(step) = check_inputs(None, Some(user), Some(ip)) {
            return step;
        }
        let target = format!("{user}@{ip}");
        let mut check = vec!["ssh".to_string()];
        check.extend(self.ssh.base());
        check.push(target.clone());
        check.push("true".into());
        let out = self.run(check).await;
        if out.ok() {
            return Step::ok("key login works", Value::Null);
        }
        let host_key_unknown = out.stderr.contains("Host key verification failed");
        let auth_refused = out.stderr.contains("Permission denied");
        if !host_key_unknown && !auth_refused {
            let detail = if out.timed_out {
                "timed out"
            } else {
                out.stderr.trim()
            };
            return Step::fail(format!("ssh failed: {detail}"));
        }
        if !self.key_path.exists() {
            let path = self.key_path.display().to_string();
            let keygen = self
                .run(argv(&[
                    "ssh-keygen",
                    "-t",
                    "ed25519",
                    "-N",
                    "",
                    "-f",
                    &path,
                ]))
                .await;
            if !keygen.ok() {
                return Step::fail(format!(
                    "could not create an ssh key: {}",
                    keygen.stderr.trim()
                ));
            }
        }
        let public = format!("{}.pub", self.key_path.display());
        let token = self.store_terminal(argv(&["ssh-copy-id", "-i", &public, &target]));
        Step {
            ok: false,
            message: if host_key_unknown {
                "first connection to this machine: confirm its fingerprint (type yes) and enter the password if asked".into()
            } else {
                "key login is not set up yet, type the password once in the terminal".into()
            },
            data: json!({ "terminal_url": format!("/term/_onboarding/{token}") }),
        }
    }

    fn store_terminal(&self, argv: Vec<String>) -> String {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let mut terminals = self.terminals.lock().expect("terminals lock");
        terminals.retain(|_, (_, at)| at.elapsed() < TOKEN_TTL);
        terminals.insert(token.clone(), (argv, Instant::now()));
        token
    }

    pub fn take_terminal(&self, token: &str) -> Option<Vec<String>> {
        let (argv, at) = self
            .terminals
            .lock()
            .expect("terminals lock")
            .remove(token)?;
        (at.elapsed() < TOKEN_TTL).then_some(argv)
    }

    pub async fn ssh_config_preview(&self, name: &str, user: &str, ip: &str) -> Step {
        if let Err(step) = check_inputs(Some(name), Some(user), Some(ip)) {
            return step;
        }
        match self.check_name(name, user, ip).await {
            Err(step) => step,
            Ok(SshEntry::Matches) => Step::ok(
                format!(
                    "{name} is already in ~/.ssh/config for {user}@{ip}, it will be used as is"
                ),
                json!({ "reuse": true }),
            ),
            Ok(SshEntry::Missing) => Step::ok(
                format!("will be added to {}", self.ssh_config.path().display()),
                json!({ "block": self.ssh_config.block(name, ip, user) }),
            ),
        }
    }

    async fn check_name(&self, name: &str, user: &str, ip: &str) -> Result<SshEntry, Step> {
        let cfg = self.config()?;
        if cfg.machine(name).is_some() {
            return Err(Step::fail("name already used in Yardbell, pick another"));
        }
        match self.ssh_config.has_host(name) {
            Ok(false) => return Ok(SshEntry::Missing),
            Ok(true) => {}
            Err(e) => return Err(Step::fail(format!("cannot read ~/.ssh/config: {e}"))),
        }
        let path = self.ssh_config.path().display().to_string();
        let out = self.run(argv(&["ssh", "-G", "-F", &path, name])).await;
        if !out.ok() {
            return Err(Step::fail(format!(
                "cannot read the {name} entry in ~/.ssh/config: {}",
                out.stderr.trim()
            )));
        }
        let (host, login) = resolved_target(&out.stdout);
        if host.eq_ignore_ascii_case(ip) && login == user {
            return Ok(SshEntry::Matches);
        }
        Err(Step::fail(format!(
            "name already used in ~/.ssh/config for {login}@{host}, pick another"
        )))
    }

    pub async fn write_ssh_config(&self, name: &str, user: &str, ip: &str) -> Step {
        if let Err(step) = check_inputs(Some(name), Some(user), Some(ip)) {
            return step;
        }
        match self.check_name(name, user, ip).await {
            Err(step) => return step,
            Ok(SshEntry::Matches) => {
                return Step::ok("already in ~/.ssh/config, left unchanged", Value::Null)
            }
            Ok(SshEntry::Missing) => {}
        }
        match self
            .ssh_config
            .append(&self.ssh_config.block(name, ip, user), name)
        {
            Ok(backup) => Step::ok(
                format!("added, backup at {}", backup.display()),
                json!({ "backup": backup.display().to_string() }),
            ),
            Err(e) => Step::fail(e.to_string()),
        }
    }

    pub async fn detect(&self, name: &str) -> Step {
        if let Err(step) = check_inputs(Some(name), None, None) {
            return step;
        }
        let roots = self.candidate_roots();
        let mut script = String::from("uname");
        for tool in TOOLS {
            script.push_str(&format!(
                "; command -v {tool} >/dev/null 2>&1 && echo 'has {tool}'"
            ));
        }
        let agents = self
            .config()
            .map(|cfg| cfg.agents())
            .unwrap_or_else(|_| crate::agents::builtin());
        for agent in &agents {
            let binary = agent.command.split_whitespace().next().unwrap_or_default();
            script.push_str(&format!(
                "; command -v {} >/dev/null 2>&1 && echo {}",
                quote(binary),
                quote(&format!("agent {}", agent.name))
            ));
        }
        script.push_str("; command -v pacman >/dev/null 2>&1 && echo pacman");
        for root in &roots {
            let path = root.replacen("~/", "", 1);
            let test = if root.starts_with("~/") {
                format!("\"$HOME\"/{}", quote(&path))
            } else {
                quote(root)
            };
            script.push_str(&format!(
                "; [ -d {test} ] && echo {}",
                quote(&format!("root {root}"))
            ));
        }
        script.push_str("; true");
        let target = Machine {
            name: name.into(),
            ssh: Some(name.into()),
            mesh_ip: None,
            port_prefix: None,
            root: String::new(),
            local: false,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        };
        let out = self
            .run(self.ssh.command(&target, &login_shell(&script)))
            .await;
        if !out.ok() {
            return Step::fail(format!("could not inspect {name}: {}", out.stderr.trim()));
        }
        let lines: Vec<&str> = out.stdout.lines().map(str::trim).collect();
        let os = lines.first().copied().unwrap_or_default().to_string();
        let pacman = lines.contains(&"pacman");
        let mut missing: Vec<Value> = TOOLS
            .iter()
            .filter(|t| !lines.contains(&format!("has {t}").as_str()))
            .map(|t| json!({ "tool": t, "hint": hint(&os, pacman, t) }))
            .collect();
        let found: Vec<&str> = lines
            .iter()
            .filter_map(|l| l.strip_prefix("agent "))
            .collect();
        if found.is_empty() {
            missing.push(json!({
                "tool": "an AI agent",
                "hint": "install one, for example npm install -g @anthropic-ai/claude-code",
            }));
        }
        let root = lines
            .iter()
            .find_map(|l| l.strip_prefix("root "))
            .map(str::to_string);
        let mut message = match missing.len() {
            0 => format!("{os}, all tools found"),
            n => format!("{os}, {n} tools missing"),
        };
        if !found.is_empty() {
            message.push_str(&format!(", agents: {}", found.join(", ")));
        }
        Step::ok(
            message,
            json!({ "os": os, "root": root, "missing": missing, "agents": found }),
        )
    }

    fn candidate_roots(&self) -> Vec<String> {
        let mut roots: Vec<String> = self
            .config()
            .map(|cfg| cfg.machines.iter().map(|m| m.root.clone()).collect())
            .unwrap_or_default();
        for r in DEFAULT_ROOTS {
            if !roots.iter().any(|x| x == r) {
                roots.push(r.to_string());
            }
        }
        roots.dedup();
        roots
    }

    pub async fn save(&self, name: &str, ip: &str, root: &str) -> Step {
        if let Err(step) = check_inputs(Some(name), None, Some(ip)) {
            return step;
        }
        if root.contains('\n') {
            return Step::fail("invalid project folder");
        }
        let mut cfg = match self.config() {
            Ok(cfg) => cfg,
            Err(step) => return step,
        };
        if cfg.machine(name).is_some() {
            return Step::fail("name already used in Yardbell, pick another");
        }
        if root.trim().is_empty() {
            return Step::fail("enter the project folder on that machine");
        }
        let prefix = match next_prefix(&cfg) {
            Ok(p) => p,
            Err(e) => return Step::fail(e),
        };
        cfg.machines.push(Machine {
            name: name.into(),
            ssh: Some(name.into()),
            mesh_ip: Some(ip.into()),
            port_prefix: Some(prefix),
            root: root.trim().into(),
            local: false,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        });
        match cfg.save(&self.cfg_path) {
            Ok(()) => Step::ok(
                format!("{name} added, its ports open as {prefix}xxxx on this machine"),
                json!({ "port_prefix": prefix }),
            ),
            Err(e) => Step::fail(e.to_string()),
        }
    }

    pub async fn remove(&self, name: &str) -> Step {
        let mut cfg = match self.config() {
            Ok(cfg) => cfg,
            Err(step) => return step,
        };
        match cfg.machine(name) {
            None => return Step::fail(format!("no machine named {name}")),
            Some(m) if m.is_local() => {
                return Step::fail("the machine Yardbell runs on cannot be removed")
            }
            Some(_) => {}
        }
        cfg.machines.retain(|m| m.name != name);
        if let Err(e) = cfg.save(&self.cfg_path) {
            return Step::fail(e.to_string());
        }
        self.tunnels.remove(name);
        self.state.remove_machine(name);
        Step::ok(
            "removed from Yardbell, ~/.ssh/config left unchanged",
            Value::Null,
        )
    }
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

fn resolved_target(ssh_g: &str) -> (String, String) {
    let field = |key: &str| {
        ssh_g
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix(' '))
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    (field("hostname"), field("user"))
}

#[cfg(test)]
mod tests;

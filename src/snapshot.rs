use crate::agents::Agent;
use crate::config::Machine;
use crate::detect::ScreenState;
use crate::shell::quote;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SCRIPT: &str = include_str!("snapshot.sh");

#[derive(Debug, thiserror::Error)]
#[error("bad snapshot: {0}")]
pub struct SnapshotError(String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Port {
    pub service: String,
    pub remote_port: u16,
    pub listening: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Active,
    Idle,
    Blocked,
}

impl Activity {
    pub fn from_cpu(cpu: f64) -> Activity {
        if cpu > 2.0 {
            Activity::Active
        } else {
            Activity::Idle
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Session {
    pub machine: String,
    pub agent: String,
    pub pid: u32,
    pub cwd: String,
    pub folder: String,
    pub branch: String,
    pub ticket: String,
    pub tmux: Option<String>,
    pub activity: Activity,
}

impl Session {
    pub fn id(&self) -> String {
        match &self.tmux {
            Some(name) => format!("{}:{}", self.machine, name),
            None => format!("{}:{}", self.machine, self.pid),
        }
    }

    pub fn attachable(&self) -> bool {
        self.tmux.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Health {
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    #[serde(default)]
    pub agent_kb: u64,
    #[serde(default)]
    pub load1: f64,
    #[serde(default)]
    pub cpus: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    pub health: Option<Health>,
    pub mesh_ips: Vec<String>,
    pub sessions: Vec<Session>,
    pub folders: BTreeMap<String, String>,
    pub folder_paths: BTreeMap<String, String>,
    pub ports: BTreeMap<String, Vec<Port>>,
}

#[derive(Deserialize)]
struct RawAgent {
    agent: String,
    pid: u32,
    cwd: String,
    cpu: f64,
    tmux: Option<String>,
    #[serde(default)]
    screen: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

// The screen is the agent's own word on what it is doing, so it wins. CPU use stays the estimate
// for agents without screen rules and for screens that say nothing either way.
fn activity(c: &RawAgent) -> Activity {
    let screen = c.screen.as_deref().map(|screen| {
        crate::detect::detect(&c.agent, screen, c.title.as_deref().unwrap_or("").trim())
    });
    match screen.flatten() {
        Some(ScreenState::Working) => Activity::Active,
        Some(ScreenState::Blocked) => Activity::Blocked,
        Some(ScreenState::Idle) => Activity::Idle,
        None => Activity::from_cpu(c.cpu),
    }
}

#[derive(Deserialize)]
struct RawFolder {
    path: String,
    branch: String,
}

#[derive(Deserialize)]
struct RawPort {
    workdir: String,
    service: String,
    host_port: u16,
    #[serde(default = "yes")]
    listening: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct Raw {
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    health: Option<Health>,
    #[serde(default)]
    mesh_ips: Vec<String>,
    agents: Vec<RawAgent>,
    folders: Vec<RawFolder>,
    ports: Vec<RawPort>,
}

pub fn script_args(
    root: &str,
    workspaces: &[String],
    services: &[String],
    agents: &[Agent],
) -> String {
    let mut parts = vec!["bash -s --".to_string(), quote(root)];
    parts.extend(workspaces.iter().map(|w| quote(w)));
    parts.push("--".into());
    parts.extend(services.iter().map(|s| quote(s)));
    parts.push("--".into());
    parts.extend(
        agents
            .iter()
            .map(|a| quote(&format!("{}={}", a.name, a.process_name()))),
    );
    parts.join(" ")
}

pub fn ticket(branch: &str, re: Option<&Regex>) -> String {
    re.and_then(|re| re.find(branch))
        .map(|m| m.as_str().to_uppercase())
        .unwrap_or_else(|| "-".into())
}

pub fn folder_label(path: &Path, root: &Path, workspace_dirs: &[PathBuf]) -> String {
    let owner = workspace_dirs
        .iter()
        .filter(|dir| path.starts_with(dir))
        .max_by_key(|dir| dir.components().count());
    let path = owner.map(PathBuf::as_path).unwrap_or(path);
    match path.strip_prefix(root) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.display().to_string(),
        _ => path.display().to_string(),
    }
}

pub fn parse(
    json: &str,
    machine: &Machine,
    root: &Path,
    ticket_re: Option<&Regex>,
) -> Result<Snapshot, SnapshotError> {
    let raw: Raw = serde_json::from_str(json).map_err(|e| SnapshotError(e.to_string()))?;
    let root = raw.root.as_deref().map(Path::new).unwrap_or(root);
    let dirs: Vec<PathBuf> = raw.folders.iter().map(|f| PathBuf::from(&f.path)).collect();
    let label = |path: &str| folder_label(Path::new(path), root, &dirs);

    let mut snap = Snapshot {
        health: raw.health,
        mesh_ips: raw.mesh_ips,
        ..Snapshot::default()
    };
    for f in &raw.folders {
        snap.folders.insert(label(&f.path), f.branch.clone());
        snap.folder_paths.insert(label(&f.path), f.path.clone());
    }
    for p in &raw.ports {
        let key = label(&p.workdir);
        if !snap.folders.contains_key(&key) {
            continue;
        }
        let port = Port {
            service: p.service.clone(),
            remote_port: p.host_port,
            listening: p.listening,
        };
        let list = snap.ports.entry(key).or_default();
        if !list.iter().any(|q| q.remote_port == port.remote_port) {
            list.push(port);
        }
    }
    for c in raw.agents {
        let activity = activity(&c);
        let folder = label(&c.cwd);
        let branch = snap.folders.get(&folder).cloned().unwrap_or_default();
        snap.sessions.push(Session {
            machine: machine.name.clone(),
            agent: c.agent,
            pid: c.pid,
            cwd: c.cwd,
            ticket: ticket(&branch, ticket_re),
            folder,
            branch,
            tmux: c.tmux,
            activity,
        });
    }
    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Machine;
    use regex::RegexBuilder;
    use std::path::{Path, PathBuf};

    fn re() -> Regex {
        RegexBuilder::new(r"^(eng|ops)-(\d+)")
            .case_insensitive(true)
            .build()
            .unwrap()
    }

    fn machine(name: &str, root: &str) -> Machine {
        Machine {
            name: name.into(),
            ssh: None,
            mesh_ip: None,
            port_prefix: Some(1),
            root: root.into(),
            local: false,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        }
    }

    fn linux() -> Snapshot {
        let json = include_str!("../tests/fixtures/snapshot_linux.json");
        parse(
            json,
            &machine("hp", "/home/u/code/acme"),
            Path::new("/home/u/code/acme"),
            Some(&re()),
        )
        .unwrap()
    }

    fn mac() -> Snapshot {
        let json = include_str!("../tests/fixtures/snapshot_mac.json");
        parse(
            json,
            &machine("mini", "/Users/u/code/acme"),
            Path::new("/Users/u/code/acme"),
            Some(&re()),
        )
        .unwrap()
    }

    #[test]
    fn ticket_cases() {
        assert_eq!(ticket("eng-1301-inbox-filter", Some(&re())), "ENG-1301");
        assert_eq!(ticket("OPS-7-x", Some(&re())), "OPS-7");
        assert_eq!(ticket("main", Some(&re())), "-");
        assert_eq!(ticket("", Some(&re())), "-");
        assert_eq!(ticket("eng-1301", None), "-");
    }

    #[test]
    fn folder_label_cases() {
        let root = Path::new("/r");
        let dirs: Vec<PathBuf> = [
            "/r/app",
            "/r/app3",
            "/r/slots/slot2",
            "/r/shop/app",
            "/r/acme/app",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(folder_label(Path::new("/r/app"), root, &dirs), "app");
        assert_eq!(folder_label(Path::new("/r/app3"), root, &dirs), "app3");
        assert_eq!(
            folder_label(Path::new("/r/slots/slot2/app/models"), root, &dirs),
            "slots/slot2"
        );
        assert_eq!(
            folder_label(Path::new("/r/shop/app/lib"), root, &dirs),
            "shop/app"
        );
        assert_eq!(
            folder_label(Path::new("/r/acme/app"), root, &dirs),
            "acme/app"
        );
        assert_eq!(
            folder_label(Path::new("/r/other/x"), root, &dirs),
            "other/x"
        );
        assert_eq!(
            folder_label(Path::new("/elsewhere"), root, &dirs),
            "/elsewhere"
        );
    }

    #[test]
    fn parse_linux_fixture() {
        let snap = linux();
        assert_eq!(snap.sessions.len(), 3);
        assert!(snap.sessions.iter().all(|s| s.machine == "hp"));
        assert_eq!(
            snap.folders.get("slots/slot2").unwrap(),
            "eng-1301-inbox-filter"
        );
        let slot2 = snap.ports.get("slots/slot2").unwrap();
        assert!(slot2.contains(&Port {
            service: "rails".into(),
            remote_port: 3020,
            listening: true
        }));
        assert!(slot2.contains(&Port {
            service: "mailpit".into(),
            remote_port: 8225,
            listening: false
        }));
        let s = snap.sessions.iter().find(|s| s.pid == 1900001).unwrap();
        assert_eq!(s.folder, "slots/slot2");
        assert_eq!(s.ticket, "ENG-1301");
        assert_eq!(s.branch, "eng-1301-inbox-filter");
        assert_eq!(s.id(), "hp:hp-eng-1301");
        assert!(s.attachable());
        assert_eq!(s.agent, "claude");
        let codex = snap.sessions.iter().find(|s| s.pid == 1872032).unwrap();
        assert_eq!(codex.agent, "codex");
    }

    #[test]
    fn activity_threshold() {
        assert_eq!(Activity::from_cpu(2.0), Activity::Idle);
        assert_eq!(Activity::from_cpu(2.1), Activity::Active);
        let snap = linux();
        let busy = snap.sessions.iter().find(|s| s.pid == 1900001).unwrap();
        assert_eq!(busy.activity, Activity::Active);
    }

    #[test]
    fn outside_workspace_has_no_ports() {
        let snap = linux();
        let s = snap.sessions.iter().find(|s| s.pid == 824335).unwrap();
        assert_eq!(s.folder, "/home/u/Projects");
        assert_eq!(s.ticket, "-");
        assert!(!snap.ports.contains_key(&s.folder));
    }

    #[test]
    fn detached_head_ticket_dash() {
        let snap = mac();
        assert_eq!(snap.folders.get("app3").unwrap(), "");
        assert!(snap.sessions.iter().all(|s| s.ticket == "-"));
    }

    #[test]
    fn two_sessions_same_folder() {
        let snap = mac();
        assert_eq!(snap.sessions.len(), 2);
        assert_ne!(snap.sessions[0].id(), snap.sessions[1].id());
        assert!(snap.sessions.iter().all(|s| s.folder == "app3"));
        assert_eq!(snap.ports.get("app3").unwrap().len(), 1);
    }

    #[test]
    fn mac_fixture_session_without_tmux_not_attachable() {
        let snap = mac();
        let s = snap.sessions.iter().find(|s| s.pid == 501).unwrap();
        assert!(!s.attachable());
        assert_eq!(s.id(), "mini:501");
    }

    #[test]
    fn parse_uses_reported_root() {
        let json = r#"{"root":"/home/u/P","agents":[{"agent":"claude","pid":1,"cwd":"/home/u/P/other/x","cpu":0,"tmux":null}],"folders":[],"ports":[]}"#;
        let snap = parse(json, &machine("hp", "~/P"), Path::new("~/P"), None).unwrap();
        assert_eq!(snap.sessions[0].folder, "other/x");
    }

    #[test]
    fn parses_machine_health() {
        let json = r#"{"root":"/r","health":{"mem_total_kb":16252928,"mem_used_kb":10276044,"agent_kb":2293760,"load1":2.41,"cpus":10},"agents":[],"folders":[],"ports":[]}"#;
        let snap = parse(json, &machine("hp", "/r"), Path::new("/r"), None).unwrap();
        let h = snap.health.unwrap();
        assert_eq!(h.mem_total_kb, 16252928);
        assert_eq!(h.mem_used_kb, 10276044);
        assert_eq!(h.agent_kb, 2293760);
        assert_eq!(h.cpus, 10);
        assert!((h.load1 - 2.41).abs() < 1e-9);
    }

    #[test]
    fn parses_mesh_addresses() {
        let json =
            r#"{"root":"/r","mesh_ips":["100.96.1.16"],"agents":[],"folders":[],"ports":[]}"#;
        let snap = parse(json, &machine("hp", "/r"), Path::new("/r"), None).unwrap();
        assert_eq!(snap.mesh_ips, vec!["100.96.1.16"]);
        assert!(linux().mesh_ips.is_empty());
    }

    #[test]
    fn health_is_optional() {
        assert!(linux().health.is_none());
    }

    #[test]
    fn bad_json_errors() {
        let m = machine("hp", "/r");
        assert!(parse("{", &m, Path::new("/r"), None).is_err());
        assert!(parse("{}", &m, Path::new("/r"), None).is_err());
    }

    #[test]
    fn script_args_quotes_values() {
        let agents = vec![
            crate::agents::builtin().remove(0),
            crate::agents::builtin().pop().unwrap(),
        ];
        let args = script_args(
            "/home/u/My Projects",
            &["slots/slot*".into()],
            &["rails".into()],
            &agents,
        );
        assert_eq!(
            args,
            "bash -s -- '/home/u/My Projects' 'slots/slot*' -- 'rails' -- 'claude=claude' 'aider=aider'"
        );
    }

    #[test]
    fn screen_decides_activity_before_cpu() {
        let json = |agent: &str, cpu: f64, screen: &str| {
            serde_json::json!({
                "agents": [{"agent": agent, "pid": 1, "cwd": "/w", "cpu": cpu, "tmux": "t", "title": "", "screen": screen}],
                "tmux": [], "folders": [], "ports": []
            })
            .to_string()
        };
        let activity = |agent: &str, cpu: f64, screen: &str| {
            parse(
                &json(agent, cpu, screen),
                &machine("hp", "/w"),
                Path::new("/w"),
                None,
            )
            .unwrap()
            .sessions[0]
                .activity
        };
        let prompt =
            " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend";
        assert_eq!(activity("claude", 0.0, prompt), Activity::Blocked);
        assert_eq!(activity("claude", 40.0, "❯ \n"), Activity::Idle);
        assert_eq!(activity("aider", 40.0, prompt), Activity::Active);
        assert_eq!(activity("aider", 0.0, prompt), Activity::Idle);
    }

    #[test]
    fn script_reports_each_agent_once_and_skips_agents_started_by_agents() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("fakeagent");
        let helper = dir.path().join("helperagent");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\nif [ -z \"$CHILD\" ]; then CHILD=1 \"$0\"; else sh -c '{}; true'; fi\n",
                helper.display()
            ),
        )
        .unwrap();
        std::fs::write(&helper, "#!/bin/sh\nsleep 30\n").unwrap();
        for f in [&bin, &helper] {
            std::fs::set_permissions(f, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
        }
        let mut agent = std::process::Command::new(&bin)
            .current_dir(dir.path())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let mut script = std::process::Command::new("bash")
            .args([
                "-s",
                "--",
                "/tmp",
                "--",
                "--",
                "fake=fakeagent",
                "helper=helperagent",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        script
            .stdin
            .take()
            .unwrap()
            .write_all(SCRIPT.as_bytes())
            .unwrap();
        let out = script.wait_with_output().unwrap();
        for f in [&bin, &helper] {
            let _ = std::process::Command::new("pkill")
                .args(["-f", &f.display().to_string()])
                .status();
        }
        let _ = agent.wait();
        let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let found: Vec<&serde_json::Value> = json["agents"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["agent"] == "fake")
            .collect();
        assert_eq!(found.len(), 1, "{json}");
        assert!(
            !json["agents"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["agent"] == "helper"),
            "{json}"
        );
        assert_eq!(found[0]["pid"], agent.id());
        let cwd = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            std::fs::canonicalize(found[0]["cwd"].as_str().unwrap()).unwrap(),
            cwd
        );
    }

    #[test]
    fn a_hung_docker_only_costs_three_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let docker = dir.path().join("docker");
        std::fs::write(&docker, "#!/bin/sh\nsleep 60\n").unwrap();
        std::fs::set_permissions(&docker, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let path = format!(
            "{}:{}",
            dir.path().display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let started = std::time::Instant::now();
        let mut script = std::process::Command::new("bash")
            .args(["-s", "--", "/tmp", "--", "web", "--"])
            .env("PATH", path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        script
            .stdin
            .take()
            .unwrap()
            .write_all(SCRIPT.as_bytes())
            .unwrap();
        let out = script.wait_with_output().unwrap();
        let took = started.elapsed();
        assert!(took < std::time::Duration::from_secs(6), "took {took:?}");
        let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(json["ports"], serde_json::json!([]));
        assert!(json["health"].is_object(), "{json}");
    }
}

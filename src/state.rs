use crate::config::{Config, HostTerminal, Machine};
use crate::probe::MachineStatus;
use crate::snapshot::{Account, Activity, Health, Port, Session, Snapshot};
use crate::worktrees::setup::SetupRun;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

pub trait PortStatus {
    fn local_port(&self, m: &Machine, remote: u16) -> Option<u16>;
    fn status(&self, m: &Machine, port: &Port) -> String;
}

#[derive(Default)]
struct Inner {
    statuses: HashMap<String, MachineStatus>,
    last_seen: HashMap<String, DateTime<Local>>,
    snapshots: HashMap<String, Snapshot>,
    ended: BTreeMap<String, Session>,
    ended_in: HashMap<String, Place>,
    setups: HashMap<(String, String), SetupRun>,
    pulls: HashMap<crate::pulls::Key, crate::pulls::PullView>,
}

// The checkout an ended session ran in, as the last check before it ended saw it.
#[derive(Clone, Default)]
struct Place {
    path: String,
    branch: String,
    worktree: bool,
}

#[derive(Clone)]
pub struct State {
    inner: Arc<RwLock<Inner>>,
    changes: tokio::sync::watch::Sender<u64>,
}

impl Default for State {
    fn default() -> State {
        State {
            inner: Arc::default(),
            changes: tokio::sync::watch::Sender::new(0),
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct MachineView {
    pub name: String,
    pub up: bool,
    pub reason: Option<String>,
    pub last_seen: Option<String>,
    pub local: bool,
    pub health: Option<Health>,
    #[serde(default)]
    pub accounts: Vec<Account>,
    pub mesh_on: Option<bool>,
}

#[derive(Serialize, Deserialize)]
pub struct FolderView {
    pub machine: String,
    pub label: String,
    pub path: String,
    pub branch: String,
}

#[derive(Serialize, Deserialize)]
pub struct PortView {
    pub service: String,
    pub remote: u16,
    pub local: Option<u16>,
    pub status: String,
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct SessionView {
    pub id: String,
    pub machine: String,
    pub agent: String,
    pub pid: u32,
    pub folder: String,
    pub ticket: String,
    pub branch: String,
    pub activity: Activity,
    pub attachable: bool,
    pub tmux: Option<String>,
    pub stale: bool,
    pub ports: Vec<PortView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull: Option<crate::pulls::PullView>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<SetupRun>,
}

#[derive(Serialize, Deserialize)]
pub struct EndedView {
    pub id: String,
    pub machine: String,
    pub agent: String,
    pub folder: String,
    pub ticket: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub worktree: bool,
}

#[derive(Serialize, Deserialize)]
pub struct AgentView {
    pub name: String,
    pub label: String,
    // Whether a reviewer or scanner on this agent starts unable to edit files.
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Serialize, Deserialize)]
pub struct StateView {
    pub agents: Vec<AgentView>,
    pub default_agent: String,
    pub machines: Vec<MachineView>,
    pub folders: Vec<FolderView>,
    pub sessions: Vec<SessionView>,
    pub ended: Vec<EndedView>,
    pub host_terminal: HostTerminal,
    pub mesh: Option<crate::mesh::MeshView>,
    #[serde(default)]
    pub server: Option<ServerView>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerView {
    pub machine: String,
    pub address: String,
    #[serde(default)]
    pub version: String,
}

impl State {
    // Open pages wait on this counter and fetch /state when it moves, instead of on a timer.
    pub fn changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn touch(&self) {
        self.changes.send_modify(|n| *n = n.wrapping_add(1));
    }

    pub fn update(&self, st: MachineStatus) {
        let mut inner = self.inner.write().expect("state lock");
        if let Some(snap) = &st.snapshot {
            let live: Vec<String> = snap.sessions.iter().map(Session::id).collect();
            let gone: Vec<Session> = inner
                .snapshots
                .get(&st.name)
                .map(|prev| {
                    prev.sessions
                        .iter()
                        .filter(|s| !live.contains(&s.id()))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            let prev = inner.snapshots.get(&st.name).cloned().unwrap_or_default();
            for s in gone.into_iter().filter(Session::attachable) {
                inner
                    .ended
                    .retain(|_, e| !(e.machine == s.machine && e.folder == s.folder));
                let place = Place {
                    path: prev
                        .folder_paths
                        .get(&s.folder)
                        .cloned()
                        .unwrap_or_else(|| s.cwd.clone()),
                    branch: s.branch.clone(),
                    worktree: prev.linked.contains(&s.folder),
                };
                inner.ended_in.insert(s.id(), place);
                inner.ended.insert(s.id(), s);
            }
            for id in &live {
                inner.ended.remove(id);
            }
            let Inner {
                ended, ended_in, ..
            } = &mut *inner;
            ended_in.retain(|id, _| ended.contains_key(id));
            inner.snapshots.insert(st.name.clone(), snap.clone());
            inner.last_seen.insert(st.name.clone(), st.checked_at);
        }
        inner.statuses.insert(st.name.clone(), st);
        drop(inner);
        self.touch();
    }

    pub fn set_pulls(&self, pulls: HashMap<crate::pulls::Key, crate::pulls::PullView>) {
        let mut inner = self.inner.write().expect("state lock");
        if inner.pulls == pulls {
            return;
        }
        inner.pulls = pulls;
        drop(inner);
        self.touch();
    }

    pub fn status(&self, name: &str) -> Option<MachineStatus> {
        self.inner
            .read()
            .expect("state lock")
            .statuses
            .get(name)
            .cloned()
    }

    pub fn snapshot(&self, name: &str) -> Option<Snapshot> {
        self.inner
            .read()
            .expect("state lock")
            .snapshots
            .get(name)
            .cloned()
    }

    pub fn forget(&self, id: &str) {
        let mut inner = self.inner.write().expect("state lock");
        inner.ended.remove(id);
        inner.ended_in.remove(id);
        drop(inner);
        self.touch();
    }

    pub fn set_setup(&self, machine: &str, run: SetupRun) {
        self.inner
            .write()
            .expect("state lock")
            .setups
            .insert((machine.to_string(), run.path.clone()), run);
        self.touch();
    }

    pub fn setup(&self, machine: &str, path: &str) -> Option<SetupRun> {
        self.inner
            .read()
            .expect("state lock")
            .setups
            .get(&(machine.to_string(), path.to_string()))
            .cloned()
    }

    // A worktree that is gone takes its setup and any ended session that ran in it along.
    pub fn worktree_removed(&self, machine: &str, path: &str) {
        let mut inner = self.inner.write().expect("state lock");
        inner
            .setups
            .remove(&(machine.to_string(), path.to_string()));
        let gone: Vec<String> = inner
            .ended_in
            .iter()
            .filter(|(id, p)| {
                p.path == path && inner.ended.get(*id).is_some_and(|s| s.machine == machine)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone {
            inner.ended.remove(&id);
            inner.ended_in.remove(&id);
        }
        drop(inner);
        self.touch();
    }

    pub fn ended(&self) -> Vec<Session> {
        self.inner
            .read()
            .expect("state lock")
            .ended
            .values()
            .cloned()
            .collect()
    }

    pub fn ended_session(&self, id: &str) -> Option<Session> {
        self.inner
            .read()
            .expect("state lock")
            .ended
            .get(id)
            .cloned()
    }

    pub fn remove_machine(&self, name: &str) {
        let mut inner = self.inner.write().expect("state lock");
        inner.statuses.remove(name);
        inner.snapshots.remove(name);
        inner.last_seen.remove(name);
        inner.ended.retain(|_, s| s.machine != name);
        drop(inner);
        self.touch();
    }

    pub fn ports(&self, name: &str) -> Vec<Port> {
        let inner = self.inner.read().expect("state lock");
        let mut out: Vec<Port> = Vec::new();
        for port in inner
            .snapshots
            .get(name)
            .iter()
            .flat_map(|s| s.ports.values().flatten())
        {
            if !out.iter().any(|q| q.remote_port == port.remote_port) {
                out.push(port.clone());
            }
        }
        out
    }

    pub fn view(&self, cfg: &Config, ports: &dyn PortStatus, page_host: &str) -> StateView {
        let inner = self.inner.read().expect("state lock");
        let mut view = StateView {
            agents: cfg
                .agents()
                .iter()
                .map(|a| AgentView {
                    name: a.name.clone(),
                    label: a.display(),
                    read_only: a.read_only_flags().is_some(),
                })
                .collect(),
            default_agent: cfg.default_agent().to_string(),
            machines: Vec::new(),
            folders: Vec::new(),
            sessions: Vec::new(),
            ended: Vec::new(),
            host_terminal: cfg.host_terminal,
            mesh: None,
            server: None,
        };
        for m in &cfg.machines {
            let status = inner.statuses.get(&m.name);
            let up = status.map(|s| s.up).unwrap_or(false);
            view.machines.push(MachineView {
                name: m.name.clone(),
                up,
                reason: status.and_then(|s| s.reason).map(|r| r.to_string()),
                last_seen: inner
                    .last_seen
                    .get(&m.name)
                    .map(|t| t.format("%H:%M").to_string()),
                local: m.is_local(),
                health: up
                    .then(|| inner.snapshots.get(&m.name).and_then(|s| s.health))
                    .flatten(),
                accounts: up
                    .then(|| inner.snapshots.get(&m.name).map(|s| s.accounts.clone()))
                    .flatten()
                    .unwrap_or_default(),
                mesh_on: up
                    .then(|| {
                        inner
                            .snapshots
                            .get(&m.name)
                            .map(|s| mesh_on(m, &s.mesh_ips))
                    })
                    .flatten(),
            });
            let Some(snap) = inner.snapshots.get(&m.name) else {
                continue;
            };
            for (label, path) in &snap.folder_paths {
                view.folders.push(FolderView {
                    machine: m.name.clone(),
                    label: label.clone(),
                    path: path.clone(),
                    branch: snap.folders.get(label).cloned().unwrap_or_default(),
                });
            }
            for s in &snap.sessions {
                let port_views = snap
                    .ports
                    .get(&s.folder)
                    .map(|list| {
                        list.iter()
                            .map(|p| port_view(m, p, ports, page_host))
                            .collect()
                    })
                    .unwrap_or_default();
                let path = snap
                    .folder_paths
                    .get(&s.folder)
                    .cloned()
                    .unwrap_or_default();
                view.sessions.push(SessionView {
                    id: s.id(),
                    machine: m.name.clone(),
                    agent: s.agent.clone(),
                    pid: s.pid,
                    folder: s.folder.clone(),
                    ticket: s.ticket.clone(),
                    branch: s.branch.clone(),
                    activity: s.activity,
                    attachable: s.attachable(),
                    tmux: s.tmux.clone(),
                    stale: !up,
                    ports: port_views,
                    pull: snap.folder_paths.get(&s.folder).and_then(|path| {
                        inner
                            .pulls
                            .get(&(m.name.clone(), path.clone(), s.branch.clone()))
                            .cloned()
                    }),
                    worktree: snap.linked.contains(&s.folder),
                    setup: inner.setups.get(&(m.name.clone(), path.clone())).cloned(),
                    path,
                });
            }
        }
        for s in inner.ended.values() {
            let place = inner.ended_in.get(&s.id()).cloned().unwrap_or_default();
            view.ended.push(EndedView {
                id: s.id(),
                machine: s.machine.clone(),
                agent: s.agent.clone(),
                folder: s.folder.clone(),
                ticket: s.ticket.clone(),
                path: place.path,
                branch: place.branch,
                worktree: place.worktree,
            });
        }
        view
    }
}

fn mesh_on(m: &Machine, ips: &[String]) -> bool {
    match &m.mesh_ip {
        Some(ip) if ip.parse::<std::net::Ipv4Addr>().is_ok() => ips.iter().any(|i| i == ip),
        _ => !ips.is_empty(),
    }
}

fn port_view(m: &Machine, p: &Port, ports: &dyn PortStatus, page_host: &str) -> PortView {
    let (local, status) = if m.is_local() {
        let status = if p.listening {
            "running"
        } else {
            "app not running"
        };
        (Some(p.remote_port), status.to_string())
    } else {
        (ports.local_port(m, p.remote_port), ports.status(m, p))
    };
    PortView {
        service: p.service.clone(),
        remote: p.remote_port,
        local,
        status,
        url: local.map(|port| format!("http://{page_host}:{port}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::probe::{MachineStatus, Reason};
    use crate::snapshot::{Activity, Port, Session, Snapshot};
    use std::path::Path;

    struct FakePorts;

    impl PortStatus for FakePorts {
        fn local_port(&self, m: &Machine, remote: u16) -> Option<u16> {
            m.port_prefix.map(|p| p as u16 * 10000 + remote)
        }
        fn status(&self, _m: &Machine, _port: &Port) -> String {
            "tunnel up".into()
        }
    }

    fn cfg() -> Config {
        Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap()
    }

    fn session(machine: &str, tmux: &str, folder: &str) -> Session {
        Session {
            machine: machine.into(),
            agent: "codex".into(),
            pid: 1,
            cwd: format!("/r/{folder}"),
            folder: folder.into(),
            branch: "eng-1301-x".into(),
            ticket: "ENG-1301".into(),
            tmux: Some(tmux.into()),
            activity: Activity::Idle,
        }
    }

    fn up(name: &str, sessions: Vec<Session>) -> MachineStatus {
        let mut snap = Snapshot {
            sessions,
            ..Snapshot::default()
        };
        snap.folders.insert("slot2".into(), "eng-1301-x".into());
        snap.folder_paths
            .insert("slot2".into(), "/r/slots/slot2".into());
        snap.ports.insert(
            "slot2".into(),
            vec![Port {
                service: "rails".into(),
                remote_port: 3020,
                listening: true,
                host: None,
            }],
        );
        snap.ports.insert(
            "app".into(),
            vec![Port {
                service: "rails".into(),
                remote_port: 3000,
                listening: false,
                host: None,
            }],
        );
        MachineStatus {
            name: name.into(),
            up: true,
            reason: None,
            snapshot: Some(snap),
            checked_at: chrono::Local::now(),
        }
    }

    #[test]
    fn view_reports_machine_health() {
        let state = State::default();
        let mut st = up("hp", vec![]);
        st.snapshot.as_mut().unwrap().health = Some(crate::snapshot::Health {
            mem_total_kb: 16_000_000,
            mem_used_kb: 13_000_000,
            agent_kb: 900_000,
            user_kb: 0,
            limit_kb: 0,
            limit_used_kb: 0,
            load1: 1.5,
            cpus: 8,
            disk_total_kb: 0,
            disk_used_kb: 0,
        });
        state.update(st);
        let view = serde_json::to_value(state.view(&cfg(), &FakePorts, "localhost")).unwrap();
        let hp = view["machines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == "hp")
            .unwrap()
            .clone();
        assert_eq!(hp["health"]["mem_used_kb"], 13_000_000);
        assert_eq!(hp["health"]["cpus"], 8);
        let pro = view["machines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == "pro")
            .unwrap()
            .clone();
        assert!(pro["health"].is_null());
    }

    #[test]
    fn view_reports_machine_mesh() {
        let state = State::default();
        let mut on = up("hp", vec![]);
        on.snapshot.as_mut().unwrap().mesh_ips = vec!["100.64.0.11".into()];
        state.update(on);
        let mut lan = up("pro", vec![]);
        lan.snapshot.as_mut().unwrap().mesh_ips = vec![];
        state.update(lan);
        let view = serde_json::to_value(state.view(&cfg(), &FakePorts, "localhost")).unwrap();
        let get = |n: &str| {
            view["machines"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["name"] == n)
                .unwrap()
                .clone()
        };
        assert_eq!(get("hp")["mesh_on"], true);
        assert_eq!(get("pro")["mesh_on"], false);
        assert!(get("mini")["mesh_on"].is_null());
    }

    #[test]
    fn processes_outside_tmux_never_become_ended() {
        let state = State::default();
        let mut loose = session("hp", "x", "yardbell");
        loose.tmux = None;
        for pid in 1..=4 {
            loose.pid = pid;
            state.update(up("hp", vec![loose.clone()]));
        }
        state.update(up("hp", vec![]));
        assert!(state.ended().is_empty(), "{:?}", state.ended());
    }

    #[test]
    fn ended_keeps_one_entry_per_folder() {
        let state = State::default();
        state.update(up("hp", vec![session("hp", "hp-a", "slot2")]));
        state.update(up("hp", vec![]));
        state.update(up("hp", vec![session("hp", "hp-b", "slot2")]));
        state.update(up("hp", vec![]));
        let ended: Vec<String> = state.ended().iter().map(|s| s.id()).collect();
        assert_eq!(ended, vec!["hp:hp-b"]);
    }

    #[test]
    fn disappearing_session_becomes_ended() {
        let state = State::default();
        state.update(up("hp", vec![session("hp", "hp-eng-1301", "slot2")]));
        state.update(up("hp", vec![]));
        let ended: Vec<String> = state.ended().iter().map(|s| s.id()).collect();
        assert_eq!(ended, vec!["hp:hp-eng-1301"]);
    }

    #[test]
    fn forget_removes_ended() {
        let state = State::default();
        state.update(up("hp", vec![session("hp", "hp-eng-1301", "slot2")]));
        state.update(up("hp", vec![]));
        state.forget("hp:hp-eng-1301");
        assert!(state.ended().is_empty());
    }

    #[test]
    fn every_change_moves_the_counter_pages_watch() {
        let state = State::default();
        let mut changes = state.changes();
        assert!(!changes.has_changed().unwrap());
        state.update(up("hp", vec![]));
        assert!(changes.has_changed().unwrap());
        changes.borrow_and_update();
        state.forget("hp:hp-x");
        assert!(changes.has_changed().unwrap());
        changes.borrow_and_update();
        state.remove_machine("hp");
        assert!(changes.has_changed().unwrap());
    }

    #[test]
    fn reappearing_session_leaves_ended() {
        let state = State::default();
        state.update(up("hp", vec![session("hp", "hp-eng-1301", "slot2")]));
        state.update(up("hp", vec![]));
        state.update(up("hp", vec![session("hp", "hp-eng-1301", "slot2")]));
        assert!(state.ended().is_empty());
    }

    #[test]
    fn down_machine_keeps_sessions_stale_with_last_seen() {
        let state = State::default();
        let first = up("hp", vec![session("hp", "hp-eng-1301", "slot2")]);
        let seen = first.checked_at.format("%H:%M").to_string();
        state.update(first);
        state.update(MachineStatus::down("hp", Reason::SshTimeout));
        let view = serde_json::to_value(state.view(&cfg(), &FakePorts, "localhost")).unwrap();
        let hp = view["machines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == "hp")
            .unwrap()
            .clone();
        assert_eq!(hp["up"], false);
        assert_eq!(hp["reason"], "ssh timeout");
        assert_eq!(hp["last_seen"], seen);
        assert_eq!(view["sessions"][0]["stale"], true);
        assert!(state.ended().is_empty());
    }

    #[test]
    fn view_urls_use_page_host() {
        let state = State::default();
        state.update(up("hp", vec![session("hp", "hp-eng-1301", "slot2")]));
        let view = serde_json::to_value(state.view(&cfg(), &FakePorts, "100.9.9.9")).unwrap();
        let port = &view["sessions"][0]["ports"][0];
        assert_eq!(port["local"], 13020);
        assert_eq!(port["url"], "http://100.9.9.9:13020");
        assert_eq!(port["status"], "tunnel up");
        assert_eq!(view["sessions"][0]["ticket"], "ENG-1301");
        assert_eq!(view["folders"][0]["path"], "/r/slots/slot2");
    }

    #[test]
    fn local_machine_ports_link_directly() {
        let state = State::default();
        state.update(up("mini", vec![session("mini", "mini-app", "app")]));
        let view = serde_json::to_value(state.view(&cfg(), &FakePorts, "localhost")).unwrap();
        let port = &view["sessions"][0]["ports"][0];
        assert_eq!(port["local"], 3000);
        assert_eq!(port["status"], "app not running");
        assert_eq!(port["url"], "http://localhost:3000");
    }

    #[test]
    fn ports_dedup_across_folders() {
        let state = State::default();
        state.update(up("hp", vec![]));
        let mut ports = state.ports("hp");
        ports.sort_by_key(|p| p.remote_port);
        assert_eq!(
            ports.iter().map(|p| p.remote_port).collect::<Vec<_>>(),
            vec![3000, 3020]
        );
    }
}

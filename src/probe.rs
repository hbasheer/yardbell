use crate::config::{Config, Machine};
use crate::shell::{Duration, Runner};
use crate::snapshot::{self, Snapshot};
use crate::ssh::Ssh;
use chrono::{DateTime, Local};
use std::path::Path;
use std::sync::Arc;

const CHECK_TIMEOUT: Duration = Duration::from_secs(3);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    NoMesh,
    SshRefused,
    SshTimeout,
    CheckTimeout,
    BadSnapshot,
}

impl std::fmt::Display for Reason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Reason::NoMesh => "no mesh",
            Reason::SshRefused => "ssh refused",
            Reason::SshTimeout => "ssh timeout",
            Reason::CheckTimeout => "machine check timed out",
            Reason::BadSnapshot => "bad snapshot",
        })
    }
}

#[derive(Debug, Clone)]
pub struct MachineStatus {
    pub name: String,
    pub up: bool,
    pub reason: Option<Reason>,
    pub snapshot: Option<Snapshot>,
    pub checked_at: DateTime<Local>,
}

impl MachineStatus {
    pub fn down(name: &str, reason: Reason) -> MachineStatus {
        MachineStatus {
            name: name.into(),
            up: false,
            reason: Some(reason),
            snapshot: None,
            checked_at: Local::now(),
        }
    }
}

pub fn ping_argv(ip: &str) -> Vec<String> {
    let wait = if cfg!(target_os = "macos") {
        "1000"
    } else {
        "1"
    };
    ["ping", "-c", "1", "-W", wait, ip]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

pub struct Probe {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
}

impl Probe {
    pub fn new(runner: Arc<dyn Runner>, ssh: Ssh) -> Probe {
        Probe { runner, ssh }
    }

    pub async fn check(&self, cfg: &Config, m: &Machine) -> MachineStatus {
        if !m.is_local() {
            if let Some(reason) = self.reachability(m).await {
                return MachineStatus::down(&m.name, reason);
            }
        }
        let root = if m.is_local() {
            m.root_expanded().display().to_string()
        } else {
            m.root.clone()
        };
        let args = snapshot::script_args(
            &root,
            cfg.workspaces_for(m),
            &cfg.forward_services,
            &cfg.agents(),
        );
        let out = self
            .runner
            .run(
                self.ssh.command(m, &args),
                Some(snapshot::SCRIPT.into()),
                SNAPSHOT_TIMEOUT,
            )
            .await;
        if out.timed_out {
            let reason = if m.is_local() {
                Reason::CheckTimeout
            } else {
                Reason::SshTimeout
            };
            return MachineStatus::down(&m.name, reason);
        }
        let parsed = snapshot::parse(
            &out.stdout,
            m,
            Path::new(&root),
            cfg.ticket_regex().as_ref(),
        );
        match parsed {
            Ok(snap) => MachineStatus {
                name: m.name.clone(),
                up: true,
                reason: None,
                snapshot: Some(snap),
                checked_at: Local::now(),
            },
            Err(e) => {
                tracing::warn!(machine = %m.name, error = %e, stderr = %out.stderr, "snapshot failed");
                MachineStatus::down(&m.name, Reason::BadSnapshot)
            }
        }
    }

    async fn reachability(&self, m: &Machine) -> Option<Reason> {
        if let Some(ip) = &m.mesh_ip {
            let ping = self.runner.run(ping_argv(ip), None, CHECK_TIMEOUT).await;
            if !ping.ok() {
                return Some(Reason::NoMesh);
            }
        }
        let out = self
            .runner
            .run(self.ssh.command(m, "true"), None, CHECK_TIMEOUT)
            .await;
        if out.timed_out {
            let _ = self
                .runner
                .run(self.ssh.exit_master(m), None, CHECK_TIMEOUT)
                .await;
            return Some(Reason::SshTimeout);
        }
        if !out.ok() {
            return Some(Reason::SshRefused);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::path::Path;
    use std::sync::Arc;

    fn cfg() -> Config {
        let mut cfg = Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap();
        for m in cfg.machines.iter_mut() {
            m.root = "/home/u/code/acme".into();
        }
        cfg
    }

    fn probe(fake: Arc<FakeRunner>) -> Probe {
        let dir = tempfile::tempdir().unwrap().keep();
        Probe::new(fake, Ssh::new(dir))
    }

    const FIXTURE: &str = include_str!("../tests/fixtures/snapshot_linux.json");

    #[tokio::test]
    async fn local_skips_ping_and_ssh() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("bash -s", Output::ok_with(FIXTURE));
        let cfg = cfg();
        let st = probe(fake.clone())
            .check(&cfg, cfg.machine("mini").unwrap())
            .await;
        assert!(st.up, "{:?}", st.reason);
        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        assert!(calls.iter().all(|c| c[0] != "ping" && c[0] != "ssh"));
    }

    #[tokio::test]
    async fn a_slow_local_check_does_not_blame_ssh() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("bash -s", Output::timeout());
        let cfg = cfg();
        let st = probe(fake).check(&cfg, cfg.machine("mini").unwrap()).await;
        assert!(!st.up);
        assert_eq!(st.reason, Some(Reason::CheckTimeout));
        assert_eq!(st.reason.unwrap().to_string(), "machine check timed out");
    }

    #[tokio::test]
    async fn ping_fail_is_no_mesh_and_skips_ssh() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("ping", Output::failed(1, ""));
        let cfg = cfg();
        let st = probe(fake.clone())
            .check(&cfg, cfg.machine("hp").unwrap())
            .await;
        assert!(!st.up);
        assert_eq!(st.reason, Some(Reason::NoMesh));
        assert!(fake.calls().iter().all(|c| c[0] != "ssh"));
    }

    #[tokio::test]
    async fn ssh_timeout() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("ping", Output::ok_with(""));
        fake.stub("ssh", Output::timeout());
        let cfg = cfg();
        let st = probe(fake.clone())
            .check(&cfg, cfg.machine("hp").unwrap())
            .await;
        assert_eq!(st.reason, Some(Reason::SshTimeout));
        assert_eq!(st.reason.unwrap().to_string(), "ssh timeout");
        assert!(
            fake.calls()
                .iter()
                .any(|c| c.join(" ").ends_with("-O exit hp")),
            "stale master not closed"
        );
    }

    #[tokio::test]
    async fn ssh_status_255_is_refused() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("ping", Output::ok_with(""));
        fake.stub("ssh", Output::failed(255, "Connection refused"));
        let cfg = cfg();
        let st = probe(fake).check(&cfg, cfg.machine("hp").unwrap()).await;
        assert_eq!(st.reason, Some(Reason::SshRefused));
    }

    #[tokio::test]
    async fn bad_snapshot() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("ping", Output::ok_with(""));
        fake.stub("bash -s", Output::ok_with("oops"));
        fake.stub("ssh", Output::ok_with(""));
        let cfg = cfg();
        let st = probe(fake).check(&cfg, cfg.machine("hp").unwrap()).await;
        assert_eq!(st.reason, Some(Reason::BadSnapshot));
        assert!(!st.up);
    }

    #[tokio::test]
    async fn success_parses_fixture() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("ping", Output::ok_with(""));
        fake.stub("bash -s", Output::ok_with(FIXTURE));
        fake.stub("ssh", Output::ok_with(""));
        let cfg = cfg();
        let st = probe(fake.clone())
            .check(&cfg, cfg.machine("hp").unwrap())
            .await;
        assert!(st.up);
        assert_eq!(st.snapshot.unwrap().sessions.len(), 3);
        let snap_call = fake
            .calls()
            .into_iter()
            .find(|c| c.join(" ").contains("bash -s"))
            .unwrap();
        assert!(snap_call
            .join(" ")
            .contains("'rails' 'mailpit' 'anycable-go'"));
    }

    #[tokio::test]
    async fn remote_root_passed_unexpanded() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("ping", Output::ok_with(""));
        fake.stub("bash -s", Output::ok_with(FIXTURE));
        fake.stub("ssh", Output::ok_with(""));
        let mut cfg = cfg();
        cfg.machines[1].root = "~/code/acme".into();
        probe(fake.clone())
            .check(&cfg, cfg.machine("hp").unwrap())
            .await;
        let snap_call = fake
            .calls()
            .into_iter()
            .find(|c| c.join(" ").contains("bash -s"))
            .unwrap();
        assert!(
            snap_call.join(" ").contains("bash -s -- '~/code/acme'"),
            "{snap_call:?}"
        );
    }

    #[test]
    fn ping_argv_platform() {
        let argv = ping_argv("100.1.1.1");
        let wait = if cfg!(target_os = "macos") {
            "1000"
        } else {
            "1"
        };
        assert_eq!(argv, vec!["ping", "-c", "1", "-W", wait, "100.1.1.1"]);
    }
}

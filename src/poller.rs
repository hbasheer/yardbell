use crate::config::{Config, Machine};
use crate::probe::{MachineStatus, Probe, Reason};
use crate::state::State;
use futures::future::BoxFuture;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

const CHECK_CAP: Duration = Duration::from_secs(15);

pub trait Check: Send + Sync {
    fn check<'a>(&'a self, cfg: &'a Config, m: &'a Machine) -> BoxFuture<'a, MachineStatus>;
}

impl Check for Probe {
    fn check<'a>(&'a self, cfg: &'a Config, m: &'a Machine) -> BoxFuture<'a, MachineStatus> {
        Box::pin(Probe::check(self, cfg, m))
    }
}

pub type Hook = Arc<dyn Fn(&Config, &MachineStatus) + Send + Sync>;

pub struct Poller {
    cfg_path: PathBuf,
    check: Arc<dyn Check>,
    state: State,
    hook: Hook,
    ticking: tokio::sync::Mutex<()>,
}

impl Poller {
    pub fn new(cfg_path: PathBuf, check: Arc<dyn Check>, state: State, hook: Hook) -> Poller {
        Poller {
            cfg_path,
            check,
            state,
            hook,
            ticking: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn tick(&self) -> Option<Config> {
        // A refresh can run alongside the background loop, and an older snapshot
        // stored after a newer one would bring an ended session back.
        let _turn = self.ticking.lock().await;
        let cfg = match Config::load(&self.cfg_path) {
            Ok(cfg) => Arc::new(cfg),
            Err(e) => {
                tracing::error!(error = %e, "config reload failed, skipping poll");
                return None;
            }
        };
        let tasks: Vec<_> = cfg
            .machines
            .iter()
            .map(|m| {
                let check = self.check.clone();
                let cfg = cfg.clone();
                let m = m.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(CHECK_CAP, check.check(&cfg, &m)).await {
                        Ok(st) => st,
                        Err(_) => MachineStatus::down(&m.name, Reason::SshTimeout),
                    }
                })
            })
            .collect();
        let names: Vec<String> = cfg.machines.iter().map(|m| m.name.clone()).collect();
        for (name, task) in names.iter().zip(tasks) {
            let st = match task.await {
                Ok(st) => st,
                Err(e) => {
                    tracing::error!(machine = %name, error = %e, "probe crashed");
                    MachineStatus::down(name, Reason::BadSnapshot)
                }
            };
            self.state.update(st.clone());
            (self.hook)(&cfg, &st);
        }
        Some(Arc::unwrap_or_clone(cfg))
    }

    pub fn start(self: Arc<Self>, interval: Duration) -> JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let next = self
                    .tick()
                    .await
                    .map(|c| Duration::from_secs(c.poll_seconds))
                    .unwrap_or(interval);
                tokio::time::sleep(next).await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{MachineStatus, Reason};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    struct SlowCheck {
        delay: Duration,
        panic_on: Option<&'static str>,
    }

    impl Check for SlowCheck {
        fn check<'a>(&'a self, _cfg: &'a Config, m: &'a Machine) -> BoxFuture<'a, MachineStatus> {
            Box::pin(async move {
                tokio::time::sleep(self.delay).await;
                if self.panic_on == Some(m.name.as_str()) {
                    panic!("boom");
                }
                MachineStatus::down(&m.name, Reason::NoMesh)
            })
        }
    }

    fn cfg_path() -> std::path::PathBuf {
        std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        ))
    }

    #[tokio::test]
    async fn tick_probes_all_machines_concurrently() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hook_seen = seen.clone();
        let state = State::default();
        let poller = Poller::new(
            cfg_path(),
            Arc::new(SlowCheck {
                delay: Duration::from_millis(300),
                panic_on: None,
            }),
            state.clone(),
            Arc::new(move |_cfg: &Config, st: &MachineStatus| {
                hook_seen.lock().unwrap().push(st.name.clone())
            }),
        );
        let start = Instant::now();
        poller.tick().await;
        assert!(
            start.elapsed() < Duration::from_millis(600),
            "{:?}",
            start.elapsed()
        );
        let mut names = seen.lock().unwrap().clone();
        names.sort();
        assert_eq!(names, vec!["hp", "mini", "pro"]);
        assert!(state.status("pro").is_some());
    }

    #[derive(Default)]
    struct CountingCheck {
        inside: AtomicUsize,
        most: AtomicUsize,
    }

    impl Check for CountingCheck {
        fn check<'a>(&'a self, _cfg: &'a Config, m: &'a Machine) -> BoxFuture<'a, MachineStatus> {
            Box::pin(async move {
                if m.name == "hp" {
                    let now = self.inside.fetch_add(1, Ordering::SeqCst) + 1;
                    self.most.fetch_max(now, Ordering::SeqCst);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                if m.name == "hp" {
                    self.inside.fetch_sub(1, Ordering::SeqCst);
                }
                MachineStatus::down(&m.name, Reason::NoMesh)
            })
        }
    }

    #[tokio::test]
    async fn concurrent_ticks_never_overlap() {
        let check = Arc::new(CountingCheck::default());
        let poller = Poller::new(
            cfg_path(),
            check.clone(),
            State::default(),
            Arc::new(|_: &Config, _: &MachineStatus| {}),
        );
        tokio::join!(poller.tick(), poller.tick(), poller.tick());
        assert_eq!(check.most.load(Ordering::SeqCst), 1);
        assert_eq!(check.inside.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn one_machine_error_does_not_block_others() {
        let state = State::default();
        let poller = Poller::new(
            cfg_path(),
            Arc::new(SlowCheck {
                delay: Duration::from_millis(10),
                panic_on: Some("hp"),
            }),
            state.clone(),
            Arc::new(|_: &Config, _: &MachineStatus| {}),
        );
        poller.tick().await;
        assert_eq!(state.status("pro").unwrap().reason, Some(Reason::NoMesh));
        let hp = state.status("hp").unwrap();
        assert!(!hp.up);
    }
}

use crate::config::Machine;
use crate::shell::Runner;
use crate::snapshot::Port;
use crate::state::PortStatus;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BACKOFF: [u64; 5] = [5, 10, 30, 60, 60];
const HEALTHY_AFTER: Duration = Duration::from_secs(60);

pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

pub fn local_port(prefix: u8, remote: u16) -> Option<u16> {
    if remote >= 10000 {
        return None;
    }
    u16::try_from(prefix as u32 * 10000 + remote as u32).ok()
}

struct Entry {
    pid: Option<u32>,
    prefix: u8,
    ports: Vec<(u16, String)>,
    failures: usize,
    next_try: Option<Instant>,
    started: Instant,
}

pub struct Tunnels {
    runner: Arc<dyn Runner>,
    bind: Vec<String>,
    log_dir: PathBuf,
    clock: Clock,
    entries: Mutex<HashMap<String, Entry>>,
    closed: AtomicBool,
}

impl Tunnels {
    pub fn new(
        runner: Arc<dyn Runner>,
        bind: Vec<String>,
        log_dir: PathBuf,
        clock: Clock,
    ) -> Tunnels {
        Tunnels {
            runner,
            bind,
            log_dir,
            clock,
            entries: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }

    fn log_path(&self, name: &str) -> PathBuf {
        self.log_dir.join(format!("tunnel-{name}.log"))
    }

    fn argv(&self, m: &Machine, ports: &[(u16, String)]) -> Vec<String> {
        let prefix = m.port_prefix.unwrap_or(0);
        let mut argv = vec!["ssh".to_string()];
        for opt in [
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=3",
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
        ] {
            argv.push(opt.into());
        }
        for (remote, host) in ports {
            let Some(local) = local_port(prefix, *remote) else {
                continue;
            };
            for bind in &self.bind {
                argv.push("-L".into());
                argv.push(format!("{bind}:{local}:{host}:{remote}"));
            }
        }
        argv.push(m.ssh_host().into());
        argv
    }

    fn start(&self, m: &Machine, entry: &mut Entry) {
        let now = (self.clock)();
        entry.next_try = None;
        entry.started = now;
        match self
            .runner
            .spawn(self.argv(m, &entry.ports), self.log_path(&m.name))
        {
            Ok(pid) => entry.pid = Some(pid),
            Err(e) => {
                tracing::error!(machine = %m.name, error = %e, "tunnel spawn failed");
                entry.pid = None;
            }
        }
    }

    pub fn sync(&self, m: &Machine, ports: &[Port]) {
        let Some(prefix) = m.port_prefix else {
            return;
        };
        let mut wanted: Vec<(u16, String)> = ports
            .iter()
            .filter(|p| local_port(prefix, p.remote_port).is_some())
            .map(|p| {
                let host = p.host.clone().unwrap_or_else(|| "localhost".into());
                (p.remote_port, host)
            })
            .collect();
        wanted.sort_unstable();
        wanted.dedup_by_key(|(remote, _)| *remote);

        let mut entries = self.entries.lock().expect("tunnels lock");
        // Read under the lock, so a poll already under way cannot start a tunnel after shutdown.
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        if wanted.is_empty() {
            if let Some(old) = entries.remove(&m.name) {
                old.pid.into_iter().for_each(|pid| self.runner.kill(pid));
            }
            return;
        }
        let now = (self.clock)();
        let entry = entries.entry(m.name.clone()).or_insert_with(|| Entry {
            pid: None,
            prefix,
            ports: Vec::new(),
            failures: 0,
            next_try: Some(now),
            started: now,
        });
        if entry.ports != wanted || entry.prefix != prefix {
            if let Some(pid) = entry.pid.take() {
                self.runner.kill(pid);
            }
            entry.prefix = prefix;
            entry.ports = wanted;
            entry.failures = 0;
            self.start(m, entry);
            return;
        }
        let alive = entry.pid.is_some_and(|pid| self.runner.alive(pid));
        if alive {
            if now.duration_since(entry.started) >= HEALTHY_AFTER {
                entry.failures = 0;
            }
            return;
        }
        match entry.next_try {
            None => {
                let delay = BACKOFF[entry.failures.min(BACKOFF.len() - 1)];
                entry.failures += 1;
                entry.next_try = Some(now + Duration::from_secs(delay));
            }
            Some(at) if now >= at => self.start(m, entry),
            Some(_) => {}
        }
    }

    pub fn retain(&self, names: &[String]) {
        let gone: Vec<String> = self
            .entries
            .lock()
            .expect("tunnels lock")
            .keys()
            .filter(|k| !names.contains(k))
            .cloned()
            .collect();
        for name in gone {
            self.remove(&name);
        }
    }

    pub fn remove(&self, name: &str) {
        if let Some(old) = self.entries.lock().expect("tunnels lock").remove(name) {
            old.pid.into_iter().for_each(|pid| self.runner.kill(pid));
        }
    }

    pub fn shutdown(&self) {
        let old: Vec<Entry> = {
            let mut entries = self.entries.lock().expect("tunnels lock");
            self.closed.store(true, Ordering::SeqCst);
            entries.drain().map(|(_, entry)| entry).collect()
        };
        for entry in old {
            entry.pid.into_iter().for_each(|pid| self.runner.kill(pid));
        }
    }
}

impl PortStatus for Tunnels {
    fn local_port(&self, m: &Machine, remote: u16) -> Option<u16> {
        local_port(m.port_prefix?, remote)
    }

    fn status(&self, m: &Machine, port: &Port) -> String {
        let Some(local) = self.local_port(m, port.remote_port) else {
            return "not forwardable".into();
        };
        let entries = self.entries.lock().expect("tunnels lock");
        let Some(entry) = entries
            .get(&m.name)
            .filter(|e| e.ports.iter().any(|(r, _)| *r == port.remote_port))
        else {
            return "tunnel down".into();
        };
        if !entry.pid.is_some_and(|pid| self.runner.alive(pid)) {
            let log = std::fs::read_to_string(self.log_path(&m.name)).unwrap_or_default();
            if log.contains("Address already in use") {
                return format!("local port {local} in use");
            }
            return "tunnel down".into();
        }
        if port.listening {
            "tunnel up".into()
        } else {
            "app not running".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRunner;
    use std::sync::Mutex;

    fn machine() -> Machine {
        Machine {
            name: "hp".into(),
            ssh: Some("hp".into()),
            mesh_ip: None,
            port_prefix: Some(1),
            root: "/r".into(),
            local: false,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        }
    }

    fn port(remote: u16, listening: bool) -> Port {
        Port {
            service: "rails".into(),
            remote_port: remote,
            listening,
            host: None,
        }
    }

    struct Rig {
        fake: Arc<FakeRunner>,
        now: Arc<Mutex<Instant>>,
        start: Instant,
        tunnels: Tunnels,
        dir: tempfile::TempDir,
    }

    impl Rig {
        fn new() -> Rig {
            let fake = Arc::new(FakeRunner::default());
            let start = Instant::now();
            let now = Arc::new(Mutex::new(start));
            let clock_now = now.clone();
            let dir = tempfile::tempdir().unwrap();
            let tunnels = Tunnels::new(
                fake.clone(),
                vec!["127.0.0.1".into(), "100.9.9.9".into()],
                dir.path().join("logs"),
                Arc::new(move || *clock_now.lock().unwrap()),
            );
            Rig {
                fake,
                now,
                start,
                tunnels,
                dir,
            }
        }

        fn at(&self, secs: u64) {
            *self.now.lock().unwrap() = self.start + Duration::from_secs(secs);
        }

        fn spawn_count(&self) -> usize {
            self.fake.spawned().len()
        }

        fn kill_current(&self) {
            for (pid, _, _) in self.fake.spawned() {
                self.fake.die(pid);
            }
        }
    }

    #[test]
    fn local_port_cases() {
        assert_eq!(local_port(1, 3020), Some(13020));
        assert_eq!(local_port(2, 3000), Some(23000));
        assert_eq!(local_port(6, 5535), Some(65535));
        assert_eq!(local_port(6, 9999), None);
        assert_eq!(local_port(1, 10000), None);
    }

    #[test]
    fn argv_has_both_binds() {
        let rig = Rig::new();
        rig.tunnels
            .sync(&machine(), &[port(8225, true), port(3020, true)]);
        let argv = rig.fake.spawned()[0].1.join(" ");
        assert!(
            argv.starts_with("ssh -o ControlMaster=no -o ControlPath=none"),
            "{argv}"
        );
        assert!(!argv.contains("ControlMaster=auto"), "{argv}");
        assert!(argv.contains("BatchMode=yes"));
        assert!(argv.contains("-N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15"));
        assert!(argv.contains("-L 127.0.0.1:13020:localhost:3020 -L 100.9.9.9:13020:localhost:3020 -L 127.0.0.1:18225:localhost:8225"));
        assert!(argv.ends_with(" hp"));
    }

    #[test]
    fn prefix_change_respawns() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(3020, true)]);
        let mut moved = machine();
        moved.port_prefix = Some(3);
        rig.tunnels.sync(&moved, &[port(3020, true)]);
        let spawned = rig.fake.spawned();
        assert_eq!(spawned.len(), 2);
        assert!(spawned[1]
            .1
            .join(" ")
            .contains("127.0.0.1:33020:localhost:3020"));
    }

    #[test]
    fn retain_drops_machines_gone_from_config() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(3020, true)]);
        rig.tunnels.retain(&["pro".to_string()]);
        assert!(!rig.fake.spawned()[0].2);
        assert_eq!(
            rig.tunnels.status(&machine(), &port(3020, true)),
            "tunnel down"
        );
    }

    #[test]
    fn same_set_no_respawn() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(3020, true)]);
        rig.tunnels.sync(&machine(), &[port(3020, false)]);
        assert_eq!(rig.spawn_count(), 1);
    }

    #[test]
    fn changed_set_respawns() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(3020, true)]);
        rig.tunnels
            .sync(&machine(), &[port(3020, true), port(8225, true)]);
        let spawned = rig.fake.spawned();
        assert_eq!(spawned.len(), 2);
        assert!(!spawned[0].2, "old tunnel still alive");
        assert!(spawned[1].2);
    }

    #[test]
    fn empty_set_kills() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(3020, true)]);
        rig.tunnels.sync(&machine(), &[]);
        assert!(!rig.fake.spawned()[0].2);
        assert_eq!(
            rig.tunnels.status(&machine(), &port(3020, true)),
            "tunnel down"
        );
    }

    #[test]
    fn unforwardable_ports_alone_spawn_nothing() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(10000, true)]);
        assert_eq!(rig.spawn_count(), 0);
    }

    #[test]
    fn backoff_5_10_30_60_60() {
        let rig = Rig::new();
        let m = machine();
        let ports = [port(3020, true)];
        rig.tunnels.sync(&m, &ports);
        let mut t = 0;
        for delay in [5, 10, 30, 60, 60] {
            rig.kill_current();
            let before = rig.spawn_count();
            rig.at(t);
            rig.tunnels.sync(&m, &ports);
            rig.at(t + delay - 1);
            rig.tunnels.sync(&m, &ports);
            assert_eq!(rig.spawn_count(), before, "respawned before +{delay}");
            t += delay;
            rig.at(t);
            rig.tunnels.sync(&m, &ports);
            assert_eq!(rig.spawn_count(), before + 1, "no respawn at +{delay}");
        }
    }

    #[test]
    fn status_strings() {
        let rig = Rig::new();
        let m = machine();
        assert_eq!(
            rig.tunnels.status(&m, &port(10000, true)),
            "not forwardable"
        );
        assert_eq!(rig.tunnels.status(&m, &port(3020, true)), "tunnel down");
        rig.tunnels.sync(&m, &[port(3020, true)]);
        assert_eq!(rig.tunnels.status(&m, &port(3020, true)), "tunnel up");
        assert_eq!(
            rig.tunnels.status(&m, &port(3020, false)),
            "app not running"
        );
        rig.kill_current();
        std::fs::create_dir_all(rig.dir.path().join("logs")).unwrap();
        std::fs::write(
            rig.dir.path().join("logs/tunnel-hp.log"),
            "bind [127.0.0.1]:13020: Address already in use\n",
        )
        .unwrap();
        assert_eq!(
            rig.tunnels.status(&m, &port(3020, true)),
            "local port 13020 in use"
        );
    }

    #[test]
    fn a_port_bound_to_one_address_is_forwarded_there() {
        let rig = Rig::new();
        let mut bound = port(3230, true);
        bound.host = Some("127.0.1.3".into());
        rig.tunnels.sync(&machine(), &[bound, port(3020, true)]);
        let argv = rig.fake.spawned()[0].1.join(" ");
        assert!(argv.contains("-L 127.0.0.1:13230:127.0.1.3:3230"), "{argv}");
        assert!(argv.contains("-L 127.0.0.1:13020:localhost:3020"), "{argv}");
    }

    #[test]
    fn a_new_bound_address_respawns() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(3230, true)]);
        let mut bound = port(3230, true);
        bound.host = Some("127.0.1.3".into());
        rig.tunnels.sync(&machine(), &[bound]);
        assert_eq!(rig.spawn_count(), 2);
        assert!(!rig.fake.spawned()[0].2);
    }

    #[test]
    fn local_port_trait_uses_prefix() {
        let rig = Rig::new();
        assert_eq!(rig.tunnels.local_port(&machine(), 3020), Some(13020));
    }

    #[test]
    fn remove_and_shutdown_kill() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(3020, true)]);
        let mut pro = machine();
        pro.name = "pro".into();
        pro.port_prefix = Some(2);
        rig.tunnels.sync(&pro, &[port(3000, true)]);
        rig.tunnels.remove("hp");
        assert!(!rig.fake.spawned()[0].2);
        assert!(rig.fake.spawned()[1].2);
        rig.tunnels.shutdown();
        assert!(rig.fake.spawned().iter().all(|s| !s.2));
    }

    #[test]
    fn sync_after_shutdown_starts_nothing() {
        let rig = Rig::new();
        rig.tunnels.sync(&machine(), &[port(3020, true)]);
        rig.tunnels.shutdown();
        rig.tunnels.sync(&machine(), &[port(3020, true)]);
        assert_eq!(rig.spawn_count(), 1);
        assert!(rig.fake.spawned().iter().all(|s| !s.2));
    }
}

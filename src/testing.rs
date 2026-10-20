use crate::phone::ntfy::{Push, Sender, Target};
use crate::shell::{Output, Runner};
use futures::future::BoxFuture;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct FakeRunner {
    stubs: Mutex<Vec<(String, Output)>>,
    calls: Mutex<Vec<Vec<String>>>,
    spawned: Mutex<Vec<(u32, Vec<String>, bool)>>,
}

impl FakeRunner {
    pub fn stub(&self, pattern: &str, out: Output) {
        self.stubs.lock().unwrap().push((pattern.into(), out));
    }

    pub fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }

    pub fn spawned(&self) -> Vec<(u32, Vec<String>, bool)> {
        self.spawned.lock().unwrap().clone()
    }

    pub fn die(&self, pid: u32) {
        for entry in self.spawned.lock().unwrap().iter_mut() {
            if entry.0 == pid {
                entry.2 = false;
            }
        }
    }

    fn lookup(&self, argv: &[String]) -> Output {
        let joined = argv.join(" ");
        self.stubs
            .lock()
            .unwrap()
            .iter()
            .find(|(pattern, _)| joined.contains(pattern.as_str()))
            .map(|(_, out)| out.clone())
            .unwrap_or_else(|| Output::failed(127, "unstubbed"))
    }
}

impl Runner for FakeRunner {
    fn run(
        &self,
        argv: Vec<String>,
        _stdin: Option<String>,
        _timeout: Duration,
    ) -> BoxFuture<'_, Output> {
        let out = self.lookup(&argv);
        self.calls.lock().unwrap().push(argv);
        Box::pin(async move { out })
    }

    fn spawn(&self, argv: Vec<String>, _log: PathBuf) -> std::io::Result<u32> {
        let mut spawned = self.spawned.lock().unwrap();
        let pid = 1000 + spawned.len() as u32;
        spawned.push((pid, argv, true));
        Ok(pid)
    }

    fn alive(&self, pid: u32) -> bool {
        self.spawned
            .lock()
            .unwrap()
            .iter()
            .any(|(p, _, alive)| *p == pid && *alive)
    }

    fn kill(&self, pid: u32) {
        self.die(pid);
    }
}

struct Fault {
    message: String,
    title: Option<String>,
    remaining: Option<usize>,
}

#[derive(Default)]
pub struct FakeSender {
    calls: Mutex<Vec<(Target, Push)>>,
    faults: Mutex<Vec<Fault>>,
}

impl FakeSender {
    pub fn calls(&self) -> Vec<(Target, Push)> {
        self.calls.lock().unwrap().clone()
    }

    pub fn fail_all(&self, message: &str) {
        self.add_fault(message, None, None);
    }

    pub fn fail_next(&self, count: usize, message: &str) {
        self.add_fault(message, None, Some(count));
    }

    pub fn fail_title(&self, title: &str, message: &str) {
        self.add_fault(message, Some(title.into()), None);
    }

    fn add_fault(&self, message: &str, title: Option<String>, remaining: Option<usize>) {
        self.faults.lock().unwrap().push(Fault {
            message: message.into(),
            title,
            remaining,
        });
    }

    fn verdict(&self, push: &Push) -> Result<(), String> {
        let mut faults = self.faults.lock().unwrap();
        for fault in faults.iter_mut() {
            if fault
                .title
                .as_ref()
                .is_some_and(|title| *title != push.title)
            {
                continue;
            }
            match &mut fault.remaining {
                Some(0) => continue,
                Some(left) => *left -= 1,
                None => {}
            }
            return Err(fault.message.clone());
        }
        Ok(())
    }
}

impl Sender for FakeSender {
    fn send<'a>(&'a self, to: &'a Target, push: &'a Push) -> BoxFuture<'a, Result<(), String>> {
        self.calls.lock().unwrap().push((to.clone(), push.clone()));
        let verdict = self.verdict(push);
        Box::pin(async move { verdict })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::{Output, Runner};
    use std::time::Duration;

    #[tokio::test]
    async fn fake_runner_matches_first_stub() {
        let fake = FakeRunner::default();
        fake.stub("ssh", Output::ok_with("first"));
        fake.stub("ssh hp", Output::ok_with("second"));
        let out = fake
            .run(
                vec!["ssh".into(), "hp".into()],
                None,
                Duration::from_secs(1),
            )
            .await;
        assert_eq!(out.stdout, "first");
        let miss = fake
            .run(vec!["ping".into()], None, Duration::from_secs(1))
            .await;
        assert_eq!(miss.status, Some(127));
        assert_eq!(fake.calls().len(), 2);
    }
}

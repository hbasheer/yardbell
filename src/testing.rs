use crate::shell::{Output, Runner};
use futures::future::BoxFuture;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct FakeRunner {
    stubs: Mutex<Vec<(String, Output)>>,
    calls: Mutex<Vec<Vec<String>>>,
    inputs: Mutex<Vec<Option<String>>>,
    spawned: Mutex<Vec<(u32, Vec<String>, bool)>>,
}

impl FakeRunner {
    pub fn stub(&self, pattern: &str, out: Output) {
        self.stubs.lock().unwrap().push((pattern.into(), out));
    }

    pub fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }

    pub fn inputs(&self) -> Vec<Option<String>> {
        self.inputs.lock().unwrap().clone()
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
        stdin: Option<String>,
        _timeout: Duration,
    ) -> BoxFuture<'_, Output> {
        let out = self.lookup(&argv);
        self.calls.lock().unwrap().push(argv);
        self.inputs.lock().unwrap().push(stdin);
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

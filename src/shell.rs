use futures::future::BoxFuture;
use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
pub use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
    pub timed_out: bool,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.status == Some(0) && !self.timed_out
    }

    pub fn ok_with(stdout: &str) -> Output {
        Output {
            stdout: stdout.into(),
            status: Some(0),
            ..Output::default()
        }
    }

    pub fn failed(status: i32, stderr: &str) -> Output {
        Output {
            stderr: stderr.into(),
            status: Some(status),
            ..Output::default()
        }
    }

    pub fn timeout() -> Output {
        Output {
            timed_out: true,
            ..Output::default()
        }
    }
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

pub fn expand_home(path: &str) -> String {
    format!(
        "p={}; case \"$p\" in \"~\") p=\"$HOME\" ;; \"~/\"*) p=\"$HOME/${{p#\\~/}}\" ;; esac",
        quote(path)
    )
}

pub fn login_shell(cmd: &str) -> String {
    format!(r#"exec "${{SHELL:-/bin/sh}}" -lic {}"#, quote(cmd))
}

pub trait Runner: Send + Sync {
    fn run(
        &self,
        argv: Vec<String>,
        stdin: Option<String>,
        timeout: Duration,
    ) -> BoxFuture<'_, Output>;
    fn spawn(&self, argv: Vec<String>, log: PathBuf) -> std::io::Result<u32>;
    fn alive(&self, pid: u32) -> bool;
    fn kill(&self, pid: u32);
}

#[derive(Default)]
pub struct RealRunner {
    children: Mutex<HashMap<u32, Child>>,
}

fn kill_group(pid: u32, signal: i32) {
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

impl Runner for RealRunner {
    fn run(
        &self,
        argv: Vec<String>,
        stdin: Option<String>,
        timeout: Duration,
    ) -> BoxFuture<'_, Output> {
        Box::pin(async move {
            let Some((program, args)) = argv.split_first() else {
                return Output::failed(127, "empty command");
            };
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(args)
                .stdin(if stdin.is_some() {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0)
                .kill_on_drop(true);
            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(e) => return Output::failed(127, &format!("{program}: {e}")),
            };
            let pid = child.id();
            if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
                tokio::spawn(async move {
                    let _ = pipe.write_all(input.as_bytes()).await;
                });
            }
            match tokio::time::timeout(timeout, child.wait_with_output()).await {
                Ok(Ok(out)) => Output {
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                    status: out.status.code(),
                    timed_out: false,
                },
                Ok(Err(e)) => Output::failed(127, &e.to_string()),
                Err(_) => {
                    if let Some(pid) = pid {
                        kill_group(pid, libc::SIGKILL);
                    }
                    Output::timeout()
                }
            }
        })
    }

    fn spawn(&self, argv: Vec<String>, log: PathBuf) -> std::io::Result<u32> {
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| std::io::Error::other("empty command"))?;
        if let Some(dir) = log.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = std::fs::File::create(&log)?;
        let child = std::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(file.try_clone()?)
            .stderr(file)
            .process_group(0)
            .spawn()?;
        let pid = child.id();
        self.children
            .lock()
            .expect("children lock")
            .insert(pid, child);
        Ok(pid)
    }

    fn alive(&self, pid: u32) -> bool {
        let mut children = self.children.lock().expect("children lock");
        let Some(child) = children.get_mut(&pid) else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            _ => {
                children.remove(&pid);
                false
            }
        }
    }

    fn kill(&self, pid: u32) {
        let Some(mut child) = self.children.lock().expect("children lock").remove(&pid) else {
            return;
        };
        kill_group(pid, libc::SIGTERM);
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for RealRunner {
    fn drop(&mut self) {
        let pids: Vec<u32> = self
            .children
            .lock()
            .map(|c| c.keys().copied().collect())
            .unwrap_or_default();
        for pid in pids {
            self.kill(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn run_captures_stdout() {
        let out = RealRunner::default()
            .run(argv(&["echo", "hi"]), None, Duration::from_secs(2))
            .await;
        assert_eq!(out.stdout, "hi\n");
        assert!(out.ok());
    }

    #[tokio::test]
    async fn run_times_out() {
        let start = Instant::now();
        let out = RealRunner::default()
            .run(argv(&["sleep", "5"]), None, Duration::from_millis(200))
            .await;
        assert!(out.timed_out);
        assert!(!out.ok());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn run_passes_stdin() {
        let out = RealRunner::default()
            .run(argv(&["cat"]), Some("x".into()), Duration::from_secs(2))
            .await;
        assert_eq!(out.stdout, "x");
    }

    #[tokio::test]
    async fn run_missing_binary_reports_error() {
        let out = RealRunner::default()
            .run(
                argv(&["yardbell-no-such-binary"]),
                None,
                Duration::from_secs(2),
            )
            .await;
        assert!(!out.ok());
        assert!(!out.stderr.is_empty());
    }

    #[test]
    fn spawn_alive_kill() {
        let dir = tempfile::tempdir().unwrap();
        let runner = RealRunner::default();
        let pid = runner
            .spawn(argv(&["sleep", "30"]), dir.path().join("s.log"))
            .unwrap();
        assert!(runner.alive(pid));
        runner.kill(pid);
        assert!(!runner.alive(pid));
    }
}

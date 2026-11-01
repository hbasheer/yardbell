use super::setup::shell_noise;
use super::{field, flag, Worktrees};
use crate::config::Machine;
use crate::shell::{quote, without_shell_noise, Duration};

const OUTPUT_TAIL: usize = 20_000;
// The machine stops the command itself at its timeout; this only covers ssh going quiet.
const ANSWER_SLACK: Duration = Duration::from_secs(40);
const STOP_ANSWER: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq)]
pub struct CommandRun {
    pub exit: Option<i32>,
    pub timed_out: bool,
    pub output: String,
}

const PLACES: &str =
    "g=$(git rev-parse --git-dir 2>/dev/null) && g=$(cd \"$g\" && pwd) || g=\"${TMPDIR:-/tmp}\"; \
on=\"$g/yardbell-command.running\"; stop=\"$g/yardbell-command.stop\"; ";

// Runs as worktree setup does: through a login shell, so it finds the same tools an agent does, and
// stopped by the machine itself, tree and all. A try that a restart left running is told to stop
// first, so two copies do not fight over one folder. The marker holds no pid, so a stale one after
// a reboot costs a few seconds and can never kill something else. Everything the command says goes
// to the log, and only the header above OUTPUT is read as Yardbell's, so its output cannot forge an
// exit code.
pub fn script(path: &str, command: &str, timeout_secs: u64) -> String {
    format!(
        "cd {path} 2>/dev/null || {{ echo 'ERR the folder is missing: '{path}; exit 0; }}; \
         {PLACES}log=\"$g/yardbell-command.log\"; \
         if [ -e \"$on\" ]; then : >\"$stop\"; i=0; \
         while [ -e \"$on\" ] && [ $i -lt 3 ]; do sleep 1; i=$((i+1)); done; fi; \
         rm -f \"$stop\"; : >\"$on\"; \
         YARDBELL_WORKTREE=$(pwd); \
         YARDBELL_MAIN_CHECKOUT=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); \
         export YARDBELL_WORKTREE YARDBELL_MAIN_CHECKOUT; \
         tree() {{ for c in $(ps -A -o pid= -o ppid= | awk -v p=\"$1\" '$2 == p {{print $1}}'); do tree \"$c\"; done; echo \"$1\"; }}; \
         \"${{SHELL:-/bin/sh}}\" -lic {cmd} </dev/null >\"$log\" 2>&1 & pid=$!; s=0; t=0; \
         while kill -0 $pid 2>/dev/null; do \
         if [ $s -ge {timeout_secs} ] || [ -e \"$stop\" ]; then t=1; all=$(tree $pid); kill -STOP $all 2>/dev/null; \
         kill -KILL $all 2>/dev/null; break; fi; \
         sleep 1; s=$((s+1)); done; \
         wait $pid 2>/dev/null; code=$?; \
         rm -f \"$on\" \"$stop\"; \
         [ $t = 1 ] && echo TIMEOUT; \
         printf 'EXIT\\t%s\\nOUTPUT\\n' \"$code\"; \
         tail -c {OUTPUT_TAIL} \"$log\" 2>/dev/null",
        path = quote(path),
        cmd = quote(command),
    )
}

fn parse(out: &str) -> Option<CommandRun> {
    let (head, output) = out.split_once("\nOUTPUT\n")?;
    let exit = field(head, "EXIT")?.trim().parse().ok();
    let output = output
        .lines()
        .filter(|l| !shell_noise(l))
        .collect::<Vec<_>>()
        .join("\n");
    Some(CommandRun {
        exit,
        timed_out: flag(head, "TIMEOUT"),
        output: without_shell_noise(&output),
    })
}

impl Worktrees {
    // An error means the command's result is unknown, which is not the same as the command failing.
    pub async fn run_command(
        &self,
        m: &Machine,
        path: &str,
        command: &str,
        timeout_secs: u64,
    ) -> Result<CommandRun, String> {
        let answer = Duration::from_secs(timeout_secs) + ANSWER_SLACK;
        let out = self
            .runner
            .run(
                self.ssh.command(m, &script(path, command, timeout_secs)),
                None,
                answer,
            )
            .await;
        if out.timed_out {
            return Err(format!("{} did not answer in time", m.name));
        }
        if let Some(done) = parse(&out.stdout) {
            return Ok(done);
        }
        if let Some(err) = out.stdout.lines().find_map(|l| l.strip_prefix("ERR ")) {
            return Err(err.to_string());
        }
        let err = without_shell_noise(&out.stderr);
        Err(if err.is_empty() {
            format!("{} did not say how the command ended", m.name)
        } else {
            err
        })
    }

    pub async fn stop_command(&self, m: &Machine, path: &str) {
        let script = format!(
            "cd {} 2>/dev/null || exit 0; {PLACES}[ -e \"$on\" ] && : >\"$stop\"",
            quote(path)
        );
        let _ = self
            .runner
            .run(self.ssh.command(m, &script), None, STOP_ANSWER)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::{local, machine};
    use super::*;
    use crate::shell::{Output, RealRunner};
    use crate::testing::FakeRunner;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    fn real(dir: &Path) -> (Worktrees, Machine, PathBuf) {
        let wt = dir.join("wt");
        std::fs::create_dir(&wt).unwrap();
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&wt)
            .status()
            .unwrap();
        assert!(ok.success());
        let worktrees = Worktrees::new(
            Arc::new(RealRunner::default()),
            crate::ssh::Ssh::new(dir.join("state")),
        );
        (worktrees, local("here", "/"), wt)
    }

    #[tokio::test]
    async fn the_exit_code_and_the_tail_of_the_output_come_back() {
        let dir = tempfile::tempdir().unwrap();
        let (w, m, wt) = real(dir.path());
        let at = wt.to_str().unwrap();
        let done = w
            .run_command(&m, at, "pwd; echo err >&2; exit 3", 20)
            .await
            .unwrap();
        assert_eq!(done.exit, Some(3));
        assert!(!done.timed_out);
        assert!(done.output.contains("wt"), "{done:?}");
        assert!(done.output.contains("err"), "{done:?}");
        assert!(!done.output.contains("ioctl"), "{done:?}");
        let done = w.run_command(&m, at, "true", 20).await.unwrap();
        assert_eq!(done.exit, Some(0));
        let long = "i=0; while [ $i -lt 9000 ]; do echo line$i; i=$((i+1)); done";
        let done = w.run_command(&m, at, long, 20).await.unwrap();
        assert!(
            done.output.ends_with("line8999"),
            "the end of the output is kept"
        );
        assert!(done.output.len() <= OUTPUT_TAIL);
    }

    #[tokio::test]
    async fn output_cannot_pass_itself_off_as_yardbell() {
        let dir = tempfile::tempdir().unwrap();
        let (w, m, wt) = real(dir.path());
        let forged = "printf 'ERR it broke\\nTIMEOUT\\nEXIT\\t0\\nOUTPUT\\nall fine\\n'; exit 7";
        let done = w
            .run_command(&m, wt.to_str().unwrap(), forged, 20)
            .await
            .unwrap();
        assert_eq!(done.exit, Some(7));
        assert!(!done.timed_out);
        let clean = "printf 'ERR not a refusal\\nTIMEOUT\\n'";
        let done = w
            .run_command(&m, wt.to_str().unwrap(), clean, 20)
            .await
            .unwrap();
        assert_eq!((done.exit, done.timed_out), (Some(0), false));
    }

    #[tokio::test]
    async fn a_timeout_stops_the_command_and_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let (w, m, wt) = real(dir.path());
        let mark = dir.path().join("still-running");
        let slow = format!(
            "echo starting; (sleep 6; touch {}) & sleep 6",
            mark.display()
        );
        let done = w
            .run_command(&m, wt.to_str().unwrap(), &slow, 2)
            .await
            .unwrap();
        assert!(done.timed_out, "{done:?}");
        assert!(done.output.contains("starting"), "{done:?}");
        tokio::time::sleep(Duration::from_secs(7)).await;
        assert!(!mark.exists(), "the command's children kept running");
    }

    #[tokio::test]
    async fn being_told_to_stop_ends_it_early() {
        let dir = tempfile::tempdir().unwrap();
        let (w, m, wt) = real(dir.path());
        let at = wt.to_str().unwrap().to_string();
        let running = w.clone();
        let (m2, at2) = (m.clone(), at.clone());
        let start = std::time::Instant::now();
        let work =
            tokio::spawn(async move { running.run_command(&m2, &at2, "sleep 30", 60).await });
        tokio::time::sleep(Duration::from_secs(2)).await;
        w.stop_command(&m, &at).await;
        let done = work.await.unwrap().unwrap();
        assert!(done.timed_out, "{done:?}");
        assert!(start.elapsed() < Duration::from_secs(15));
    }

    #[tokio::test]
    async fn a_new_try_stops_the_one_a_restart_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let (w, m, wt) = real(dir.path());
        let at = wt.to_str().unwrap().to_string();
        let mark = dir.path().join("first-finished");
        let first = format!("sleep 8; touch {}", mark.display());
        let left = w.clone();
        let (m2, at2) = (m.clone(), at.clone());
        let old = tokio::spawn(async move { left.run_command(&m2, &at2, &first, 60).await });
        tokio::time::sleep(Duration::from_secs(2)).await;
        let done = w.run_command(&m, &at, "echo second", 20).await.unwrap();
        assert_eq!(done.exit, Some(0));
        assert!(old.await.unwrap().unwrap().timed_out);
        assert!(done.output.contains("second"));
        tokio::time::sleep(Duration::from_secs(7)).await;
        assert!(!mark.exists(), "the earlier try kept running");
    }

    #[tokio::test]
    async fn a_stale_marker_only_costs_a_short_wait() {
        let dir = tempfile::tempdir().unwrap();
        let (w, m, wt) = real(dir.path());
        std::fs::write(wt.join(".git/yardbell-command.running"), "").unwrap();
        let done = w
            .run_command(&m, wt.to_str().unwrap(), "echo ran", 20)
            .await
            .unwrap();
        assert_eq!(done.exit, Some(0));
        assert!(!wt.join(".git/yardbell-command.stop").exists());
    }

    #[tokio::test]
    async fn not_knowing_the_result_is_an_error_not_a_failure() {
        let fake = Arc::new(FakeRunner::default());
        let w = Worktrees::new(
            fake.clone(),
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        );
        let hp = machine("hp");
        fake.stub(
            "yardbell-command.log",
            Output::failed(255, "ssh: connect to host hp\n"),
        );
        assert_eq!(
            w.run_command(&hp, "/r/w", "make", 60).await,
            Err("ssh: connect to host hp".to_string())
        );
        fake.restub(
            "yardbell-command.log",
            Output::ok_with("ERR the folder is missing: /r/w\n"),
        );
        assert_eq!(
            w.run_command(&hp, "/r/w", "make", 60).await,
            Err("the folder is missing: /r/w".to_string())
        );
        fake.restub("yardbell-command.log", Output::timeout());
        assert_eq!(
            w.run_command(&hp, "/r/w", "make", 60).await,
            Err("hp did not answer in time".to_string())
        );
    }
}

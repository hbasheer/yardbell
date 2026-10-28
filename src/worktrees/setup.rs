use super::{field, flag, Worktrees};
use crate::config::Machine;
use crate::shell::{quote, Duration};
use serde::{Deserialize, Serialize};

pub const DEFAULT_TIMEOUT_SECS: u64 = 300;
pub const MAX_TIMEOUT_SECS: u64 = 3600;
const COMMAND_MAX: usize = 2000;
const OUTPUT_TAIL: usize = 4000;
// The machine stops the command itself at its timeout; this only covers ssh going quiet.
const ANSWER_SLACK: Duration = Duration::from_secs(30);

const ANY: &str = "any";

fn any() -> String {
    ANY.into()
}

fn is_any(machine: &str) -> bool {
    machine == ANY
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

fn is_default_timeout(secs: &u64) -> bool {
    *secs == DEFAULT_TIMEOUT_SECS
}

// What runs in a worktree right after Yardbell creates it, for the repositories whose main
// checkout matches the folder pattern.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorktreeSetup {
    pub folder: String,
    #[serde(default = "any", skip_serializing_if = "is_any")]
    pub machine: String,
    pub command: String,
    #[serde(
        default = "default_timeout",
        skip_serializing_if = "is_default_timeout"
    )]
    pub timeout_seconds: u64,
}

pub fn validate(
    setups: &[WorktreeSetup],
    known_machine: impl Fn(&str) -> bool,
) -> Result<(), String> {
    for (i, s) in setups.iter().enumerate() {
        let n = i + 1;
        if s.folder.trim().is_empty() {
            return Err(format!("worktree setup {n} needs a folder"));
        }
        if s.folder.starts_with('~') {
            return Err(format!(
                "worktree setup {n}: folder {:?} cannot start with ~, use a folder like acme/web or an absolute path",
                s.folder
            ));
        }
        if let Err(e) = crate::dispatch::valid_folder_pattern(&s.folder) {
            return Err(format!(
                "worktree setup {n}: folder {:?} is not a pattern Yardbell can read: {e}",
                s.folder
            ));
        }
        if !is_any(&s.machine) && !known_machine(&s.machine) {
            return Err(format!(
                "worktree setup {n}: machine {:?} is not in Yardbell",
                s.machine
            ));
        }
        if s.command.trim().is_empty() {
            return Err(format!("worktree setup {n} needs a command"));
        }
        if s.command.len() > COMMAND_MAX || s.command.contains('\0') {
            return Err(format!(
                "worktree setup {n}: the command must be under {COMMAND_MAX} characters"
            ));
        }
        if !(1..=MAX_TIMEOUT_SECS).contains(&s.timeout_seconds) {
            return Err(format!(
                "worktree setup {n}: timeout_seconds must be from 1 to {MAX_TIMEOUT_SECS}"
            ));
        }
        if let Some(earlier) = setups[..i]
            .iter()
            .position(|o| o.machine == s.machine && o.folder == s.folder)
        {
            return Err(format!(
                "worktree setups {} and {n} are for the same folder, keep one",
                earlier + 1
            ));
        }
    }
    Ok(())
}

// The setup that names the machine wins, then the one with the longer folder pattern.
pub fn pick<'a>(
    setups: &'a [WorktreeSetup],
    machine: &str,
    folders: &[String],
) -> Option<&'a WorktreeSetup> {
    setups
        .iter()
        .filter(|s| is_any(&s.machine) || s.machine == machine)
        .filter(|s| crate::dispatch::folder_matches(&s.folder, folders))
        .max_by_key(|s| {
            (
                !is_any(&s.machine),
                s.folder.chars().filter(|c| !matches!(c, '*' | '?')).count(),
            )
        })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetupRun {
    pub command: String,
    pub path: String,
    pub ok: bool,
    pub exit: Option<i32>,
    pub timed_out: bool,
    pub seconds: u64,
    pub log: String,
    pub output: String,
}

impl SetupRun {
    pub fn summary(&self) -> String {
        if self.ok {
            return format!("{} finished in {} s", self.command, self.seconds);
        }
        if self.timed_out {
            return format!(
                "{} was stopped after {} s, its timeout",
                self.command, self.seconds
            );
        }
        match self.exit {
            Some(code) => format!("{} failed with exit code {code}", self.command),
            None => format!("{} could not run: {}", self.command, self.output.trim()),
        }
    }

    // Told to the agent, so it knows its folder may be half set up and where to look.
    pub fn note_for_agent(&self) -> Option<String> {
        if self.ok {
            return None;
        }
        let log = if self.log.is_empty() {
            String::new()
        } else {
            format!(" Its output is in {}.", self.log)
        };
        Some(format!(
            "Note from Yardbell: this worktree's setup command did not finish. {}.{log} Finish \
the setup before you rely on it.",
            self.summary()
        ))
    }
}

// The command runs through an interactive login shell, like the agent, so it finds the same
// tools. Such a shell ignores SIGTERM, puts what it runs in process groups of its own and goes on
// to the next command when one is killed, so a timeout freezes the whole tree of processes under
// it, then kills it. Its output goes to a
// log in the worktree's own git folder: kept for later, outside the files git tracks, and gone
// once the worktree is removed.
pub fn script(path: &str, command: &str, timeout_secs: u64) -> String {
    format!(
        "cd {path} 2>/dev/null || {{ echo 'ERR the new worktree is missing: '{path}; exit 0; }}; \
         g=$(git rev-parse --git-dir 2>/dev/null) && g=$(cd \"$g\" && pwd) || g=\"${{TMPDIR:-/tmp}}\"; \
         log=\"$g/yardbell-setup.log\"; printf 'LOG\\t%s\\n' \"$log\"; \
         YARDBELL_WORKTREE=$(pwd); \
         YARDBELL_MAIN_CHECKOUT=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); \
         export YARDBELL_WORKTREE YARDBELL_MAIN_CHECKOUT; \
         tree() {{ for c in $(ps -A -o pid= -o ppid= | awk -v p=\"$1\" '$2 == p {{print $1}}'); do tree \"$c\"; done; echo \"$1\"; }}; \
         \"${{SHELL:-/bin/sh}}\" -lic {cmd} </dev/null >\"$log\" 2>&1 & pid=$!; s=0; t=0; \
         while kill -0 $pid 2>/dev/null; do \
         if [ $s -ge {timeout_secs} ]; then t=1; all=$(tree $pid); kill -STOP $all 2>/dev/null; \
         kill -KILL $all 2>/dev/null; break; fi; \
         sleep 1; s=$((s+1)); done; \
         wait $pid 2>/dev/null; code=$?; \
         [ $t = 1 ] && echo TIMEOUT; \
         printf 'EXIT\\t%s\\nSECONDS\\t%s\\nOUTPUT\\n' \"$code\" \"$s\"; \
         tail -c {OUTPUT_TAIL} \"$log\" 2>/dev/null",
        path = quote(path),
        cmd = quote(command),
    )
}

// What an interactive shell without a terminal says about itself, which is not the command's.
fn shell_noise(line: &str) -> bool {
    line.contains("Inappropriate ioctl for device") || line.contains("no job control")
}

pub fn parse(command: &str, path: &str, out: &str) -> SetupRun {
    let exit = field(out, "EXIT").and_then(|c| c.trim().parse().ok());
    let timed_out = flag(out, "TIMEOUT");
    let output = out
        .split_once("\nOUTPUT\n")
        .map(|(_, tail)| tail)
        .or_else(|| out.strip_prefix("OUTPUT\n"))
        .unwrap_or_default();
    SetupRun {
        command: command.to_string(),
        path: path.to_string(),
        ok: exit == Some(0) && !timed_out,
        exit,
        timed_out,
        seconds: field(out, "SECONDS")
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0),
        log: field(out, "LOG").unwrap_or_default().to_string(),
        output: crate::shell::without_shell_noise(
            &output
                .lines()
                .filter(|l| !shell_noise(l))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    }
}

impl Worktrees {
    pub async fn setup(&self, m: &Machine, path: &str, setup: &WorktreeSetup) -> SetupRun {
        let secs = setup.timeout_seconds.clamp(1, MAX_TIMEOUT_SECS);
        let script = script(path, &setup.command, secs);
        let answer = Duration::from_secs(secs + 3) + ANSWER_SLACK;
        match self.run(m, &script, None, answer).await {
            Ok(out) => parse(&setup.command, path, &out),
            Err(e) => SetupRun {
                command: setup.command.clone(),
                path: path.to_string(),
                ok: false,
                exit: None,
                timed_out: false,
                seconds: 0,
                log: String::new(),
                output: e,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::{local, machine, script as last_script};
    use super::*;
    use crate::shell::{Output, RealRunner};
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    fn setup(folder: &str, machine: &str, command: &str) -> WorktreeSetup {
        WorktreeSetup {
            folder: folder.into(),
            machine: machine.into(),
            command: command.into(),
            timeout_seconds: DEFAULT_TIMEOUT_SECS,
        }
    }

    fn worktrees(fake: Arc<FakeRunner>) -> Worktrees {
        Worktrees::new(
            fake,
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        )
    }

    #[test]
    fn the_most_specific_setup_is_picked() {
        let setups = [
            setup("acme/*", "any", "make"),
            setup("acme/web", "any", "npm ci"),
            setup("acme/web", "hp", "bin/setup"),
        ];
        let web = ["acme/web".to_string(), "/home/u/acme/web".to_string()];
        assert_eq!(pick(&setups, "hp", &web).unwrap().command, "bin/setup");
        assert_eq!(pick(&setups, "mini", &web).unwrap().command, "npm ci");
        let api = ["acme/api".to_string()];
        assert_eq!(pick(&setups, "mini", &api).unwrap().command, "make");
        assert!(pick(&setups, "mini", &["shop".to_string()]).is_none());
    }

    #[test]
    fn setups_are_validated() {
        let known = |m: &str| m == "hp";
        assert!(validate(&[setup("acme/web", "hp", "bin/setup")], known).is_ok());
        let mut slow = setup("web", "any", "x");
        slow.timeout_seconds = 0;
        let cases = [
            (vec![setup("", "any", "x")], "worktree setup 1 needs a folder"),
            (
                vec![setup("~/web", "any", "x")],
                "worktree setup 1: folder \"~/web\" cannot start with ~, use a folder like acme/web or an absolute path",
            ),
            (
                vec![setup("web", "nope", "x")],
                "worktree setup 1: machine \"nope\" is not in Yardbell",
            ),
            (vec![setup("web", "any", " ")], "worktree setup 1 needs a command"),
            (
                vec![slow],
                "worktree setup 1: timeout_seconds must be from 1 to 3600",
            ),
            (
                vec![setup("web", "any", "a"), setup("web", "any", "b")],
                "worktree setups 1 and 2 are for the same folder, keep one",
            ),
        ];
        for (setups, message) in cases {
            assert_eq!(validate(&setups, known), Err(message.to_string()));
        }
    }

    #[tokio::test]
    async fn the_command_runs_in_the_worktree_with_a_timeout_and_a_log() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "yardbell-setup.log",
            Output::ok_with(
                "LOG\t/r/app/.git/worktrees/eng-1/yardbell-setup.log\nEXIT\t0\nSECONDS\t4\nOUTPUT\nadded 120 packages\n",
            ),
        );
        let mut s = setup(
            "app",
            "any",
            "npm ci && cp \"$YARDBELL_MAIN_CHECKOUT/.env\" .",
        );
        s.timeout_seconds = 90;
        let run = worktrees(fake.clone())
            .setup(&machine("hp"), "/r/app-worktrees/eng-1", &s)
            .await;
        assert!(run.ok, "{run:?}");
        assert_eq!(run.output, "added 120 packages");
        assert_eq!(run.log, "/r/app/.git/worktrees/eng-1/yardbell-setup.log");
        assert_eq!(run.summary(), format!("{} finished in 4 s", s.command));
        assert_eq!(run.note_for_agent(), None);
        let sent = last_script(&fake, 0);
        assert!(sent.contains("cd '/r/app-worktrees/eng-1'"), "{sent}");
        assert!(sent.contains("[ $s -ge 90 ]"), "{sent}");
        assert!(
            sent.contains(&quote("npm ci && cp \"$YARDBELL_MAIN_CHECKOUT/.env\" .")),
            "{sent}"
        );
    }

    #[tokio::test]
    async fn a_failed_or_timed_out_setup_says_so() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "yardbell-setup.log",
            Output::ok_with("LOG\t/l\nTIMEOUT\nEXIT\t143\nSECONDS\t300\nOUTPUT\nwaiting for db\n"),
        );
        let run = worktrees(fake.clone())
            .setup(&machine("hp"), "/r/w", &setup("app", "any", "bin/setup"))
            .await;
        assert!(!run.ok && run.timed_out);
        assert_eq!(
            run.summary(),
            "bin/setup was stopped after 300 s, its timeout"
        );
        assert_eq!(
            run.note_for_agent().unwrap(),
            "Note from Yardbell: this worktree's setup command did not finish. bin/setup was \
stopped after 300 s, its timeout. Its output is in /l. Finish the setup before you rely on it."
        );
        fake.restub(
            "yardbell-setup.log",
            Output::ok_with("LOG\t/l\nEXIT\t2\nSECONDS\t1\nOUTPUT\nmake: *** no rule\n"),
        );
        let run = worktrees(fake.clone())
            .setup(&machine("hp"), "/r/w", &setup("app", "any", "make"))
            .await;
        assert_eq!(run.summary(), "make failed with exit code 2");
        fake.restub("yardbell-setup.log", Output::timeout());
        let run = worktrees(fake)
            .setup(&machine("hp"), "/r/w", &setup("app", "any", "make"))
            .await;
        assert!(!run.ok);
        assert_eq!(run.output, "hp did not answer in time");
    }

    #[tokio::test]
    async fn a_real_timeout_stops_the_command_and_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir(&wt).unwrap();
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&wt)
            .status()
            .unwrap();
        assert!(ok.success());
        let marker = dir.path().join("still-running");
        let worktrees = Worktrees::new(
            Arc::new(RealRunner::default()),
            crate::ssh::Ssh::new(dir.path().join("state")),
        );
        let mut slow = setup(
            "x",
            "any",
            &format!(
                "echo starting; (sleep 4; touch {}) & sleep 3; echo still running",
                marker.display()
            ),
        );
        slow.timeout_seconds = 1;
        let m = local("here", "/");
        let run = worktrees.setup(&m, wt.to_str().unwrap(), &slow).await;
        assert!(run.timed_out, "{run:?}");
        assert!(run.output.contains("starting"), "{run:?}");
        assert!(!run.output.contains("still running"), "{run:?}");
        assert!(!run.output.contains("ioctl"), "{run:?}");
        assert!(std::path::Path::new(&run.log).exists());
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!marker.exists(), "the command's children kept running");
        let quick = setup("x", "any", "echo done; exit 3");
        let run = worktrees.setup(&m, wt.to_str().unwrap(), &quick).await;
        assert_eq!(run.exit, Some(3));
        assert!(run.output.contains("done"), "{run:?}");
    }
}

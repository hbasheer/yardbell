use crate::agents::Agent;
use crate::config::{HostTerminal, Machine};
use crate::shell::{expand_home, login_shell, quote, without_shell_noise, Duration, Runner};
use crate::ssh::Ssh;
use std::sync::Arc;

const ACTION_TIMEOUT: Duration = Duration::from_secs(10);

pub fn session_name(machine: &str, ticket: &str, folder: &str) -> String {
    let base = if ticket == "-" { folder } else { ticket };
    format!("{machine}-{base}")
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn exact(name: &str) -> String {
    format!("={name}")
}

pub fn applescript(term: HostTerminal, argv: &[String]) -> Option<String> {
    let cmd: Vec<String> = argv.iter().map(|a| quote(a)).collect();
    let cmd = cmd.join(" ").replace('\\', "\\\\").replace('"', "\\\"");
    match term {
        HostTerminal::Iterm2 => Some(format!(
            r#"tell application "iTerm2" to create window with default profile command "{cmd}""#
        )),
        HostTerminal::Terminal => Some(format!(
            r#"tell application "Terminal" to do script "{cmd}""#
        )),
        HostTerminal::None => None,
    }
}

// tmux new succeeds even when the agent's command is missing or exits at once, and the
// session is then gone before anyone attaches, so both cases are checked here.
fn start_script(m: &Machine, name: &str, folder_path: &str, run: &str, agent: &Agent) -> String {
    let program = run.split_whitespace().next().unwrap_or_default();
    let missing = quote(&format!(
        "{} is not installed on {}",
        agent.display(),
        m.name
    ));
    let stopped = quote(&format!(
        "{} stopped as soon as it started on {}",
        agent.display(),
        m.name
    ));
    format!(
        "command -v {} >/dev/null 2>&1 || {{ echo {missing} >&2; exit 127; }}; \
         tmux new -d -s {} -c {} {} || exit $?; \
         sleep 1; \
         tmux has-session -t {} 2>/dev/null || {{ echo {stopped} >&2; exit 1; }}",
        quote(program),
        quote(name),
        quote(folder_path),
        quote(run),
        quote(&exact(name)),
    )
}

pub struct Sessions {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
}

impl Sessions {
    pub fn new(runner: Arc<dyn Runner>, ssh: Ssh) -> Sessions {
        Sessions { runner, ssh }
    }

    pub async fn create(
        &self,
        m: &Machine,
        folder_path: &str,
        ticket: &str,
        folder_label: &str,
        agent: &Agent,
        resume: bool,
    ) -> Result<String, String> {
        let name = session_name(&m.name, ticket, folder_label);
        let run = if resume {
            &agent.resume
        } else {
            &agent.command
        };
        let script = start_script(m, &name, folder_path, run, agent);
        self.exec(m, &login_shell(&script)).await.map(|_| name)
    }

    pub async fn stop(&self, m: &Machine, name: &str) -> Result<(), String> {
        self.exec(m, &format!("tmux kill-session -t {}", quote(&exact(name))))
            .await
    }

    pub async fn open_shell(&self, m: &Machine) -> Result<String, String> {
        let name = session_name(&m.name, "-", "shell");
        let cmd = format!(
            "{}; tmux has-session -t {} 2>/dev/null || tmux new -d -s {} -c \"$p\"",
            expand_home(&m.root),
            quote(&exact(&name)),
            quote(&name)
        );
        self.exec(m, &cmd).await.map(|_| name)
    }

    pub async fn stop_pid(&self, m: &Machine, pid: u32) -> Result<(), String> {
        let cmd = format!(
            "kill {pid} 2>/dev/null; i=0; while [ $i -lt 32 ]; do kill -0 {pid} 2>/dev/null || exit 0; sleep 0.25; i=$((i+1)); done; echo 'the agent is still running after 8 seconds' >&2; exit 1"
        );
        self.exec(m, &cmd).await
    }

    async fn exec(&self, m: &Machine, cmd: &str) -> Result<(), String> {
        let out = self
            .runner
            .run(self.ssh.command(m, cmd), None, ACTION_TIMEOUT)
            .await;
        if out.ok() {
            return Ok(());
        }
        if out.timed_out {
            return Err(format!("{} did not answer in time", m.name));
        }
        Err(without_shell_noise(&out.stderr))
    }

    pub fn attach_argv(&self, m: &Machine, name: &str) -> Vec<String> {
        // The browser terminal is always UTF-8, but ssh and login services often start without
        // a locale, and tmux then draws "_" for every non-ASCII character unless told with -u.
        if m.is_local() {
            return [
                "tmux",
                "-u",
                "-T",
                "clipboard",
                "attach",
                "-t",
                &exact(name),
                ";",
                "set-option",
                "-w",
                "window-size",
                "latest",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
        }
        let remote = format!(
            r"tmux -u -T clipboard attach -t {} \; set-option -w window-size latest",
            quote(&exact(name))
        );
        self.ssh.tty_command(m, &remote)
    }

    pub async fn open_on_host(&self, term: HostTerminal, argv: &[String]) -> Result<(), String> {
        let unavailable = || "not available on this host".to_string();
        if !cfg!(target_os = "macos") {
            return Err(unavailable());
        }
        let script = applescript(term, argv).ok_or_else(unavailable)?;
        let out = self
            .runner
            .run(
                vec!["osascript".into(), "-e".into(), script],
                None,
                ACTION_TIMEOUT,
            )
            .await;
        if out.ok() {
            Ok(())
        } else {
            Err(out.stderr.trim().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;

    fn machine(local: bool) -> Machine {
        Machine {
            name: "hp".into(),
            ssh: Some("hp".into()),
            mesh_ip: None,
            port_prefix: if local { None } else { Some(1) },
            root: "/r".into(),
            local,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        }
    }

    fn sessions(fake: Arc<FakeRunner>) -> Sessions {
        Sessions::new(fake, Ssh::new(tempfile::tempdir().unwrap().keep()))
    }

    #[test]
    fn session_name_cases() {
        assert_eq!(session_name("mini", "-", "app3"), "mini-app3");
        assert_eq!(session_name("hp", "ENG-1301", "slot2"), "hp-eng-1301");
        assert_eq!(session_name("hp", "-", "other/x.y"), "hp-other-x-y");
    }

    #[tokio::test]
    async fn create_runs_tmux_new_with_quoted_folder() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("tmux new", Output::ok_with(""));
        let name = sessions(fake.clone())
            .create(
                &machine(false),
                "/r/my slots/slot2",
                "ENG-1301",
                "slot2",
                &claude(),
                false,
            )
            .await
            .unwrap();
        assert_eq!(name, "hp-eng-1301");
        let call = fake.calls().pop().unwrap();
        assert_eq!(call[0], "ssh");
        let script = start_script(
            &machine(false),
            "hp-eng-1301",
            "/r/my slots/slot2",
            "claude",
            &claude(),
        );
        assert_eq!(
            *call.last().unwrap(),
            format!(
                "{}{}",
                crate::ssh::REMOTE_PATH,
                crate::shell::login_shell(&script)
            )
        );
    }

    #[test]
    fn the_start_script_checks_the_agent_before_and_after_starting_it() {
        assert_eq!(
            start_script(
                &machine(false),
                "hp-app",
                "/r/my app",
                "claude --continue",
                &claude()
            ),
            "command -v 'claude' >/dev/null 2>&1 || { echo 'Claude Code is not installed on hp' >&2; exit 127; }; \
             tmux new -d -s 'hp-app' -c '/r/my app' 'claude --continue' || exit $?; \
             sleep 1; \
             tmux has-session -t '=hp-app' 2>/dev/null || { echo 'Claude Code stopped as soon as it started on hp' >&2; exit 1; }"
        );
    }

    #[tokio::test]
    async fn a_missing_agent_reports_that_it_is_not_installed() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "tmux new",
            Output::failed(127, "Claude Code is not installed on hp\n"),
        );
        let err = sessions(fake)
            .create(&machine(false), "/r/app", "-", "app", &claude(), false)
            .await
            .unwrap_err();
        assert_eq!(err, "Claude Code is not installed on hp");
    }

    fn claude() -> Agent {
        crate::agents::builtin().remove(0)
    }

    fn last_command(fake: &FakeRunner) -> String {
        fake.calls().pop().unwrap().last().unwrap().clone()
    }

    #[tokio::test]
    async fn resume_uses_the_agents_resume_command() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("tmux new", Output::ok_with(""));
        sessions(fake.clone())
            .create(&machine(false), "/r/app", "-", "app", &claude(), true)
            .await
            .unwrap();
        assert!(last_command(&fake).contains(r"'\''claude --continue'\'' || exit $?"));
    }

    #[tokio::test]
    async fn starts_the_chosen_agent() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("tmux new", Output::ok_with(""));
        let codex = crate::agents::builtin()
            .into_iter()
            .find(|a| a.name == "codex")
            .unwrap();
        let s = sessions(fake.clone());
        s.create(&machine(false), "/r/app", "-", "app", &codex, false)
            .await
            .unwrap();
        assert!(last_command(&fake).contains(r"'\''codex'\'' || exit $?"));
        s.create(&machine(false), "/r/app", "-", "app", &codex, true)
            .await
            .unwrap();
        assert!(last_command(&fake).contains(r"'\''codex resume --last'\'' || exit $?"));
    }

    #[tokio::test]
    async fn open_shell_reuses_or_starts_a_plain_tmux_session_in_the_root() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("tmux", Output::ok_with(""));
        let mut m = machine(false);
        m.root = "~/code".into();
        let name = sessions(fake.clone()).open_shell(&m).await.unwrap();
        assert_eq!(name, "hp-shell");
        let cmd = last_command(&fake);
        assert!(cmd.contains(r#"p='~/code'; case "$p" in"#), "{cmd}");
        assert!(
            cmd.ends_with(r#"tmux has-session -t '=hp-shell' 2>/dev/null || tmux new -d -s 'hp-shell' -c "$p""#),
            "{cmd}"
        );
    }

    #[tokio::test]
    async fn stop_pid_waits_for_the_process_to_exit() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("kill ", Output::ok_with(""));
        sessions(fake.clone())
            .stop_pid(&machine(false), 4242)
            .await
            .unwrap();
        let cmd = last_command(&fake);
        assert!(cmd.contains("kill 4242"), "{cmd}");
        assert!(cmd.contains("kill -0 4242"), "{cmd}");
        assert!(cmd.contains("still running"), "{cmd}");
    }

    #[tokio::test]
    async fn create_duplicate_returns_stderr() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("tmux new", Output::failed(1, "duplicate session: hp-app"));
        let err = sessions(fake)
            .create(&machine(false), "/r/app", "-", "app", &claude(), false)
            .await
            .unwrap_err();
        assert_eq!(err, "duplicate session: hp-app");
    }

    #[tokio::test]
    async fn stop_kills_session() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("kill-session", Output::ok_with(""));
        sessions(fake.clone())
            .stop(&machine(false), "hp-app")
            .await
            .unwrap();
        assert_eq!(
            fake.calls().pop().unwrap().last().unwrap(),
            r#"PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"; export PATH; tmux kill-session -t '=hp-app'"#
        );
    }

    #[test]
    fn attach_argv_remote_and_local() {
        let s = sessions(Arc::new(FakeRunner::default()));
        let remote = s.attach_argv(&machine(false), "hp-app");
        assert_eq!(remote[0], "ssh");
        assert_eq!(remote[1], "-t");
        assert_eq!(
            remote.last().unwrap(),
            r#"PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"; export PATH; tmux -u -T clipboard attach -t '=hp-app' \; set-option -w window-size latest"#
        );
        assert_eq!(
            s.attach_argv(&machine(true), "hp-app"),
            vec![
                "tmux",
                "-u",
                "-T",
                "clipboard",
                "attach",
                "-t",
                "=hp-app",
                ";",
                "set-option",
                "-w",
                "window-size",
                "latest"
            ]
        );
    }

    #[test]
    fn host_terminal_escapes_quotes() {
        let argv: Vec<String> = vec![
            "ssh".into(),
            "-t".into(),
            "hp".into(),
            "tmux attach -t 'a\"b'".into(),
        ];
        let script = applescript(HostTerminal::Iterm2, &argv).unwrap();
        assert_eq!(
            script,
            r#"tell application "iTerm2" to create window with default profile command "'ssh' '-t' 'hp' 'tmux attach -t '\\''a\"b'\\'''""#
        );
        let term = applescript(HostTerminal::Terminal, &argv).unwrap();
        assert!(term.starts_with(r#"tell application "Terminal" to do script ""#));
        assert!(applescript(HostTerminal::None, &argv).is_none());
    }

    #[tokio::test]
    async fn host_terminal_none_errors() {
        let s = sessions(Arc::new(FakeRunner::default()));
        let err = s
            .open_on_host(HostTerminal::None, &["true".into()])
            .await
            .unwrap_err();
        assert_eq!(err, "not available on this host");
    }
}

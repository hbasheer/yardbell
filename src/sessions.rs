use crate::agents::Agent;
use crate::config::{HostTerminal, Machine};
use crate::shell::{expand_home, login_shell, quote, without_shell_noise, Duration, Runner};
use crate::ssh::Ssh;
use crate::viewers::Plan;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
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

#[derive(Clone, Copy)]
pub enum Start<'a> {
    New,
    Resume,
    Task(&'a str),
}

pub struct Launch<'a> {
    pub folder_path: &'a str,
    pub ticket: &'a str,
    pub folder_label: &'a str,
    pub agent: &'a Agent,
    pub start: Start<'a>,
    pub mcp_config: Option<&'a str>,
}

fn exact(name: &str) -> String {
    format!("={name}")
}

const MAX_WHEELS: u32 = 200;

// Agents draw on tmux's alternate screen, so the browser terminal has no scrollback of its own.
// A program that keeps its own screen and takes the mouse, like Claude Code's full-screen mode,
// leaves tmux no history to scroll, so it gets wheel events instead. Anything else scrolls tmux's
// history in copy mode, and -e leaves copy mode once scrolled back to the bottom.
fn scroll_command(name: &str, lines: i32) -> String {
    let target = quote(&format!("{}:", exact(name)));
    let copy_mode = if lines < 0 {
        format!(
            r"tmux copy-mode -e -t {target} \; send-keys -X -t {target} -N {} scroll-up",
            lines.unsigned_abs()
        )
    } else {
        format!("tmux send-keys -X -t {target} -N {lines} scroll-down")
    };
    let button = if lines < 0 { 64 } else { 65 };
    let wheels = lines.unsigned_abs().min(MAX_WHEELS);
    format!(
        "set -- $(tmux display -p -t {target} '#{{alternate_on}}#{{mouse_any_flag}}#{{mouse_sgr_flag}} #{{pane_height}}'); \
         if [ \"$1\" = 111 ]; then \
         r=$(( ${{2:-2}} / 2 )); w=''; i=0; \
         while [ $i -lt {wheels} ]; do w=\"$w$(printf '\\033[<{button};1;%sM' \"$r\")\"; i=$((i+1)); done; \
         tmux send-keys -t {target} -l \"$w\"; \
         else {copy_mode}; fi"
    )
}

fn installed_script(agents: &[Agent]) -> String {
    let mut script = String::new();
    for agent in agents {
        let program = agent.command.split_whitespace().next().unwrap_or_default();
        script.push_str(&format!(
            "command -v {} >/dev/null 2>&1 && echo {}; ",
            quote(program),
            quote(&format!("agent {}", agent.name))
        ));
    }
    script.push_str("true");
    script
}

fn size_command(name: &str, plan: &Plan) -> String {
    let session = quote(&format!("{}:", exact(name)));
    let flags = plan
        .owner
        .iter()
        .map(|id| (id, "!ignore-size"))
        .chain(plan.ignored.iter().map(|id| (id, "ignore-size")));
    let mut script = String::new();
    for (id, flag) in flags {
        script.push_str(&format!(
            "c=$(tmux list-clients -F '#{{client_pid}} #{{client_name}}' | awk -v p=\"$(tmux show -qv -t {session} @yb_{id})\" '$1 == p {{print $2}}'); \
             [ -n \"$c\" ] && tmux refresh-client -t \"$c\" -f '{flag}'; "
        ));
    }
    script.push_str("true");
    script
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
    let name = quote(name);
    format!(
        "command -v {} >/dev/null 2>&1 || {{ echo {missing} >&2; exit 127; }}; \
         n={name}; i=2; \
         while tmux has-session -t \"=$n\" 2>/dev/null; do n={name}-$i; i=$((i+1)); done; \
         tmux new -d -s \"$n\" -c {} {} || exit $?; \
         sleep 1; \
         tmux has-session -t \"=$n\" 2>/dev/null || {{ echo {stopped} >&2; exit 1; }}; \
         echo \"$n\"",
        quote(program),
        quote(folder_path),
        quote(run),
    )
}

// The config holds MCP servers' tokens, so it goes on stdin into a file only the account can
// read, never on a command line, which ps shows to every account. Named after its contents, so
// sessions with the same servers share a file and two Yardbell servers never overwrite each
// other's. Every start rewrites it, and files from an older config go after 30 days.
fn mcp_config_script(config: &str) -> String {
    let mut hasher = DefaultHasher::new();
    config.hash(&mut hasher);
    format!(
        "umask 077; d=\"${{XDG_CACHE_HOME:-$HOME/.cache}}/yardbell/mcp\"; f=\"$d/mcp-{:016x}.json\"; \
         {{ mkdir -p \"$d\" && chmod 700 \"$d\" && cat > \"$f.$$\" && mv -f \"$f.$$\" \"$f\"; }} || {{ rm -f \"$f.$$\"; exit 1; }}; \
         find \"$d\" -name 'mcp-*.json' -mtime +30 -exec rm -f '{{}}' + 2>/dev/null; \
         echo \"$f\"",
        hasher.finish()
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

    pub async fn create(&self, m: &Machine, launch: Launch<'_>) -> Result<String, String> {
        let Launch {
            folder_path,
            ticket,
            folder_label,
            agent,
            start,
            mcp_config,
        } = launch;
        let name = session_name(&m.name, ticket, folder_label);
        let mut run = match start {
            Start::New => agent.command.clone(),
            Start::Resume => agent.resume.clone(),
            Start::Task(prompt) => agent.with_prompt(prompt)?,
        };
        // --mcp-config takes several values, so it goes last or it would swallow the task.
        if let Some(config) = mcp_config {
            let file = self.write_mcp_config(m, config).await?;
            run = format!("{run} --mcp-config {}", quote(&file));
        }
        let script = start_script(m, &name, folder_path, &run, agent);
        let out = self.output(m, &login_shell(&script)).await?;
        let started = out.lines().map(str::trim).rfind(|line| !line.is_empty());
        Ok(started.map_or(name, str::to_string))
    }

    async fn write_mcp_config(&self, m: &Machine, config: &str) -> Result<String, String> {
        let failed = format!("cannot write the MCP config on {}", m.name);
        let out = self
            .output_with_input(m, &mcp_config_script(config), Some(config.to_string()))
            .await
            .map_err(|e| match e.trim() {
                "" => failed.clone(),
                e => format!("{failed}: {e}"),
            })?;
        out.lines()
            .map(str::trim)
            .rfind(|line| line.starts_with('/'))
            .map(str::to_string)
            .ok_or(failed)
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
        // An agent suspended with Ctrl+Z only acts on SIGTERM once it is continued.
        let cmd = format!(
            "kill {pid} 2>/dev/null; kill -CONT {pid} 2>/dev/null; i=0; while [ $i -lt 32 ]; do kill -0 {pid} 2>/dev/null || exit 0; sleep 0.25; i=$((i+1)); done; echo 'the agent is still running after 8 seconds' >&2; exit 1"
        );
        self.exec(m, &cmd).await
    }

    pub async fn read(&self, m: &Machine, name: &str, lines: u32) -> Result<String, String> {
        self.output(
            m,
            &format!(
                "tmux capture-pane -p -J -t {} -S -{lines}",
                quote(&format!("{}:", exact(name)))
            ),
        )
        .await
    }

    pub async fn send(&self, m: &Machine, name: &str, text: &str) -> Result<(), String> {
        let target = quote(&format!("{}:", exact(name)));
        let cmd = format!(
            "tmux send-keys -t {target} -l {} && sleep 0.2 && tmux send-keys -t {target} Enter",
            quote(text)
        );
        self.exec(m, &cmd).await
    }

    // Keys typed as they are, without Enter, for picking an agent's numbered choice.
    pub async fn send_keys(&self, m: &Machine, name: &str, keys: &str) -> Result<(), String> {
        let target = quote(&format!("{}:", exact(name)));
        self.exec(m, &format!("tmux send-keys -t {target} -l {}", quote(keys)))
            .await
    }

    pub async fn scroll(&self, m: &Machine, name: &str, lines: i32) -> Result<(), String> {
        self.exec(m, &scroll_command(name, lines)).await
    }

    pub async fn leave_copy_mode(&self, m: &Machine, name: &str) -> Result<(), String> {
        let target = quote(&format!("{}:", exact(name)));
        let cmd = format!("tmux send-keys -X -t {target} cancel 2>/dev/null || true");
        self.exec(m, &cmd).await
    }

    async fn exec(&self, m: &Machine, cmd: &str) -> Result<(), String> {
        self.output(m, cmd).await.map(|_| ())
    }

    async fn output(&self, m: &Machine, cmd: &str) -> Result<String, String> {
        self.output_with_input(m, cmd, None).await
    }

    async fn output_with_input(
        &self,
        m: &Machine,
        cmd: &str,
        input: Option<String>,
    ) -> Result<String, String> {
        let out = self
            .runner
            .run(self.ssh.command(m, cmd), input, ACTION_TIMEOUT)
            .await;
        if out.ok() {
            return Ok(out.stdout);
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

    // The client records its own process id first: exec keeps it, so the server can later find
    // this viewer among the session's tmux clients, also through ssh.
    pub fn viewer_argv(&self, m: &Machine, name: &str, viewer: &str) -> Vec<String> {
        let session = quote(&format!("{}:", exact(name)));
        let script = format!(
            r#"tmux set -q -t {session} @yb_{viewer} "$$"; exec tmux -u -T clipboard attach -t {session} \; set-option -w window-size latest"#
        );
        self.ssh.tty_command(m, &script)
    }

    pub async fn installed_agents(
        &self,
        m: &Machine,
        agents: &[Agent],
    ) -> Result<Vec<String>, String> {
        let out = self
            .output(m, &login_shell(&installed_script(agents)))
            .await?;
        Ok(out
            .lines()
            .filter_map(|line| line.trim().strip_prefix("agent "))
            .map(str::to_string)
            .collect())
    }

    pub async fn size_viewers(&self, m: &Machine, name: &str, plan: &Plan) -> Result<(), String> {
        self.exec(m, &size_command(name, plan)).await
    }

    pub async fn forget_viewer(&self, m: &Machine, name: &str, viewer: &str) -> Result<(), String> {
        let session = quote(&format!("{}:", exact(name)));
        self.exec(
            m,
            &format!("tmux set -qu -t {session} @yb_{viewer} 2>/dev/null || true"),
        )
        .await
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
                Launch {
                    folder_path: "/r/my slots/slot2",
                    ticket: "ENG-1301",
                    folder_label: "slot2",
                    agent: &claude(),
                    start: Start::New,
                    mcp_config: None,
                },
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
             n='hp-app'; i=2; \
             while tmux has-session -t \"=$n\" 2>/dev/null; do n='hp-app'-$i; i=$((i+1)); done; \
             tmux new -d -s \"$n\" -c '/r/my app' 'claude --continue' || exit $?; \
             sleep 1; \
             tmux has-session -t \"=$n\" 2>/dev/null || { echo 'Claude Code stopped as soon as it started on hp' >&2; exit 1; }; \
             echo \"$n\""
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
            .create(
                &machine(false),
                Launch {
                    folder_path: "/r/app",
                    ticket: "-",
                    folder_label: "app",
                    agent: &claude(),
                    start: Start::New,
                    mcp_config: None,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(err, "Claude Code is not installed on hp");
    }

    #[tokio::test]
    async fn a_task_is_passed_to_the_agent_when_it_starts() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("tmux new", Output::ok_with(""));
        sessions(fake.clone())
            .create(
                &machine(false),
                Launch {
                    folder_path: "/r/app",
                    ticket: "-",
                    folder_label: "app",
                    agent: &claude(),
                    start: Start::Task("fix login"),
                    mcp_config: None,
                },
            )
            .await
            .unwrap();
        let script = start_script(
            &machine(false),
            "hp-app",
            "/r/app",
            "claude 'fix login'",
            &claude(),
        );
        assert_eq!(
            last_command(&fake),
            format!(
                "{}{}",
                crate::ssh::REMOTE_PATH,
                crate::shell::login_shell(&script)
            )
        );
    }

    const MCP_CONFIG: &str = r#"{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp","headers":{"Authorization":"Bearer lin_api_secret"}}}}"#;

    fn task_with_mcp(agent: &Agent) -> Launch<'_> {
        Launch {
            folder_path: "/r/app",
            ticket: "-",
            folder_label: "app",
            agent,
            start: Start::Task("fix login"),
            mcp_config: Some(MCP_CONFIG),
        }
    }

    #[tokio::test]
    async fn the_mcp_config_goes_on_stdin_and_only_its_path_after_the_task() {
        for local in [true, false] {
            let fake = Arc::new(FakeRunner::default());
            fake.stub("tmux new", Output::ok_with(""));
            fake.stub(
                "yardbell/mcp",
                Output::ok_with("/home/u/.cache/yardbell/mcp/mcp-1.json\n"),
            );
            sessions(fake.clone())
                .create(&machine(local), task_with_mcp(&claude()))
                .await
                .unwrap();
            for call in fake.calls() {
                assert!(!call.join(" ").contains("lin_api_secret"), "{call:?}");
            }
            assert_eq!(fake.inputs(), vec![Some(MCP_CONFIG.to_string()), None]);
            let script = start_script(
                &machine(local),
                "hp-app",
                "/r/app",
                "claude 'fix login' --mcp-config '/home/u/.cache/yardbell/mcp/mcp-1.json'",
                &claude(),
            );
            assert!(last_command(&fake).ends_with(&crate::shell::login_shell(&script)));
        }
    }

    #[tokio::test]
    async fn a_session_does_not_start_when_its_mcp_config_cannot_be_written() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "yardbell/mcp",
            Output::failed(1, "mkdir: cannot create directory: Permission denied\n"),
        );
        let err = sessions(fake.clone())
            .create(&machine(false), task_with_mcp(&claude()))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            "cannot write the MCP config on hp: mkdir: cannot create directory: Permission denied"
        );
        assert_eq!(fake.calls().len(), 1);
    }

    #[test]
    fn the_mcp_config_file_is_readable_only_by_the_account() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let cache = tempfile::tempdir().unwrap();
        let dir = cache.path().join("yardbell/mcp");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let stale = dir.join("mcp-0000000000000000.json");
        std::fs::File::create(&stale)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - Duration::from_secs(40 * 24 * 3600))
            .unwrap();
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("umask 000; {}", mcp_config_script(MCP_CONFIG)))
            .env("XDG_CACHE_HOME", cache.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(MCP_CONFIG.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        let file = std::path::PathBuf::from(String::from_utf8(out.stdout).unwrap().trim());
        assert_eq!(file.parent().unwrap(), dir);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), MCP_CONFIG);
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&dir), 0o700);
        assert!(!stale.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn read_captures_the_pane_and_send_types_then_presses_enter() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("capture-pane", Output::ok_with("line 1\nline 2\n"));
        fake.stub("send-keys", Output::ok_with(""));
        let s = sessions(fake.clone());
        let text = s.read(&machine(false), "hp-app", 50).await.unwrap();
        assert_eq!(text, "line 1\nline 2\n");
        assert!(last_command(&fake).contains("tmux capture-pane -p -J -t '=hp-app:' -S -50"));
        s.send(&machine(false), "hp-app", "yes, it's fine")
            .await
            .unwrap();
        assert!(last_command(&fake).contains(
            r"tmux send-keys -t '=hp-app:' -l 'yes, it'\''s fine' && sleep 0.2 && tmux send-keys -t '=hp-app:' Enter"
        ));
    }

    #[tokio::test]
    async fn stop_pid_ends_an_agent_suspended_with_ctrl_z() {
        // Started through a shell that exits at once, like an agent in its own terminal, so the
        // test process is not its parent and it does not linger as a zombie.
        let out = std::process::Command::new("bash")
            .args(["-c", "sleep 300 >/dev/null 2>&1 & echo $!"])
            .output()
            .unwrap();
        let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let stopped = std::process::Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .unwrap();
        assert!(stopped.success());
        let real = Sessions::new(
            Arc::new(crate::shell::RealRunner::default()),
            Ssh::new(tempfile::tempdir().unwrap().keep()),
        );
        let started = std::time::Instant::now();
        real.stop_pid(&machine(true), pid).await.unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
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
            .create(
                &machine(false),
                Launch {
                    folder_path: "/r/app",
                    ticket: "-",
                    folder_label: "app",
                    agent: &claude(),
                    start: Start::Resume,
                    mcp_config: None,
                },
            )
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
        s.create(
            &machine(false),
            Launch {
                folder_path: "/r/app",
                ticket: "-",
                folder_label: "app",
                agent: &codex,
                start: Start::New,
                mcp_config: None,
            },
        )
        .await
        .unwrap();
        assert!(last_command(&fake).contains(r"'\''codex'\'' || exit $?"));
        s.create(
            &machine(false),
            Launch {
                folder_path: "/r/app",
                ticket: "-",
                folder_label: "app",
                agent: &codex,
                start: Start::Resume,
                mcp_config: None,
            },
        )
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
    async fn create_takes_the_next_free_name_when_the_folder_has_a_session() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("tmux new", Output::ok_with("motd line\nhp-app-2\n"));
        let name = sessions(fake.clone())
            .create(
                &machine(false),
                Launch {
                    folder_path: "/r/app",
                    ticket: "-",
                    folder_label: "app",
                    agent: &claude(),
                    start: Start::New,
                    mcp_config: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(name, "hp-app-2");
        let cmd = last_command(&fake);
        assert!(cmd.contains("while tmux has-session"), "{cmd}");
    }

    #[tokio::test]
    async fn create_failure_returns_stderr() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("tmux new", Output::failed(1, "duplicate session: hp-app"));
        let err = sessions(fake)
            .create(
                &machine(false),
                Launch {
                    folder_path: "/r/app",
                    ticket: "-",
                    folder_label: "app",
                    agent: &claude(),
                    start: Start::New,
                    mcp_config: None,
                },
            )
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
    fn scroll_sends_wheels_to_mouse_programs_and_copy_mode_otherwise() {
        let up = scroll_command("hp-app", -3);
        assert!(
            up.contains("'#{alternate_on}#{mouse_any_flag}#{mouse_sgr_flag} #{pane_height}'"),
            "{up}"
        );
        assert!(up.contains("while [ $i -lt 3 ]"), "{up}");
        assert!(up.contains(r"\033[<64;1;%sM"), "{up}");
        assert!(
            up.ends_with(r"else tmux copy-mode -e -t '=hp-app:' \; send-keys -X -t '=hp-app:' -N 3 scroll-up; fi"),
            "{up}"
        );
        let down = scroll_command("hp-app", 5);
        assert!(down.contains(r"\033[<65;1;%sM"), "{down}");
        assert!(
            down.ends_with("else tmux send-keys -X -t '=hp-app:' -N 5 scroll-down; fi"),
            "{down}"
        );
        assert!(scroll_command("hp-app", -900).contains("while [ $i -lt 200 ]"));
    }

    #[test]
    fn installed_script_checks_each_agent_program() {
        let script = installed_script(&[claude()]);
        assert_eq!(
            script,
            "command -v 'claude' >/dev/null 2>&1 && echo 'agent claude'; true"
        );
    }

    #[test]
    fn size_command_frees_the_owner_and_ignores_the_rest() {
        let plan = Plan {
            owner: Some("aa".into()),
            ignored: vec!["bb".into()],
        };
        let cmd = size_command("hp-app", &plan);
        let owner = cmd.find("@yb_aa").unwrap();
        let other = cmd.find("@yb_bb").unwrap();
        assert!(owner < other, "{cmd}");
        assert!(cmd.contains("tmux show -qv -t '=hp-app:' @yb_aa"), "{cmd}");
        assert!(cmd.contains("-f '!ignore-size'; c=$("), "{cmd}");
        assert!(cmd.ends_with("-f 'ignore-size'; true"), "{cmd}");
        assert_eq!(size_command("hp-app", &Plan::default()), "true");
    }

    #[test]
    fn a_viewer_records_its_client_pid_before_attaching() {
        let s = sessions(Arc::new(FakeRunner::default()));
        let local = s.viewer_argv(&machine(true), "hp-app", "ab12");
        assert_eq!(local[..2], ["bash", "-c"]);
        assert!(
            local[2].starts_with(r#"tmux set -q -t '=hp-app:' @yb_ab12 "$$"; exec tmux -u -T clipboard attach -t '=hp-app:'"#),
            "{}",
            local[2]
        );
        let remote = s.viewer_argv(&machine(false), "hp-app", "ab12");
        assert_eq!(remote[1], "-t");
        assert!(remote.last().unwrap().contains("@yb_ab12"));
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

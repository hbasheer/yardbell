use super::backend::{self, codex, Launch, TurnSpec};
use super::prompt::{memory_section, system_prompt};
use super::store::{new_id, now, title_of, Conversation, Shared, Stored};
use super::{actions, Dispatch};
use crate::config::{DispatchSettings, RunsOn};
use crate::shell::{login_shell, Duration};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Notify};

const TURN_LIMIT: Duration = Duration::from_secs(900);
const INSTRUCTIONS_CHANGED: &str = "Yardbell's instructions for you have changed since this \
conversation started, for example your memory or the user's rules. These replace the earlier ones:";

// A conversation that a trigger starts, rather than the person: its title, the trigger's mark,
// and a note for Claude that nobody typed the message.
pub struct Opening<'a> {
    pub title: &'a str,
    pub trigger: Value,
    pub note: &'a str,
}

// Who sends a turn's message: the person, with what the page knows about where the message came
// from (such as the saved task it ran), a trigger that opens a conversation, or Yardbell in a
// conversation that exists, with a note for Claude that nobody typed it.
#[derive(Clone, Copy)]
enum Author<'a> {
    Person(Option<&'a Value>),
    Trigger(&'a Opening<'a>),
    Yardbell(&'a str),
}

impl Author<'_> {
    fn note(&self) -> Option<&str> {
        match self {
            Author::Person(_) => None,
            Author::Trigger(o) => Some(o.note),
            Author::Yardbell(note) => Some(note),
        }
    }

    fn opening(&self) -> Option<&Opening<'_>> {
        match self {
            Author::Trigger(o) => Some(o),
            _ => None,
        }
    }
}

impl Dispatch {
    async fn agent(&self, runs_on: RunsOn) -> Result<Vec<String>, String> {
        let backend = backend::of(runs_on);
        let cached = self
            .commands
            .lock()
            .expect("dispatch lock")
            .get(&runs_on)
            .cloned();
        let argv = match cached {
            Some(argv) => argv,
            None => {
                let out = self
                    .runner
                    .run(
                        vec![
                            "sh".into(),
                            "-c".into(),
                            login_shell(&format!("command -v {}", backend.binary())),
                        ],
                        None,
                        Duration::from_secs(10),
                    )
                    .await;
                let path = out
                    .stdout
                    .lines()
                    .rev()
                    .map(str::trim)
                    .find(|l| l.starts_with('/'))
                    .ok_or_else(|| {
                        format!(
                            "{} is not installed on this machine, Dispatch needs it",
                            backend.label()
                        )
                    })?
                    .to_string();
                self.commands
                    .lock()
                    .expect("dispatch lock")
                    .insert(runs_on, vec![path.clone()]);
                vec![path]
            }
        };
        if runs_on == RunsOn::Codex {
            codex::check_version(&version_of(&argv).await?)?;
        }
        Ok(argv)
    }

    // A resumed thread keeps the instructions it started with, so a change to them since, such as
    // a new memory entry or rule, comes with the message instead.
    fn told(&self, id: &str, instructions: &str, resumed: bool, prompt: String) -> String {
        let mut chats = self.shared.lock();
        let Some(c) = chats.get_mut(id) else {
            return prompt;
        };
        let changed = c.stored.instructions.as_deref() != Some(instructions);
        c.stored.instructions = Some(instructions.to_string());
        if !(resumed && changed) {
            return prompt;
        }
        format!(
            "{INSTRUCTIONS_CHANGED}\n<dispatch_instructions>\n{instructions}\n</dispatch_instructions>\n\n{prompt}"
        )
    }

    // A conversation keeps the agent it started on; a new one starts on the one in Settings.
    fn runs_on(&self, id: Option<&str>, settings: &DispatchSettings) -> Result<RunsOn, String> {
        match id {
            Some(id) => self
                .shared
                .lock()
                .get(id)
                .map(|c| c.stored.backend)
                .ok_or_else(|| "no such conversation".into()),
            None => Ok(settings.runs_on),
        }
    }

    // Returns the conversation, the agent's session to resume, and the prompt: the message, after
    // anything Dispatch has not heard about yet, such as what the person did with its proposals.
    fn begin(
        &self,
        id: Option<&str>,
        runs_on: RunsOn,
        sender: Author,
        text: &str,
        cancel: Arc<Notify>,
        live: mpsc::Sender<Value>,
    ) -> Result<(String, Option<String>, String), String> {
        let mut chats = self.shared.lock();
        let id = match id {
            Some(id) => {
                let c = chats.get_mut(id).ok_or("no such conversation")?;
                if c.busy {
                    return Err("this conversation is still answering".into());
                }
                id.to_string()
            }
            None => {
                let id = new_id();
                let stamp = now();
                chats.insert(
                    id.clone(),
                    Conversation::new(Stored {
                        id: id.clone(),
                        title: title_of(sender.opening().map_or(text, |o| o.title)),
                        created: stamp.clone(),
                        updated: stamp,
                        trigger: sender.opening().map(|o| o.trigger.clone()),
                        backend: runs_on,
                        ..Stored::default()
                    }),
                );
                id
            }
        };
        let c = chats.get_mut(&id).expect("conversation exists");
        let stamp = now();
        c.busy = true;
        c.cancel = Some(cancel);
        c.live = Some(live);
        c.reached = false;
        actions::withdraw(&mut c.stored.events, &stamp);
        let news = actions::untold(&mut c.stored.events);
        let mut message = json!({ "role": "user", "text": text });
        if matches!(sender, Author::Yardbell(_)) {
            message["by"] = json!("yardbell");
        }
        if let Author::Person(Some(Value::Object(about))) = sender {
            for (key, value) in about {
                message[key] = value.clone();
            }
        }
        c.stored.events.push(message);
        c.stored.updated = stamp;
        let prompt = actions::with_news(&news, text);
        Ok((
            id,
            c.stored.session.clone(),
            match sender.note() {
                Some(note) => format!("{note}\n\n{prompt}"),
                None => prompt,
            },
        ))
    }

    pub async fn ask(
        &self,
        conversation: Option<&str>,
        text: &str,
        port: u16,
        settings: &DispatchSettings,
        extra: Option<&str>,
    ) -> Result<(String, mpsc::Receiver<Value>), String> {
        self.turn(
            conversation,
            Author::Person(None),
            text,
            port,
            settings,
            extra,
        )
        .await
    }

    // The same turn, with the message marked with what started it, such as {"task": {"name",
    // "version"}} for a saved task. The marks are for the page; Claude gets only the text.
    pub async fn ask_marked(
        &self,
        conversation: Option<&str>,
        text: &str,
        marks: &Value,
        port: u16,
        settings: &DispatchSettings,
        extra: Option<&str>,
    ) -> Result<(String, mpsc::Receiver<Value>), String> {
        self.turn(
            conversation,
            Author::Person(Some(marks)),
            text,
            port,
            settings,
            extra,
        )
        .await
    }

    // A message Yardbell sends in an existing conversation, with a note for Claude that nobody
    // typed it.
    pub(super) async fn follow_turn(
        &self,
        id: &str,
        note: &str,
        text: &str,
        port: u16,
        settings: &DispatchSettings,
        extra: Option<&str>,
    ) -> Result<(String, mpsc::Receiver<Value>), String> {
        self.turn(
            Some(id),
            Author::Yardbell(note),
            text,
            port,
            settings,
            extra,
        )
        .await
    }

    pub async fn ask_triggered(
        &self,
        opening: Opening<'_>,
        text: &str,
        port: u16,
        settings: &DispatchSettings,
        extra: Option<&str>,
    ) -> Result<(String, mpsc::Receiver<Value>), String> {
        self.turn(None, Author::Trigger(&opening), text, port, settings, extra)
            .await
    }

    async fn turn(
        &self,
        conversation: Option<&str>,
        sender: Author<'_>,
        text: &str,
        port: u16,
        settings: &DispatchSettings,
        extra: Option<&str>,
    ) -> Result<(String, mpsc::Receiver<Value>), String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("type a task first".into());
        }
        let runs_on = self.runs_on(conversation, settings)?;
        let binary = self.agent(runs_on).await?;
        let cancel = Arc::new(Notify::new());
        let (tx, rx) = mpsc::channel(64);
        let (id, resume, prompt) = self.begin(
            conversation,
            runs_on,
            sender,
            text,
            cancel.clone(),
            tx.clone(),
        )?;
        let config = match runs_on {
            RunsOn::Claude => match self.write_mcp_config(port, extra, &id) {
                Ok(config) => Some(config),
                Err(e) => {
                    self.shared.finish(&id);
                    return Err(e);
                }
            },
            RunsOn::Codex => None,
        };
        let (remembered, omitted) = self.memory.for_prompt();
        let instructions = system_prompt(settings, &memory_section(&remembered, omitted));
        let backend = backend::of(runs_on);
        let prompt = if backend.keeps_instructions() {
            self.told(&id, &instructions, resume.is_some(), prompt)
        } else {
            prompt
        };
        self.shared.save(&id);
        let launch = backend.launch(
            binary,
            &TurnSpec {
                prompt: &prompt,
                system_prompt: &instructions,
                settings,
                resume: resume.as_deref(),
                port,
                conversation: &id,
                token: &self.token,
                mcp_config: config.as_deref(),
                extra,
            },
        );
        let launch = match launch {
            Ok(launch) => launch,
            Err(e) => {
                self.shared.finish(&id);
                return Err(e);
            }
        };
        let shared = self.shared.clone();
        let turn = id.clone();
        tokio::spawn(async move {
            let outcome = tokio::time::timeout(
                TURN_LIMIT,
                run_turn(launch, runs_on, &shared, &turn, &tx, cancel),
            )
            .await
            .unwrap_or_else(|_| Err("Dispatch took longer than 15 minutes and was stopped".into()));
            if runs_on == RunsOn::Codex {
                codex_usage(&shared, &turn).await;
            }
            if let Err(message) = outcome {
                let event = json!({ "role": "error", "text": message });
                shared.push(&turn, event.clone());
                let _ = tx.send(event).await;
            }
            shared.finish(&turn);
            let _ = tx.send(json!({ "role": "done" })).await;
        });
        Ok((id, rx))
    }
}

async fn version_of(argv: &[String]) -> Result<String, String> {
    let out = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(&argv[0])
            .args(&argv[1..])
            .arg("--version")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "codex --version did not answer within 10 seconds".to_string())?
    .map_err(|e| format!("cannot start Codex: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn codex_usage(shared: &Shared, id: &str) {
    let thread = shared.lock().get(id).and_then(|c| c.stored.session.clone());
    let (Some(home), Some(thread)) = (shared.codex_home.clone(), thread) else {
        return;
    };
    if let Some(usage) = codex::usage_after(home, thread).await {
        shared.keep_usage(RunsOn::Codex, usage);
    }
}

async fn run_turn(
    launch: Launch,
    runs_on: RunsOn,
    shared: &Shared,
    id: &str,
    tx: &mpsc::Sender<Value>,
    cancel: Arc<Notify>,
) -> Result<(), String> {
    let backend = backend::of(runs_on);
    let label = backend.label();
    let argv = &launch.argv;
    let mut child = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .envs(launch.env)
        .current_dir(&shared.dir)
        .stdin(if launch.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start {label}: {e}"))?;
    if let (Some(text), Some(mut stdin)) = (launch.stdin, child.stdin.take()) {
        tokio::spawn(async move {
            let _ = stdin.write_all(text.as_bytes()).await;
        });
    }
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stderr_text = tokio::spawn(async move {
        let mut text = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            text.push_str(&line);
            text.push('\n');
        }
        text
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut tools = HashMap::new();
    let mut finished = false;
    loop {
        let line = tokio::select! {
            line = lines.next_line() => line,
            _ = cancel.notified() => {
                let _ = child.kill().await;
                return Err("stopped".into());
            }
        };
        let Ok(Some(line)) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(session) = backend.session_of(&message) {
            if let Some(c) = shared.lock().get_mut(id) {
                c.stored.session = Some(session);
            }
        }
        finished |= backend.finished(&message);
        if let Some(found) = backend.usage_of(&message) {
            shared.set_usage(found);
        }
        for event in backend.events_of(&message, &mut tools) {
            // A step that changes something is recorded by the MCP server as a step of its own,
            // with its decision and result.
            if matches!(event["role"].as_str(), Some("tool" | "tool_result"))
                && event["name"]
                    .as_str()
                    .is_some_and(actions::changes_something)
            {
                continue;
            }
            shared.push(id, event.clone());
            let _ = tx.send(event).await;
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr_text.await.unwrap_or_default();
    let reached = shared.lock().get(id).is_some_and(|c| c.reached);
    if runs_on == RunsOn::Codex && !reached && (status.success() || codex::mentions_mcp(&stderr)) {
        return Err(codex::unreachable(&stderr));
    }
    if !status.success() && !finished {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("{label} stopped with {status}")
        } else {
            format!("{label} stopped: {detail}")
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::tests::{conversation, drain, fake_claude, fake_script, start_input};
    use crate::dispatch::{By, Refusal};
    use crate::testing::FakeRunner;
    use std::path::Path;
    use tokio::io::AsyncReadExt;

    const VERSION: &str = r#"[ "$1" = --version ] && echo 'codex-cli 0.165.0' && exit 0"#;
    // What Codex does first with a reachable server: a request to Yardbell's MCP server, with the
    // conversation header Yardbell gave it.
    const REACH: &str = r#"for a in "$@"; do case "$a" in
  *yardbell.http_headers=*) id=${a##*=\"}; id=${id%\"\}} ;;
  *yardbell.url=*) port=${a##*:}; port=${port%%/*} ;;
esac; done
exec 3<>"/dev/tcp/127.0.0.1/$port"
printf 'POST /mcp HTTP/1.0\r\nx-yardbell-conversation: %s\r\n\r\n' "$id" >&3
cat <&3 >/dev/null"#;

    // Run by bash rather than exec'd, since a script written a moment ago can still be open in
    // a process another test is forking ("Text file busy").
    fn codex_argv(dir: &Path, script: &str) -> Vec<String> {
        vec![
            "/bin/bash".into(),
            fake_script(dir, "codex", "/bin/bash", script),
        ]
    }

    fn fake_codex(dir: &Path, script: &str) -> Arc<Dispatch> {
        Arc::new(
            Dispatch::new(Arc::new(FakeRunner::default()), dir.join("dispatch"))
                .with_agent(RunsOn::Codex, codex_argv(dir, script))
                .with_codex_home(dir.join("codex-home")),
        )
    }

    // A stand-in for Yardbell's MCP server that only notes which conversation reached it.
    async fn mcp_stub(dispatch: Arc<Dispatch>) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let dispatch = dispatch.clone();
                tokio::spawn(async move {
                    let mut request = String::new();
                    let mut buf = vec![0; 4096];
                    while !request.contains("\r\n\r\n") {
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        request.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                    let header = format!("{}: ", crate::dispatch::CONVERSATION_HEADER);
                    if let Some(id) = request.lines().find_map(|l| l.strip_prefix(&header)) {
                        dispatch.reached(id.trim());
                    }
                    let _ = socket
                        .write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n")
                        .await;
                });
            }
        });
        port
    }

    fn codex_settings(model: &str) -> DispatchSettings {
        DispatchSettings {
            runs_on: RunsOn::Codex,
            codex_model: model.into(),
            ..DispatchSettings::default()
        }
    }

    #[tokio::test]
    async fn a_new_message_withdraws_waiting_steps_and_tells_dispatch_what_happened() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let dispatch = fake_claude(
            dir.path(),
            &format!(
                r#"printf '%s\n' "$@" > {}
echo '{{"type":"system","subtype":"init","session_id":"s1"}}'"#,
                args.display()
            ),
        );
        let id = conversation(&dispatch, "fix it on hp").await;
        let started = dispatch
            .propose(
                &id,
                "start_session",
                start_input(),
                By::Dispatch,
                None,
                None,
            )
            .unwrap();
        let started = started["id"].as_str().unwrap();
        let waiting = dispatch
            .propose(
                &id,
                "send_to_session",
                json!({ "machine": "hp", "name": "hp-app", "text": "yes" }),
                By::Dispatch,
                None,
                None,
            )
            .unwrap();
        let waiting = waiting["id"].as_str().unwrap();
        dispatch.approve(&id, started, None).unwrap();
        dispatch
            .ran(
                &id,
                started,
                &Ok(json!({ "machine": "hp", "name": "hp-eng-1", "path": "/r/app" })),
            )
            .unwrap();
        let (_, rx) = dispatch
            .ask(
                Some(&id),
                "and the docs",
                4000,
                &DispatchSettings::default(),
                None,
            )
            .await
            .unwrap();
        drain(rx).await;
        let sent = std::fs::read_to_string(&args).unwrap();
        assert!(
            sent.starts_with(
                "-p\nWhat happened since your last reply:\n- You proposed starting a session on hp in app on branch eng-1. I approved it, and it started as hp-eng-1 on hp.\n- You proposed typing \"yes\" into hp-app on hp, but I wrote this message before deciding, so it was withdrawn."
            ),
            "{sent}"
        );
        assert!(sent.contains("\n\nMy message:\nand the docs\n--output-format"));
        assert_eq!(
            dispatch.approve(&id, waiting, None),
            Err(Refusal::Taken(
                "this step was withdrawn when you sent a new message".into()
            ))
        );
        let events = dispatch.get(&id).unwrap()["events"].clone();
        assert_eq!(
            events.as_array().unwrap().last().unwrap()["text"],
            "and the docs",
            "the conversation shows the message as typed"
        );

        let (_, rx) = dispatch
            .ask(
                Some(&id),
                "thanks",
                4000,
                &DispatchSettings::default(),
                None,
            )
            .await
            .unwrap();
        drain(rx).await;
        assert!(
            std::fs::read_to_string(&args)
                .unwrap()
                .starts_with("-p\nthanks\n"),
            "nothing is told twice"
        );
    }

    #[tokio::test]
    async fn conversations_resume_their_own_claude_session_and_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let script = format!(
            r#"printf '%s\n' "$@" > {}
echo '{{"type":"system","subtype":"init","session_id":"s-'$$'"}}'
echo '{{"type":"rate_limit_event","rate_limit_info":{{"unifiedWindows":{{"five_hour":{{"utilization":0.25,"resetsAt":1}}}}}}}}'
echo '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"Started on mini."}}]}}}}'
echo '{{"type":"result","is_error":false,"result":"Started on mini."}}'"#,
            args.display()
        );
        let dispatch = fake_claude(dir.path(), &script);
        assert_eq!(dispatch.usage(), Value::Null);
        let (first, rx) = dispatch
            .ask(
                None,
                "fix the login bug",
                4000,
                &DispatchSettings::default(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            drain(rx).await,
            [
                json!({ "role": "assistant", "text": "Started on mini." }),
                json!({ "role": "done" })
            ]
        );
        let sent = std::fs::read_to_string(&args).unwrap();
        assert!(sent.starts_with("-p\nfix the login bug\n"), "{sent}");
        assert!(!sent.contains("--resume"));
        let config =
            std::fs::read_to_string(dir.path().join(format!("dispatch/mcp/{first}.json"))).unwrap();
        assert!(config.contains(&format!("Bearer {}", dispatch.token())));

        let (second, rx) = dispatch
            .ask(
                None,
                "update the docs",
                4000,
                &DispatchSettings::default(),
                None,
            )
            .await
            .unwrap();
        drain(rx).await;
        assert_ne!(first, second);

        let session = dispatch.shared.lock()[&first]
            .stored
            .session
            .clone()
            .unwrap();
        let (again, rx) = dispatch
            .ask(
                Some(&first),
                "and logout",
                4000,
                &DispatchSettings::default(),
                None,
            )
            .await
            .unwrap();
        drain(rx).await;
        assert_eq!(again, first);
        assert!(std::fs::read_to_string(&args)
            .unwrap()
            .ends_with(&format!("--resume\n{session}\n")));

        let list = dispatch.list();
        assert_eq!(list[0]["id"], first.as_str(), "most recent first");
        assert_eq!(list[1]["title"], "update the docs");

        let reopened = fake_claude(dir.path(), &script);
        let convo = reopened.get(&first).unwrap();
        assert_eq!(convo["title"], "fix the login bug");
        assert_eq!(convo["events"].as_array().unwrap().len(), 4);
        assert_eq!(convo["busy"], false);
        assert_eq!(
            reopened.usage()["windows"][0]["used"],
            0.25,
            "the last usage seen survives a restart"
        );
    }

    #[tokio::test]
    async fn the_model_setting_reaches_claude() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let dispatch = fake_claude(
            dir.path(),
            &format!(r#"printf '%s\n' "$@" > {}"#, args.display()),
        );
        let settings = DispatchSettings {
            model: "haiku".into(),
            ..DispatchSettings::default()
        };
        let (_, rx) = dispatch
            .ask(None, "hi", 4000, &settings, None)
            .await
            .unwrap();
        drain(rx).await;
        assert!(std::fs::read_to_string(&args)
            .unwrap()
            .ends_with("--model\nhaiku\n"));
    }

    #[tokio::test]
    async fn every_turn_reads_the_memory_as_it_is_then() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let dispatch = fake_claude(
            dir.path(),
            &format!(r#"printf '%s\n' "$@" > {}"#, args.display()),
        );
        let prompt_of = || {
            let text = std::fs::read_to_string(&args).unwrap();
            let after = text.split("--append-system-prompt\n").nth(1).unwrap();
            after.to_string()
        };
        let (id, rx) = dispatch
            .ask(None, "hi", 4000, &DispatchSettings::default(), None)
            .await
            .unwrap();
        drain(rx).await;
        assert!(prompt_of().contains("<dispatch_memory>\n(empty)\n</dispatch_memory>"));
        dispatch
            .memory()
            .apply(
                &crate::dispatch::MemoryChange {
                    change: crate::dispatch::memory::Kind::Add,
                    entry: "Never open PRs on Fridays".into(),
                    old: String::new(),
                    reason: "the user said so".into(),
                },
                crate::dispatch::By::You,
            )
            .unwrap();
        let (_, rx) = dispatch
            .ask(Some(&id), "again", 4000, &DispatchSettings::default(), None)
            .await
            .unwrap();
        drain(rx).await;
        assert!(prompt_of()
            .contains("<dispatch_memory>\n- Never open PRs on Fridays\n</dispatch_memory>"));
    }

    #[tokio::test]
    async fn a_failing_claude_reports_its_error() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "echo 'not logged in' >&2; exit 1");
        let (_, rx) = dispatch
            .ask(None, "hi", 4000, &DispatchSettings::default(), None)
            .await
            .unwrap();
        assert_eq!(
            drain(rx).await,
            [
                json!({ "role": "error", "text": "Claude Code stopped: not logged in" }),
                json!({ "role": "done" })
            ]
        );
    }

    #[tokio::test]
    async fn a_missing_claude_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = Dispatch::new(Arc::new(FakeRunner::default()), dir.path().join("d"));
        assert_eq!(
            dispatch
                .ask(None, "hi", 4000, &DispatchSettings::default(), None)
                .await
                .unwrap_err(),
            "Claude Code is not installed on this machine, Dispatch needs it"
        );
        assert_eq!(
            dispatch.list(),
            json!([]),
            "nothing is saved when Claude is missing"
        );
    }

    #[tokio::test]
    async fn a_codex_turn_gets_its_prompt_on_stdin_and_its_token_by_environment() {
        let dir = tempfile::tempdir().unwrap();
        let rec = dir.path().join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let day = dir.path().join("codex-home/sessions/2026/10/29");
        std::fs::create_dir_all(&day).unwrap();
        let script = format!(
            r#"{VERSION}
printf '%s\n' "$@" > {rec}/args
printf '%s' "$YARDBELL_DISPATCH_TOKEN" > {rec}/token
cat > {rec}/stdin
{REACH}
cat > {day}/rollout-2026-10-29T00-16-51-thread-1.jsonl <<'ROLLOUT'
{{"timestamp":"2026-10-28T21:17:06.737Z","type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"primary":{{"used_percent":6.0,"window_minutes":300,"resets_at":1793226870}},"secondary":{{"used_percent":3.0,"window_minutes":10080,"resets_at":1793790405}},"rate_limit_reached_type":null}}}}}}
ROLLOUT
cat <<'LINES'
{{"type":"thread.started","thread_id":"thread-1"}}
{{"type":"turn.started"}}
{{"type":"item.completed","item":{{"id":"item_0","type":"agent_message","text":"Looking at your machines."}}}}
{{"type":"item.started","item":{{"id":"item_1","type":"mcp_tool_call","server":"yardbell","tool":"list_machines","arguments":{{}},"result":null,"error":null,"status":"in_progress"}}}}
{{"type":"item.completed","item":{{"id":"item_1","type":"mcp_tool_call","server":"yardbell","tool":"list_machines","arguments":{{}},"result":{{"content":[{{"type":"text","text":"hp is up"}}],"structured_content":null}},"error":null,"status":"completed"}}}}
{{"type":"item.started","item":{{"id":"item_2","type":"mcp_tool_call","server":"yardbell","tool":"start_session","arguments":{{"machine":"hp"}},"result":null,"error":null,"status":"in_progress"}}}}
{{"type":"item.completed","item":{{"id":"item_2","type":"mcp_tool_call","server":"yardbell","tool":"start_session","arguments":{{"machine":"hp"}},"result":{{"content":[{{"type":"text","text":"Not run yet."}}]}},"error":null,"status":"completed"}}}}
{{"type":"item.completed","item":{{"id":"item_3","type":"agent_message","text":"I proposed a session on hp."}}}}
{{"type":"turn.completed","usage":{{"input_tokens":1,"output_tokens":1}}}}
LINES"#,
            rec = rec.display(),
            day = day.display(),
        );
        let dispatch = fake_codex(dir.path(), &script);
        let port = mcp_stub(dispatch.clone()).await;
        let (id, rx) = dispatch
            .ask(None, "what is up?", port, &codex_settings(""), None)
            .await
            .unwrap();
        assert_eq!(
            drain(rx).await,
            [
                json!({ "role": "assistant", "text": "Looking at your machines." }),
                json!({ "role": "tool", "name": "list_machines", "input": {} }),
                json!({ "role": "tool_result", "name": "list_machines", "text": "hp is up", "is_error": false }),
                json!({ "role": "assistant", "text": "I proposed a session on hp." }),
                json!({ "role": "done" }),
            ],
            "a step is left to the MCP server, which records it with its decision"
        );
        let args = std::fs::read_to_string(rec.join("args")).unwrap();
        let token = dispatch.token();
        assert!(!args.contains(token), "the token is never in argv: {args}");
        assert_eq!(std::fs::read_to_string(rec.join("token")).unwrap(), token);
        assert_eq!(
            std::fs::read_to_string(rec.join("stdin")).unwrap(),
            "what is up?"
        );
        assert!(
            args.starts_with(
                "exec\n--json\n--ignore-user-config\n--ignore-rules\n--skip-git-repo-check\n"
            ),
            "{args}"
        );
        assert!(
            args.ends_with("\n-\n"),
            "the prompt is read from stdin: {args}"
        );
        for wanted in [
            "--disable\nshell_tool\n".to_string(),
            "--disable\nunified_exec\n".to_string(),
            "-c\nsandbox_mode=\"read-only\"\n".to_string(),
            format!("-c\nmcp_servers.yardbell.url=\"http://127.0.0.1:{port}/mcp\"\n"),
            "-c\nmcp_servers.yardbell.bearer_token_env_var=\"YARDBELL_DISPATCH_TOKEN\"\n"
                .to_string(),
            format!(
                "-c\nmcp_servers.yardbell.http_headers={{\"x-yardbell-conversation\"=\"{id}\"}}\n"
            ),
            "-c\nmcp_servers.yardbell.default_tools_approval_mode=\"approve\"\n".to_string(),
            "-c\nmcp_servers.yardbell.required=true\n".to_string(),
        ] {
            assert!(args.contains(&wanted), "{wanted} missing from {args}");
        }
        let tools = args
            .lines()
            .find_map(|l| l.strip_prefix("mcp_servers.yardbell.enabled_tools="))
            .unwrap();
        let tools: toml::Table = toml::from_str(&format!("t = {tools}")).unwrap();
        assert_eq!(tools["t"].as_array().unwrap().len(), backend::TOOLS.len());
        let instructions = args
            .split("-c\ndeveloper_instructions=")
            .nth(1)
            .unwrap()
            .split("\n-c\n")
            .next()
            .unwrap();
        let instructions: toml::Table = toml::from_str(&format!("v = {instructions}")).unwrap();
        assert!(instructions["v"]
            .as_str()
            .unwrap()
            .contains("<dispatch_memory>\n(empty)\n</dispatch_memory>"));
        assert!(!args.contains("\n-m\n"), "Codex's own default model");
        assert!(!args.contains("resume"));

        let convo = dispatch.get(&id).unwrap();
        assert_eq!(convo["backend"], "codex");
        assert_eq!(dispatch.list()[0]["backend"], "codex");
        let saved = std::fs::read_to_string(dispatch.shared.file(&id)).unwrap();
        assert!(saved.contains(r#""backend":"codex""#), "{saved}");
        assert!(saved.contains(r#""session":"thread-1""#), "{saved}");
        let card = dispatch.usage_card(RunsOn::Codex);
        assert_eq!(card["runs_on"], "codex");
        assert_eq!(card["codex"]["windows"][0]["used"], 0.06);
        assert_eq!(card["codex"]["windows"][1]["label"], "Weekly limit");

        let (_, rx) = dispatch
            .ask(
                Some(&id),
                "and now?",
                port,
                &codex_settings("gpt-6.1-sol"),
                None,
            )
            .await
            .unwrap();
        drain(rx).await;
        let args = std::fs::read_to_string(rec.join("args")).unwrap();
        assert!(args.starts_with("exec\nresume\n--json\n"), "{args}");
        assert!(args.contains("\n-m\ngpt-6.1-sol\n"), "{args}");
        assert!(args.ends_with("\nthread-1\n-\n"), "{args}");
        assert!(args.contains("-c\nsandbox_mode=\"read-only\"\n"));
        assert_eq!(
            std::fs::read_to_string(rec.join("stdin")).unwrap(),
            "and now?",
            "unchanged instructions are not sent again"
        );
        dispatch
            .memory()
            .apply(
                &crate::dispatch::MemoryChange {
                    change: crate::dispatch::memory::Kind::Add,
                    entry: "Never open PRs on Fridays".into(),
                    old: String::new(),
                    reason: "the user said so".into(),
                },
                crate::dispatch::By::You,
            )
            .unwrap();
        let (_, rx) = dispatch
            .ask(Some(&id), "and Friday?", port, &codex_settings(""), None)
            .await
            .unwrap();
        drain(rx).await;
        let sent = std::fs::read_to_string(rec.join("stdin")).unwrap();
        assert!(sent.starts_with(INSTRUCTIONS_CHANGED), "{sent}");
        assert!(
            sent.contains("<dispatch_memory>\n- Never open PRs on Fridays\n</dispatch_memory>"),
            "a resumed thread keeps its first instructions, so the change comes with the message"
        );
        assert!(
            sent.ends_with("</dispatch_instructions>\n\nand Friday?"),
            "{sent}"
        );
        let reopened = Dispatch::new(Arc::new(FakeRunner::default()), dir.path().join("dispatch"));
        assert_eq!(
            reopened.usage_card(RunsOn::Claude)["codex"]["windows"][0]["used"],
            0.06,
            "Codex's figures survive a restart"
        );
    }

    #[tokio::test]
    async fn a_codex_turn_that_never_reached_yardbell_fails() {
        let dir = tempfile::tempdir().unwrap();
        let silent = fake_codex(
            dir.path(),
            &format!(
                r#"{VERSION}
echo '2026-10-28T21:18:45Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed' >&2
echo '{{"type":"thread.started","thread_id":"thread-2"}}'
echo '{{"type":"item.completed","item":{{"id":"item_0","type":"agent_message","text":"I cannot see any tools."}}}}'
echo '{{"type":"turn.completed","usage":{{}}}}'"#
            ),
        );
        let (_, rx) = silent
            .ask(None, "hi", 1, &codex_settings(""), None)
            .await
            .unwrap();
        assert_eq!(
            drain(rx).await,
            [
                json!({ "role": "assistant", "text": "I cannot see any tools." }),
                json!({ "role": "error", "text": "Codex could not reach Yardbell's tools, so Dispatch could not act on this message. Codex said: 2026-10-28T21:18:45Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed" }),
                json!({ "role": "done" }),
            ]
        );

        let required = fake_codex(
            dir.path(),
            &format!(
                r#"{VERSION}
echo 'Error: thread/start failed: required MCP servers failed to initialize: yardbell: handshaking with MCP server failed' >&2
exit 1"#
            ),
        );
        let (_, rx) = required
            .ask(None, "hi", 1, &codex_settings(""), None)
            .await
            .unwrap();
        assert_eq!(
            drain(rx).await,
            [
                json!({ "role": "error", "text": "Codex could not reach Yardbell's tools, so Dispatch could not act on this message. Codex said: Error: thread/start failed: required MCP servers failed to initialize: yardbell: handshaking with MCP server failed" }),
                json!({ "role": "done" }),
            ]
        );

        let signed_out = fake_codex(
            dir.path(),
            &format!("{VERSION}\necho 'Not signed in. Run codex login.' >&2\nexit 1"),
        );
        let (_, rx) = signed_out
            .ask(None, "hi", 1, &codex_settings(""), None)
            .await
            .unwrap();
        assert_eq!(
            drain(rx).await,
            [
                json!({ "role": "error", "text": "Codex stopped: Not signed in. Run codex login." }),
                json!({ "role": "done" }),
            ]
        );
    }

    #[tokio::test]
    async fn an_old_or_missing_codex_is_refused_before_anything_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let old = fake_codex(
            dir.path(),
            r#"[ "$1" = --version ] && echo 'codex-cli 0.150.3' && exit 0
touch ran"#,
        );
        assert_eq!(
            old.ask(None, "hi", 4000, &codex_settings(""), None)
                .await
                .unwrap_err(),
            "Dispatch needs Codex 0.165.0 or newer, and this machine has 0.150.3. Update Codex, then send the message again"
        );
        assert_eq!(old.list(), json!([]));
        let missing = Dispatch::new(Arc::new(FakeRunner::default()), dir.path().join("d"));
        assert_eq!(
            missing
                .ask(None, "hi", 4000, &codex_settings(""), None)
                .await
                .unwrap_err(),
            "Codex is not installed on this machine, Dispatch needs it"
        );
        assert_eq!(missing.list(), json!([]));
    }

    #[tokio::test]
    async fn a_conversation_keeps_the_agent_it_started_on() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        let claude = fake_script(
            dir.path(),
            "claude",
            "/bin/sh",
            &format!(
                r#"echo claude >> {log}
echo '{{"type":"system","subtype":"init","session_id":"claude-session"}}'"#,
                log = log.display()
            ),
        );
        let codex = codex_argv(
            dir.path(),
            &format!(
                r#"{VERSION}
{REACH}
echo codex >> {log}
echo '{{"type":"thread.started","thread_id":"codex-thread"}}'
echo '{{"type":"turn.completed","usage":{{}}}}'"#,
                log = log.display()
            ),
        );
        let dispatch = Arc::new(
            Dispatch::new(Arc::new(FakeRunner::default()), dir.path().join("dispatch"))
                .with_agent(RunsOn::Claude, vec![claude])
                .with_agent(RunsOn::Codex, codex)
                .with_codex_home(dir.path().join("codex-home")),
        );
        let port = mcp_stub(dispatch.clone()).await;
        let on_claude_settings = DispatchSettings::default();
        let ask = |id: Option<String>, text: &'static str, settings: DispatchSettings| {
            let dispatch = dispatch.clone();
            async move {
                let (id, rx) = dispatch
                    .ask(id.as_deref(), text, port, &settings, None)
                    .await
                    .unwrap();
                drain(rx).await;
                id
            }
        };
        let on_claude = ask(None, "one", on_claude_settings.clone()).await;
        let on_codex = ask(None, "two", codex_settings("")).await;
        ask(Some(on_claude.clone()), "three", codex_settings("")).await;
        ask(Some(on_codex.clone()), "four", on_claude_settings).await;
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "claude\ncodex\nclaude\ncodex\n"
        );
        assert_eq!(dispatch.get(&on_claude).unwrap()["backend"], "claude");
        assert_eq!(dispatch.get(&on_codex).unwrap()["backend"], "codex");
        let saved = std::fs::read_to_string(dispatch.shared.file(&on_claude)).unwrap();
        assert!(
            !saved.contains("backend"),
            "Claude Code conversations are saved as before: {saved}"
        );
    }
}

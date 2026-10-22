use crate::shell::{login_shell, Duration, Runner};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Notify};

const TURN_LIMIT: Duration = Duration::from_secs(900);
const RESULT_PREVIEW: usize = 4000;
const TOOL_PREFIX: &str = "mcp__yardbell__";
const TOOLS: [&str; 7] = [
    "list_machines",
    "list_sessions",
    "list_folders",
    "start_session",
    "read_session",
    "send_to_session",
    "stop_session",
];

const PROMPT: &str = "You are the Yardbell relay. The user gives you a coding task, and you hand it \
to an AI coding agent on the best machine; you never do the coding yourself. Use the yardbell tools.

To pick the machine:
1. Find the repository the task is about with list_folders. If it is unclear, or several \
checkouts match, ask the user which one before starting anything.
2. Only consider machines that are up and have that repository.
3. Among those, prefer the one with the most free memory and the lowest load per CPU, and with \
fewer agent sessions already running. Avoid a machine with under 1.5 GB free unless it is the only one.

Then call start_session with the machine, the folder, a branch when the task names one or clearly \
needs one (new_branch with base when it does not exist yet), and the task as prompt, written as a \
clear instruction for the coding agent with every detail the user gave. Use the default agent \
unless the user asks for another.

Reply briefly: which machine and folder you chose and why in one or two sentences, and the session \
name. When the user asks about a running session, use read_session; to answer an agent that is \
waiting, use send_to_session.";

#[derive(Default)]
struct Chat {
    session_id: Option<String>,
    events: Vec<Value>,
    busy: bool,
    cancel: Option<Arc<Notify>>,
}

pub struct Relay {
    runner: Arc<dyn Runner>,
    workdir: PathBuf,
    command: Mutex<Option<Vec<String>>>,
    token: String,
    chat: Arc<Mutex<Chat>>,
}

impl Relay {
    pub fn new(runner: Arc<dyn Runner>, workdir: PathBuf) -> Relay {
        Relay {
            runner,
            workdir,
            command: Mutex::new(None),
            token: crate::mcp::new_token(),
            chat: Arc::default(),
        }
    }

    pub fn with_command(self, argv: Vec<String>) -> Relay {
        *self.command.lock().expect("relay lock") = Some(argv);
        self
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn history(&self) -> Value {
        let chat = self.chat.lock().expect("relay lock");
        json!({ "events": chat.events, "busy": chat.busy })
    }

    pub fn reset(&self) -> Result<(), String> {
        let mut chat = self.chat.lock().expect("relay lock");
        if chat.busy {
            return Err("the relay is still answering, stop it first".into());
        }
        *chat = Chat::default();
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(cancel) = &self.chat.lock().expect("relay lock").cancel {
            cancel.notify_one();
        }
    }

    async fn claude(&self) -> Result<Vec<String>, String> {
        if let Some(argv) = self.command.lock().expect("relay lock").clone() {
            return Ok(argv);
        }
        let out = self
            .runner
            .run(
                vec!["sh".into(), "-c".into(), login_shell("command -v claude")],
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
            .ok_or("Claude Code is not installed on this machine, the relay needs it")?
            .to_string();
        *self.command.lock().expect("relay lock") = Some(vec![path.clone()]);
        Ok(vec![path])
    }

    fn write_mcp_config(&self, port: u16) -> Result<PathBuf, String> {
        let config = json!({
            "mcpServers": { "yardbell": {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp"),
                "headers": { "Authorization": format!("Bearer {}", self.token) },
            }}
        });
        let path = self.workdir.join("mcp.json");
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&self.workdir)?;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)?;
            std::io::Write::write_all(&mut file, config.to_string().as_bytes())
        };
        write().map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        Ok(path)
    }

    pub async fn ask(&self, text: &str, port: u16) -> Result<mpsc::Receiver<Value>, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("type a task first".into());
        }
        let mut argv = self.claude().await?;
        let config = self.write_mcp_config(port)?;
        let cancel = Arc::new(Notify::new());
        let resume = {
            let mut chat = self.chat.lock().expect("relay lock");
            if chat.busy {
                return Err("the relay is still answering".into());
            }
            chat.busy = true;
            chat.cancel = Some(cancel.clone());
            chat.events.push(json!({ "role": "user", "text": text }));
            chat.session_id.clone()
        };
        let allowed: Vec<String> = TOOLS.iter().map(|t| format!("{TOOL_PREFIX}{t}")).collect();
        argv.extend(
            [
                "-p",
                text,
                "--output-format",
                "stream-json",
                "--verbose",
                "--mcp-config",
                &config.display().to_string(),
                "--strict-mcp-config",
                "--allowedTools",
                &allowed.join(","),
                "--append-system-prompt",
                PROMPT,
            ]
            .map(String::from),
        );
        if let Some(id) = resume {
            argv.extend(["--resume".into(), id]);
        }
        let (tx, rx) = mpsc::channel(64);
        let chat = self.chat.clone();
        let workdir = self.workdir.clone();
        tokio::spawn(async move {
            let outcome = tokio::time::timeout(
                TURN_LIMIT,
                run_turn(argv, workdir, chat.clone(), tx.clone(), cancel),
            )
            .await
            .unwrap_or_else(|_| {
                Err("the relay took longer than 15 minutes and was stopped".into())
            });
            if let Err(message) = outcome {
                emit(&chat, &tx, json!({ "role": "error", "text": message })).await;
            }
            {
                let mut c = chat.lock().expect("relay lock");
                c.busy = false;
                c.cancel = None;
            }
            let _ = tx.send(json!({ "role": "done" })).await;
        });
        Ok(rx)
    }
}

async fn emit(chat: &Mutex<Chat>, tx: &mpsc::Sender<Value>, event: Value) {
    chat.lock().expect("relay lock").events.push(event.clone());
    let _ = tx.send(event).await;
}

async fn run_turn(
    argv: Vec<String>,
    workdir: PathBuf,
    chat: Arc<Mutex<Chat>>,
    tx: mpsc::Sender<Value>,
    cancel: Arc<Notify>,
) -> Result<(), String> {
    let mut child = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(&workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start Claude Code: {e}"))?;
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
        if let Some(id) = message["session_id"].as_str() {
            chat.lock().expect("relay lock").session_id = Some(id.to_string());
        }
        finished |= message["type"] == "result";
        for event in events_of(&message, &mut tools) {
            emit(&chat, &tx, event).await;
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr_text.await.unwrap_or_default();
    if !status.success() && !finished {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("Claude Code stopped with {status}")
        } else {
            format!("Claude Code stopped: {detail}")
        });
    }
    Ok(())
}

fn short(text: &str) -> String {
    if text.chars().count() <= RESULT_PREVIEW {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(RESULT_PREVIEW).collect();
    cut.push_str("\n…");
    cut
}

fn tool_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn events_of(message: &Value, tools: &mut HashMap<String, String>) -> Vec<Value> {
    let parts = message["message"]["content"].as_array();
    match message["type"].as_str() {
        Some("assistant") => parts
            .into_iter()
            .flatten()
            .filter_map(|part| match part["type"].as_str() {
                Some("text") => part["text"]
                    .as_str()
                    .filter(|t| !t.trim().is_empty())
                    .map(|t| json!({ "role": "assistant", "text": t })),
                Some("tool_use") => {
                    let name = part["name"].as_str()?.strip_prefix(TOOL_PREFIX)?;
                    if let Some(id) = part["id"].as_str() {
                        tools.insert(id.to_string(), name.to_string());
                    }
                    Some(json!({ "role": "tool", "name": name, "input": part["input"] }))
                }
                _ => None,
            })
            .collect(),
        Some("user") => parts
            .into_iter()
            .flatten()
            .filter(|part| part["type"] == "tool_result")
            .filter_map(|part| {
                let name = tools.get(part["tool_use_id"].as_str()?)?;
                Some(json!({
                    "role": "tool_result",
                    "name": name,
                    "text": short(&tool_text(&part["content"])),
                    "is_error": part["is_error"].as_bool().unwrap_or(false),
                }))
            })
            .collect(),
        Some("result") if message["is_error"] == true => {
            let text = message["result"]
                .as_str()
                .unwrap_or("Claude Code reported an error");
            vec![json!({ "role": "error", "text": text })]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRunner;

    #[test]
    fn stream_json_becomes_chat_events() {
        let mut tools = HashMap::new();
        let call = json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": "Looking at your machines." },
            { "type": "tool_use", "id": "t1", "name": "mcp__yardbell__start_session", "input": { "machine": "mini" } },
        ]}});
        assert_eq!(
            events_of(&call, &mut tools),
            [
                json!({ "role": "assistant", "text": "Looking at your machines." }),
                json!({ "role": "tool", "name": "start_session", "input": { "machine": "mini" } }),
            ]
        );
        let result = json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": "{\"name\":\"mini-app\"}" }] },
        ]}});
        assert_eq!(
            events_of(&result, &mut tools),
            [
                json!({ "role": "tool_result", "name": "start_session", "text": "{\"name\":\"mini-app\"}", "is_error": false })
            ]
        );
        let failed =
            json!({ "type": "result", "is_error": true, "result": "credit balance too low" });
        assert_eq!(
            events_of(&failed, &mut tools),
            [json!({ "role": "error", "text": "credit balance too low" })]
        );
        assert!(events_of(&json!({ "type": "system", "subtype": "init" }), &mut tools).is_empty());
        let builtin = json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t2", "name": "ToolSearch", "input": {} },
        ]}});
        assert!(events_of(&builtin, &mut tools).is_empty());
        let builtin_result = json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t2", "content": "" },
        ]}});
        assert!(events_of(&builtin_result, &mut tools).is_empty());
    }

    fn fake_claude(dir: &std::path::Path, script: &str) -> Relay {
        let path = dir.join("claude");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        Relay::new(Arc::new(FakeRunner::default()), dir.join("relay"))
            .with_command(vec![path.display().to_string()])
    }

    async fn drain(mut rx: mpsc::Receiver<Value>) -> Vec<Value> {
        let mut all = Vec::new();
        while let Some(event) = rx.recv().await {
            all.push(event);
        }
        all
    }

    #[tokio::test]
    async fn a_turn_streams_events_and_the_next_one_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let relay = fake_claude(
            dir.path(),
            &format!(
                r#"printf '%s\n' "$@" > {}
echo '{{"type":"system","subtype":"init","session_id":"s-1"}}'
echo '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"Started on mini."}}]}}}}'
echo '{{"type":"result","is_error":false,"result":"Started on mini.","session_id":"s-1"}}'"#,
                args.display()
            ),
        );
        let events = drain(relay.ask("fix the login bug", 4000).await.unwrap()).await;
        assert_eq!(
            events,
            [
                json!({ "role": "assistant", "text": "Started on mini." }),
                json!({ "role": "done" })
            ]
        );
        let first = std::fs::read_to_string(&args).unwrap();
        assert!(first.starts_with("-p\nfix the login bug\n"), "{first}");
        assert!(first.contains("mcp__yardbell__start_session"));
        assert!(!first.contains("--resume"));
        let config = std::fs::read_to_string(dir.path().join("relay/mcp.json")).unwrap();
        assert!(config.contains(&format!("Bearer {}", relay.token())));
        assert!(config.contains("http://127.0.0.1:4000/mcp"));

        drain(relay.ask("and the logout one", 4000).await.unwrap()).await;
        assert!(std::fs::read_to_string(&args)
            .unwrap()
            .ends_with("--resume\ns-1\n"));
        let history = relay.history();
        assert_eq!(history["busy"], false);
        assert_eq!(
            history["events"][0],
            json!({ "role": "user", "text": "fix the login bug" })
        );
        assert_eq!(history["events"].as_array().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn a_failing_claude_reports_its_error() {
        let dir = tempfile::tempdir().unwrap();
        let relay = fake_claude(dir.path(), "echo 'not logged in' >&2; exit 1");
        let events = drain(relay.ask("hi", 4000).await.unwrap()).await;
        assert_eq!(
            events,
            [
                json!({ "role": "error", "text": "Claude Code stopped: not logged in" }),
                json!({ "role": "done" })
            ]
        );
    }

    #[tokio::test]
    async fn stop_ends_a_running_turn_and_reset_clears_the_chat() {
        let dir = tempfile::tempdir().unwrap();
        let relay = fake_claude(dir.path(), "sleep 30");
        let rx = relay.ask("hi", 4000).await.unwrap();
        assert_eq!(
            relay.ask("again", 4000).await.unwrap_err(),
            "the relay is still answering"
        );
        assert!(relay.reset().is_err());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        relay.stop();
        let events = drain(rx).await;
        assert_eq!(events[0], json!({ "role": "error", "text": "stopped" }));
        relay.reset().unwrap();
        assert_eq!(relay.history()["events"], json!([]));
    }

    #[tokio::test]
    async fn a_missing_claude_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let relay = Relay::new(Arc::new(FakeRunner::default()), dir.path().join("relay"));
        assert_eq!(
            relay.ask("hi", 4000).await.unwrap_err(),
            "Claude Code is not installed on this machine, the relay needs it"
        );
    }
}

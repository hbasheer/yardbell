use crate::shell::{login_shell, Duration, Runner};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Notify};

const TURN_LIMIT: Duration = Duration::from_secs(900);
const RESULT_PREVIEW: usize = 4000;
const TITLE_CHARS: usize = 80;
const ID_LEN: usize = 16;
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

const PROMPT: &str = "You are Yardbell's dispatcher. The user gives you a coding task, and you \
hand it to an AI coding agent on the best machine; you never do the coding yourself. Use the \
yardbell tools.

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    id: String,
    title: String,
    created: String,
    updated: String,
    #[serde(default)]
    claude_session: Option<String>,
    #[serde(default)]
    events: Vec<Value>,
}

struct Conversation {
    stored: Stored,
    busy: bool,
    cancel: Option<Arc<Notify>>,
}

struct Shared {
    dir: PathBuf,
    chats: Mutex<HashMap<String, Conversation>>,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Conversation>> {
        self.chats.lock().expect("dispatch lock")
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join("conversations").join(format!("{id}.json"))
    }

    fn push(&self, id: &str, event: Value) {
        if let Some(c) = self.lock().get_mut(id) {
            c.stored.events.push(event);
            c.stored.updated = now();
        }
    }

    fn save(&self, id: &str) {
        let Some(stored) = self.lock().get(id).map(|c| c.stored.clone()) else {
            return;
        };
        if let Err(e) = write_private(
            &self.file(id),
            &serde_json::to_vec(&stored).unwrap_or_default(),
        ) {
            tracing::warn!(error = %e, "could not save dispatch conversation {id}");
        }
    }

    fn finish(&self, id: &str) {
        if let Some(c) = self.lock().get_mut(id) {
            c.busy = false;
            c.cancel = None;
        }
        self.save(id);
    }
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn new_id() -> String {
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(ID_LEN)
        .map(|b| char::from(b).to_ascii_lowercase())
        .collect()
}

pub fn valid_id(id: &str) -> bool {
    id.len() == ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn title_of(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    if line.chars().count() <= TITLE_CHARS {
        return line.to_string();
    }
    let mut cut: String = line.chars().take(TITLE_CHARS).collect();
    cut.push('…');
    cut
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    std::io::Write::write_all(&mut file, bytes)?;
    std::fs::rename(&tmp, path)
}

fn load(dir: &Path) -> HashMap<String, Conversation> {
    let Ok(entries) = std::fs::read_dir(dir.join("conversations")) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let text = std::fs::read(e.path()).ok()?;
            let stored: Stored = serde_json::from_slice(&text)
                .inspect_err(|err| tracing::warn!(error = %err, "skipping {}", e.path().display()))
                .ok()?;
            valid_id(&stored.id).then_some(())?;
            Some((
                stored.id.clone(),
                Conversation {
                    stored,
                    busy: false,
                    cancel: None,
                },
            ))
        })
        .collect()
}

pub struct Dispatch {
    runner: Arc<dyn Runner>,
    command: Mutex<Option<Vec<String>>>,
    token: String,
    shared: Arc<Shared>,
}

impl Dispatch {
    pub fn new(runner: Arc<dyn Runner>, dir: PathBuf) -> Dispatch {
        let chats = Mutex::new(load(&dir));
        Dispatch {
            runner,
            command: Mutex::new(None),
            token: crate::mcp::new_token(),
            shared: Arc::new(Shared { dir, chats }),
        }
    }

    pub fn with_command(self, argv: Vec<String>) -> Dispatch {
        *self.command.lock().expect("dispatch lock") = Some(argv);
        self
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn list(&self) -> Value {
        let chats = self.shared.lock();
        let mut all: Vec<&Conversation> = chats.values().collect();
        all.sort_by(|a, b| b.stored.updated.cmp(&a.stored.updated));
        json!(all
            .iter()
            .map(|c| json!({
                "id": c.stored.id,
                "title": c.stored.title,
                "updated": c.stored.updated,
                "busy": c.busy,
            }))
            .collect::<Vec<_>>())
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        let chats = self.shared.lock();
        let c = chats.get(id)?;
        Some(json!({
            "id": c.stored.id,
            "title": c.stored.title,
            "events": c.stored.events,
            "busy": c.busy,
        }))
    }

    pub fn stop(&self, id: &str) {
        if let Some(cancel) = self.shared.lock().get(id).and_then(|c| c.cancel.clone()) {
            cancel.notify_one();
        }
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        {
            let mut chats = self.shared.lock();
            match chats.get(id) {
                None => return Err("no such conversation".into()),
                Some(c) if c.busy => {
                    return Err("this conversation is still answering, stop it first".into())
                }
                Some(_) => {
                    chats.remove(id);
                }
            }
        }
        match std::fs::remove_file(self.shared.file(id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("could not delete the conversation: {e}"))
            }
            _ => Ok(()),
        }
    }

    pub fn clear(&self) -> Result<usize, String> {
        let idle: Vec<String> = self
            .shared
            .lock()
            .values()
            .filter(|c| !c.busy)
            .map(|c| c.stored.id.clone())
            .collect();
        for id in &idle {
            self.delete(id)?;
        }
        Ok(self.shared.lock().len())
    }

    async fn claude(&self) -> Result<Vec<String>, String> {
        if let Some(argv) = self.command.lock().expect("dispatch lock").clone() {
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
            .ok_or("Claude Code is not installed on this machine, Dispatch needs it")?
            .to_string();
        *self.command.lock().expect("dispatch lock") = Some(vec![path.clone()]);
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
        let path = self.shared.dir.join("mcp.json");
        write_private(&path, config.to_string().as_bytes())
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        Ok(path)
    }

    fn begin(
        &self,
        id: Option<&str>,
        text: &str,
        cancel: Arc<Notify>,
    ) -> Result<(String, Option<String>), String> {
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
                    Conversation {
                        stored: Stored {
                            id: id.clone(),
                            title: title_of(text),
                            created: stamp.clone(),
                            updated: stamp,
                            ..Stored::default()
                        },
                        busy: false,
                        cancel: None,
                    },
                );
                id
            }
        };
        let c = chats.get_mut(&id).expect("conversation exists");
        c.busy = true;
        c.cancel = Some(cancel);
        c.stored
            .events
            .push(json!({ "role": "user", "text": text }));
        c.stored.updated = now();
        Ok((id, c.stored.claude_session.clone()))
    }

    pub async fn ask(
        &self,
        conversation: Option<&str>,
        text: &str,
        port: u16,
    ) -> Result<(String, mpsc::Receiver<Value>), String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("type a task first".into());
        }
        let mut argv = self.claude().await?;
        let config = self.write_mcp_config(port)?;
        let cancel = Arc::new(Notify::new());
        let (id, resume) = self.begin(conversation, text, cancel.clone())?;
        self.shared.save(&id);
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
        if let Some(session) = resume {
            argv.extend(["--resume".into(), session]);
        }
        let (tx, rx) = mpsc::channel(64);
        let shared = self.shared.clone();
        let turn = id.clone();
        tokio::spawn(async move {
            let outcome =
                tokio::time::timeout(TURN_LIMIT, run_turn(argv, &shared, &turn, &tx, cancel))
                    .await
                    .unwrap_or_else(|_| {
                        Err("Dispatch took longer than 15 minutes and was stopped".into())
                    });
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

async fn run_turn(
    argv: Vec<String>,
    shared: &Shared,
    id: &str,
    tx: &mpsc::Sender<Value>,
    cancel: Arc<Notify>,
) -> Result<(), String> {
    let mut child = tokio::process::Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(&shared.dir)
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
        if let Some(session) = message["session_id"].as_str() {
            if let Some(c) = shared.lock().get_mut(id) {
                c.stored.claude_session = Some(session.to_string());
            }
        }
        finished |= message["type"] == "result";
        for event in events_of(&message, &mut tools) {
            shared.push(id, event.clone());
            let _ = tx.send(event).await;
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

    #[test]
    fn titles_and_ids() {
        assert_eq!(
            title_of("  fix the login bug\nmore detail"),
            "fix the login bug"
        );
        assert_eq!(title_of(&"a".repeat(90)).chars().count(), 81);
        let id = new_id();
        assert!(valid_id(&id), "{id}");
        assert!(!valid_id("../../etc/passwd"));
        assert!(!valid_id("ABCDEFGHIJKLMNOP"));
    }

    fn fake_claude(dir: &Path, script: &str) -> Dispatch {
        static COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = dir.join(format!("claude-{n}"));
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        Dispatch::new(Arc::new(FakeRunner::default()), dir.join("dispatch"))
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
    async fn conversations_resume_their_own_claude_session_and_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let script = format!(
            r#"printf '%s\n' "$@" > {}
echo '{{"type":"system","subtype":"init","session_id":"s-'$$'"}}'
echo '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"Started on mini."}}]}}}}'
echo '{{"type":"result","is_error":false,"result":"Started on mini."}}'"#,
            args.display()
        );
        let dispatch = fake_claude(dir.path(), &script);
        let (first, rx) = dispatch.ask(None, "fix the login bug", 4000).await.unwrap();
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
        let config = std::fs::read_to_string(dir.path().join("dispatch/mcp.json")).unwrap();
        assert!(config.contains(&format!("Bearer {}", dispatch.token())));

        let (second, rx) = dispatch.ask(None, "update the docs", 4000).await.unwrap();
        drain(rx).await;
        assert_ne!(first, second);

        let session = dispatch.shared.lock()[&first]
            .stored
            .claude_session
            .clone()
            .unwrap();
        let (again, rx) = dispatch
            .ask(Some(&first), "and logout", 4000)
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
    }

    #[tokio::test]
    async fn a_failing_claude_reports_its_error() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "echo 'not logged in' >&2; exit 1");
        let (_, rx) = dispatch.ask(None, "hi", 4000).await.unwrap();
        assert_eq!(
            drain(rx).await,
            [
                json!({ "role": "error", "text": "Claude Code stopped: not logged in" }),
                json!({ "role": "done" })
            ]
        );
    }

    #[tokio::test]
    async fn busy_conversations_refuse_delete_and_survive_clear() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "sleep 30");
        let (busy, rx) = dispatch.ask(None, "long task", 4000).await.unwrap();
        assert_eq!(
            dispatch.ask(Some(&busy), "again", 4000).await.unwrap_err(),
            "this conversation is still answering"
        );
        assert!(dispatch.delete(&busy).is_err());

        let quick = fake_claude(dir.path(), "true");
        let (idle, rx2) = quick.ask(None, "short task", 4000).await.unwrap();
        drain(rx2).await;
        assert!(dir
            .path()
            .join(format!("dispatch/conversations/{idle}.json"))
            .exists());
        quick.delete(&idle).unwrap();
        assert!(!dir
            .path()
            .join(format!("dispatch/conversations/{idle}.json"))
            .exists());
        assert_eq!(quick.delete(&idle).unwrap_err(), "no such conversation");

        assert_eq!(dispatch.clear().unwrap(), 1, "the busy one is kept");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        dispatch.stop(&busy);
        let events = drain(rx).await;
        assert_eq!(events[0], json!({ "role": "error", "text": "stopped" }));
        assert_eq!(dispatch.clear().unwrap(), 0);
        assert_eq!(dispatch.list(), json!([]));
    }

    #[tokio::test]
    async fn a_missing_claude_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = Dispatch::new(Arc::new(FakeRunner::default()), dir.path().join("d"));
        assert_eq!(
            dispatch.ask(None, "hi", 4000).await.unwrap_err(),
            "Claude Code is not installed on this machine, Dispatch needs it"
        );
        assert_eq!(
            dispatch.list(),
            json!([]),
            "nothing is saved when Claude is missing"
        );
    }
}

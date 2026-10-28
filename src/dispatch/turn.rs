use super::mcp_config::extra_servers;
use super::prompt::system_prompt;
use super::store::{new_id, now, title_of, Conversation, Shared, Stored};
use super::{actions, usage, Dispatch};
use crate::config::DispatchSettings;
use crate::shell::{login_shell, Duration};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Notify};

const TURN_LIMIT: Duration = Duration::from_secs(900);
const RESULT_PREVIEW: usize = 4000;
const TOOL_PREFIX: &str = "mcp__yardbell__";
const TOOLS: [&str; 8] = [
    "list_machines",
    "list_sessions",
    "list_folders",
    "start_session",
    "read_session",
    "send_to_session",
    "stop_session",
    "review_session",
];

impl Dispatch {
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

    // Returns the conversation, the Claude session to resume, and the prompt: the message, after
    // anything Dispatch has not heard about yet, such as what the person did with its proposals.
    fn begin(
        &self,
        id: Option<&str>,
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
                        title: title_of(text),
                        created: stamp.clone(),
                        updated: stamp,
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
        actions::withdraw(&mut c.stored.events, &stamp);
        let news = actions::untold(&mut c.stored.events);
        c.stored
            .events
            .push(json!({ "role": "user", "text": text }));
        c.stored.updated = stamp;
        Ok((
            id,
            c.stored.claude_session.clone(),
            actions::with_news(&news, text),
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
        let text = text.trim();
        if text.is_empty() {
            return Err("type a task first".into());
        }
        let mut argv = self.claude().await?;
        let cancel = Arc::new(Notify::new());
        let (tx, rx) = mpsc::channel(64);
        let (id, resume, prompt) = self.begin(conversation, text, cancel.clone(), tx.clone())?;
        let config = match self.write_mcp_config(port, extra, &id) {
            Ok(config) => config,
            Err(e) => {
                self.shared.finish(&id);
                return Err(e);
            }
        };
        self.shared.save(&id);
        let mut allowed: Vec<String> = TOOLS.iter().map(|t| format!("{TOOL_PREFIX}{t}")).collect();
        allowed.extend(
            extra_servers(extra)
                .into_iter()
                .map(|name| format!("mcp__{name}")),
        );
        argv.extend(
            [
                "-p",
                &prompt,
                "--output-format",
                "stream-json",
                "--verbose",
                "--mcp-config",
                &config.display().to_string(),
                "--strict-mcp-config",
                "--allowedTools",
                &allowed.join(","),
                "--append-system-prompt",
                &system_prompt(settings),
            ]
            .map(String::from),
        );
        if !settings.model.is_empty() {
            argv.extend(["--model".into(), settings.model.clone()]);
        }
        if let Some(session) = resume {
            argv.extend(["--resume".into(), session]);
        }
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
        if let Some(found) = usage::from_stream(&message) {
            shared.set_usage(found);
        }
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
                    // A step that changes something is recorded by the MCP server as a step of
                    // its own, with its decision and result.
                    (!actions::changes_something(name))
                        .then(|| json!({ "role": "tool", "name": name, "input": part["input"] }))
                }
                _ => None,
            })
            .collect(),
        Some("user") => parts
            .into_iter()
            .flatten()
            .filter(|part| part["type"] == "tool_result")
            .filter_map(|part| {
                let name = tools
                    .get(part["tool_use_id"].as_str()?)
                    .filter(|name| !actions::changes_something(name))?;
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
    use crate::dispatch::tests::{conversation, drain, fake_claude, start_input};
    use crate::dispatch::{By, Refusal};
    use crate::testing::FakeRunner;

    #[test]
    fn stream_json_becomes_chat_events() {
        let mut tools = HashMap::new();
        let call = json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": "Looking at your machines." },
            { "type": "tool_use", "id": "t1", "name": "mcp__yardbell__list_folders", "input": { "machine": "mini" } },
        ]}});
        assert_eq!(
            events_of(&call, &mut tools),
            [
                json!({ "role": "assistant", "text": "Looking at your machines." }),
                json!({ "role": "tool", "name": "list_folders", "input": { "machine": "mini" } }),
            ]
        );
        let result = json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": "[]" }] },
        ]}});
        assert_eq!(
            events_of(&result, &mut tools),
            [
                json!({ "role": "tool_result", "name": "list_folders", "text": "[]", "is_error": false })
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
        let step = json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "t3", "name": "mcp__yardbell__start_session", "input": { "machine": "mini" } },
        ]}});
        assert!(
            events_of(&step, &mut tools).is_empty(),
            "a step is recorded by the MCP server instead"
        );
        let step_result = json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "t3", "content": "Not run yet." },
        ]}});
        assert!(events_of(&step_result, &mut tools).is_empty());
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
            .claude_session
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
}

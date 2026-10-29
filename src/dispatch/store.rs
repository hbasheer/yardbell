use super::{actions, follow, missing, Refusal};
use crate::config::RunsOn;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, Notify};

const TITLE_CHARS: usize = 80;
const ID_LEN: usize = 16;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct Stored {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) created: String,
    pub(super) updated: String,
    // A conversation stays on the agent it started on, since one's session means nothing to the
    // other. Conversations from before Codex ran on Claude Code.
    #[serde(default, skip_serializing_if = "RunsOn::is_default")]
    pub(super) backend: RunsOn,
    #[serde(default, alias = "claude_session")]
    pub(super) session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) instructions: Option<String>,
    #[serde(default)]
    pub(super) events: Vec<Value>,
    #[serde(default)]
    pub(super) sessions: Vec<follow::Tracked>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) trigger: Option<Value>,
}

pub(super) struct Conversation {
    pub(super) stored: Stored,
    pub(super) busy: bool,
    pub(super) cancel: Option<Arc<Notify>>,
    pub(super) live: Option<mpsc::Sender<Value>>,
    // Whether the agent reached Yardbell's MCP server during the turn now running.
    pub(super) reached: bool,
}

impl Conversation {
    pub(super) fn new(stored: Stored) -> Conversation {
        Conversation {
            stored,
            busy: false,
            cancel: None,
            live: None,
            reached: false,
        }
    }
}

pub(super) struct Shared {
    pub(super) dir: PathBuf,
    pub(super) chats: Mutex<HashMap<String, Conversation>>,
    pub(super) usage: Mutex<Option<Value>>,
    pub(super) codex_usage: Mutex<Option<Value>>,
    pub(super) codex_home: Option<PathBuf>,
}

impl Shared {
    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Conversation>> {
        self.chats.lock().expect("dispatch lock")
    }

    pub(super) fn file(&self, id: &str) -> PathBuf {
        self.dir.join("conversations").join(format!("{id}.json"))
    }

    pub(super) fn push(&self, id: &str, event: Value) {
        if let Some(c) = self.lock().get_mut(id) {
            c.stored.events.push(event);
            c.stored.updated = now();
        }
    }

    pub(super) fn save(&self, id: &str) {
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

    pub(super) fn usage_file(dir: &Path, runs_on: RunsOn) -> PathBuf {
        dir.join(match runs_on {
            RunsOn::Claude => "usage.json",
            RunsOn::Codex => "usage-codex.json",
        })
    }

    pub(super) fn set_usage(&self, usage: Value) {
        self.keep_usage(RunsOn::Claude, usage);
    }

    pub(super) fn keep_usage(&self, runs_on: RunsOn, usage: Value) {
        if let Err(e) = write_private(
            &Shared::usage_file(&self.dir, runs_on),
            &serde_json::to_vec(&usage).unwrap_or_default(),
        ) {
            tracing::warn!(error = %e, "could not save the {} usage", runs_on.label());
        }
        let slot = match runs_on {
            RunsOn::Claude => &self.usage,
            RunsOn::Codex => &self.codex_usage,
        };
        *slot.lock().expect("dispatch lock") = Some(usage);
    }

    pub(super) fn finish(&self, id: &str) {
        if let Some(c) = self.lock().get_mut(id) {
            c.busy = false;
            c.cancel = None;
            c.live = None;
            c.reached = false;
        }
        self.save(id);
    }

    // An event that does not come from Claude's own output, such as a proposal made through the
    // MCP server, still reaches a page that is streaming the turn.
    pub(super) fn send_live(&self, id: &str, event: &Value) {
        let live = self.lock().get(id).and_then(|c| c.live.clone());
        if let Some(live) = live {
            let _ = live.try_send(event.clone());
        }
    }

    pub(super) fn edit<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut Stored) -> Result<T, Refusal>,
    ) -> Result<T, Refusal> {
        let out = {
            let mut chats = self.lock();
            let c = chats.get_mut(id).ok_or_else(|| missing("conversation"))?;
            let out = change(&mut c.stored)?;
            c.stored.updated = now();
            out
        };
        self.save(id);
        Ok(out)
    }
}

pub(super) fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

pub(crate) fn new_id() -> String {
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

pub(super) fn title_of(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    if line.chars().count() <= TITLE_CHARS {
        return line.to_string();
    }
    let mut cut: String = line.chars().take(TITLE_CHARS).collect();
    cut.push('…');
    cut
}

pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
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

pub(super) fn load(dir: &Path) -> HashMap<String, Conversation> {
    let Ok(entries) = std::fs::read_dir(dir.join("conversations")) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let text = std::fs::read(e.path()).ok()?;
            let mut stored: Stored = serde_json::from_slice(&text)
                .inspect_err(|err| tracing::warn!(error = %err, "skipping {}", e.path().display()))
                .ok()?;
            valid_id(&stored.id).then_some(())?;
            actions::interrupted(&mut stored.events);
            super::group::resumed(&mut stored.events);
            Some((stored.id.clone(), Conversation::new(stored)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DispatchSettings;
    use crate::dispatch::tests::{conversation, drain, fake_claude, start_input};
    use crate::dispatch::By;
    use serde_json::json;

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

    #[tokio::test]
    async fn conversations_saved_before_steps_existed_still_open_and_continue() {
        let dir = tempfile::tempdir().unwrap();
        let saved = json!({
            "id": "oldconversation1",
            "title": "fix the login bug",
            "created": "2026-10-20T10:00:00+03:00",
            "updated": "2026-10-20T10:01:00+03:00",
            "claude_session": "s-old",
            "events": [
                { "role": "user", "text": "fix the login bug" },
                { "role": "tool", "name": "start_session", "input": { "machine": "hp", "folder": "app" } },
                { "role": "tool_result", "name": "start_session", "text": "{\"machine\":\"hp\",\"name\":\"hp-app\",\"path\":\"/r/app\"}", "is_error": false },
                { "role": "assistant", "text": "Started hp-app." },
                { "role": "session", "machine": "hp", "name": "hp-app", "path": "/r/app", "state": "idle", "screen": "done", "options": [], "at": "2026-10-20T10:30:00+03:00" }
            ],
            "sessions": [{ "machine": "hp", "name": "hp-app", "path": "/r/app", "last": "idle" }]
        });
        let conversations = dir.path().join("dispatch/conversations");
        std::fs::create_dir_all(&conversations).unwrap();
        std::fs::write(
            conversations.join("oldconversation1.json"),
            saved.to_string(),
        )
        .unwrap();
        let args = dir.path().join("args");
        let dispatch = fake_claude(
            dir.path(),
            &format!(r#"printf '%s\n' "$@" > {}"#, args.display()),
        );
        let convo = dispatch.get("oldconversation1").unwrap();
        assert_eq!(convo["events"], saved["events"]);
        assert_eq!(convo["sessions"][0]["name"], "hp-app");
        assert!(convo["sessions"][0].get("review").is_none());
        assert_eq!(dispatch.list()[0]["waiting"], 0);
        let (_, rx) = dispatch
            .ask(
                Some("oldconversation1"),
                "is it done?",
                4000,
                &DispatchSettings::default(),
                None,
            )
            .await
            .unwrap();
        drain(rx).await;
        let sent = std::fs::read_to_string(&args).unwrap();
        assert!(sent.starts_with("-p\nis it done?\n"), "{sent}");
        assert!(sent.ends_with("--resume\ns-old\n"), "{sent}");
    }

    #[tokio::test]
    async fn a_step_cut_short_by_a_restart_is_marked_failed() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = conversation(&dispatch, "fix it").await;
        let step = dispatch
            .propose(
                &id,
                "start_session",
                start_input(),
                By::Dispatch,
                None,
                None,
            )
            .unwrap();
        let step = step["id"].as_str().unwrap().to_string();
        dispatch.approve(&id, &step, None).unwrap();
        let reopened = fake_claude(dir.path(), "true");
        let stored = reopened.step(&id, &step).unwrap();
        assert_eq!(stored["result"]["ok"], false);
        assert!(stored["result"]["text"]
            .as_str()
            .unwrap()
            .starts_with("Yardbell restarted before this finished"));
    }
}

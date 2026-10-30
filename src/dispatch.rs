mod actions;
mod backend;
pub(crate) mod diff;
mod follow;
mod group;
mod mcp_config;
mod memory;
mod prompt;
mod pull;
mod read_only;
mod review;
mod rules;
mod store;
mod tasks;
mod turn;
mod usage;

pub use actions::{changes_something, result as step_result, valid_id as valid_action_id, By};
pub use diff::{Op as DiffOp, Part as DiffPart};
pub use follow::Change;
pub use group::{
    clash as group_clash, clash_message as group_clash_message, parse as parse_result,
    plan as plan_group, with_request as with_result_request, ChildStart, Due as GroupDue,
    Opened as GroupOpened, Outcome as GroupOutcome, Place as GroupPlace, Plan as GroupPlan,
    MAX_CHILDREN as GROUP_MAX, MAX_MINUTES as GROUP_MAX_MINUTES, MIN_CHILDREN as GROUP_MIN,
};
pub use mcp_config::CONVERSATION_HEADER;
pub use memory::{Memory, MemoryChange};
pub(crate) use review::{bullet, clip, is_marker, unframed, value_of};
pub use review::{
    changed_file as review_file, changed_files as review_files, evidence_folder, file_view,
    fix_request, found_by, picked as review_picked, places as finding_files,
    prompt as review_prompt, scan_prompt, valid_path as valid_review_path, Anchor as ReviewAnchor,
    ReviewOf, ScanKind, Screenshots,
};
pub use rules::{
    decide as decide_step, decide_always_wait, decide_memory, folder_matches, valid_folder_pattern,
    validate as validate_rules, Rule, Step, Verdict,
};
pub(crate) use store::new_id as new_conversation_id;
pub use store::valid_id;
pub use store::write_private;
pub use tasks::{History as TaskHistory, SavedTask, Version as TaskVersion, MAX_VERSIONS};
pub use turn::Opening;

use crate::config::RunsOn;
use crate::shell::Runner;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use store::{load, now, Conversation, Shared, Stored};

#[derive(Debug, Clone, PartialEq)]
pub struct Origin {
    pub conversation: String,
    pub prompt: String,
    pub task: Option<(String, Option<u32>)>,
}

#[derive(Debug, PartialEq)]
pub enum Refusal {
    Missing(String),
    Taken(String),
}

impl Refusal {
    pub fn message(&self) -> &str {
        match self {
            Refusal::Missing(m) | Refusal::Taken(m) => m,
        }
    }
}

fn missing(what: &str) -> Refusal {
    Refusal::Missing(format!("no such {what}"))
}

pub struct Dispatch {
    runner: Arc<dyn Runner>,
    commands: Mutex<HashMap<RunsOn, Vec<String>>>,
    token: String,
    shared: Arc<Shared>,
    memory: Memory,
}

impl Dispatch {
    pub fn new(runner: Arc<dyn Runner>, dir: PathBuf) -> Dispatch {
        let chats = Mutex::new(load(&dir));
        let usage = |runs_on| {
            std::fs::read(Shared::usage_file(&dir, runs_on))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        };
        let (claude_usage, codex_usage) = (usage(RunsOn::Claude), usage(RunsOn::Codex));
        Dispatch {
            runner,
            commands: Mutex::new(HashMap::new()),
            token: crate::mcp::new_token(),
            memory: Memory::new(&dir),
            shared: Arc::new(Shared {
                dir,
                chats,
                usage: Mutex::new(claude_usage),
                codex_usage: Mutex::new(codex_usage),
                codex_home: backend::codex::home(),
            }),
        }
    }

    pub fn with_command(self, argv: Vec<String>) -> Dispatch {
        self.with_agent(RunsOn::Claude, argv)
    }

    pub fn with_agent(self, runs_on: RunsOn, argv: Vec<String>) -> Dispatch {
        self.commands
            .lock()
            .expect("dispatch lock")
            .insert(runs_on, argv);
        self
    }

    pub fn with_codex_home(mut self, home: PathBuf) -> Dispatch {
        if let Some(shared) = Arc::get_mut(&mut self.shared) {
            shared.codex_home = Some(home);
        }
        self
    }

    // The MCP server saw a request from this conversation's agent, so the agent reached
    // Yardbell's tools.
    pub fn reached(&self, id: &str) {
        if let Some(c) = self.shared.lock().get_mut(id) {
            c.reached = true;
        }
    }

    pub fn codex_models(&self) -> Vec<String> {
        self.shared
            .codex_home
            .as_deref()
            .map(backend::codex::models)
            .unwrap_or_default()
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn memory(&self) -> &Memory {
        &self.memory
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
                "waiting": actions::pending(&c.stored.events).count(),
                "trigger": c.stored.trigger.as_ref().map(|t| &t["name"]),
                "backend": c.stored.backend,
            }))
            .collect::<Vec<_>>())
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        let chats = self.shared.lock();
        let c = chats.get(id)?;
        Some(json!({
            "id": c.stored.id,
            "title": c.stored.title,
            "updated": c.stored.updated,
            "events": c.stored.events,
            "sessions": c.stored.sessions,
            "busy": c.busy,
            "trigger": c.stored.trigger,
            "backend": c.stored.backend,
        }))
    }

    // Where a session Dispatch started came from: the task it was given, and the saved task
    // that the conversation ran, from its trigger or from the message that asked for it.
    pub fn origin(&self, machine: &str, name: &str) -> Option<Origin> {
        let chats = self.shared.lock();
        let mut found: Vec<(&str, usize, &Conversation)> = chats
            .values()
            .filter_map(|c| {
                let i = c.stored.events.iter().rposition(|e| {
                    e["role"] == "action"
                        && e["tool"] == "start_session"
                        && e["result"]["session"]["machine"] == machine
                        && e["result"]["session"]["name"] == name
                })?;
                Some((c.stored.updated.as_str(), i, c))
            })
            .collect();
        found.sort_by(|a, b| b.0.cmp(a.0));
        let (_, i, c) = found.into_iter().next()?;
        let events = &c.stored.events;
        let task = |mark: &Value| {
            let task = mark["name"].as_str().filter(|n| !n.is_empty())?;
            Some((
                task.to_string(),
                mark["version"].as_u64().and_then(|v| u32::try_from(v).ok()),
            ))
        };
        let asked = events[..i]
            .iter()
            .rev()
            .find(|e| e["role"] == "user" && e["by"] != "yardbell");
        let from = asked.and_then(|e| task(&e["task"])).or_else(|| {
            let t = c.stored.trigger.as_ref()?;
            task(&json!({ "name": t["task"], "version": t["version"] }))
        });
        let input = &events[i]["input"];
        Some(Origin {
            conversation: c.stored.id.clone(),
            prompt: input["prompt"].as_str().unwrap_or_default().to_string(),
            task: from,
        })
    }

    pub fn triggered_busy(&self, trigger: &str) -> bool {
        self.shared.lock().values().any(|c| {
            c.busy
                && c.stored
                    .trigger
                    .as_ref()
                    .is_some_and(|t| t["name"] == trigger)
        })
    }

    pub fn event(&self, id: &str, index: usize) -> Option<Value> {
        self.shared
            .lock()
            .get(id)?
            .stored
            .events
            .get(index)
            .cloned()
    }

    pub fn step(&self, id: &str, action: &str) -> Option<Value> {
        let mut chats = self.shared.lock();
        actions::find(&mut chats.get_mut(id)?.stored.events, action).map(|a| a.clone())
    }

    pub fn pending(&self, id: &str) -> Vec<String> {
        self.shared
            .lock()
            .get(id)
            .map(|c| {
                actions::pending(&c.stored.events)
                    .filter_map(|e| e["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    // A conversation of its own for a step the person asks for outside one, such as a scan of a
    // folder started before any message.
    pub fn open_conversation(&self, title: &str) -> String {
        let id = store::new_id();
        let stamp = now();
        self.shared.lock().insert(
            id.clone(),
            Conversation::new(Stored {
                id: id.clone(),
                title: store::title_of(title),
                created: stamp.clone(),
                updated: stamp,
                ..Stored::default()
            }),
        );
        self.shared.save(&id);
        id
    }

    pub fn propose(
        &self,
        id: &str,
        tool: &str,
        input: Value,
        by: By,
        review: Option<ReviewOf>,
        rule: Option<&Rule>,
    ) -> Result<Value, Refusal> {
        let mut event = actions::event(tool, input, by, review.as_ref(), "pending", &now());
        if let Some(rule) = rule {
            event["rule"] = json!(rule);
        }
        self.shared.edit(id, |s| {
            s.events.push(event.clone());
            Ok(())
        })?;
        self.shared.send_live(id, &event);
        Ok(event)
    }

    // A step that ran without asking: Dispatch already saw its result, so it is recorded as told.
    pub fn record(
        &self,
        id: &str,
        tool: &str,
        input: Value,
        review: Option<ReviewOf>,
        rule: Option<&Rule>,
        outcome: &Result<Value, String>,
    ) {
        self.record_as(id, tool, input, review, rule, outcome, By::Dispatch, None);
    }

    // The pipeline's steps are not Dispatch's, so Dispatch hears of them at its next turn.
    #[allow(clippy::too_many_arguments)]
    pub fn record_as(
        &self,
        id: &str,
        tool: &str,
        input: Value,
        review: Option<ReviewOf>,
        rule: Option<&Rule>,
        outcome: &Result<Value, String>,
        by: By,
        run_started: Option<&str>,
    ) {
        let at = now();
        let mut event = actions::event(tool, input, by, review.as_ref(), "auto", &at);
        if let Some(rule) = rule {
            event["rule"] = json!(rule);
        }
        if let Some(started) = run_started {
            event["run_started"] = json!(started);
        }
        event["result"] = actions::result(outcome, &at);
        event["told"] = json!(by != By::Pipeline);
        let recorded = self.shared.edit(id, |s| {
            track(s, &event);
            s.events.push(event.clone());
            Ok(())
        });
        if recorded.is_ok() {
            self.shared.send_live(id, &event);
        }
    }

    // Claims the step for the person who approved it, so a second click or a second device
    // cannot run it again. Returns the tool and the input to run, edited or not.
    pub fn approve(
        &self,
        id: &str,
        action: &str,
        edited: Option<Value>,
    ) -> Result<(String, Value), Refusal> {
        let at = now();
        self.shared.edit(id, |s| {
            let a = undecided(&mut s.events, action)?;
            match edited.filter(|input| *input != a["input"]) {
                Some(input) => {
                    a["original"] = a["input"].take();
                    a["input"] = input;
                    a["status"] = json!("edited");
                }
                None => a["status"] = json!("approved"),
            }
            a["decided"] = json!(at);
            Ok((
                a["tool"].as_str().unwrap_or_default().to_string(),
                a["input"].clone(),
            ))
        })
    }

    pub fn reject(&self, id: &str, action: &str) -> Result<Value, Refusal> {
        let at = now();
        self.shared.edit(id, |s| {
            let a = undecided(&mut s.events, action)?;
            a["status"] = json!("rejected");
            a["decided"] = json!(at);
            Ok(a.clone())
        })
    }

    pub fn ran(
        &self,
        id: &str,
        action: &str,
        outcome: &Result<Value, String>,
    ) -> Result<Value, Refusal> {
        let at = now();
        self.shared.edit(id, |s| {
            let a = actions::find(&mut s.events, action).ok_or_else(|| missing("step"))?;
            a["result"] = actions::result(outcome, &at);
            let event = a.clone();
            track(s, &event);
            Ok(event)
        })
    }

    pub fn answered(
        &self,
        id: &str,
        index: usize,
        key: &str,
        label: &str,
    ) -> Result<Value, Refusal> {
        let at = now();
        self.shared.edit(id, |s| {
            let card = s
                .events
                .get_mut(index)
                .filter(|e| e["role"] == "session")
                .ok_or_else(|| missing("question"))?;
            if let Some(earlier) = card["answer"]["label"].as_str() {
                return Err(Refusal::Taken(format!(
                    "it was already answered with {earlier}"
                )));
            }
            card["answer"] = json!({ "key": key, "label": label, "at": at });
            Ok(card.clone())
        })
    }

    pub fn review_outcome(&self, id: &str, index: usize, outcome: Value) -> Result<Value, Refusal> {
        let at = now();
        self.shared.edit(id, |s| {
            let review = s
                .events
                .get_mut(index)
                .filter(|e| e["role"] == "review")
                .ok_or_else(|| missing("review"))?;
            if review["outcome"].is_object() {
                return Err(Refusal::Taken("this review was already handled".into()));
            }
            review["outcome"] = outcome;
            review["outcome"]["at"] = json!(at);
            Ok(review.clone())
        })
    }

    pub fn observe(&self, view: &crate::state::StateView) -> Vec<Change> {
        let mut found = Vec::new();
        let mut touched = Vec::new();
        {
            let mut chats = self.shared.lock();
            for c in chats.values_mut() {
                let before = c.stored.sessions.clone();
                found.extend(follow::changes(&c.stored.id, &mut c.stored.sessions, view));
                if c.stored.sessions != before {
                    touched.push(c.stored.id.clone());
                }
            }
        }
        for id in touched {
            self.shared.save(&id);
        }
        found
    }

    pub fn report(&self, change: &Change, screen: &str) {
        if self.group_report(change, screen) {
            return;
        }
        let event = self
            .review_result(change, screen)
            .unwrap_or_else(|| follow::event(change, screen));
        self.shared.push(&change.conversation, event);
        self.shared.save(&change.conversation);
    }

    // A review's card also gets its screenshots and the start of its diff, read from the
    // reviewer's machine before the card is shown. A scan has neither.
    pub async fn report_from(
        &self,
        change: &Change,
        screen: &str,
        folders: &crate::folders::Folders,
        m: &crate::config::Machine,
    ) {
        if self.group_report(change, screen) {
            return;
        }
        let event = match self.review_result(change, screen) {
            Some(scan) if scan["of"]["scan"].is_string() => scan,
            Some(review) => {
                let store = self.evidence_dir(&change.conversation);
                review::gather(review, &store, folders, m).await
            }
            None => follow::event(change, screen),
        };
        self.shared.push(&change.conversation, event);
        self.shared.save(&change.conversation);
    }

    fn evidence_dir(&self, id: &str) -> PathBuf {
        self.shared.dir.join("evidence").join(id)
    }

    pub fn evidence(&self, id: &str, card: usize, file: &str) -> Option<Vec<u8>> {
        let review = self.event(id, card).filter(|e| e["role"] == "review")?;
        let listed = review["evidence"]
            .as_array()?
            .iter()
            .any(|e| e["file"] == file);
        (listed && review::valid_evidence_file(file))
            .then(|| std::fs::read(self.evidence_dir(id).join(file)).ok())
            .flatten()
    }

    // A reviewer that finished with its report gives a review result instead of a session card,
    // once: the same report seen again, after the person typed into the reviewer, is a card.
    // A scanner's report is read the same way, from its own block.
    fn review_result(&self, change: &Change, screen: &str) -> Option<Value> {
        let of = change.review.as_ref().filter(|_| change.state == "idle")?;
        let report = match of.scan_kind() {
            Some(_) => review::parse_scan(screen)?.to_scan_json(),
            None => review::parse(screen)?.to_json(),
        };
        let chats = self.shared.lock();
        let earlier = chats
            .get(&change.conversation)?
            .stored
            .events
            .iter()
            .rev()
            .find(|e| {
                e["role"] == "review" && e["machine"] == change.machine && e["name"] == change.name
            });
        let same = |e: &Value| {
            ["verdict", "summary", "findings"]
                .iter()
                .all(|k| e[k] == report[k])
        };
        if earlier.is_some_and(same) {
            return None;
        }
        let mut event = json!({
            "role": "review",
            "machine": change.machine,
            "name": change.name,
            "path": change.path,
            "of": of,
            "at": now(),
        });
        for key in ["verdict", "summary", "findings"] {
            event[key] = report[key].clone();
        }
        Some(event)
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
        let _ = std::fs::remove_file(self.mcp_config_file(id));
        let _ = std::fs::remove_dir_all(self.evidence_dir(id));
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
}

fn undecided<'a>(events: &'a mut [Value], action: &str) -> Result<&'a mut Value, Refusal> {
    let a = actions::find(events, action).ok_or_else(|| missing("step"))?;
    match a["status"].as_str().unwrap_or_default() {
        "pending" => Ok(a),
        "withdrawn" => Err(Refusal::Taken(
            "this step was withdrawn when you sent a new message".into(),
        )),
        decided => Err(Refusal::Taken(format!("this step was already {decided}"))),
    }
}

// A session started by an approved step is followed like one Dispatch started itself, and a
// reviewer keeps what it reviews.
fn track(stored: &mut Stored, action: &Value) {
    if action["tool"] != "start_session" {
        return;
    }
    let Some(mut t) = follow::started(&action["result"]["session"]) else {
        return;
    };
    t.review = serde_json::from_value(action["review"].clone()).ok();
    let known = stored
        .sessions
        .iter()
        .any(|s| s.machine == t.machine && s.name == t.name);
    if !known {
        stored.sessions.push(t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DispatchSettings;
    use crate::testing::FakeRunner;
    use std::path::Path;
    use tokio::sync::mpsc;

    pub(super) fn fake_script(dir: &Path, name: &str, shell: &str, script: &str) -> String {
        static COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = dir.join(format!("{name}-{n}"));
        std::fs::write(&path, format!("#!{shell}\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        path.display().to_string()
    }

    pub(super) fn fake_claude(dir: &Path, script: &str) -> Dispatch {
        Dispatch::new(Arc::new(FakeRunner::default()), dir.join("dispatch"))
            .with_command(vec![fake_script(dir, "claude", "/bin/sh", script)])
    }

    pub(super) async fn drain(mut rx: mpsc::Receiver<Value>) -> Vec<Value> {
        let mut all = Vec::new();
        while let Some(event) = rx.recv().await {
            all.push(event);
        }
        all
    }

    fn view(activity: Option<crate::snapshot::Activity>, name: &str) -> crate::state::StateView {
        use crate::state::{MachineView, SessionView, StateView};
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines: vec![MachineView {
                name: "hp".into(),
                up: true,
                reason: None,
                last_seen: None,
                local: true,
                health: None,
                accounts: Vec::new(),
                mesh_on: None,
            }],
            folders: vec![],
            sessions: activity
                .into_iter()
                .map(|activity| SessionView {
                    pull_why: None,
                    id: "x".into(),
                    machine: "hp".into(),
                    agent: "claude".into(),
                    pid: 1,
                    folder: "app".into(),
                    ticket: "-".into(),
                    branch: "main".into(),
                    activity,
                    attachable: true,
                    tmux: Some(name.into()),
                    stale: false,
                    ports: vec![],
                    pull: None,
                    path: String::new(),
                    worktree: false,
                    setup: None,
                })
                .collect(),
            ended: vec![],
            host_terminal: crate::config::HostTerminal::None,
            mesh: None,
            server: None,
            proposals: 0,
        }
    }

    pub(super) async fn conversation(dispatch: &Dispatch, text: &str) -> String {
        let (id, rx) = dispatch
            .ask(None, text, 4000, &DispatchSettings::default(), None)
            .await
            .unwrap();
        drain(rx).await;
        id
    }

    pub(super) fn start_input() -> Value {
        json!({ "machine": "hp", "folder": "app", "branch": "eng-1", "prompt": "fix it" })
    }

    #[tokio::test]
    async fn approved_sessions_are_followed_into_the_conversation() {
        use crate::snapshot::Activity;
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let script = format!(
            r#"printf '%s\n' "$@" > {}
echo '{{"type":"system","subtype":"init","session_id":"s1"}}'
echo '{{"type":"result","is_error":false,"result":"ok"}}'"#,
            args.display()
        );
        let dispatch = fake_claude(dir.path(), &script);
        let linear =
            r#"{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}}"#;
        let (id, rx) = dispatch
            .ask(
                None,
                "fix it",
                4000,
                &DispatchSettings::default(),
                Some(linear),
            )
            .await
            .unwrap();
        drain(rx).await;
        let config =
            std::fs::read_to_string(dir.path().join(format!("dispatch/mcp/{id}.json"))).unwrap();
        assert!(
            config.contains("mcp.linear.app")
                && config.contains(&format!(r#""{CONVERSATION_HEADER}":"{id}""#)),
            "{config}"
        );
        assert!(std::fs::read_to_string(&args)
            .unwrap()
            .contains("mcp__linear"));

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
        let step_id = step["id"].as_str().unwrap();
        assert_eq!(step["status"], "pending");
        assert_eq!(dispatch.list()[0]["waiting"], 1);
        assert!(dispatch.get(&id).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty());
        let (tool, input) = dispatch.approve(&id, step_id, None).unwrap();
        assert_eq!((tool.as_str(), input), ("start_session", start_input()));
        let done = dispatch
            .ran(
                &id,
                step_id,
                &Ok(json!({ "machine": "hp", "name": "hp-app", "path": "/r/app" })),
            )
            .unwrap();
        assert_eq!(done["status"], "approved");
        assert_eq!(done["result"]["session"]["name"], "hp-app");
        assert_eq!(dispatch.list()[0]["waiting"], 0);
        assert_eq!(dispatch.get(&id).unwrap()["sessions"][0]["name"], "hp-app");

        assert!(dispatch
            .observe(&view(Some(Activity::Active), "hp-app"))
            .is_empty());
        let changes = dispatch.observe(&view(Some(Activity::Blocked), "hp-app"));
        assert_eq!(changes.len(), 1);
        dispatch.report(&changes[0], "Run the migration?\n ❯ 1. Yes\n   2. No");
        let events = dispatch.get(&id).unwrap()["events"].clone();
        let index = events.as_array().unwrap().len() - 1;
        let card = &events[index];
        assert_eq!(card["role"], "session");
        assert_eq!(card["state"], "blocked");
        assert_eq!(card["options"][1]["label"], "No");
        assert!(card.get("review").is_none());

        let answered = dispatch.answered(&id, index, "2", "No").unwrap();
        assert_eq!(answered["answer"]["label"], "No");
        assert_eq!(
            dispatch.answered(&id, index, "1", "Yes"),
            Err(Refusal::Taken("it was already answered with No".into()))
        );
        assert_eq!(
            dispatch.answered(&id, 0, "1", "Yes"),
            Err(Refusal::Missing("no such question".into())),
            "the first event is the message"
        );
    }

    #[tokio::test]
    async fn a_step_is_decided_once() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = conversation(&dispatch, "stop the old ones").await;
        let stop = json!({ "machine": "hp", "name": "hp-old" });
        let first = dispatch
            .propose(&id, "stop_session", stop.clone(), By::Dispatch, None, None)
            .unwrap();
        let second = dispatch
            .propose(&id, "stop_session", stop, By::Dispatch, None, None)
            .unwrap();
        let (first, second) = (
            first["id"].as_str().unwrap(),
            second["id"].as_str().unwrap(),
        );
        assert_eq!(dispatch.pending(&id), [first, second]);
        dispatch.approve(&id, first, None).unwrap();
        assert_eq!(
            dispatch.approve(&id, first, None),
            Err(Refusal::Taken("this step was already approved".into()))
        );
        assert_eq!(dispatch.reject(&id, second).unwrap()["status"], "rejected");
        assert_eq!(
            dispatch.reject(&id, second),
            Err(Refusal::Taken("this step was already rejected".into()))
        );
        assert_eq!(
            dispatch.approve(&id, "zzzzzzzz", None),
            Err(Refusal::Missing("no such step".into()))
        );
        assert_eq!(
            dispatch.approve("aaaaaaaaaaaaaaaa", first, None),
            Err(Refusal::Missing("no such conversation".into()))
        );
        assert!(dispatch.pending(&id).is_empty());
    }

    #[tokio::test]
    async fn an_edited_step_keeps_what_was_proposed() {
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
        let mut edited = start_input();
        edited["prompt"] = json!("fix it, and add a test");
        let (_, input) = dispatch
            .approve(&id, step["id"].as_str().unwrap(), Some(edited.clone()))
            .unwrap();
        assert_eq!(input, edited);
        let stored = dispatch.step(&id, step["id"].as_str().unwrap()).unwrap();
        assert_eq!(stored["status"], "edited");
        assert_eq!(stored["original"], start_input());
        let same = dispatch
            .propose(
                &id,
                "start_session",
                start_input(),
                By::Dispatch,
                None,
                None,
            )
            .unwrap();
        dispatch
            .approve(&id, same["id"].as_str().unwrap(), Some(start_input()))
            .unwrap();
        assert_eq!(
            dispatch.step(&id, same["id"].as_str().unwrap()).unwrap()["status"],
            "approved",
            "approving the proposal as it was is not an edit"
        );
    }

    #[tokio::test]
    async fn a_step_proposed_during_a_turn_reaches_the_page_streaming_it() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(
            dir.path(),
            r#"sleep 1; echo '{"type":"result","is_error":false,"result":"ok"}'"#,
        );
        let (id, rx) = dispatch
            .ask(None, "fix it", 4000, &DispatchSettings::default(), None)
            .await
            .unwrap();
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
        let streamed = drain(rx).await;
        assert_eq!(streamed[0], step);
        assert_eq!(streamed.last().unwrap()["role"], "done");
    }

    #[tokio::test]
    async fn a_step_that_ran_without_asking_is_recorded_as_told() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = conversation(&dispatch, "fix it").await;
        dispatch.record(
            &id,
            "start_session",
            start_input(),
            None,
            None,
            &Ok(json!({ "machine": "hp", "name": "hp-eng-1", "path": "/r/app" })),
        );
        dispatch.record(
            &id,
            "stop_session",
            json!({ "machine": "hp", "name": "gone" }),
            None,
            None,
            &Err("can't find session: gone".into()),
        );
        let convo = dispatch.get(&id).unwrap();
        let events = convo["events"].as_array().unwrap();
        let (ran, failed) = (&events[events.len() - 2], &events[events.len() - 1]);
        assert_eq!(
            (&ran["status"], &ran["told"], &ran["result"]["ok"]),
            (&json!("auto"), &json!(true), &json!(true))
        );
        assert_eq!(failed["result"]["text"], "can't find session: gone");
        assert_eq!(convo["sessions"][0]["name"], "hp-eng-1");
        assert_eq!(dispatch.list()[0]["waiting"], 0);
    }

    #[tokio::test]
    async fn a_pipeline_step_is_recorded_as_the_pipelines() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = dispatch.open_conversation("COM-1: Fix the login");
        dispatch.record_as(
            &id,
            "start_session",
            start_input(),
            None,
            None,
            &Ok(json!({ "machine": "hp", "name": "hp-com-1", "path": "/r/app" })),
            By::Pipeline,
            Some("2026-10-29T09:40:00+03:00"),
        );
        let convo = dispatch.get(&id).unwrap();
        let step = convo["events"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(step["by"], "pipeline");
        assert_eq!(step["status"], "auto");
        assert_eq!(step["run_started"], "2026-10-29T09:40:00+03:00");
        assert_eq!(step["result"]["ok"], true);
        assert_eq!(convo["sessions"][0]["name"], "hp-com-1");
    }

    #[tokio::test]
    async fn a_finished_reviewer_reports_a_review_once() {
        use crate::snapshot::Activity;
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = conversation(&dispatch, "review hp-app").await;
        let of = ReviewOf {
            machine: "hp".into(),
            name: "hp-app".into(),
            path: "/r/app".into(),
            branch: "eng-1".into(),
            evidence: String::new(),
            scan: String::new(),
        };
        let step = dispatch
            .propose(
                &id,
                "start_session",
                json!({ "machine": "hp", "path": "/r/app", "prompt": review_prompt("eng-1", "", None) }),
                By::You,
                Some(of.clone()),
                None,
            )
            .unwrap();
        let step = step["id"].as_str().unwrap();
        dispatch.approve(&id, step, None).unwrap();
        dispatch
            .ran(
                &id,
                step,
                &Ok(json!({ "machine": "hp", "name": "hp-app-2", "path": "/r/app" })),
            )
            .unwrap();
        assert_eq!(
            dispatch.get(&id).unwrap()["sessions"][0]["review"]["name"],
            "hp-app"
        );
        let screen = "⏺ YARDBELL REVIEW\n  verdict: changes needed\n  summary: One bug.\n  - high: src/a.rs:3: Off by one.\n  END REVIEW";
        let finish = |activity: Activity| {
            assert!(dispatch
                .observe(&view(Some(activity), "hp-app-2"))
                .is_empty());
            let changes = dispatch.observe(&view(Some(Activity::Idle), "hp-app-2"));
            assert_eq!(changes.len(), 1);
            assert_eq!(changes[0].review.as_ref(), Some(&of));
            dispatch.report(&changes[0], screen);
            dispatch.get(&id).unwrap()["events"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()
                .clone()
        };
        let review = finish(Activity::Active);
        assert_eq!(review["role"], "review");
        assert_eq!(review["name"], "hp-app-2");
        assert_eq!(review["of"]["branch"], "eng-1");
        assert_eq!(review["verdict"], "changes");
        assert_eq!(review["findings"][0]["place"], "src/a.rs:3");
        let again = finish(Activity::Active);
        assert_eq!(
            again["role"], "session",
            "the same report is not a new review"
        );
        assert_eq!(again["review"], true);

        let index = dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .position(|e| e["role"] == "review")
            .unwrap();
        let decided = dispatch
            .review_outcome(&id, index, json!({ "decision": "dismissed" }))
            .unwrap();
        assert_eq!(decided["outcome"]["decision"], "dismissed");
        assert!(dispatch
            .review_outcome(&id, index, json!({ "decision": "dismissed" }))
            .is_err());
    }

    #[tokio::test]
    async fn a_finished_scanner_reports_a_scan_without_a_diff() {
        use crate::snapshot::Activity;
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "true");
        let id = dispatch.open_conversation("security scan of app");
        assert_eq!(dispatch.get(&id).unwrap()["title"], "security scan of app");
        let of = ReviewOf {
            machine: "hp".into(),
            name: String::new(),
            path: "/r/app".into(),
            branch: String::new(),
            evidence: String::new(),
            scan: "security".into(),
        };
        let input = json!({ "machine": "hp", "path": "/r/app", "prompt": scan_prompt(ScanKind::Security, "") });
        let step = dispatch
            .propose(&id, "start_session", input, By::You, Some(of.clone()), None)
            .unwrap();
        let step = step["id"].as_str().unwrap();
        dispatch.approve(&id, step, None).unwrap();
        dispatch
            .ran(
                &id,
                step,
                &Ok(json!({ "machine": "hp", "name": "hp-app-2", "path": "/r/app" })),
            )
            .unwrap();
        dispatch.observe(&view(Some(Activity::Active), "hp-app-2"));
        let changes = dispatch.observe(&view(Some(Activity::Idle), "hp-app-2"));
        let review_screen = "YARDBELL REVIEW\nverdict: ready\nsummary: x\nEND REVIEW";
        dispatch.report(&changes[0], review_screen);
        let card = dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        assert_eq!(card["role"], "session", "a review's report is not a scan's");
        dispatch.observe(&view(Some(Activity::Active), "hp-app-2"));
        let changes = dispatch.observe(&view(Some(Activity::Idle), "hp-app-2"));
        let folders = crate::folders::Folders::new(
            Arc::new(FakeRunner::default()),
            crate::ssh::Ssh::new(dir.path().join("ssh")),
        );
        let m: crate::config::Machine =
            serde_yaml::from_str("name: hp\nlocal: true\nroot: /r").unwrap();
        dispatch
            .report_from(
                &changes[0],
                "YARDBELL SCAN\nverdict: clean\nsummary: Nothing found.\n- none\nEND SCAN",
                &folders,
                &m,
            )
            .await;
        let card = dispatch.get(&id).unwrap()["events"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        assert_eq!(card["role"], "review");
        assert_eq!(
            (&card["verdict"], &card["of"]["scan"]),
            (&json!("clean"), &json!("security"))
        );
        assert!(
            card.get("diff").is_none() && card.get("evidence").is_none(),
            "{card}"
        );
    }

    #[tokio::test]
    async fn busy_conversations_refuse_delete_and_survive_clear() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = fake_claude(dir.path(), "sleep 30");
        let (busy, rx) = dispatch
            .ask(None, "long task", 4000, &DispatchSettings::default(), None)
            .await
            .unwrap();
        assert_eq!(
            dispatch
                .ask(
                    Some(&busy),
                    "again",
                    4000,
                    &DispatchSettings::default(),
                    None
                )
                .await
                .unwrap_err(),
            "this conversation is still answering"
        );
        assert!(dispatch.delete(&busy).is_err());

        let quick = fake_claude(dir.path(), "true");
        let (idle, rx2) = quick
            .ask(None, "short task", 4000, &DispatchSettings::default(), None)
            .await
            .unwrap();
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

    fn started(name: &str) -> Value {
        json!({
            "role": "action", "id": format!("act-{name}"), "tool": "start_session",
            "input": { "machine": "hp", "folder": "app", "prompt": format!("work on {name}") },
            "status": "approved",
            "result": { "ok": true, "session": { "machine": "hp", "name": name, "path": "/r/app" } },
        })
    }

    #[test]
    fn a_session_knows_its_task_and_the_saved_task_it_came_from() {
        let dir = tempfile::tempdir().unwrap();
        let chats = dir.path().join("dispatch/conversations");
        std::fs::create_dir_all(&chats).unwrap();
        let write = |id: &str, updated: &str, trigger: Value, events: Vec<Value>| {
            let mut c = json!({ "id": id, "title": id, "created": updated, "updated": updated, "events": events });
            if !trigger.is_null() {
                c["trigger"] = trigger;
            }
            std::fs::write(chats.join(format!("{id}.json")), c.to_string()).unwrap();
        };
        write(
            "chatfromtask0001",
            "2026-10-28T10:00:00+00:00",
            Value::Null,
            vec![
                json!({ "role": "user", "text": "Fix bugs", "task": { "name": "Fix bugs", "version": 3 } }),
                started("hp-a"),
                json!({ "role": "user", "text": "and another" }),
                started("hp-b"),
            ],
        );
        write(
            "chattriggered001",
            "2026-10-28T11:00:00+00:00",
            json!({ "name": "Morning", "task": "Plan my day", "version": 2 }),
            vec![json!({ "role": "user", "text": "plan" }), started("hp-c")],
        );
        write(
            "chatoldtrigger01",
            "2026-10-28T09:00:00+00:00",
            json!({ "name": "Morning", "task": "Plan my day" }),
            vec![json!({ "role": "user", "text": "plan" }), started("hp-d")],
        );
        let d = Dispatch::new(Arc::new(FakeRunner::default()), dir.path().join("dispatch"));
        let a = d.origin("hp", "hp-a").unwrap();
        assert_eq!(a.conversation, "chatfromtask0001");
        assert_eq!(a.prompt, "work on hp-a");
        assert_eq!(a.task, Some(("Fix bugs".into(), Some(3))));
        assert_eq!(
            d.origin("hp", "hp-b").unwrap().task,
            None,
            "only the message that asked for it counts"
        );
        assert_eq!(
            d.origin("hp", "hp-c").unwrap().task,
            Some(("Plan my day".into(), Some(2)))
        );
        assert_eq!(
            d.origin("hp", "hp-d").unwrap().task,
            Some(("Plan my day".into(), None)),
            "a trigger from before versions names no version"
        );
        assert!(d.origin("pro", "hp-a").is_none());
        assert!(d.origin("hp", "hp-z").is_none());
    }

    #[tokio::test]
    async fn a_marked_message_keeps_its_marks_and_claude_gets_only_the_text() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let dispatch = fake_claude(
            dir.path(),
            &format!("printf '%s\\n' \"$@\" > {}", args.display()),
        );
        let marks = json!({ "task": { "name": "Fix bugs", "version": 4 } });
        let (id, rx) = dispatch
            .ask_marked(
                None,
                "Fix the bugs",
                &marks,
                4000,
                &DispatchSettings::default(),
                None,
            )
            .await
            .unwrap();
        drain(rx).await;
        let events = dispatch.get(&id).unwrap()["events"].clone();
        assert_eq!(
            events[0],
            json!({ "role": "user", "text": "Fix the bugs", "task": { "name": "Fix bugs", "version": 4 } })
        );
        let argv = std::fs::read_to_string(&args).unwrap();
        assert!(argv.contains("Fix the bugs"));
        assert!(!argv.contains("version"), "{argv}");
    }
}

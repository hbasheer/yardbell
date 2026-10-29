use super::definition::Outcome;
use super::engine::{self, tests::run_of};
use super::prompts::TicketText;
use super::record::{Effect, PrRef, PullRef, Run, RunState, Seen, WaitKind};
use super::run::{act, World};
use super::watch;
use crate::config::Pipelines;
use crate::dispatch::ReviewOf;
use crate::snapshot::Activity;
use crate::state::{MachineView, SessionView, StateView};
use futures::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct Fake {
    pub sessions: Mutex<Vec<(String, String, String, Activity)>>,
    pub screens: Mutex<HashMap<String, String>>,
    pub replies: Mutex<VecDeque<String>>,
    pub closed: Mutex<VecDeque<bool>>,
    pub refuse: Mutex<HashMap<String, String>>,
    pub calls: Mutex<Vec<String>>,
    pub recorded: Mutex<Vec<String>>,
    pub notes: Mutex<Vec<String>>,
    pub started: Mutex<u32>,
}

impl Fake {
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    pub fn session(&self, machine: &str, name: &str, branch: &str, activity: Activity) {
        let mut s = self.sessions.lock().unwrap();
        s.retain(|x| x.1 != name);
        s.push((machine.into(), name.into(), branch.into(), activity));
    }

    fn call(&self, what: String) {
        self.calls.lock().unwrap().push(what);
    }
}

impl World for Fake {
    fn view(&self) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines: ["hp", "mini", "devbox"]
                .iter()
                .map(|m| MachineView {
                    name: m.to_string(),
                    up: true,
                    reason: None,
                    last_seen: None,
                    local: false,
                    health: None,
                    accounts: Vec::new(),
                    mesh_on: None,
                })
                .collect(),
            folders: vec![],
            sessions: self
                .sessions
                .lock()
                .unwrap()
                .iter()
                .map(|(machine, name, branch, activity)| SessionView {
                    id: name.clone(),
                    machine: machine.clone(),
                    agent: "claude".into(),
                    pid: 1,
                    folder: "app".into(),
                    ticket: "-".into(),
                    branch: branch.clone(),
                    activity: *activity,
                    attachable: true,
                    tmux: Some(name.clone()),
                    stale: false,
                    ports: vec![],
                    pull: None,
                    path: format!("/r/{name}"),
                    worktree: true,
                    setup: None,
                })
                .collect(),
            ended: vec![],
            host_terminal: crate::config::HostTerminal::None,
            mesh: None,
            server: None,
        }
    }

    fn machines(&self) -> Vec<String> {
        vec!["hp".into(), "mini".into(), "devbox".into()]
    }

    fn notes(&self, _folder: &str) -> String {
        String::new()
    }

    fn screen<'a>(&'a self, _machine: &'a str, name: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.screens.lock().unwrap().get(name).cloned() })
    }

    fn events(&self, _conversation: &str) -> Vec<Value> {
        vec![]
    }

    fn open_conversation(&self, _title: &str) -> String {
        "conv0000000001".into()
    }

    fn record(
        &self,
        _conversation: &str,
        tool: &str,
        _input: Value,
        _review: Option<ReviewOf>,
        _outcome: &Result<Value, String>,
        run_started: &str,
    ) {
        assert!(!run_started.is_empty());
        self.recorded.lock().unwrap().push(tool.into());
    }

    fn refused(&self, tool: &str, _input: &Value) -> Option<String> {
        self.refuse.lock().unwrap().get(tool).cloned()
    }

    fn perform<'a>(&'a self, tool: &'a str, input: Value) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.call(format!("{tool} {input}"));
            match tool {
                "start_session" | "move_session" => {
                    let n = {
                        let mut s = self.started.lock().unwrap();
                        *s += 1;
                        *s
                    };
                    let machine = input["to"]
                        .as_str()
                        .or(input["machine"].as_str())
                        .unwrap_or("hp")
                        .to_string();
                    let name = format!("{machine}-s{n}");
                    let path = input["path"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("/r/{name}"));
                    self.session(&machine, &name, "com-1", Activity::Active);
                    Ok(json!({ "name": name, "machine": machine, "path": path }))
                }
                _ => Ok(json!({ "ok": true })),
            }
        })
    }

    fn review_plan(&self, _machine: &str, _name: &str) -> Result<(Value, ReviewOf), String> {
        Err("not used by pipelines".into())
    }

    fn ask<'a>(
        &'a self,
        _conversation: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            self.call(format!("ask {}", text.lines().next().unwrap_or_default()));
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or("no reply".into())
        })
    }

    fn ticket<'a>(
        &'a self,
        _linear_id: &'a str,
    ) -> BoxFuture<'a, Result<(TicketText, bool), String>> {
        Box::pin(async move {
            let closed = self.closed.lock().unwrap().pop_front().unwrap_or(false);
            Ok((
                TicketText {
                    description: "The redirect loops.".into(),
                    comments: vec![],
                },
                closed,
            ))
        })
    }

    fn move_ticket<'a>(
        &'a self,
        _linear_id: &'a str,
        state: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.call(format!("move {state}"));
            Ok(())
        })
    }

    fn open_draft<'a>(
        &'a self,
        run: &'a Run,
        path: &'a str,
    ) -> BoxFuture<'a, Result<PullRef, String>> {
        Box::pin(async move {
            self.call(format!("draft {} {path}", run.place.branch));
            Ok(PullRef {
                url: "https://github.com/acme/app/pull/12".into(),
                number: 12,
            })
        })
    }

    fn notify(&self, text: &str) {
        self.notes.lock().unwrap().push(text.into());
    }
}

pub(crate) const PLANNED: &str = "TRIAGE\ndecision: start\nmachine: hp\nfolder: acme/app\nbranch: com-1-fix-the-login\nreason: hp has acme/app\nEND TRIAGE";
pub(crate) const REPORTED: &str = "REPORT\nAll steps passed.\nEND REPORT";

fn result(outcome: &str, summary: &str) -> String {
    format!("YARDBELL RESULT\nstatus: {outcome}\nsummary: {summary}\n- 12 passed\nEND RESULT")
}

// Plays the tick: carries out effects, feeds what they saw to the engine, admits queued agent
// steps, and lets each agent finish with the outcome `script` gives its step.
async fn drive(fake: &Fake, mut run: Run, script: &[(&str, &str)]) -> Run {
    let cfg = Pipelines::default();
    let mut queue: VecDeque<Effect> = VecDeque::new();
    let (r, effects) = engine::start(run, chrono::Local::now());
    run = r;
    queue.extend(effects);
    for _ in 0..60 {
        if let Some(effect) = queue.pop_front() {
            for seen in act(fake, &cfg, &run, &effect).await {
                let (r, effects) = engine::step(run, seen, &cfg, chrono::Local::now());
                run = r;
                queue.extend(
                    effects
                        .into_iter()
                        .filter(|e| !matches!(e, Effect::Notify { .. })),
                );
            }
            continue;
        }
        match run.state {
            RunState::Queued => {
                let (r, effects) = engine::step(run, Seen::Admitted, &cfg, chrono::Local::now());
                run = r;
                queue.extend(effects);
            }
            RunState::Running => {
                let step = run.step.clone();
                let session = run
                    .steps
                    .get(&step)
                    .map(|s| s.session.clone())
                    .unwrap_or_default();
                let (outcome, summary) = script
                    .iter()
                    .find(|(s, _)| *s == step)
                    .map(|(_, o)| (*o, format!("{step} said {o}")))
                    .unwrap_or(("pass", format!("{step} done")));
                fake.screens
                    .lock()
                    .unwrap()
                    .insert(session.clone(), result(outcome, &summary));
                let machine = run
                    .steps
                    .get(&step)
                    .map(|s| s.machine.clone())
                    .unwrap_or_default();
                fake.session(&machine, &session, "com-1", Activity::Idle);
                let screen = fake.screens.lock().unwrap().get(&session).cloned();
                match watch::seen(&run, &fake.view(), screen.as_deref(), chrono::Local::now()) {
                    Some(seen) => {
                        let (r, effects) = engine::step(run, seen, &cfg, chrono::Local::now());
                        run = r;
                        queue.extend(
                            effects
                                .into_iter()
                                .filter(|e| !matches!(e, Effect::Notify { .. })),
                        );
                    }
                    None => break,
                }
            }
            _ => break,
        }
    }
    run
}

fn mr(run: &mut Run) {
    run.subject.pr = Some(PrRef {
        url: "https://git.commslayer.com/commslayer/app/-/merge_requests/87".into(),
        number: 87,
        branch: "com-1-webhook".into(),
        host: "git.commslayer.com".into(),
        project: "commslayer/app".into(),
        forge: "gitlab".into(),
    });
}

#[tokio::test]
async fn a_run_of_the_review_template_reports() {
    let fake = Fake::default();
    fake.replies
        .lock()
        .unwrap()
        .extend([PLANNED.to_string(), REPORTED.to_string()]);
    let mut run = run_of("Review my merge requests");
    mr(&mut run);
    let run = drive(&fake, run, &[]).await;
    assert_eq!(run.state, RunState::Done, "{:?}", run.history);
    assert_eq!(run.report, "All steps passed.");
    let calls = fake.calls();
    let first = calls
        .iter()
        .find(|c| c.starts_with("start_session"))
        .unwrap();
    assert!(
        first.contains("\"branch\":\"com-1-webhook\"")
            && first.contains("\"new_branch\":false")
            && first.contains("\"read_only\":true"),
        "{first}"
    );
    let moved = calls
        .iter()
        .find(|c| c.starts_with("move_session"))
        .expect("Test copies the branch to devbox");
    assert!(
        moved.contains("\"to\":\"devbox\"") && moved.contains("\"read_only\":true"),
        "{moved}"
    );
    assert_eq!(run.steps["test"].machine, "devbox");
    assert!(
        fake.notes.lock().unwrap().iter().any(|n| n.contains("!87")),
        "the report reaches the phone"
    );
}

#[tokio::test]
async fn same_as_reuses_the_path() {
    let fake = Fake::default();
    fake.replies
        .lock()
        .unwrap()
        .extend([PLANNED.to_string(), REPORTED.to_string()]);
    let mut run = run_of("Review my merge requests");
    mr(&mut run);
    let run = drive(&fake, run, &[]).await;
    let understand = run.steps["understand"].path.clone();
    let root = fake
        .calls()
        .into_iter()
        .filter(|c| c.starts_with("start_session"))
        .nth(1)
        .unwrap();
    assert!(
        root.contains(&format!("\"path\":\"{understand}\"")),
        "{root}"
    );
}

#[tokio::test]
async fn copy_on_the_same_machine_reads_the_worktree() {
    let fake = Fake::default();
    fake.replies.lock().unwrap().extend([
        PLANNED.replace("machine: hp", "machine: devbox"),
        REPORTED.to_string(),
    ]);
    let mut run = run_of("Review my merge requests");
    mr(&mut run);
    let run = drive(&fake, run, &[]).await;
    assert_eq!(run.state, RunState::Done);
    assert!(
        !fake.calls().iter().any(|c| c.starts_with("move_session")),
        "{:?}",
        fake.calls()
    );
    assert_eq!(run.steps["test"].path, run.steps["understand"].path);
}

#[tokio::test]
async fn continue_types_into_the_session() {
    let fake = Fake::default();
    fake.replies
        .lock()
        .unwrap()
        .extend([PLANNED.to_string(), REPORTED.to_string()]);
    let run = drive(
        &fake,
        run_of("Implement my Linear tickets"),
        &[("review", "fail")],
    )
    .await;
    let implement = run.steps["implement"].session.clone();
    let sent = fake
        .calls()
        .into_iter()
        .find(|c| c.starts_with("send_to_session"))
        .expect("Fix types into Implement's session");
    assert!(
        sent.contains(&format!("\"name\":\"{implement}\"")) && sent.contains("review said fail"),
        "{sent}"
    );
    assert_eq!(run.steps["fix"].session, implement);
}

#[tokio::test]
async fn continue_on_an_ended_session_waits() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    run.place.machine = "hp".into();
    run.step = "fix".into();
    run.state = RunState::Running;
    run.state_of("implement").session = "gone".into();
    run.state_of("implement").machine = "hp".into();
    run.state_of("fix").machine = "hp".into();
    let seen = act(
        &fake,
        &Pipelines::default(),
        &run,
        &Effect::Agent { step: "fix".into() },
    )
    .await;
    let (run, _) = engine::step(
        run,
        seen.into_iter().next().unwrap(),
        &Pipelines::default(),
        chrono::Local::now(),
    );
    assert_eq!(
        run.waiting.as_ref().map(|w| (w.kind, w.screen.clone())),
        Some((WaitKind::NeedsYou, "Implement's session has ended".into()))
    );
}

#[tokio::test]
async fn a_denying_rule_waits() {
    let fake = Fake::default();
    fake.replies.lock().unwrap().push_back(PLANNED.to_string());
    fake.refuse.lock().unwrap().insert(
        "start_session".into(),
        "Your rule: deny start_session on hp".into(),
    );
    let run = drive(&fake, run_of("Implement my Linear tickets"), &[]).await;
    assert_eq!(
        run.waiting.map(|w| (w.kind, w.reason)),
        Some((
            WaitKind::Refused,
            "Your rule: deny start_session on hp".into()
        ))
    );
}

#[tokio::test]
async fn a_closed_ticket_waits() {
    let fake = Fake::default();
    fake.replies.lock().unwrap().push_back(PLANNED.to_string());
    fake.closed.lock().unwrap().extend([false, true]);
    let run = drive(&fake, run_of("Implement my Linear tickets"), &[]).await;
    assert_eq!(run.waiting.map(|w| w.kind), Some(WaitKind::Closed));
    assert!(!fake.calls().iter().any(|c| c.starts_with("start_session")));
}

#[tokio::test]
async fn the_implement_template_pushes_and_moves_the_ticket() {
    let fake = Fake::default();
    fake.replies
        .lock()
        .unwrap()
        .extend([PLANNED.to_string(), REPORTED.to_string()]);
    let run = drive(&fake, run_of("Implement my Linear tickets"), &[]).await;
    assert_eq!(run.state, RunState::Done, "{:?}", run.history);
    let calls = fake.calls();
    let implement = run.steps["implement"].path.clone();
    assert!(
        calls
            .iter()
            .any(|c| c.starts_with("push_branch") && c.contains(&implement)),
        "{calls:?}"
    );
    assert!(calls.iter().any(|c| c == "move In Review"), "{calls:?}");
    assert_eq!(run.pull.unwrap().number, 12);
    assert_eq!(
        *fake.recorded.lock().unwrap(),
        vec![
            "start_session",
            "start_session",
            "move_session",
            "push_branch"
        ]
    );
    let _ = Outcome::Pass;
}

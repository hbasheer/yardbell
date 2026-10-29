use super::Pipeline;
use crate::dispatch::ReviewOf;
use crate::pipeline::legacy::{Effect, ParkKind, Parked, PullRef, Question, Record, Stage, Ticket};
use crate::pipeline::legacy_engine::tests::cfg;
use crate::pipeline::legacy_prompts::TicketText;
use crate::pipeline::legacy_run::World;
use crate::snapshot::Activity;
use crate::state::{MachineView, SessionView, StateView};
use futures::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Fake {
    sessions: Mutex<Vec<(String, String, String, Activity)>>,
    screens: Mutex<HashMap<String, String>>,
    events: Mutex<Vec<Value>>,
    replies: Mutex<VecDeque<String>>,
    started: Mutex<VecDeque<String>>,
    closed: Mutex<VecDeque<bool>>,
    refuse: Mutex<HashMap<String, String>>,
    calls: Mutex<Vec<String>>,
    recorded: Mutex<Vec<(String, String)>>,
    notes: Mutex<Vec<String>>,
}

impl Fake {
    fn call(&self, what: impl Into<String>) {
        self.calls.lock().unwrap().push(what.into());
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn session(&self, machine: &str, name: &str, branch: &str, activity: Activity) {
        let mut s = self.sessions.lock().unwrap();
        s.retain(|x| x.1 != name);
        s.push((machine.into(), name.into(), branch.into(), activity));
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

    fn screen<'a>(&'a self, _machine: &'a str, name: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.screens.lock().unwrap().get(name).cloned() })
    }

    fn events(&self, _conversation: &str) -> Vec<Value> {
        self.events.lock().unwrap().clone()
    }

    fn open_conversation(&self, title: &str) -> String {
        self.call(format!("open {title}"));
        "conv0000000001".into()
    }

    fn record(
        &self,
        conversation: &str,
        tool: &str,
        _input: Value,
        _review: Option<ReviewOf>,
        _outcome: &Result<Value, String>,
        run_started: &str,
    ) {
        assert!(!run_started.is_empty());
        self.recorded
            .lock()
            .unwrap()
            .push((conversation.into(), tool.into()));
    }

    fn refused(&self, tool: &str, _input: &Value) -> Option<String> {
        self.refuse.lock().unwrap().get(tool).cloned()
    }

    fn perform<'a>(&'a self, tool: &'a str, input: Value) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.call(format!("{tool} {input}"));
            match tool {
                "start_session" | "move_session" => {
                    let name = self
                        .started
                        .lock()
                        .unwrap()
                        .pop_front()
                        .ok_or("nothing to start")?;
                    Ok(json!({ "name": name, "machine": "hp", "path": format!("/r/{name}") }))
                }
                _ => Ok(json!({ "ok": true })),
            }
        })
    }

    fn review_plan(&self, machine: &str, name: &str) -> Result<(Value, ReviewOf), String> {
        let of = ReviewOf {
            machine: machine.into(),
            name: name.into(),
            path: format!("/r/{name}"),
            branch: "com-1-fix-the-login".into(),
            evidence: String::new(),
            scan: String::new(),
        };
        Ok((
            json!({ "machine": machine, "prompt": "review it", "read_only": true }),
            of,
        ))
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
        r: &'a Record,
        path: &'a str,
    ) -> BoxFuture<'a, Result<PullRef, String>> {
        Box::pin(async move {
            self.call(format!("draft {} {path}", r.branch));
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

const TRIAGED: &str = "TRIAGE\ndecision: start\nmachine: hp\nfolder: acme/app\nbranch: com-1-fix-the-login\nreason: hp has acme/app\nEND TRIAGE";
const SUMMARY: &str =
    "SUMMARY\nFixed the redirect loop.\nLINEAR COMMENT\nFixed in the draft PR.\nEND SUMMARY";
const RESULT: &str = "YARDBELL RESULT\nstatus: done\nsummary: Fixed it.\nbranch: com-1-fix-the-login\n- 12 passed\nEND RESULT";

fn ticket() -> Ticket {
    Ticket {
        linear_id: "u-1".into(),
        id: "COM-1".into(),
        title: "Fix the login".into(),
        url: "https://linear.app/acme/issue/COM-1".into(),
        state: "Todo".into(),
    }
}

fn pipeline() -> (Arc<Pipeline>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    (
        Arc::new(Pipeline::new(dir.path().join("pipeline.json"))),
        dir,
    )
}

async fn tick(p: &Arc<Pipeline>, fake: &Arc<Fake>, cfg: Option<&crate::config::Pipeline>) {
    let world: Arc<dyn World> = fake.clone();
    for handle in p.tick(&world, cfg, chrono::Local::now()).await {
        handle.await.unwrap();
    }
}

fn put(p: &Pipeline, r: Record) {
    p.put(r);
}

#[tokio::test]
async fn a_run_takes_a_ticket_to_done() {
    let (p, _dir) = pipeline();
    let fake = Arc::new(Fake::default());
    let cfg = cfg();
    fake.replies
        .lock()
        .unwrap()
        .extend([TRIAGED.to_string(), SUMMARY.to_string()]);
    fake.started.lock().unwrap().extend([
        "hp-app-com-1".into(),
        "hp-app-com-1-review".into(),
        "devbox-app-com-1".into(),
    ]);
    p.add(&[ticket()], "you").unwrap();
    for _ in 0..12 {
        tick(&p, &fake, Some(&cfg)).await;
        let r = p.get("COM-1").unwrap();
        match r.stage {
            Stage::Implement if !r.sessions.implement.is_empty() => {
                fake.session("hp", &r.sessions.implement, &r.branch, Activity::Idle);
                fake.screens
                    .lock()
                    .unwrap()
                    .insert(r.sessions.implement.clone(), RESULT.into());
            }
            Stage::Review if !r.sessions.review.is_empty() => {
                fake.events.lock().unwrap().push(json!({
                    "role": "review", "of": { "name": r.sessions.implement }, "at": chrono::Local::now().to_rfc3339(),
                    "verdict": "ready", "findings": [],
                }));
            }
            Stage::Qa if !r.sessions.qa.is_empty() => {
                fake.session("devbox", &r.sessions.qa, &r.branch, Activity::Idle);
                fake.screens.lock().unwrap().insert(
                    r.sessions.qa.clone(),
                    RESULT.replace("- 12 passed", "verdict: pass\n- 12 passed"),
                );
            }
            Stage::Done => break,
            _ => {}
        }
    }
    let r = p.get("COM-1").unwrap();
    assert_eq!(r.stage, Stage::Done, "{:?}", r.history);
    assert_eq!(r.pull.as_ref().unwrap().number, 12);
    assert_eq!(r.summary, "Fixed the redirect loop.");
    assert_eq!(r.conversation, "conv0000000001");
    let calls = fake.calls();
    assert!(
        calls
            .iter()
            .any(|c| c.starts_with("push_branch") && c.contains("/r/hp-app-com-1")),
        "{calls:?}"
    );
    assert!(
        calls.iter().any(|c| c.starts_with("move_session")
            && c.contains("\"read_only\":true")
            && c.contains("\"to\":\"devbox\"")),
        "{calls:?}"
    );
    assert!(calls.iter().any(|c| c == "move In Review"), "{calls:?}");
    let tools: Vec<String> = fake
        .recorded
        .lock()
        .unwrap()
        .iter()
        .map(|(_, t)| t.clone())
        .collect();
    assert_eq!(
        tools,
        vec![
            "start_session",
            "start_session",
            "move_session",
            "push_branch"
        ]
    );
    let notes = fake.notes.lock().unwrap().clone();
    assert!(
        notes.iter().any(|n| n.contains("COM-1 is done")),
        "{notes:?}"
    );
    assert!(
        notes
            .iter()
            .any(|n| n == "Run finished: 1 done, 0 need you, 0 failed"),
        "{notes:?}"
    );
}

#[tokio::test]
async fn a_restart_mid_start_finds_the_session() {
    let (p, _dir) = pipeline();
    let fake = Arc::new(Fake::default());
    fake.session(
        "hp",
        "hp-app-com-1",
        "com-1-fix-the-login",
        Activity::Active,
    );
    put(
        &p,
        Record {
            id: "COM-1".into(),
            stage: Stage::Implement,
            machine: "hp".into(),
            branch: "com-1-fix-the-login".into(),
            conversation: "conv0000000001".into(),
            stage_since: chrono::Local::now().to_rfc3339(),
            pending: Some(Effect::Implement),
            ..Record::default()
        },
    );
    tick(&p, &fake, Some(&cfg())).await;
    let r = p.get("COM-1").unwrap();
    assert_eq!(r.sessions.implement, "hp-app-com-1");
    assert!(r.pending.is_none());
    assert!(
        !fake.calls().iter().any(|c| c.starts_with("start_session")),
        "{:?}",
        fake.calls()
    );
}

#[tokio::test]
async fn without_config_nothing_moves() {
    let (p, _dir) = pipeline();
    let fake = Arc::new(Fake::default());
    p.add(&[ticket()], "you").unwrap();
    tick(&p, &fake, None).await;
    assert_eq!(p.get("COM-1").unwrap().stage, Stage::Queued);
    assert!(fake.calls().is_empty());
}

#[tokio::test]
async fn a_denying_rule_parks_the_ticket() {
    let (p, _dir) = pipeline();
    let fake = Arc::new(Fake::default());
    fake.session("hp", "hp-app-com-1", "com-1-fix-the-login", Activity::Idle);
    fake.refuse.lock().unwrap().insert(
        "push_branch".into(),
        "Your rule: deny push_branch on any machine".into(),
    );
    put(
        &p,
        Record {
            id: "COM-1".into(),
            stage: Stage::Finish,
            machine: "hp".into(),
            branch: "com-1-fix-the-login".into(),
            conversation: "conv0000000001".into(),
            sessions: crate::pipeline::legacy::Sessions {
                implement: "hp-app-com-1".into(),
                ..Default::default()
            },
            stage_since: chrono::Local::now().to_rfc3339(),
            pending: Some(Effect::Push),
            ..Record::default()
        },
    );
    tick(&p, &fake, Some(&cfg())).await;
    let r = p.get("COM-1").unwrap();
    let parked = r.parked.unwrap();
    assert_eq!(parked.kind, ParkKind::Push);
    assert_eq!(parked.reason, "Your rule: deny push_branch on any machine");
    assert!(!fake.calls().iter().any(|c| c.starts_with("push_branch")));
}

#[tokio::test]
async fn answer_retry_and_drop_save_at_once() {
    let (p, dir) = pipeline();
    put(
        &p,
        Record {
            id: "COM-1".into(),
            stage: Stage::Parked,
            parked: Some(Parked {
                kind: ParkKind::Questions,
                reason: "Triage has 1 question".into(),
                from: Stage::Triage,
                screen: String::new(),
            }),
            questions: vec![Question {
                asked: "Which page?".into(),
                ..Question::default()
            }],
            ..Record::default()
        },
    );
    let r = p.answer("COM-1", "The account page").unwrap();
    assert_eq!(
        (r.stage, r.pending.clone()),
        (Stage::Triage, Some(Effect::Triage))
    );
    let again = Pipeline::new(dir.path().join("pipeline.json"));
    assert_eq!(
        again.get("COM-1").unwrap().questions[0].answer,
        "The account page"
    );
    assert!(
        p.answer("COM-1", "again").is_err(),
        "a ticket that is not waiting refuses an answer"
    );
    assert!(p.answer("COM-9", "x").is_err());
    let r = p.drop_ticket("COM-1").unwrap();
    assert_eq!(
        (r.stage, r.pending),
        (Stage::Dropped, Some(Effect::StopSessions))
    );
    let mut failed = Record {
        id: "COM-2".into(),
        stage: Stage::Failed,
        failed_at: Some(Stage::Review),
        ..Record::default()
    };
    failed.sessions.implement = "hp-app-com-2".into();
    put(&p, failed);
    let r = p.retry("COM-2").unwrap();
    assert_eq!((r.stage, r.pending), (Stage::Review, Some(Effect::Review)));
}

#[tokio::test]
async fn a_closed_ticket_parks_at_the_next_stage() {
    let (p, _dir) = pipeline();
    let fake = Arc::new(Fake::default());
    fake.replies.lock().unwrap().push_back(TRIAGED.into());
    fake.closed.lock().unwrap().extend([false, true]);
    p.add(&[ticket()], "you").unwrap();
    for _ in 0..3 {
        tick(&p, &fake, Some(&cfg())).await;
    }
    let r = p.get("COM-1").unwrap();
    assert_eq!(
        r.parked.as_ref().map(|p| p.kind),
        Some(ParkKind::Closed),
        "{:?}",
        r.history
    );
    assert!(!fake.calls().iter().any(|c| c.starts_with("start_session")));
}

#[tokio::test]
async fn a_finished_run_sends_one_push() {
    let (p, _dir) = pipeline();
    let fake = Arc::new(Fake::default());
    fake.replies.lock().unwrap().push_back(SUMMARY.into());
    let base = |id: &str, stage: Stage| Record {
        id: id.into(),
        run: "r1".into(),
        stage,
        conversation: "conv0000000001".into(),
        finished: vec!["push".into(), "pull".into(), "linear".into()],
        stage_since: chrono::Local::now().to_rfc3339(),
        ..Record::default()
    };
    put(&p, base("COM-1", Stage::Done));
    put(
        &p,
        Record {
            pending: Some(Effect::Summarise),
            ..base("COM-2", Stage::Finish)
        },
    );
    tick(&p, &fake, Some(&cfg())).await;
    tick(&p, &fake, Some(&cfg())).await;
    let notes = fake.notes.lock().unwrap().clone();
    let finished: Vec<&String> = notes
        .iter()
        .filter(|n| n.starts_with("Run finished"))
        .collect();
    assert_eq!(finished, vec!["Run finished: 2 done, 0 need you, 0 failed"]);
}

#[tokio::test]
async fn a_restart_in_finish_resumes_after_the_push() {
    let (p, _dir) = pipeline();
    let fake = Arc::new(Fake::default());
    fake.session("hp", "hp-app-com-1", "com-1-fix-the-login", Activity::Idle);
    fake.replies.lock().unwrap().push_back(SUMMARY.into());
    put(
        &p,
        Record {
            id: "COM-1".into(),
            stage: Stage::Finish,
            machine: "hp".into(),
            branch: "com-1-fix-the-login".into(),
            conversation: "conv0000000001".into(),
            sessions: crate::pipeline::legacy::Sessions {
                implement: "hp-app-com-1".into(),
                ..Default::default()
            },
            finished: vec!["push".into()],
            stage_since: chrono::Local::now().to_rfc3339(),
            pending: Some(Effect::OpenPull),
            ..Record::default()
        },
    );
    tick(&p, &fake, Some(&cfg())).await;
    let calls = fake.calls();
    assert!(
        calls
            .iter()
            .any(|c| c.starts_with("draft com-1-fix-the-login /r/hp-app-com-1")),
        "{calls:?}"
    );
    assert!(
        !calls.iter().any(|c| c.starts_with("push_branch")),
        "{calls:?}"
    );
    assert_eq!(p.get("COM-1").unwrap().stage, Stage::Done);
}

#[tokio::test]
async fn qa_on_the_same_machine_starts_a_reader_in_the_worktree() {
    let (p, _dir) = pipeline();
    let fake = Arc::new(Fake::default());
    fake.session("hp", "hp-app-com-1", "com-1-fix-the-login", Activity::Idle);
    fake.started
        .lock()
        .unwrap()
        .push_back("hp-app-com-1-qa".into());
    let mut cfg = cfg();
    cfg.test_machine = "hp".into();
    put(
        &p,
        Record {
            id: "COM-1".into(),
            stage: Stage::Qa,
            machine: "hp".into(),
            branch: "com-1-fix-the-login".into(),
            conversation: "conv0000000001".into(),
            sessions: crate::pipeline::legacy::Sessions {
                implement: "hp-app-com-1".into(),
                ..Default::default()
            },
            stage_since: chrono::Local::now().to_rfc3339(),
            pending: Some(Effect::MoveToTest),
            ..Record::default()
        },
    );
    tick(&p, &fake, Some(&cfg)).await;
    let calls = fake.calls();
    assert!(
        !calls.iter().any(|c| c.starts_with("move_session")),
        "{calls:?}"
    );
    let start = calls
        .iter()
        .find(|c| c.starts_with("start_session"))
        .expect("a QA session");
    assert!(
        start.contains("\"path\":\"/r/hp-app-com-1\"") && start.contains("\"read_only\":true"),
        "{start}"
    );
    assert_eq!(p.get("COM-1").unwrap().sessions.qa, "hp-app-com-1-qa");
}

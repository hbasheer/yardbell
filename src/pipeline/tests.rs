use super::definition::{Outcome, SessionChoice, StepKind};
use super::engine::{self, tests::run_of};
use super::prompts::{marker, TicketText};
use super::record::{Effect, PrRef, PullRef, Run, RunState, Seen, TicketRef, WaitKind};
use super::run::{act, needless_sessions, World};
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
    pub ticket_fails: Mutex<bool>,
    pub on_start: Mutex<Option<Box<dyn Fn() + Send>>>,
    pub note_kinds: Mutex<Vec<super::run::Note>>,
    pub teardowns: Mutex<Vec<String>>,
    pub teardown_fails: Mutex<bool>,
    pub teardown_repos: Mutex<Vec<String>>,
    pub others: Mutex<Vec<Run>>,
    pub stale: Mutex<Vec<String>>,
    pub stop_fails: Mutex<bool>,
    pub hold_stops: Mutex<Option<std::sync::Arc<tokio::sync::Semaphore>>>,
    pub transcript: Mutex<HashMap<String, String>>,
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
                    pull_why: None,
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
                    stale: self.stale.lock().unwrap().contains(name),
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
            proposals: 0,
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
            if tool == "stop_session" {
                let gate = self.hold_stops.lock().unwrap().clone();
                if let Some(gate) = gate {
                    let _ = gate.acquire().await;
                }
                if *self.stop_fails.lock().unwrap() {
                    return Err("ssh: connection timed out".to_string());
                }
            }
            match tool {
                "start_session" | "move_session" => {
                    if let Some(hook) = self.on_start.lock().unwrap().as_ref() {
                        hook();
                    }
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
                    let given = input["path"].as_str().filter(|_| tool == "start_session");
                    let path = given
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("/r/{name}"));
                    self.session(&machine, &name, "com-1", Activity::Active);
                    Ok(json!({
                        "name": name,
                        "machine": machine,
                        "path": path,
                        "created": given.is_none(),
                        "repo": "/r/repo",
                    }))
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
        _ticket: &'a TicketRef,
    ) -> BoxFuture<'a, Result<(TicketText, bool), String>> {
        Box::pin(async move {
            if *self.ticket_fails.lock().unwrap() {
                return Err("Linear has no ticket COM-1".into());
            }
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
        _ticket: &'a TicketRef,
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

    fn written_result<'a>(
        &'a self,
        _machine: &'a str,
        _agent: &'a str,
        _path: &'a str,
        marker: &'a str,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move { self.transcript.lock().unwrap().get(marker).cloned() })
    }

    fn notify(&self, kind: super::run::Note, text: &str, _run: &Run) {
        self.note_kinds.lock().unwrap().push(kind);
        self.notes.lock().unwrap().push(text.into());
    }

    fn teardown<'a>(
        &'a self,
        machine: &'a str,
        repo: &'a str,
        path: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.teardown_repos.lock().unwrap().push(repo.to_string());
            self.teardowns
                .lock()
                .unwrap()
                .push(format!("{machine}:{path}"));
            if *self.teardown_fails.lock().unwrap() {
                return Err("docker compose down exited 1".to_string());
            }
            Ok(())
        })
    }

    fn other_runs(&self, _id: &str) -> Vec<Run> {
        self.others.lock().unwrap().clone()
    }
}

pub(crate) const PLANNED: &str = "TRIAGE\ndecision: start\nmachine: hp\nfolder: acme/app\nbranch: com-1-fix-the-login\nreason: hp has acme/app\nEND TRIAGE";
pub(crate) const REPORTED: &str = "REPORT\nAll steps passed.\nEND REPORT";

fn result(marker: &str, outcome: &str, summary: &str) -> String {
    format!("YARDBELL RESULT\nstep: {marker}\nstatus: {outcome}\nsummary: {summary}\n- 12 passed\nEND RESULT")
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
                fake.screens.lock().unwrap().insert(
                    session.clone(),
                    result(&marker(&run, &step), outcome, &summary),
                );
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

#[test]
fn pipeline_notifications_follow_their_switches() {
    use super::run::Note;
    let mut phone = crate::config::PhoneNotifications::default();
    assert!(Note::Waiting.allowed(&phone) && Note::Finished.allowed(&phone));
    phone.pipeline_waiting = false;
    assert!(!Note::Waiting.allowed(&phone) && Note::Finished.allowed(&phone));
    phone.pipeline_waiting = true;
    phone.pipeline_finished = false;
    assert!(Note::Waiting.allowed(&phone) && !Note::Finished.allowed(&phone));
}

#[tokio::test]
async fn a_report_notifies_as_finished() {
    use super::run::Note;
    let fake = Fake::default();
    fake.replies.lock().unwrap().push_back(REPORTED.to_string());
    let run = run_of("Implement my Linear tickets");
    act(
        &fake,
        &Pipelines::default(),
        &run,
        &Effect::Report {
            step: "report".into(),
        },
    )
    .await;
    assert_eq!(*fake.note_kinds.lock().unwrap(), vec![Note::Finished]);
    act(
        &fake,
        &Pipelines::default(),
        &run,
        &Effect::Notify {
            text: "COM-1 needs you".into(),
        },
    )
    .await;
    assert_eq!(
        *fake.note_kinds.lock().unwrap(),
        vec![Note::Finished, Note::Waiting]
    );
}

#[tokio::test]
async fn a_closed_item_waits() {
    let fake = Fake::default();
    fake.closed.lock().unwrap().push_back(true);
    let mut run = run_of("Implement my Linear tickets");
    run.subject.ticket.as_mut().unwrap().source = "trello".into();
    run.step = "implement".into();
    run.state = RunState::Running;
    run.state_of("implement").machine = "hp".into();
    let effect = Effect::Agent {
        step: "implement".into(),
    };
    let seen = act(&fake, &Pipelines::default(), &run, &effect).await;
    assert!(matches!(&seen[..], [Seen::Closed(_)]), "{seen:?}");
}

#[tokio::test]
async fn a_linear_step_on_a_trello_item_fails_clearly() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    let ticket = run.subject.ticket.as_mut().unwrap();
    ticket.source = "trello".into();
    let effect = Effect::Linear {
        step: "linear-move".into(),
    };
    let seen = act(&fake, &Pipelines::default(), &run, &effect).await;
    match &seen[..] {
        [Seen::Linear(Err(e))] => assert!(e.contains("is not a Linear ticket"), "{e}"),
        other => panic!("{other:?}"),
    }
    assert!(fake.calls().is_empty());
}

#[test]
fn a_finished_review_session_is_needless() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    set_session(&mut run, "review", "hp", "hp-review", "/r/main");
    run.step = "qa".into();
    run.state = RunState::Running;
    fake.session("hp", "hp-main", "b", Activity::Idle);
    fake.session("hp", "hp-review", "b", Activity::Idle);
    assert_eq!(
        needless_sessions(&run, &fake.view()),
        vec![("hp".to_string(), "hp-review".to_string())]
    );
}

#[test]
fn a_waiting_steps_session_stays() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    set_session(&mut run, "review", "hp", "hp-review", "/r/main");
    run.step = "review".into();
    run.state = RunState::Waiting;
    fake.session("hp", "hp-main", "b", Activity::Idle);
    fake.session("hp", "hp-review", "b", Activity::Idle);
    assert!(needless_sessions(&run, &fake.view()).is_empty());
}

#[test]
fn a_shared_reviewer_stays_while_the_next_read_only_step_uses_it() {
    let fake = Fake::default();
    let mut run = run_of("Review my merge requests");
    set_session(&mut run, "understand", "hp", "hp-reader", "/r/main");
    set_session(&mut run, "root-cause", "hp", "hp-reader", "/r/main");
    run.step = "root-cause".into();
    run.state = RunState::Running;
    fake.session("hp", "hp-reader", "b", Activity::Active);
    assert!(needless_sessions(&run, &fake.view()).is_empty());
}

#[tokio::test]
async fn a_run_that_ends_stops_every_session_and_keeps_the_worktree() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    set_session(&mut run, "review", "hp", "hp-review", "/r/main");
    fake.session("hp", "hp-main", "b", Activity::Idle);
    fake.session("hp", "hp-review", "b", Activity::Idle);
    run.state = RunState::Done;
    let seen = act(&fake, &Pipelines::default(), &run, &Effect::StopSessions).await;
    let calls = fake.calls();
    assert_eq!(count(&calls, "stop_session"), 2, "{calls:?}");
    assert_eq!(count(&calls, "remove_worktree"), 0, "{calls:?}");
    assert_eq!(seen, vec![Seen::TornDown(None)]);
}

#[tokio::test]
async fn teardown_runs_once_per_folder() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    set_session(&mut run, "fix", "hp", "hp-main", "/r/main");
    set_session(&mut run, "qa", "devbox", "devbox-qa", "/r/copy");
    made(&mut run, "implement");
    made(&mut run, "qa");
    act(&fake, &Pipelines::default(), &run, &Effect::StopSessions).await;
    assert_eq!(fake.teardown_repos.lock().unwrap()[0], "/r/repo");
    let mut did = fake.teardowns.lock().unwrap().clone();
    did.sort();
    assert_eq!(did, vec!["devbox:/r/copy", "hp:/r/main"]);
}

#[tokio::test]
async fn a_failing_teardown_still_ends_the_run() {
    let fake = Fake::default();
    *fake.teardown_fails.lock().unwrap() = true;
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    made(&mut run, "implement");
    run.state = RunState::Done;
    let seen = act(&fake, &Pipelines::default(), &run, &Effect::StopSessions).await;
    let (run, _) = engine::step(
        run,
        seen.into_iter().next().unwrap(),
        &Pipelines::default(),
        chrono::Local::now(),
    );
    assert_eq!(run.state, RunState::Done);
    assert!(
        run.teardown_problem.contains("exited 1"),
        "{}",
        run.teardown_problem
    );
}

fn made(run: &mut Run, id: &str) {
    let st = run.state_of(id);
    st.made = st.path.clone();
    st.repo = "/r/repo".into();
}

async fn stop_all(fake: &Fake, run: &Run) -> Option<String> {
    match act(fake, &Pipelines::default(), run, &Effect::StopSessions)
        .await
        .into_iter()
        .next()
    {
        Some(Seen::TornDown(problem)) => problem,
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn teardown_leaves_a_folder_the_run_did_not_make() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main-checkout");
    assert_eq!(stop_all(&fake, &run).await, None);
    assert!(fake.teardowns.lock().unwrap().is_empty());
}

#[tokio::test]
async fn teardown_leaves_a_folder_another_session_works_in() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/someone");
    made(&mut run, "implement");
    fake.session("hp", "someone", "b", Activity::Idle);
    let problem = stop_all(&fake, &run).await.expect("a note");
    assert!(fake.teardowns.lock().unwrap().is_empty());
    assert!(problem.contains("someone"), "{problem}");
}

#[tokio::test]
async fn teardown_leaves_a_folder_another_active_run_holds() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    made(&mut run, "implement");
    let mut other = run_of("Implement my Linear tickets");
    other.id = "r2".into();
    other.state = RunState::Done;
    set_session(&mut other, "implement", "hp", "hp-other", "/r/main");
    fake.others.lock().unwrap().push(other.clone());
    assert_eq!(
        stop_all(&fake, &run).await,
        None,
        "an ended run holds nothing"
    );
    assert_eq!(fake.teardowns.lock().unwrap().len(), 1);

    fake.teardowns.lock().unwrap().clear();
    other.state = RunState::Running;
    *fake.others.lock().unwrap() = vec![other];
    let problem = stop_all(&fake, &run).await.expect("a note");
    assert!(fake.teardowns.lock().unwrap().is_empty());
    assert!(problem.contains("another run"), "{problem}");
}

#[tokio::test]
async fn a_failed_stop_at_the_end_of_a_run_is_told() {
    let fake = Fake::default();
    *fake.stop_fails.lock().unwrap() = true;
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    fake.session("hp", "hp-main", "b", Activity::Idle);
    let problem = stop_all(&fake, &run).await.expect("a note");
    assert!(problem.contains("hp-main"), "{problem}");
}

#[tokio::test]
async fn a_start_says_which_worktree_it_made() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    run.step = "implement".into();
    run.place.machine = "hp".into();
    run.place.folder = "acme/app".into();
    run.state_of("implement").machine = "hp".into();
    let effect = Effect::Agent {
        step: "implement".into(),
    };
    let seen = act(&fake, &Pipelines::default(), &run, &effect).await;
    assert_eq!(
        seen.first(),
        Some(&Seen::WorktreeMade {
            step: "implement".into(),
            path: "/r/hp-s1".into(),
            repo: "/r/repo".into(),
        }),
        "{seen:?}"
    );
    let (run, _) = engine::step(
        run,
        seen[0].clone(),
        &Pipelines::default(),
        chrono::Local::now(),
    );
    assert_eq!(run.steps["implement"].made, "/r/hp-s1");
    assert_eq!(run.steps["implement"].repo, "/r/repo");
}

#[tokio::test]
async fn a_run_tags_the_sessions_it_starts() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    let calls = enter_step(&fake, &mut run, "implement").await;
    assert!(
        calls[0].starts_with("start_session") && calls[0].contains("\"name_tag\":\"r1\""),
        "{calls:?}"
    );
}

#[tokio::test]
async fn a_blocked_shared_session_is_not_typed_into() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    fake.session("hp", "hp-main", "b", Activity::Blocked);
    run.step = "fix".into();
    run.state = RunState::Running;
    run.state_of("fix").machine = "hp".into();
    let effect = Effect::Agent { step: "fix".into() };
    let seen = act(&fake, &Pipelines::default(), &run, &effect).await;
    assert_eq!(count(&fake.calls(), "send_to_session"), 0);
    let (run, _) = engine::step(
        run,
        seen[0].clone(),
        &Pipelines::default(),
        chrono::Local::now(),
    );
    assert_eq!(run.steps["fix"].session, "hp-main");
    assert!(matches!(
        watch::seen(&run, &fake.view(), Some("Allow?"), chrono::Local::now()),
        Some(Seen::Waiting { .. })
    ));
}

#[tokio::test]
async fn a_busy_shared_session_is_typed_into_once_it_is_idle() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    fake.session("hp", "hp-main", "b", Activity::Active);
    run.step = "fix".into();
    run.state = RunState::Running;
    run.state_of("fix").machine = "hp".into();
    run.step_since = (chrono::Local::now() - chrono::Duration::minutes(5)).to_rfc3339();
    let effect = Effect::Agent { step: "fix".into() };
    let seen = act(&fake, &Pipelines::default(), &run, &effect).await;
    assert_eq!(count(&fake.calls(), "send_to_session"), 0);
    let (run, _) = engine::step(
        run,
        seen[0].clone(),
        &Pipelines::default(),
        chrono::Local::now(),
    );
    assert_eq!(
        watch::seen(&run, &fake.view(), None, chrono::Local::now()),
        None
    );
    fake.session("hp", "hp-main", "b", Activity::Idle);
    let (run, effects) = engine::step(
        run.clone(),
        watch::seen(&run, &fake.view(), Some("no result"), chrono::Local::now()).unwrap(),
        &Pipelines::default(),
        chrono::Local::now(),
    );
    assert_eq!(effects, vec![effect.clone()]);
    act(&fake, &Pipelines::default(), &run, &effect).await;
    assert_eq!(count(&fake.calls(), "send_to_session"), 1);
}

#[tokio::test]
async fn a_copy_from_a_stopped_session_names_its_folder() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-gone", "/r/main");
    run.state_of("qa").machine = "devbox".into();
    let calls = enter_step(&fake, &mut run, "qa").await;
    let moved = calls
        .iter()
        .find(|c| c.starts_with("move_session"))
        .expect("a move");
    assert!(moved.contains("\"path\":\"/r/main\""), "{moved}");
    assert!(moved.contains("\"name_tag\":\"r1\""), "{moved}");
}

#[test]
fn an_older_saved_step_still_loads() {
    let saved: Effect = serde_json::from_str(r#"{"effect":"stop_read_only"}"#).unwrap();
    assert_eq!(saved, Effect::StopSessions);
}

#[test]
fn a_runs_file_that_cannot_be_read_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("runs.json");
    std::fs::write(&file, "{ not json").unwrap();
    let store = super::store::Store::load(file);
    assert!(store.all().is_empty());
    let kept: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| std::fs::read_to_string(p).is_ok_and(|t| t == "{ not json"))
        .filter(|p| p.file_name().unwrap() != "runs.json")
        .collect();
    assert_eq!(kept.len(), 1, "a copy of the unreadable file stays");
}

#[test]
fn a_stale_session_is_left_out_of_the_sweep() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    set_session(&mut run, "review", "hp", "hp-review", "/r/main");
    run.step = "qa".into();
    run.state = RunState::Running;
    fake.session("hp", "hp-main", "b", Activity::Idle);
    fake.session("hp", "hp-review", "b", Activity::Idle);
    fake.stale.lock().unwrap().push("hp-review".to_string());
    assert!(needless_sessions(&run, &fake.view()).is_empty());
}

fn set_session(run: &mut Run, id: &str, machine: &str, session: &str, path: &str) {
    let st = run.state_of(id);
    st.machine = machine.into();
    st.session = session.into();
    st.path = path.into();
    st.started = chrono::Local::now().to_rfc3339();
}

fn edit_agent(run: &mut Run, id: &str, edit: impl FnOnce(&mut String, &mut SessionChoice)) {
    let def = run.definition.as_mut().unwrap();
    let step = def.steps.iter_mut().find(|s| s.id == id).unwrap();
    if let StepKind::Agent { agent, session, .. } = &mut step.kind {
        edit(agent, session);
    }
}

async fn enter_step(fake: &Fake, run: &mut Run, id: &str) -> Vec<String> {
    run.step = id.into();
    run.state = RunState::Running;
    run.place.machine = "hp".into();
    run.place.folder = "acme/app".into();
    run.place.branch = "com-1-fix".into();
    run.state_of(id).machine = run
        .steps
        .get(id)
        .map(|s| s.machine.clone())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "hp".into());
    act(
        fake,
        &Pipelines::default(),
        run,
        &Effect::Agent { step: id.into() },
    )
    .await;
    fake.calls()
}

fn count(calls: &[String], tool: &str) -> usize {
    calls.iter().filter(|c| c.starts_with(tool)).count()
}

#[tokio::test]
async fn steps_share_one_session() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    fake.session("hp", "hp-main", "com-1-fix", Activity::Idle);
    edit_agent(&mut run, "fix", |_, session| *session = SessionChoice::New);
    let calls = enter_step(&fake, &mut run, "fix").await;
    assert_eq!(count(&calls, "start_session"), 0, "{calls:?}");
    assert!(
        calls
            .iter()
            .any(|c| c.starts_with("send_to_session") && c.contains("hp-main")),
        "{calls:?}"
    );
}

#[tokio::test]
async fn a_review_step_gets_its_own_session() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    fake.session("hp", "hp-main", "com-1-fix", Activity::Idle);
    let calls = enter_step(&fake, &mut run, "review").await;
    assert_eq!(count(&calls, "start_session"), 1, "{calls:?}");
    assert_eq!(count(&calls, "send_to_session"), 0, "{calls:?}");
}

#[tokio::test]
async fn consecutive_read_only_steps_share_a_session() {
    let fake = Fake::default();
    let mut run = run_of("Review my merge requests");
    mr(&mut run);
    set_session(&mut run, "understand", "hp", "hp-reader", "/r/reader");
    fake.session("hp", "hp-reader", "com-1", Activity::Idle);
    let calls = enter_step(&fake, &mut run, "root-cause").await;
    assert_eq!(count(&calls, "start_session"), 0, "{calls:?}");
    assert!(
        calls
            .iter()
            .any(|c| c.starts_with("send_to_session") && c.contains("hp-reader")),
        "{calls:?}"
    );
}

#[tokio::test]
async fn a_step_on_another_machine_gets_its_own_session() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    fake.session("hp", "hp-main", "com-1-fix", Activity::Idle);
    edit_agent(&mut run, "fix", |_, session| *session = SessionChoice::New);
    run.state_of("fix").machine = "devbox".into();
    let calls = enter_step(&fake, &mut run, "fix").await;
    assert_eq!(count(&calls, "send_to_session"), 0, "{calls:?}");
    assert_eq!(count(&calls, "start_session"), 1, "{calls:?}");
}

#[tokio::test]
async fn a_step_naming_another_agent_gets_its_own_session() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    fake.session("hp", "hp-main", "com-1-fix", Activity::Idle);
    edit_agent(&mut run, "fix", |agent, session| {
        *agent = "codex".into();
        *session = SessionChoice::New;
    });
    let calls = enter_step(&fake, &mut run, "fix").await;
    assert_eq!(count(&calls, "send_to_session"), 0, "{calls:?}");
    assert_eq!(count(&calls, "start_session"), 1, "{calls:?}");
}

#[tokio::test]
async fn a_dead_shared_session_is_started_again_in_the_same_folder() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-gone", "/r/main");
    let calls = enter_step(&fake, &mut run, "fix").await;
    let start = calls
        .iter()
        .find(|c| c.starts_with("start_session"))
        .expect("a new session");
    assert!(start.contains("\"path\":\"/r/main\""), "{start}");
    assert!(!start.contains("new_branch"), "{start}");

    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-gone", "/r/main");
    run.state_of("implement").runs = 2;
    let calls = enter_step(&fake, &mut run, "implement").await;
    let start = calls
        .iter()
        .find(|c| c.starts_with("start_session"))
        .expect("a new session");
    assert!(
        start.contains("\"path\":\"/r/main\""),
        "no second worktree: {start}"
    );
}

#[tokio::test]
async fn a_retried_step_keeps_the_shared_session() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-old", "/r/main");
    run.state_of("implement").runs = 2;
    fake.session("hp", "hp-old", "com-1-fix", Activity::Idle);
    let calls = enter_step(&fake, &mut run, "implement").await;
    assert_eq!(count(&calls, "stop_session"), 0, "{calls:?}");
    assert_eq!(count(&calls, "start_session"), 0, "{calls:?}");
    assert!(
        calls
            .iter()
            .any(|c| c.starts_with("send_to_session") && c.contains("hp-old")),
        "{calls:?}"
    );
}

#[tokio::test]
async fn a_quiet_reviewer_is_asked_for_its_result_not_stopped() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    set_session(&mut run, "review", "hp", "hp-review", "/r/main");
    run.state_of("review").runs = 1;
    run.retried = true;
    fake.session("hp", "hp-main", "b", Activity::Idle);
    fake.session("hp", "hp-review", "b", Activity::Idle);
    let calls = enter_step(&fake, &mut run, "review").await;
    assert_eq!(count(&calls, "stop_session"), 0, "{calls:?}");
    assert_eq!(count(&calls, "start_session"), 0, "{calls:?}");
    let sent = calls
        .iter()
        .find(|c| c.starts_with("send_to_session"))
        .expect("a reminder");
    assert!(
        sent.contains("hp-review") && sent.contains("review-1-r1"),
        "{sent}"
    );
}

#[tokio::test]
async fn a_working_reviewer_is_left_alone_on_a_second_try() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    set_session(&mut run, "review", "hp", "hp-review", "/r/main");
    run.state_of("review").runs = 1;
    run.retried = true;
    fake.session("hp", "hp-main", "b", Activity::Idle);
    fake.session("hp", "hp-review", "b", Activity::Active);
    let calls = enter_step(&fake, &mut run, "review").await;
    assert!(calls.is_empty(), "{calls:?}");
}

#[tokio::test]
async fn a_retried_reviewer_starts_afresh() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    set_session(&mut run, "implement", "hp", "hp-main", "/r/main");
    set_session(&mut run, "review", "hp", "hp-review", "/r/main");
    run.state_of("review").runs = 2;
    fake.session("hp", "hp-main", "com-1-fix", Activity::Idle);
    fake.session("hp", "hp-review", "com-1-fix", Activity::Idle);
    let calls = enter_step(&fake, &mut run, "review").await;
    let stop = calls
        .iter()
        .position(|c| c.starts_with("stop_session") && c.contains("hp-review"));
    let start = calls.iter().position(|c| c.starts_with("start_session"));
    assert!(
        stop.is_some() && start.is_some() && stop < start,
        "{calls:?}"
    );
}

#[tokio::test]
async fn a_new_worktree_step_never_takes_over_another_session() {
    let fake = Fake::default();
    let mut run = run_of("Implement my Linear tickets");
    run.place = crate::pipeline::record::Place {
        machine: "hp".into(),
        folder: "acme/app".into(),
        branch: "com-1-fix".into(),
        path: String::new(),
    };
    run.step = "implement".into();
    run.state_of("implement").machine = "hp".into();
    fake.session("hp", "hp-yours", "com-1-fix", Activity::Idle);
    let seen = act(
        &fake,
        &Pipelines::default(),
        &run,
        &Effect::Agent {
            step: "implement".into(),
        },
    )
    .await;
    assert!(
        fake.calls().iter().any(|c| c.starts_with("start_session")),
        "{:?}",
        fake.calls()
    );
    assert!(!format!("{seen:?}").contains("hp-yours"), "{seen:?}");
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
async fn a_pull_request_whose_ticket_cannot_be_read_still_runs() {
    let fake = Fake::default();
    *fake.ticket_fails.lock().unwrap() = true;
    fake.replies
        .lock()
        .unwrap()
        .extend([PLANNED.to_string(), REPORTED.to_string()]);
    let mut run = run_of("Review my merge requests");
    mr(&mut run);
    let run = drive(&fake, run, &[]).await;
    assert_eq!(run.state, RunState::Done, "{:?}", run.waiting);
}

#[tokio::test]
async fn read_only_steps_in_one_folder_share_its_session() {
    let fake = Fake::default();
    fake.replies
        .lock()
        .unwrap()
        .extend([PLANNED.to_string(), REPORTED.to_string()]);
    let mut run = run_of("Review my merge requests");
    mr(&mut run);
    let run = drive(&fake, run, &[]).await;
    let understand = &run.steps["understand"];
    assert_eq!(run.steps["root-cause"].path, understand.path);
    assert_eq!(run.steps["root-cause"].session, understand.session);
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

mod pipelines {
    use super::*;
    use crate::pipeline::definition::{tests::cfg, Trigger};
    use crate::pipeline::record::{Subject, TicketRef};
    use crate::pipeline::triggers::{tests::Fakes, Sources};
    use crate::pipeline::Pipelines;
    use crate::pulls::{GitLabAccess, Mr};
    use std::sync::Arc;

    fn pipelines() -> (Arc<Pipelines>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Arc::new(Pipelines::new(dir.path().to_path_buf())), dir)
    }

    async fn tick(
        p: &Arc<Pipelines>,
        fake: &Arc<Fake>,
        src: Option<&Sources<'_>>,
        now: chrono::DateTime<chrono::Local>,
    ) {
        let world: Arc<dyn World> = fake.clone();
        for handle in p
            .tick(&world, &crate::config::Pipelines::default(), src, now)
            .await
        {
            handle.await.unwrap();
        }
    }

    fn ticket(id: &str) -> Subject {
        Subject {
            ticket: Some(TicketRef {
                source: String::new(),
                item_id: format!("u-{id}"),
                id: id.into(),
                title: "Fix".into(),
                url: String::new(),
            }),
            pr: None,
        }
    }

    #[tokio::test]
    async fn a_slow_sweep_does_not_hold_up_the_tick() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.step = "qa".into();
        run.state = RunState::Waiting;
        run.pending = None;
        run.state_of("implement").session = "hp-main".into();
        run.state_of("implement").machine = "hp".into();
        run.state_of("review").session = "hp-review".into();
        run.state_of("review").machine = "hp".into();
        p.put(run);
        let fake = Arc::new(Fake::default());
        fake.session("hp", "hp-main", "b", Activity::Idle);
        fake.session("hp", "hp-review", "b", Activity::Idle);
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *fake.hold_stops.lock().unwrap() = Some(gate.clone());
        let world: Arc<dyn World> = fake.clone();
        let settings = crate::config::Pipelines::default();
        let round = p.tick(&world, &settings, None, chrono::Local::now());
        let handles = tokio::time::timeout(std::time::Duration::from_secs(2), round)
            .await
            .expect("the tick did not wait for the stop");
        gate.add_permits(10);
        for handle in handles {
            handle.await.unwrap();
        }
        assert!(fake.calls().iter().any(|c| c.contains("hp-review")));
    }

    #[tokio::test]
    async fn a_result_off_the_screen_is_read_from_the_transcript() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.step = "review".into();
        run.state = RunState::Running;
        run.pending = None;
        run.step_since = chrono::Local::now().to_rfc3339();
        let st = run.state_of("review");
        st.session = "hp-review".into();
        st.machine = "hp".into();
        st.runs = 1;
        let marker = marker(&run, "review");
        let id = run.id.clone();
        p.put(run);
        let fake = Arc::new(Fake::default());
        fake.session("hp", "hp-review", "b", Activity::Idle);
        fake.screens
            .lock()
            .unwrap()
            .insert("hp-review".into(), "❯".into());
        fake.transcript
            .lock()
            .unwrap()
            .insert(marker.clone(), result(&marker, "pass", "Reviewed it."));
        tick(&p, &fake, None, chrono::Local::now()).await;
        let run = p.run(&id).unwrap();
        assert_eq!(run.steps["review"].outcome, Some(Outcome::Pass));
        assert_eq!(run.steps["review"].report, "Reviewed it.");
    }

    #[test]
    fn a_notification_opens_its_run() {
        let mut run = crate::pipeline::engine::tests::run_of("Implement my Linear tickets");
        run.id = "run-1".into();
        run.pipeline = "implement".into();
        assert_eq!(
            super::super::run::run_link("http://hp:4000", &run),
            "http://hp:4000/pipeline?p=implement&run=run-1"
        );
    }

    #[tokio::test]
    async fn deleting_a_running_run_stops_it_then_removes_it() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.step = "implement".into();
        run.state = RunState::Running;
        run.pending = None;
        let st = run.state_of("implement");
        st.session = "hp-main".into();
        st.machine = "hp".into();
        st.path = "/r/made".into();
        st.made = "/r/made".into();
        st.repo = "/r/repo".into();
        let id = run.id.clone();
        p.put(run);
        let fake = Arc::new(Fake::default());
        fake.session("hp", "hp-main", "b", Activity::Active);
        assert!(p.delete_run(&id));
        assert!(
            p.runs().iter().all(|r| r.id != id),
            "it leaves the lists at once"
        );
        assert_eq!(p.run(&id).unwrap().state, RunState::Dropped);
        tick(&p, &fake, None, chrono::Local::now()).await;
        assert!(fake
            .calls()
            .iter()
            .any(|c| c.starts_with("stop_session") && c.contains("hp-main")));
        assert_eq!(*fake.teardowns.lock().unwrap(), vec!["hp:/r/made"]);
        tick(&p, &fake, None, chrono::Local::now()).await;
        assert!(p.run(&id).is_none());
        assert!(!p.delete_run(&id), "it is gone");
    }

    #[tokio::test]
    async fn deleting_an_ended_run_removes_it_at_once() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.state = RunState::Done;
        run.pending = None;
        let id = run.id.clone();
        p.put(run);
        assert!(p.delete_run(&id));
        assert!(p.run(&id).is_none());
    }

    #[tokio::test]
    async fn a_run_still_stopping_goes_once_it_has_stopped() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.state = RunState::Dropped;
        run.pending = Some(Effect::StopSessions);
        let id = run.id.clone();
        p.put(run);
        assert!(p.delete_run(&id));
        assert!(p.run(&id).is_some());
        let fake = Arc::new(Fake::default());
        tick(&p, &fake, None, chrono::Local::now()).await;
        assert!(p.run(&id).is_none());
    }

    #[tokio::test]
    async fn a_tick_stops_a_finished_reviewers_session() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.step = "qa".into();
        run.state = RunState::Waiting;
        run.pending = None;
        run.state_of("implement").session = "hp-main".into();
        run.state_of("implement").machine = "hp".into();
        run.state_of("review").session = "hp-review".into();
        run.state_of("review").machine = "hp".into();
        p.put(run);
        let fake = Arc::new(Fake::default());
        fake.session("hp", "hp-main", "b", Activity::Idle);
        fake.session("hp", "hp-review", "b", Activity::Idle);
        tick(&p, &fake, None, chrono::Local::now()).await;
        let calls = fake.calls();
        assert!(
            calls
                .iter()
                .any(|c| c.starts_with("stop_session") && c.contains("hp-review")),
            "{calls:?}"
        );
        assert!(!calls.iter().any(|c| c.contains("hp-main")), "{calls:?}");
    }

    #[tokio::test]
    async fn dropping_a_run_while_its_step_starts_stops_the_new_session() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.place = crate::pipeline::record::Place {
            machine: "hp".into(),
            folder: "acme/app".into(),
            branch: "com-1-fix".into(),
            path: String::new(),
        };
        run.step = "implement".into();
        run.state = RunState::Running;
        run.slot = Some("hp".into());
        run.state_of("implement").machine = "hp".into();
        run.pending = Some(Effect::Agent {
            step: "implement".into(),
        });
        let id = run.id.clone();
        p.put(run);
        let fake = Arc::new(Fake::default());
        let (p2, id2) = (p.clone(), id.clone());
        *fake.on_start.lock().unwrap() = Some(Box::new(move || {
            p2.drop_run(&id2).unwrap();
        }));
        tick(&p, &fake, None, chrono::Local::now()).await;
        let run = p.run(&id).unwrap();
        assert_eq!(run.state, RunState::Dropped);
        assert!(
            fake.calls()
                .iter()
                .any(|c| c.starts_with("stop_session") && c.contains("hp-s1")),
            "{:?}",
            fake.calls()
        );
        assert_eq!(run.pending, None);
    }

    #[tokio::test]
    async fn deleting_a_pipeline_stops_its_runs_sessions() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.step = "implement".into();
        run.state = RunState::Running;
        run.pending = None;
        let st = run.state_of("implement");
        st.machine = "hp".into();
        st.session = "hp-busy".into();
        p.put(run);
        let fake = Arc::new(Fake::default());
        fake.session("hp", "hp-busy", "com-1-fix", Activity::Active);
        p.delete(&def.id).unwrap();
        assert!(p.runs().is_empty());
        tick(&p, &fake, None, chrono::Local::now()).await;
        assert!(
            fake.calls()
                .iter()
                .any(|c| c.starts_with("stop_session") && c.contains("hp-busy")),
            "{:?}",
            fake.calls()
        );
    }

    #[tokio::test]
    async fn finished_runs_are_pruned_to_the_newest() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        for n in 0..60 {
            let mut run = p
                .start(&def.id, vec![ticket(&format!("COM-{n}"))], "you")
                .unwrap()
                .remove(0);
            run.state = RunState::Done;
            run.pending = None;
            run.started = format!("2026-10-{:02}T09:00:00+00:00", 1 + n % 28);
            p.put(run);
        }
        let fake = Arc::new(Fake::default());
        tick(&p, &fake, None, chrono::Local::now()).await;
        assert_eq!(p.runs().len(), crate::pipeline::KEEP_FINISHED);
    }

    #[tokio::test]
    async fn starting_a_run_plans_it() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let runs = p.start(&def.id, vec![ticket("COM-1")], "you").unwrap();
        assert_eq!(
            runs[0].pending,
            Some(Effect::Plan {
                step: "plan".into()
            })
        );
        let err = p.start(&def.id, vec![ticket("COM-1")], "you").unwrap_err();
        assert!(
            err.contains("COM-1 Fix is already in a run of Implement my Linear tickets"),
            "{err}"
        );
        assert!(p.start("nope", vec![ticket("COM-2")], "you").is_err());
    }

    #[tokio::test]
    async fn an_item_in_a_run_is_not_started_again() {
        let (p, _dir) = pipelines();
        let mut def = p
            .library()
            .copy_template("Review my merge requests", &cfg())
            .unwrap();
        def.trigger = Trigger::GitlabReviewer {
            host: "git.commslayer.com".into(),
        };
        let def = p.library().save(def, &cfg()).unwrap();
        let def = p.library().set_enabled(&def.id, true, &cfg()).unwrap();
        let fakes = Fakes::default();
        let src = Sources {
            connectors: &fakes,
            feeds: &fakes,
            gitlab: &fakes,
            accesses: vec![GitLabAccess {
                host: "git.commslayer.com".into(),
                api: String::new(),
                secret: "gitlab".into(),
                token: Ok("t".into()),
            }],
            linear_key: Ok("lin".into()),
            pattern: None,
        };
        let fake = Arc::new(Fake::default());
        let t0 = chrono::Local::now();
        tick(&p, &fake, Some(&src), t0).await;
        *fakes.mrs.lock().unwrap() = vec![Mr {
            url: "https://git.commslayer.com/commslayer/app/-/merge_requests/91".into(),
            iid: 91,
            title: "Inbox".into(),
            source_branch: "com-1250-inbox".into(),
            project: "commslayer/app".into(),
        }];
        tick(&p, &fake, Some(&src), t0 + chrono::Duration::minutes(4)).await;
        assert_eq!(p.runs().len(), 1);
        assert_eq!(p.runs()[0].pipeline, def.id);
        assert_eq!(p.runs()[0].started_by, "a trigger");
        let subject = p.runs()[0].subject.clone();
        assert!(
            p.start(&def.id, vec![subject], "you").is_err(),
            "the same merge request is not run twice"
        );
    }

    #[tokio::test]
    async fn a_restart_mid_start_finds_the_session() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.place.machine = "hp".into();
        run.place.branch = "com-1-fix-the-login".into();
        run.step = "implement".into();
        run.state = RunState::Running;
        run.slot = Some("hp".into());
        run.state_of("implement").machine = "hp".into();
        run.pending = Some(Effect::Agent {
            step: "implement".into(),
        });
        run.conversation = "conv0000000001".into();
        let id = run.id.clone();
        p.put(run);
        let fake = Arc::new(Fake::default());
        fake.session(
            "hp",
            "hp-app-com-1",
            "com-1-fix-the-login",
            Activity::Active,
        );
        tick(&p, &fake, None, chrono::Local::now()).await;
        let run = p.run(&id).unwrap();
        assert_eq!(
            run.steps["implement"].session, "hp-s1",
            "a session it did not start is left alone"
        );
        assert!(run.pending.is_none());
    }

    #[tokio::test]
    async fn answer_retry_continue_and_drop() {
        let (p, _dir) = pipelines();
        let def = p
            .library()
            .copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        let mut run = p
            .start(&def.id, vec![ticket("COM-1")], "you")
            .unwrap()
            .remove(0);
        run.state = RunState::Waiting;
        run.step = "implement".into();
        run.waiting = Some(crate::pipeline::record::Waiting {
            kind: WaitKind::Stopped,
            step: "implement".into(),
            reason: "Implement failed".into(),
            screen: String::new(),
        });
        let id = run.id.clone();
        p.put(run);
        let err = p.answer(&id, "go").unwrap_err();
        assert!(err.contains("is not waiting for an answer"), "{err}");
        let run = p.continue_on(&id, Outcome::Pass).unwrap();
        assert_eq!((run.step.as_str(), run.state), ("review", RunState::Queued));
        let run = p.drop_run(&id).unwrap();
        assert_eq!(
            (run.state, run.pending),
            (RunState::Dropped, Some(Effect::StopSessions))
        );
        assert!(p.retry(&id).is_err());
        assert!(p.answer("nope", "x").unwrap_err().contains("is not a run"));
    }
}

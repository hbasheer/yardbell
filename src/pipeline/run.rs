use super::definition::{LinearAction, Outcome, Step, StepKind, Workspace};
use super::forge::{Draft, Forge};
use super::linear::Linear;
use super::prompts::{self, TicketText};
use super::record::{Effect, PullRef, Run, Seen, StepState};
use crate::config::{Approval, Config, Pipelines as Cfg};
use crate::dispatch::{By, ReviewOf};
use crate::phone::Push;
use crate::secrets::Secrets;
use crate::state::{SessionView, StateView};
use crate::triggers::LINEAR_SECRET;
use crate::web::AppState;
use futures::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::Arc;

// Everything a pipeline does outside its own records goes through here: the live one uses the
// server's state, Dispatch, Linear and the forges; tests use a fake that records each call.
pub trait World: Send + Sync {
    fn view(&self) -> StateView;
    fn machines(&self) -> Vec<String>;
    fn notes(&self, folder: &str) -> String;
    fn screen<'a>(&'a self, machine: &'a str, name: &'a str) -> BoxFuture<'a, Option<String>>;
    fn events(&self, conversation: &str) -> Vec<Value>;
    fn open_conversation(&self, title: &str) -> String;
    fn record(
        &self,
        conversation: &str,
        tool: &str,
        input: Value,
        review: Option<ReviewOf>,
        outcome: &Result<Value, String>,
        run_started: &str,
    );
    fn refused(&self, tool: &str, input: &Value) -> Option<String>;
    fn perform<'a>(&'a self, tool: &'a str, input: Value) -> BoxFuture<'a, Result<Value, String>>;
    fn review_plan(&self, machine: &str, name: &str) -> Result<(Value, ReviewOf), String>;
    fn ask<'a>(
        &'a self,
        conversation: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<String, String>>;
    fn ticket<'a>(
        &'a self,
        linear_id: &'a str,
    ) -> BoxFuture<'a, Result<(TicketText, bool), String>>;
    fn move_ticket<'a>(
        &'a self,
        linear_id: &'a str,
        state: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;
    fn open_draft<'a>(
        &'a self,
        run: &'a Run,
        path: &'a str,
    ) -> BoxFuture<'a, Result<PullRef, String>>;
    fn notify(&self, text: &str);
    fn teardown<'a>(
        &'a self,
        machine: &'a str,
        folder: &'a str,
        path: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;
}

enum Halt {
    Refused(String),
    Failed(String),
}

// One step the way Dispatch's own run: put to the rules, carried out, and recorded in the run's
// conversation so its card shows there.
async fn run_step(world: &dyn World, run: &Run, tool: &str, input: Value) -> Result<Value, Halt> {
    if let Some(reason) = world.refused(tool, &input) {
        return Err(Halt::Refused(reason));
    }
    let out = world.perform(tool, input.clone()).await;
    world.record(&run.conversation, tool, input, None, &out, &run.started);
    out.map_err(Halt::Failed)
}

fn session<'a>(view: &'a StateView, name: &str) -> Option<&'a SessionView> {
    (!name.is_empty())
        .then(|| {
            view.sessions
                .iter()
                .find(|s| s.tmux.as_deref() == Some(name))
        })
        .flatten()
}

fn branch(run: &Run) -> String {
    match &run.subject.pr {
        Some(pr) if !pr.branch.is_empty() => pr.branch.clone(),
        _ => run.place.branch.clone(),
    }
}

// The folder the work is in: the first agent step that made a worktree.
fn work_path(run: &Run) -> Option<String> {
    run.def()
        .steps
        .iter()
        .filter(|s| {
            matches!(
                s.kind,
                StepKind::Agent {
                    workspace: Workspace::NewWorktree,
                    ..
                }
            )
        })
        .filter_map(|s| run.steps.get(&s.id).map(|st| st.path.clone()))
        .find(|p| !p.is_empty())
}

async fn ticket_text(world: &dyn World, run: &Run) -> Result<TicketText, Seen> {
    let Some(t) = &run.subject.ticket else {
        return Ok(TicketText::default());
    };
    match world.ticket(&t.linear_id).await {
        Ok((_, true)) => Err(Seen::Closed("closed".into())),
        Ok((text, false)) => Ok(text),
        // A pull request's ticket is only a name found in its branch or title, so one Linear
        // cannot read leaves the step without the ticket's text rather than stopping it.
        Err(_) if run.subject.pr.is_some() => Ok(TicketText::default()),
        Err(e) => Err(Seen::Started {
            step: run.step.clone(),
            result: Err(e),
        }),
    }
}

async fn started(world: &dyn World, run: &Run, step: &str, tool: &str, input: Value) -> Seen {
    match run_step(world, run, tool, input).await {
        Ok(v) => {
            let field = |k: &str| v[k].as_str().unwrap_or_default().to_string();
            match field("name") {
                name if !name.is_empty() => Seen::Started {
                    step: step.into(),
                    result: Ok((name, field("machine"), field("path"))),
                },
                _ => Seen::Started {
                    step: step.into(),
                    result: Err(format!("{tool} did not say which session it started")),
                },
            }
        }
        Err(Halt::Refused(reason)) => Seen::Refused(reason),
        Err(Halt::Failed(e)) => Seen::Started {
            step: step.into(),
            result: Err(e),
        },
    }
}

fn agent_of(step: &Step) -> Option<(&str, bool)> {
    match &step.kind {
        StepKind::Agent {
            agent, read_only, ..
        } => Some((agent, *read_only)),
        _ => None,
    }
}

// The session this step can type into instead of starting one: the run's newest live session on
// the same machine, with the same agent and the same read-only setting, which cannot change in a
// running agent. A reviewer run again never reuses its own.
fn shared_session(run: &Run, view: &StateView, step: &Step, machine: &str) -> Option<StepState> {
    let wanted = agent_of(step)?;
    let def = run.def();
    run.steps
        .iter()
        .filter(|(id, st)| {
            st.machine == machine
                && session(view, &st.session).is_some()
                && !(wanted.1 && **id == step.id)
                && def.step(id).and_then(agent_of) == Some(wanted)
        })
        .map(|(_, st)| st)
        .max_by_key(|st| st.started.clone())
        .cloned()
}

// Sessions of a live run that nothing needs any more: everything but the current step's and the
// newest writer's, which later steps type into.
pub fn needless_sessions(run: &Run, view: &StateView) -> Vec<(String, String)> {
    let def = run.def();
    let current = run
        .steps
        .get(&run.step)
        .map(|s| s.session.as_str())
        .unwrap_or_default();
    let writer = run
        .steps
        .iter()
        .filter(|(id, st)| {
            !st.session.is_empty()
                && def
                    .step(id)
                    .and_then(agent_of)
                    .is_some_and(|(_, read_only)| !read_only)
        })
        .max_by_key(|(_, st)| st.started.clone())
        .map(|(_, st)| st.session.as_str())
        .unwrap_or_default();
    let mut out: Vec<(String, String)> = run
        .steps
        .values()
        .filter(|st| st.session != current && st.session != writer)
        .filter_map(|st| {
            session(view, &st.session).map(|s| (s.machine.clone(), st.session.clone()))
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn folder_on(run: &Run, machine: &str) -> Option<String> {
    run.steps
        .values()
        .filter(|st| st.machine == machine && !st.path.is_empty())
        .max_by_key(|st| st.started.clone())
        .map(|st| st.path.clone())
}

async fn agent(world: &dyn World, cfg: &Cfg, run: &Run, step: &Step) -> Vec<Seen> {
    let StepKind::Agent {
        agent,
        workspace,
        read_only,
        ..
    } = &step.kind
    else {
        return vec![];
    };
    let text = match ticket_text(world, run).await {
        Ok(t) => t,
        Err(seen) => return vec![seen],
    };
    let state = run.steps.get(&step.id).cloned().unwrap_or_default();
    let notes = cfg
        .qa_notes
        .get(&run.place.folder)
        .cloned()
        .unwrap_or_else(|| world.notes(&run.place.folder));
    let answer = Some(state.answer.as_str()).filter(|a| !a.is_empty());
    let prompt = prompts::agent(run, step, &text, answer, &notes);
    let view = world.view();
    let machine = state.machine.clone();
    if let Some(shared) = shared_session(run, &view, step, &machine) {
        let live_machine =
            session(&view, &shared.session).map_or_else(|| machine.clone(), |s| s.machine.clone());
        let input = json!({ "machine": live_machine, "name": shared.session, "text": prompt });
        return match run_step(world, run, "send_to_session", input).await {
            Ok(_) => vec![Seen::Started {
                step: step.id.clone(),
                result: Ok((shared.session, live_machine, shared.path)),
            }],
            Err(Halt::Refused(reason)) => vec![Seen::Refused(reason)],
            Err(Halt::Failed(e)) => vec![Seen::Sent(Err(e))],
        };
    }
    // A reviewer run again starts afresh, so it reads the code rather than its earlier opinion.
    if *read_only {
        if let Some(old) = session(&view, &state.session) {
            let input = json!({ "machine": old.machine, "name": state.session });
            let _ = world.perform("stop_session", input).await;
        }
    }
    let mut input = match workspace {
        // The run's folder outlives a session that died, so its work is picked up there.
        Workspace::NewWorktree if folder_on(run, &machine).is_some() => {
            let path = folder_on(run, &machine).unwrap_or_default();
            json!({ "machine": machine, "path": path, "prompt": prompt, "read_only": read_only, "wait": true })
        }
        Workspace::NewWorktree => {
            let wanted = branch(run);
            json!({
                "machine": machine,
                "folder": run.place.folder,
                "branch": wanted,
                "new_branch": run.subject.pr.is_none(),
                "prompt": prompt,
                "read_only": read_only,
                "wait": true,
            })
        }
        Workspace::SameAs { step: other } => {
            let path = run
                .steps
                .get(other)
                .map(|s| s.path.clone())
                .unwrap_or_default();
            json!({ "machine": machine, "path": path, "prompt": prompt, "read_only": read_only, "wait": true })
        }
        Workspace::Copy { from } => {
            let theirs = run.steps.get(from).cloned().unwrap_or_default();
            if theirs.machine == machine {
                json!({ "machine": machine, "path": theirs.path, "prompt": prompt, "read_only": read_only, "wait": true })
            } else {
                let input = json!({
                    "machine": theirs.machine,
                    "name": theirs.session,
                    "to": machine,
                    "task": prompt,
                    "stop_original": false,
                    "read_only": read_only,
                });
                return vec![started(world, run, &step.id, "move_session", input).await];
            }
        }
    };
    if !agent.is_empty() {
        input["agent"] = json!(agent);
    }
    vec![started(world, run, &step.id, "start_session", input).await]
}

async fn closed(world: &dyn World, run: &Run) -> bool {
    match &run.subject.ticket {
        Some(t) => matches!(world.ticket(&t.linear_id).await, Ok((_, true))),
        None => false,
    }
}

pub async fn act(world: &dyn World, cfg: &Cfg, run: &Run, effect: &Effect) -> Vec<Seen> {
    let step_of = |id: &str| run.def().step(id).cloned();
    match effect {
        Effect::Plan { step } => {
            let text = match ticket_text(world, run).await {
                Ok(t) => t,
                Err(Seen::Closed(c)) => return vec![Seen::Closed(c)],
                Err(_) => TicketText::default(),
            };
            let mut machines = match step_of(step).map(|s| s.kind) {
                Some(StepKind::Plan { machines }) => machines,
                _ => vec![],
            };
            if machines.is_empty() {
                machines = world.machines();
            }
            let reply = world
                .ask(&run.conversation, &prompts::plan(run, &text, &machines))
                .await;
            vec![Seen::Planned(
                reply.and_then(|t| prompts::parse_plan(&t, &machines, run)),
            )]
        }
        Effect::Agent { step } => match step_of(step) {
            Some(s) => agent(world, cfg, run, &s).await,
            None => vec![],
        },
        Effect::Answer { step, text } => {
            let st = run.steps.get(step).cloned().unwrap_or_default();
            let input = json!({ "machine": st.machine, "name": st.session, "text": text });
            match run_step(world, run, "send_to_session", input).await {
                Ok(_) => vec![Seen::Sent(Ok(()))],
                Err(Halt::Refused(reason)) => vec![Seen::Refused(reason)],
                Err(Halt::Failed(e)) => vec![Seen::Sent(Err(e))],
            }
        }
        Effect::Push { .. } => {
            if closed(world, run).await {
                return vec![Seen::Closed("closed".into())];
            }
            let Some(path) = work_path(run) else {
                return vec![Seen::Pushed(Err(
                    "no step made a worktree, so there is no branch to push".into(),
                ))];
            };
            let input =
                json!({ "machine": run.place.machine, "path": path, "branch": branch(run) });
            match run_step(world, run, "push_branch", input).await {
                Ok(_) => vec![Seen::Pushed(Ok(()))],
                Err(Halt::Refused(e) | Halt::Failed(e)) => vec![Seen::Pushed(Err(e))],
            }
        }
        Effect::OpenPull { .. } => match work_path(run) {
            Some(path) => vec![Seen::Opened(world.open_draft(run, &path).await)],
            None => vec![Seen::Opened(Err("no step made a worktree".into()))],
        },
        Effect::Linear { step } => {
            let Some(StepKind::Linear { action, state }) = step_of(step).map(|s| s.kind) else {
                return vec![];
            };
            let Some(ticket) = &run.subject.ticket else {
                return vec![Seen::Linear(Err("this run has no Linear ticket".into()))];
            };
            match action {
                LinearAction::Move => {
                    vec![Seen::Linear(
                        world.move_ticket(&ticket.linear_id, &state).await,
                    )]
                }
                LinearAction::Comment => vec![Seen::Ended {
                    step: step.clone(),
                    outcome: Outcome::Pass,
                    report: comment(run),
                    details: vec![],
                }],
            }
        }
        Effect::Report { .. } => {
            let reply = world.ask(&run.conversation, &prompts::report(run)).await;
            let written = reply.and_then(|t| prompts::parse_report(&t));
            let line = written
                .as_ref()
                .ok()
                .and_then(|t| t.lines().next())
                .unwrap_or("its report could not be written");
            world.notify(&format!("{}: {line}", run.subject.label()));
            vec![Seen::Reported(written)]
        }
        Effect::Notify { text } => {
            world.notify(text);
            vec![]
        }
        Effect::StopSessions => {
            let view = world.view();
            let mut live: Vec<(&str, &str)> = run
                .steps
                .values()
                .filter_map(|st| {
                    session(&view, &st.session).map(|s| (s.machine.as_str(), st.session.as_str()))
                })
                .collect();
            live.sort_unstable();
            live.dedup();
            for (machine, name) in live {
                let input = json!({ "machine": machine, "name": name });
                let _ = world.perform("stop_session", input).await;
            }
            let mut places: Vec<(&str, &str)> = run
                .steps
                .values()
                .filter(|st| !st.machine.is_empty() && !st.path.is_empty())
                .map(|st| (st.machine.as_str(), st.path.as_str()))
                .collect();
            places.sort_unstable();
            places.dedup();
            let mut problems = Vec::new();
            for (machine, path) in places {
                if let Err(e) = world.teardown(machine, &run.place.folder, path).await {
                    problems.push(e);
                }
            }
            vec![Seen::TornDown(
                (!problems.is_empty()).then(|| problems.join("; ")),
            )]
        }
    }
}

// A comment for the person to post on the ticket: what each step found, in order.
fn comment(run: &Run) -> String {
    let mut lines = vec![format!("{} ran on this ticket:", run.pipeline_name)];
    for e in run.history.iter().filter(|e| e.outcome.is_some()) {
        if let (Some(step), Some(st)) = (run.def().step(&e.step), run.steps.get(&e.step)) {
            let said = st.report.lines().next().unwrap_or("");
            lines.push(format!("- {}: {said}", step.name));
        }
    }
    if let Some(p) = &run.pull {
        lines.push(format!("Draft: {}", p.url));
    }
    lines.join("\n")
}

// The pipelines' view of the running server, built afresh each round with that round's config.
pub struct Live {
    app: Arc<AppState>,
    cfg: Config,
    secrets: Result<Secrets, String>,
    linear: Arc<Linear>,
    forge: Arc<Forge>,
}

impl Live {
    pub fn new(app: Arc<AppState>, cfg: Config, linear: Arc<Linear>, forge: Arc<Forge>) -> Live {
        let secrets = Secrets::for_config(&app.cfg_path).map_err(|e| e.to_string());
        Live {
            app,
            cfg,
            secrets,
            linear,
            forge,
        }
    }

    fn key(&self) -> Result<&str, String> {
        let secrets = self.secrets.as_ref().map_err(|e| format!("Linear: {e}"))?;
        secrets.get(LINEAR_SECRET).ok_or_else(|| {
            format!(
                "Linear: the secret {LINEAR_SECRET} is not set. Add your Linear API key under Settings, MCP servers, Secrets"
            )
        })
    }
}

impl World for Live {
    fn teardown<'a>(
        &'a self,
        machine: &'a str,
        folder: &'a str,
        path: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let m = self
                .cfg
                .machine(machine)
                .ok_or_else(|| format!("{machine} is not a machine"))?;
            let folders = vec![folder.to_string(), path.to_string()];
            match crate::web::worktrees_api::run_teardown(&self.app, &self.cfg, m, folders, path)
                .await
            {
                Some(run) if !run.ok => Err(run.summary()),
                _ => Ok(()),
            }
        })
    }

    fn view(&self) -> StateView {
        self.app
            .state
            .view(&self.cfg, self.app.ports.as_ref(), "localhost")
    }

    fn machines(&self) -> Vec<String> {
        self.cfg.machines.iter().map(|m| m.name.clone()).collect()
    }

    fn notes(&self, folder: &str) -> String {
        self.cfg
            .pipelines
            .qa_notes
            .get(folder)
            .cloned()
            .unwrap_or_default()
    }

    fn screen<'a>(&'a self, machine: &'a str, name: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let m = self.cfg.machine(machine)?.clone();
            self.app.sessions.read(&m, name, 60).await.ok()
        })
    }

    fn events(&self, conversation: &str) -> Vec<Value> {
        self.app
            .dispatch
            .get(conversation)
            .and_then(|c| c["events"].as_array().cloned())
            .unwrap_or_default()
    }

    fn open_conversation(&self, title: &str) -> String {
        self.app.dispatch.open_conversation(title)
    }

    fn record(
        &self,
        conversation: &str,
        tool: &str,
        input: Value,
        review: Option<ReviewOf>,
        outcome: &Result<Value, String>,
        run_started: &str,
    ) {
        self.app.dispatch.record_as(
            conversation,
            tool,
            input,
            review,
            None,
            outcome,
            By::Pipeline,
            Some(run_started),
        );
    }

    fn refused(&self, tool: &str, input: &Value) -> Option<String> {
        let step = crate::mcp::step_of(&self.app, tool, input);
        let d = &self.cfg.dispatch;
        let verdict = crate::dispatch::decide_step(d.approval, &d.rules, &step);
        (verdict.approval == Approval::Deny).then(|| match verdict.rule {
            Some(rule) => format!("Your rule: {}", rule.describe()),
            None => "Dispatch's settings refuse every step".to_string(),
        })
    }

    fn perform<'a>(&'a self, tool: &'a str, input: Value) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            crate::mcp::perform(&self.app, tool, input)
                .await
                .map_err(|e| e.1)
        })
    }

    fn review_plan(&self, machine: &str, name: &str) -> Result<(Value, ReviewOf), String> {
        let (_, input, of) = crate::mcp::plan(
            &self.app,
            &self.cfg,
            "review_session",
            json!({ "machine": machine, "name": name }),
        )
        .map_err(|e| e.1)?;
        Ok((input, of.ok_or("Yardbell did not plan a reviewer")?))
    }

    // One Dispatch turn whose reply Yardbell reads. Dispatch is asked to propose nothing, and
    // anything it proposed anyway is turned down so it never waits for the person.
    fn ask<'a>(
        &'a self,
        conversation: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let extra = match (&self.secrets, self.cfg.host()) {
                (Ok(s), Some(m)) => self.cfg.mcp_config_for(&m.name, s)?,
                _ => None,
            };
            let (id, mut rx) = self
                .app
                .dispatch
                .ask(
                    Some(conversation),
                    text,
                    self.cfg.port,
                    &self.cfg.dispatch,
                    extra.as_deref(),
                )
                .await?;
            while rx.recv().await.is_some() {}
            for step in self.app.dispatch.pending(&id) {
                let _ = self.app.dispatch.reject(&id, &step);
            }
            self.events(&id)
                .iter()
                .rev()
                .find(|e| e["role"] == "assistant")
                .and_then(|e| e["text"].as_str())
                .map(str::to_string)
                .ok_or_else(|| "Dispatch did not reply".to_string())
        })
    }

    fn ticket<'a>(
        &'a self,
        linear_id: &'a str,
    ) -> BoxFuture<'a, Result<(TicketText, bool), String>> {
        Box::pin(async move { self.linear.ticket(self.key()?, linear_id).await })
    }

    fn move_ticket<'a>(
        &'a self,
        linear_id: &'a str,
        state: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.linear.move_to(self.key()?, linear_id, state).await })
    }

    fn open_draft<'a>(
        &'a self,
        run: &'a Run,
        path: &'a str,
    ) -> BoxFuture<'a, Result<PullRef, String>> {
        Box::pin(async move {
            let m = self
                .cfg
                .machine(&run.place.machine)
                .ok_or_else(|| format!("{} is not a machine", run.place.machine))?;
            let gitlab = crate::pulls::accesses(&self.cfg.pull_requests, &self.secrets);
            let body = if run.report.is_empty() {
                comment(run)
            } else {
                run.report.clone()
            };
            let draft = Draft {
                branch: branch(run),
                title: run.subject.label(),
                body,
            };
            self.forge.open_draft(m, path, &draft, &gitlab).await
        })
    }

    fn notify(&self, text: &str) {
        let click = crate::phone::base_url(&self.cfg).map(|base| format!("{base}/pipeline"));
        self.app.phone.inbox.add(&[Push {
            title: "Yardbell pipelines".into(),
            message: text.to_string(),
            tags: vec![],
            priority: 3,
            click,
        }]);
    }
}

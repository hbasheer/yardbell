use super::forge::Forge;
use super::linear::Linear;
use super::prompts::{self, TicketText};
use super::record::{Effect, PullRef, Record, Seen, Stage};
use crate::config::{Approval, Config, Pipeline as Cfg};
use crate::dispatch::{By, ReviewOf};
use crate::phone::Push;
use crate::secrets::Secrets;
use crate::state::StateView;
use crate::triggers::LINEAR_SECRET;
use crate::web::AppState;
use futures::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::Arc;

// Everything the pipeline does outside its own records goes through here: the live one uses the
// server's state, Dispatch, Linear and the forges; tests use a fake that records each call.
pub trait World: Send + Sync {
    fn view(&self) -> StateView;
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
        r: &'a Record,
        path: &'a str,
    ) -> BoxFuture<'a, Result<PullRef, String>>;
    fn notify(&self, text: &str);
}

enum Halt {
    Refused(String),
    Failed(String),
}

fn run_started(r: &Record) -> String {
    r.history
        .first()
        .map(|e| e.at.clone())
        .filter(|at| !at.is_empty())
        .unwrap_or_else(|| r.stage_since.clone())
}

// One step the way Dispatch's own run: put to the rules, carried out, and recorded in the ticket's
// conversation so its card shows there.
async fn run_step(
    world: &dyn World,
    r: &Record,
    tool: &str,
    input: Value,
    review: Option<ReviewOf>,
) -> Result<Value, Halt> {
    if let Some(reason) = world.refused(tool, &input) {
        return Err(Halt::Refused(reason));
    }
    let out = world.perform(tool, input.clone()).await;
    world.record(&r.conversation, tool, input, review, &out, &run_started(r));
    out.map_err(Halt::Failed)
}

async fn started(
    world: &dyn World,
    r: &Record,
    tool: &str,
    input: Value,
    review: Option<ReviewOf>,
) -> Seen {
    match run_step(world, r, tool, input, review).await {
        Ok(v) => match v["name"].as_str() {
            Some(name) if !name.is_empty() => Seen::Started(Ok(name.to_string())),
            _ => Seen::Started(Err(format!("{tool} did not say which session it started"))),
        },
        Err(Halt::Refused(reason)) => Seen::Refused(reason),
        Err(Halt::Failed(e)) => Seen::Started(Err(e)),
    }
}

fn session<'a>(view: &'a StateView, name: &str) -> Option<&'a crate::state::SessionView> {
    (!name.is_empty())
        .then(|| {
            view.sessions
                .iter()
                .find(|s| s.tmux.as_deref() == Some(name))
        })
        .flatten()
}

// A session for this ticket's branch that already runs, such as one started just before Yardbell
// restarted, so a second one is never started beside it.
fn running(view: &StateView, r: &Record) -> Option<String> {
    if let Some(s) = session(view, &r.sessions.implement) {
        return s.tmux.clone();
    }
    view.sessions
        .iter()
        .find(|s| s.machine == r.machine && s.branch == r.branch && s.tmux.is_some())
        .and_then(|s| s.tmux.clone())
}

async fn ticket_text(world: &dyn World, r: &Record) -> Result<TicketText, Seen> {
    match world.ticket(&r.linear_id).await {
        Ok((_, true)) => Err(Seen::Closed("closed".into())),
        Ok((text, false)) => Ok(text),
        Err(e) => Err(Seen::Started(Err(e))),
    }
}

async fn closed(world: &dyn World, r: &Record) -> bool {
    matches!(world.ticket(&r.linear_id).await, Ok((_, true)))
}

pub async fn act(world: &dyn World, cfg: &Cfg, r: &Record, effect: &Effect) -> Vec<Seen> {
    let view = world.view();
    match effect {
        Effect::Triage => match world.ticket(&r.linear_id).await {
            Err(e) => vec![Seen::Triaged(Err(e))],
            Ok((_, true)) => vec![Seen::Closed("closed".into())],
            Ok((text, false)) => {
                let reply = world
                    .ask(&r.conversation, &prompts::triage(r, &text, cfg))
                    .await;
                vec![Seen::Triaged(reply.and_then(|t| {
                    prompts::parse_triage(&t, cfg, &r.id, &r.title)
                }))]
            }
        },
        Effect::Implement => {
            if let Some(name) = running(&view, r) {
                return vec![Seen::Started(Ok(name))];
            }
            let text = match ticket_text(world, r).await {
                Ok(t) => t,
                Err(seen) => return vec![seen],
            };
            let input = json!({
                "machine": r.machine,
                "folder": r.folder,
                "branch": r.branch,
                "new_branch": true,
                "prompt": prompts::implement(r, &text),
                "wait": true,
            });
            vec![started(world, r, "start_session", input, None).await]
        }
        Effect::Review => {
            if closed(world, r).await {
                return vec![Seen::Closed("closed".into())];
            }
            match world.review_plan(&r.machine, &r.sessions.implement) {
                Ok((input, of)) => vec![started(world, r, "start_session", input, Some(of)).await],
                Err(e) => vec![Seen::Started(Err(e))],
            }
        }
        Effect::Send(text) | Effect::Answer(text) => {
            let name = match (effect, r.stage) {
                (Effect::Answer(_), Stage::Qa) => &r.sessions.qa,
                (Effect::Answer(_), Stage::Review) => &r.sessions.review,
                _ => &r.sessions.implement,
            };
            let machine = session(&view, name).map_or(r.machine.clone(), |s| s.machine.clone());
            let input = json!({ "machine": machine, "name": name, "text": text });
            match run_step(world, r, "send_to_session", input, None).await {
                Ok(_) => vec![Seen::Sent(Ok(()))],
                Err(Halt::Refused(reason)) => vec![Seen::Refused(reason)],
                Err(Halt::Failed(e)) => vec![Seen::Sent(Err(e))],
            }
        }
        Effect::MoveToTest => {
            let text = match ticket_text(world, r).await {
                Ok(t) => t,
                Err(seen) => return vec![seen],
            };
            let task = prompts::qa(r, &text, cfg);
            // On the machine that implemented it, QA reads the same worktree instead of a copy.
            if cfg.test_machine == r.machine {
                let Some(path) = session(&view, &r.sessions.implement).map(|s| s.path.clone())
                else {
                    return vec![Seen::Started(Err(gone(r)))];
                };
                let input = json!({
                    "machine": r.machine,
                    "path": path,
                    "prompt": task,
                    "read_only": true,
                    "wait": true,
                });
                return vec![started(world, r, "start_session", input, None).await];
            }
            let input = json!({
                "machine": r.machine,
                "name": r.sessions.implement,
                "to": cfg.test_machine,
                "task": task,
                "stop_original": false,
                "read_only": true,
            });
            vec![started(world, r, "move_session", input, None).await]
        }
        Effect::Push => {
            if closed(world, r).await {
                return vec![Seen::Closed("closed".into())];
            }
            let Some(path) = session(&view, &r.sessions.implement).map(|s| s.path.clone()) else {
                return vec![Seen::Pushed(Err(gone(r)))];
            };
            let input = json!({ "machine": r.machine, "path": path, "branch": r.branch });
            match run_step(world, r, "push_branch", input, None).await {
                Ok(_) => vec![Seen::Pushed(Ok(()))],
                Err(Halt::Refused(e) | Halt::Failed(e)) => vec![Seen::Pushed(Err(e))],
            }
        }
        Effect::OpenPull => match session(&view, &r.sessions.implement) {
            Some(s) => vec![Seen::Opened(world.open_draft(r, &s.path).await)],
            None => vec![Seen::Opened(Err(gone(r)))],
        },
        Effect::MoveLinear => vec![Seen::Moved(
            world.move_ticket(&r.linear_id, &cfg.linear_state).await,
        )],
        Effect::Summarise => {
            let reply = world.ask(&r.conversation, &prompts::summary(r)).await;
            vec![Seen::Summarised(
                reply.and_then(|t| prompts::parse_summary(&t)),
            )]
        }
        Effect::Notify(text) => {
            world.notify(text);
            vec![]
        }
        Effect::StopSessions => {
            for name in [&r.sessions.implement, &r.sessions.review, &r.sessions.qa] {
                if let Some(s) = session(&view, name) {
                    let _ = world
                        .perform(
                            "stop_session",
                            json!({ "machine": s.machine, "name": name }),
                        )
                        .await;
                }
            }
            vec![]
        }
    }
}

fn gone(r: &Record) -> String {
    format!(
        "the implementer's session for {} is gone, so Yardbell cannot find the branch's folder",
        r.id
    )
}

// The pipeline's view of the running server, built afresh each round with the config of the round.
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
    fn view(&self) -> StateView {
        self.app
            .state
            .view(&self.cfg, self.app.ports.as_ref(), "localhost")
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
        r: &'a Record,
        path: &'a str,
    ) -> BoxFuture<'a, Result<PullRef, String>> {
        Box::pin(async move {
            let m = self
                .cfg
                .machine(&r.machine)
                .ok_or_else(|| format!("{} is not a machine", r.machine))?;
            let gitlab = crate::pulls::accesses(&self.cfg.pull_requests, &self.secrets);
            self.forge.open_draft(m, path, r, &gitlab).await
        })
    }

    fn notify(&self, text: &str) {
        let click = crate::phone::base_url(&self.cfg).map(|base| format!("{base}/pipeline"));
        self.app.phone.inbox.add(&[Push {
            title: "Yardbell pipeline".into(),
            message: text.to_string(),
            tags: vec![],
            priority: 3,
            click,
        }]);
    }
}

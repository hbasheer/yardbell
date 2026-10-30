pub mod definition;
pub mod engine;
pub mod forge;
pub mod library;
pub mod linear;
pub mod prompts;
pub mod record;
pub mod run;
pub mod store;
pub mod templates;
pub mod triggers;
pub mod watch;

#[cfg(test)]
mod tests;

use definition::Outcome;
use library::Library;
use record::{Effect, Run, RunState, Seen, Subject};
use run::World;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use store::Store;
use tokio::task::JoinHandle;

const TICK: std::time::Duration = std::time::Duration::from_secs(10);
pub const KEEP_FINISHED: usize = 50;

pub struct Pipelines {
    library: Library,
    store: Store,
    watch: triggers::Watch,
    // Runs with a step being carried out; the tick leaves them alone until it ends.
    busy: Mutex<HashSet<String>>,
    cfg: Mutex<crate::config::Pipelines>,
    ticking: tokio::sync::Mutex<()>,
    linear: Mutex<Arc<linear::Linear>>,
    // Sessions of runs that went with a deleted pipeline, stopped on the next round.
    orphans: Mutex<Vec<(String, String)>>,
}

fn first_step(effects: Vec<Effect>) -> (Option<Effect>, Vec<String>) {
    let mut step = None;
    let mut notes = Vec::new();
    for e in effects {
        match e {
            Effect::Notify { text } => notes.push(text),
            other if step.is_none() => step = Some(other),
            _ => {}
        }
    }
    (step, notes)
}

impl Pipelines {
    pub fn new(dir: PathBuf) -> Pipelines {
        Pipelines {
            library: Library::load(dir.join("pipelines")),
            store: Store::load(dir.join("runs.json")),
            watch: triggers::Watch::load(dir.join("watch.json")),
            busy: Mutex::new(HashSet::new()),
            cfg: Mutex::new(crate::config::Pipelines::default()),
            ticking: tokio::sync::Mutex::new(()),
            linear: Mutex::new(Arc::new(linear::Linear::new())),
            orphans: Mutex::new(Vec::new()),
        }
    }

    pub fn library(&self) -> &Library {
        &self.library
    }

    pub fn watch(&self) -> &triggers::Watch {
        &self.watch
    }

    pub fn runs(&self) -> Vec<Run> {
        self.store
            .all()
            .into_iter()
            .filter(|r| !r.deleting)
            .collect()
    }

    pub fn run(&self, id: &str) -> Option<Run> {
        self.store.get(id)
    }

    pub fn linear(&self) -> Arc<linear::Linear> {
        self.linear.lock().expect("pipelines linear").clone()
    }

    #[cfg(test)]
    pub fn use_linear(&self, linear: linear::Linear) {
        *self.linear.lock().expect("pipelines linear") = Arc::new(linear);
    }

    #[cfg(test)]
    pub fn put(&self, run: Run) {
        self.store.put(run);
    }

    pub fn delete(&self, pipeline: &str) -> Result<(), String> {
        self.library.delete(pipeline)?;
        let sessions = self
            .store
            .all()
            .into_iter()
            .filter(|r| r.pipeline == pipeline && r.state.active())
            .flat_map(|r| r.steps.into_values())
            .filter(|st| !st.session.is_empty())
            .map(|st| (st.machine, st.session));
        self.orphans
            .lock()
            .expect("pipelines orphans")
            .extend(sessions);
        self.store.remove_pipeline(pipeline);
        Ok(())
    }

    // Starts a run for each subject; one already running in this pipeline is refused.
    pub fn start(
        &self,
        pipeline: &str,
        subjects: Vec<Subject>,
        by: &str,
    ) -> Result<Vec<Run>, String> {
        let def = self
            .library
            .get(pipeline)
            .ok_or_else(|| format!("there is no pipeline {pipeline}"))?;
        let now = chrono::Local::now();
        let mut started = Vec::new();
        let mut refused = Vec::new();
        for subject in subjects {
            match self.store.add(&def, subject, by, &now.to_rfc3339()) {
                Ok(run) => {
                    let (mut run, effects) = engine::start(run, now);
                    run.pending = first_step(effects).0;
                    self.store.put(run.clone());
                    started.push(run);
                }
                Err(e) => refused.push(e),
            }
        }
        if started.is_empty() && !refused.is_empty() {
            return Err(refused.join("; "));
        }
        Ok(started)
    }

    fn busy(&self, id: &str) -> bool {
        self.busy.lock().expect("pipelines busy").contains(id)
    }

    // Feeds what was seen to the engine and saves the result. The next step to carry out is
    // kept on the run, so a restart picks it up; notifications go out at once.
    fn apply(&self, world: &dyn World, id: &str, seen: Seen, now: chrono::DateTime<chrono::Local>) {
        let cfg = self.cfg.lock().expect("pipelines cfg").clone();
        let notes = self.store.update(id, |run| {
            // A session that started after the run was dropped is still stopped.
            if let (
                false,
                Seen::Started {
                    step,
                    result: Ok((session, machine, path)),
                },
            ) = (run.state.active(), &seen)
            {
                let st = run.state_of(step);
                st.session = session.clone();
                st.machine = machine.clone();
                st.path = path.clone();
                run.pending = Some(Effect::StopSessions);
                return Vec::new();
            }
            let (next, effects) = engine::step(run.clone(), seen, &cfg, now);
            *run = next;
            let (step, notes) = first_step(effects);
            if step.is_some() {
                run.pending = step;
            }
            notes
        });
        let Some(run) = self.store.get(id) else {
            return;
        };
        for note in notes.unwrap_or_default() {
            world.notify(run::Note::Waiting, &note, &run);
        }
    }

    fn person(
        &self,
        id: &str,
        seen: Seen,
        allowed: impl Fn(&Run) -> Result<(), String>,
    ) -> Result<Run, String> {
        let cfg = self.cfg.lock().expect("pipelines cfg").clone();
        self.store
            .update(id, |run| {
                allowed(run)?;
                let (next, effects) = engine::step(run.clone(), seen, &cfg, chrono::Local::now());
                *run = next;
                if let Some(step) = first_step(effects).0 {
                    run.pending = Some(step);
                }
                Ok(run.clone())
            })
            .ok_or_else(|| format!("{id} is not a run"))?
    }

    fn waiting(run: &Run) -> Result<(), String> {
        match run.state {
            RunState::Waiting => Ok(()),
            _ => Err(format!("{} is not waiting for you", run.subject.label())),
        }
    }

    pub fn answer(&self, id: &str, text: &str) -> Result<Run, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("type an answer first".into());
        }
        self.person(id, Seen::Answer(text.to_string()), |r| match &r.waiting {
            Some(w) if r.state == RunState::Waiting && w.kind.answerable() => Ok(()),
            _ => Err(format!(
                "{} is not waiting for an answer",
                r.subject.label()
            )),
        })
    }

    pub fn retry(&self, id: &str) -> Result<Run, String> {
        self.person(id, Seen::Retry, Self::waiting)
    }

    pub fn continue_on(&self, id: &str, outcome: Outcome) -> Result<Run, String> {
        self.person(id, Seen::Continue(outcome), Self::waiting)
    }

    // A run still going is dropped first, so its sessions stop and its worktree is torn down as
    // for any drop. It leaves the lists at once; its record goes when that is done.
    pub fn delete_run(&self, id: &str) -> bool {
        let Some(run) = self.store.get(id) else {
            return false;
        };
        if run.state.active() {
            let _ = self.drop_run(id);
        }
        self.store.update(id, |r| r.deleting = true);
        self.finish_deleting(id);
        true
    }

    fn finish_deleting(&self, id: &str) {
        let done = self
            .store
            .get(id)
            .is_some_and(|r| r.deleting && !r.state.active() && r.pending.is_none());
        if done && !self.busy(id) {
            self.store.remove(id);
        }
    }

    // Told before the session goes, so the watcher never sees it missing and starts it again.
    pub fn session_stopped(&self, id: &str, name: &str) -> Result<Run, String> {
        self.person(id, Seen::PersonStopped(name.to_string()), |r| {
            match r.steps.values().any(|s| s.session == name) {
                true => Ok(()),
                false => Err(format!("{name} is not a session of this run")),
            }
        })
    }

    pub fn drop_run(&self, id: &str) -> Result<Run, String> {
        self.person(id, Seen::Drop, |r| match r.state.active() {
            true => Ok(()),
            false => Err(format!("{} has already ended", r.subject.label())),
        })
    }

    // One round: start runs for what the triggers found, admit queued agent steps, read what
    // changed for running steps, and carry out each run's pending step in a task of its own, so
    // a long one (a move, a Dispatch turn) never holds up the others.
    pub async fn tick(
        self: &Arc<Self>,
        world: &Arc<dyn World>,
        cfg: &crate::config::Pipelines,
        sources: Option<&triggers::Sources<'_>>,
        now: chrono::DateTime<chrono::Local>,
    ) -> Vec<JoinHandle<()>> {
        let Ok(_round) = self.ticking.try_lock() else {
            return Vec::new();
        };
        *self.cfg.lock().expect("pipelines cfg") = cfg.clone();
        if let Some(src) = sources {
            for (pipeline, subject) in self.watch.due(&self.library.list(), src, now).await {
                if let Err(e) = self.start(&pipeline, vec![subject], "a trigger") {
                    tracing::debug!(error = %e, "a trigger found an item already in a run");
                }
            }
        }
        let view = world.view();
        let orphans: Vec<_> = std::mem::take(&mut *self.orphans.lock().expect("pipelines orphans"));
        for (machine, name) in orphans {
            if view
                .sessions
                .iter()
                .any(|s| s.tmux.as_deref() == Some(name.as_str()))
            {
                let input = serde_json::json!({ "machine": machine, "name": name });
                let _ = world.perform("stop_session", input).await;
            }
        }
        self.store.prune(KEEP_FINISHED);
        for run in self.store.all().into_iter().filter(|r| r.deleting) {
            self.finish_deleting(&run.id);
        }
        let up = |m: &str| view.machines.iter().any(|x| x.name == m && x.up);
        for id in engine::admit(&self.store.all(), cfg, &up) {
            if !self.busy(&id) {
                self.apply(world.as_ref(), &id, Seen::Admitted, now);
            }
        }
        let mut handles = Vec::new();
        for run in self.store.all() {
            if matches!(run.state, RunState::Running | RunState::Waiting)
                && !self.busy(&run.id)
                && run.pending.is_none()
            {
                let needless = run::needless_sessions(&run, &view);
                // A machine that stopped answering takes seconds per stop, so each sweep is a
                // task of its own and holds up only its run.
                if !needless.is_empty() {
                    self.busy
                        .lock()
                        .expect("pipelines busy")
                        .insert(run.id.clone());
                    let (me, world) = (self.clone(), world.clone());
                    handles.push(tokio::spawn(async move {
                        for (machine, name) in needless {
                            let input = serde_json::json!({ "machine": machine, "name": name });
                            let _ = world.perform("stop_session", input).await;
                        }
                        me.busy.lock().expect("pipelines busy").remove(&run.id);
                    }));
                    continue;
                }
            }
            let watched = matches!(run.state, RunState::Running | RunState::Queued);
            if !watched || self.busy(&run.id) || run.pending.is_some() {
                continue;
            }
            let name = run
                .steps
                .get(&run.step)
                .map(|s| s.session.clone())
                .unwrap_or_default();
            let shown = view
                .sessions
                .iter()
                .find(|s| !name.is_empty() && s.tmux.as_deref() == Some(name.as_str()));
            let screen = match shown {
                Some(s) if s.activity != crate::snapshot::Activity::Active => {
                    let on_screen = world.screen(&s.machine, &name).await;
                    let marker = prompts::marker(&run, &run.step);
                    let seen_it = on_screen
                        .as_deref()
                        .is_some_and(|text| prompts::outcome(text, &marker).is_some());
                    if run.state == RunState::Running
                        && s.activity == crate::snapshot::Activity::Idle
                        && !seen_it
                    {
                        world
                            .written_result(&s.machine, &s.agent, &s.path, &marker)
                            .await
                            .or(on_screen)
                    } else {
                        on_screen
                    }
                }
                _ => None,
            };
            if let Some(seen) = watch::seen(&run, &view, screen.as_deref(), now) {
                self.apply(world.as_ref(), &run.id, seen, now);
            }
            if self.store.get(&run.id).is_some_and(|r| r.pending.is_none()) {
                self.apply(world.as_ref(), &run.id, Seen::Tick, now);
            }
        }
        for run in self.store.all() {
            let claimed = run.pending.is_some()
                && self
                    .busy
                    .lock()
                    .expect("pipelines busy")
                    .insert(run.id.clone());
            if !claimed {
                continue;
            }
            let (me, world, cfg) = (self.clone(), world.clone(), cfg.clone());
            handles.push(tokio::spawn(
                async move { me.chain(world, cfg, run.id).await },
            ));
        }
        handles
    }

    async fn chain(
        self: Arc<Self>,
        world: Arc<dyn World>,
        cfg: crate::config::Pipelines,
        id: String,
    ) {
        while let Some(mut run) = self.store.get(&id) {
            let Some(effect) = run.pending.clone() else {
                break;
            };
            if run.conversation.is_empty() {
                let title = format!("{}: {}", run.pipeline_name, run.subject.label());
                run.conversation = world.open_conversation(&title);
                self.store.put(run.clone());
            }
            let seen = run::act(world.as_ref(), &cfg, &run, &effect).await;
            // A person may have dropped the run meanwhile and left a step of their own.
            self.store.update(&id, |now| {
                if now.pending.as_ref() == Some(&effect) {
                    now.pending = None;
                }
            });
            for s in seen {
                self.apply(world.as_ref(), &id, s, chrono::Local::now());
            }
        }
        self.busy.lock().expect("pipelines busy").remove(&id);
        self.finish_deleting(&id);
    }

    pub fn start_loop(
        self: Arc<Self>,
        app: Arc<crate::web::AppState>,
        forge: forge::Forge,
        feeds: Arc<dyn crate::triggers::Feeds>,
    ) -> JoinHandle<()> {
        let forge = Arc::new(forge);
        let gitlab = crate::pulls::GitLab::new();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(TICK);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                let Ok(cfg) = app.config() else {
                    continue;
                };
                let secrets =
                    crate::secrets::Secrets::for_config(&app.cfg_path).map_err(|e| e.to_string());
                let sources = triggers::Sources {
                    feeds: feeds.as_ref(),
                    gitlab: &gitlab,
                    accesses: crate::pulls::accesses(&cfg.pull_requests, &secrets),
                    linear_key: secrets.as_ref().map_err(Clone::clone).and_then(|s| {
                        s.get(crate::triggers::LINEAR_SECRET)
                            .map(str::to_string)
                            .ok_or_else(|| "the secret linear is not set".to_string())
                    }),
                    pattern: cfg.ticket_regex(),
                };
                let settings = cfg.pipelines.clone();
                let world: Arc<dyn World> = Arc::new(run::Live::new(
                    app.clone(),
                    cfg,
                    self.linear(),
                    forge.clone(),
                ));
                if !self
                    .tick(&world, &settings, Some(&sources), chrono::Local::now())
                    .await
                    .is_empty()
                {
                    app.state.touch();
                }
            }
        })
    }
}

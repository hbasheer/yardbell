pub mod engine;
pub mod forge;
pub mod linear;
pub mod prompts;
pub mod record;
pub mod run;
pub mod store;
pub mod watch;

use crate::config::Pipeline as Cfg;
use chrono::{DateTime, Local};
use record::{Effect, Record, Seen, Stage, Ticket};
use run::World;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use store::Store;
use tokio::task::JoinHandle;

const TICK: std::time::Duration = std::time::Duration::from_secs(10);

pub struct Pipeline {
    store: Store,
    // Tickets with a step running; the tick leaves them alone until it ends.
    busy: Mutex<HashSet<String>>,
    // Runs whose end was already announced.
    told: Mutex<HashSet<String>>,
    cfg: Mutex<Option<Cfg>>,
    ticking: tokio::sync::Mutex<()>,
}

fn settled(stage: Stage) -> bool {
    matches!(
        stage,
        Stage::Done | Stage::Parked | Stage::Failed | Stage::Dropped
    )
}

fn first_step(effects: Vec<Effect>) -> (Option<Effect>, Vec<String>) {
    let mut step = None;
    let mut notes = Vec::new();
    for e in effects {
        match e {
            Effect::Notify(text) => notes.push(text),
            other if step.is_none() => step = Some(other),
            _ => {}
        }
    }
    (step, notes)
}

impl Pipeline {
    pub fn new(file: PathBuf) -> Pipeline {
        Pipeline {
            store: Store::load(file),
            busy: Mutex::new(HashSet::new()),
            told: Mutex::new(HashSet::new()),
            cfg: Mutex::new(None),
            ticking: tokio::sync::Mutex::new(()),
        }
    }

    pub fn add(&self, tickets: &[Ticket], started_by: &str) -> Result<Vec<Record>, String> {
        let now = Local::now();
        let run = format!("r{}", now.format("%Y%m%d-%H%M"));
        self.store.add(tickets, &run, started_by, &now.to_rfc3339())
    }

    pub fn records(&self) -> Vec<Record> {
        self.store.all()
    }

    pub fn get(&self, id: &str) -> Option<Record> {
        self.store.get(id)
    }

    fn known_cfg(&self) -> Cfg {
        self.cfg
            .lock()
            .expect("pipeline cfg")
            .clone()
            .unwrap_or(Cfg {
                machines: Vec::new(),
                test_machine: String::new(),
                per_machine: 2,
                review_rounds: 2,
                qa_retries: 1,
                stage_minutes: 120,
                linear_state: String::new(),
                qa_instructions: String::new(),
            })
    }

    fn busy(&self, id: &str) -> bool {
        self.busy.lock().expect("pipeline busy").contains(id)
    }

    // Feeds what was seen to the engine and saves the result. The next step to run is kept on the
    // record, so a restart picks it up; notifications go out at once.
    fn apply(&self, world: &dyn World, id: &str, seen: Seen, cfg: &Cfg, now: DateTime<Local>) {
        let Some(r) = self.store.get(id) else {
            return;
        };
        let before = r.stage;
        let (mut r, effects) = engine::step(r, seen, cfg, now);
        let (step, notes) = first_step(effects);
        if step.is_some() {
            r.pending = step;
        }
        let run = r.run.clone();
        let stage = r.stage;
        self.store.put(r);
        for note in notes {
            world.notify(&note);
        }
        if stage != before {
            self.ended(world, &run, stage);
        }
    }

    fn ended(&self, world: &dyn World, run: &str, stage: Stage) {
        let mut told = self.told.lock().expect("pipeline told");
        if !settled(stage) {
            told.remove(run);
            return;
        }
        let records: Vec<Record> = self
            .store
            .all()
            .into_iter()
            .filter(|r| r.run == run)
            .collect();
        if records.iter().any(|r| !settled(r.stage)) || !told.insert(run.to_string()) {
            return;
        }
        let count = |s: Stage| records.iter().filter(|r| r.stage == s).count();
        let parked = count(Stage::Parked);
        world.notify(&format!(
            "Run finished: {} done, {parked} {} you, {} failed",
            count(Stage::Done),
            if parked == 1 { "needs" } else { "need" },
            count(Stage::Failed)
        ));
    }

    fn person(
        &self,
        id: &str,
        seen: Seen,
        allowed: impl Fn(&Record) -> Result<(), String>,
    ) -> Result<Record, String> {
        let r = self
            .store
            .get(id)
            .ok_or_else(|| format!("{id} is not in the pipeline"))?;
        allowed(&r)?;
        let (mut r, effects) = engine::step(r, seen, &self.known_cfg(), Local::now());
        r.pending = first_step(effects).0;
        self.store.put(r.clone());
        Ok(r)
    }

    pub fn answer(&self, id: &str, text: &str) -> Result<Record, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("type an answer first".into());
        }
        self.person(id, Seen::Answer(text.to_string()), |r| match &r.parked {
            Some(p) if r.stage == Stage::Parked && p.kind.answerable() => Ok(()),
            _ => Err(format!("{id} is not waiting for an answer")),
        })
    }

    pub fn retry(&self, id: &str) -> Result<Record, String> {
        self.person(id, Seen::Retry, |r| match r.stage {
            Stage::Parked | Stage::Failed => Ok(()),
            _ => Err(format!("{id} is not parked or failed")),
        })
    }

    pub fn drop_ticket(&self, id: &str) -> Result<Record, String> {
        self.person(id, Seen::Drop, |r| match r.stage {
            Stage::Done | Stage::Dropped => {
                Err(format!("{id} is already {}", r.stage.word().to_lowercase()))
            }
            _ => Ok(()),
        })
    }

    // One round: admit queued tickets, read what changed for the ones in a stage, and start the
    // pending step of every ticket not already running one. Steps run in tasks of their own, so a
    // long one (a move, a Dispatch turn) never holds up the others.
    pub async fn tick(
        self: &Arc<Self>,
        world: &Arc<dyn World>,
        cfg: Option<&Cfg>,
        now: DateTime<Local>,
    ) -> Vec<JoinHandle<()>> {
        let Some(cfg) = cfg else {
            return Vec::new();
        };
        let Ok(_round) = self.ticking.try_lock() else {
            return Vec::new();
        };
        *self.cfg.lock().expect("pipeline cfg") = Some(cfg.clone());
        let view = world.view();
        let up = |m: &str| view.machines.iter().any(|x| x.name == m && x.up);
        for id in engine::admit(&self.store.all(), cfg, &up) {
            if !self.busy(&id) {
                self.apply(world.as_ref(), &id, Seen::Admitted, cfg, now);
            }
        }
        for r in self.store.all() {
            if self.busy(&r.id)
                || r.pending.is_some()
                || !r.stage.active()
                || r.stage == Stage::Parked
            {
                continue;
            }
            let name = match r.stage {
                Stage::Implement | Stage::Fix => r.sessions.implement.as_str(),
                Stage::Qa => r.sessions.qa.as_str(),
                _ => "",
            };
            let shown = view
                .sessions
                .iter()
                .find(|s| !name.is_empty() && s.tmux.as_deref() == Some(name));
            let screen = match shown {
                Some(s) if s.activity != crate::snapshot::Activity::Active => {
                    world.screen(&s.machine, name).await
                }
                _ => None,
            };
            let reviews = if r.stage == Stage::Review {
                world.events(&r.conversation)
            } else {
                Vec::new()
            };
            if let Some(seen) = watch::seen(&r, &view, screen.as_deref(), &reviews, now) {
                self.apply(world.as_ref(), &r.id, seen, cfg, now);
            }
            if self.store.get(&r.id).is_some_and(|r| r.pending.is_none()) {
                self.apply(world.as_ref(), &r.id, Seen::Tick, cfg, now);
            }
        }
        let mut handles = Vec::new();
        for r in self.store.all() {
            if r.pending.is_none()
                || !self
                    .busy
                    .lock()
                    .expect("pipeline busy")
                    .insert(r.id.clone())
            {
                continue;
            }
            let (me, world, cfg) = (self.clone(), world.clone(), cfg.clone());
            handles.push(tokio::spawn(
                async move { me.chain(world, cfg, r.id).await },
            ));
        }
        handles
    }

    async fn chain(self: Arc<Self>, world: Arc<dyn World>, cfg: Cfg, id: String) {
        while let Some(mut r) = self.store.get(&id) {
            let Some(effect) = r.pending.clone() else {
                break;
            };
            if r.conversation.is_empty() {
                r.conversation = world.open_conversation(&format!("{}: {}", r.id, r.title));
                self.store.put(r.clone());
            }
            let seen = run::act(world.as_ref(), &cfg, &r, &effect).await;
            if let Some(mut now) = self.store.get(&id) {
                now.pending = None;
                self.store.put(now);
            }
            for s in seen {
                self.apply(world.as_ref(), &id, s, &cfg, Local::now());
            }
        }
        self.busy.lock().expect("pipeline busy").remove(&id);
    }

    pub fn start_loop(
        self: Arc<Self>,
        app: Arc<crate::web::AppState>,
        forge: forge::Forge,
    ) -> JoinHandle<()> {
        let linear = Arc::new(linear::Linear::new());
        let forge = Arc::new(forge);
        tokio::spawn(async move {
            let mut every = tokio::time::interval(TICK);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                let Ok(cfg) = app.config() else {
                    continue;
                };
                let Some(pipeline) = cfg.pipeline.clone() else {
                    continue;
                };
                let world: Arc<dyn World> = Arc::new(run::Live::new(
                    app.clone(),
                    cfg,
                    linear.clone(),
                    forge.clone(),
                ));
                if !self
                    .tick(&world, Some(&pipeline), Local::now())
                    .await
                    .is_empty()
                {
                    app.state.touch();
                }
            }
        })
    }
}

#[cfg(test)]
mod tests;

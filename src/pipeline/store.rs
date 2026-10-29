use super::definition::Definition;
use super::record::{Entry, Run, RunState, Subject};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Store {
    file: PathBuf,
    runs: Mutex<BTreeMap<String, Run>>,
}

impl Store {
    pub fn load(file: PathBuf) -> Store {
        let runs = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Store {
            file,
            runs: Mutex::new(runs),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Run>> {
        self.runs.lock().expect("runs lock")
    }

    pub fn all(&self) -> Vec<Run> {
        self.lock().values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<Run> {
        self.lock().get(id).cloned()
    }

    pub fn put(&self, run: Run) {
        self.lock().insert(run.id.clone(), run);
        self.save();
    }

    pub fn remove_pipeline(&self, pipeline: &str) {
        self.lock().retain(|_, r| r.pipeline != pipeline);
        self.save();
    }

    pub fn add(
        &self,
        def: &Definition,
        subject: Subject,
        started_by: &str,
        now: &str,
    ) -> Result<Run, String> {
        let key = subject.key();
        let mut runs = self.lock();
        let busy = runs
            .values()
            .any(|r| r.pipeline == def.id && r.key == key && r.state.active() && key != "none");
        if busy {
            return Err(format!(
                "{} is already in a run of {}",
                subject.label(),
                def.name
            ));
        }
        let run = Run {
            id: crate::dispatch::new_conversation_id(),
            pipeline: def.id.clone(),
            pipeline_name: def.name.clone(),
            version: def.version,
            definition: Some(def.clone()),
            subject,
            key,
            started_by: started_by.to_string(),
            started: now.to_string(),
            state: RunState::Queued,
            step_since: now.to_string(),
            history: vec![Entry {
                step: String::new(),
                outcome: None,
                at: now.to_string(),
                note: format!("started by {started_by}"),
            }],
            ..Run::default()
        };
        runs.insert(run.id.clone(), run.clone());
        drop(runs);
        self.save();
        Ok(run)
    }

    fn save(&self) {
        let bytes = serde_json::to_vec_pretty(&*self.lock()).unwrap_or_default();
        let tmp = self.file.with_extension("tmp");
        let written = self
            .file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&tmp, bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.file));
        if let Err(e) = written {
            tracing::warn!(error = %e, "could not save {}", self.file.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::definition::tests::cfg;
    use crate::pipeline::library::Library;
    use crate::pipeline::record::{PrRef, RunState, Subject, TicketRef};

    fn ticket(id: &str) -> Subject {
        Subject {
            ticket: Some(TicketRef {
                linear_id: format!("u-{id}"),
                id: id.into(),
                title: "Fix the webhook dedup".into(),
                url: format!("https://linear.app/acme/issue/{id}"),
            }),
            pr: None,
        }
    }

    fn mr() -> Subject {
        Subject {
            pr: Some(PrRef {
                url: "https://git.commslayer.com/commslayer/app/-/merge_requests/87".into(),
                number: 87,
                branch: "com-1234-webhook-dedup".into(),
                host: "git.commslayer.com".into(),
                project: "commslayer/app".into(),
                forge: "gitlab".into(),
            }),
            ..ticket("COM-1234")
        }
    }

    const NOW: &str = "2026-10-29T09:40:00+03:00";

    fn setup() -> (Store, Library, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::load(dir.path().join("pipelines"));
        lib.copy_template("Implement my Linear tickets", &cfg())
            .unwrap();
        lib.copy_template("Review my merge requests", &cfg())
            .unwrap();
        (Store::load(dir.path().join("runs.json")), lib, dir)
    }

    #[test]
    fn subject_keys_and_labels() {
        assert_eq!(ticket("COM-1").key(), "ticket:COM-1");
        assert_eq!(ticket("COM-1").label(), "COM-1 Fix the webhook dedup");
        assert_eq!(
            mr().key(),
            "pr:https://git.commslayer.com/commslayer/app/-/merge_requests/87"
        );
        assert_eq!(mr().label(), "!87 COM-1234 Fix the webhook dedup");
        assert_eq!(Subject::default().key(), "none");
    }

    #[test]
    fn runs_survive_a_reload() {
        let (store, lib, dir) = setup();
        let def = lib.get("implement-my-linear-tickets").unwrap();
        let run = store.add(&def, ticket("COM-1"), "you", NOW).unwrap();
        assert_eq!(run.state, RunState::Queued);
        assert_eq!(run.pipeline, "implement-my-linear-tickets");
        assert_eq!(run.pipeline_name, "Implement my Linear tickets");
        let mut changed = store.get(&run.id).unwrap();
        changed.step = "implement".into();
        store.put(changed);
        let again = Store::load(dir.path().join("runs.json"));
        assert_eq!(again.get(&run.id).unwrap().step, "implement");
    }

    #[test]
    fn an_item_in_a_run_of_this_pipeline_is_refused() {
        let (store, lib, _dir) = setup();
        let review = lib.get("review-my-merge-requests").unwrap();
        let implement = lib.get("implement-my-linear-tickets").unwrap();
        let first = store.add(&review, mr(), "trigger", NOW).unwrap();
        let err = store.add(&review, mr(), "trigger", NOW).unwrap_err();
        assert_eq!(
            err,
            "!87 COM-1234 Fix the webhook dedup is already in a run of Review my merge requests"
        );
        store.add(&implement, mr(), "you", NOW).unwrap();
        let mut done = store.get(&first.id).unwrap();
        done.state = RunState::Done;
        store.put(done);
        store.add(&review, mr(), "trigger", NOW).unwrap();
    }

    #[test]
    fn a_run_keeps_its_version() {
        let (store, lib, _dir) = setup();
        let def = lib.get("implement-my-linear-tickets").unwrap();
        let run = store.add(&def, ticket("COM-1"), "you", NOW).unwrap();
        let mut changed = def.clone();
        changed.steps.retain(|s| s.id != "fix-after-qa");
        if let Some(qa) = changed.steps.iter_mut().find(|s| s.id == "qa") {
            qa.next.fail = "fix".into();
        }
        let saved = lib.save(changed, &cfg()).unwrap();
        assert_eq!(saved.version, 2);
        let kept = store.get(&run.id).unwrap();
        assert_eq!(kept.version, 1);
        assert!(kept.def().step("fix-after-qa").is_some());
    }
}

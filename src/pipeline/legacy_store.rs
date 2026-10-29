use super::legacy::{Entry, Record, Stage, Ticket};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Store {
    file: PathBuf,
    records: Mutex<BTreeMap<String, Record>>,
}

impl Store {
    pub fn load(file: PathBuf) -> Store {
        let records = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Store {
            file,
            records: Mutex::new(records),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Record>> {
        self.records.lock().expect("pipeline lock")
    }

    pub fn all(&self) -> Vec<Record> {
        self.lock().values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<Record> {
        self.lock().get(id).cloned()
    }

    pub fn put(&self, record: Record) {
        self.lock().insert(record.id.clone(), record);
        self.save();
    }

    // All or none: one ticket still running refuses the whole batch, so a run never starts with
    // half its tickets.
    pub fn add(
        &self,
        tickets: &[Ticket],
        run: &str,
        started_by: &str,
        now: &str,
    ) -> Result<Vec<Record>, String> {
        let mut records = self.lock();
        if let Some(busy) = tickets
            .iter()
            .find(|t| records.get(&t.id).is_some_and(|r| r.stage.active()))
        {
            return Err(format!("{} is already in a run", busy.id));
        }
        let added: Vec<Record> = tickets
            .iter()
            .map(|t| Record {
                id: t.id.clone(),
                linear_id: t.linear_id.clone(),
                title: t.title.clone(),
                url: t.url.clone(),
                run: run.to_string(),
                started_by: started_by.to_string(),
                stage: Stage::Queued,
                stage_since: now.to_string(),
                history: vec![Entry {
                    stage: Stage::Queued,
                    at: now.to_string(),
                    note: String::new(),
                }],
                ..Record::default()
            })
            .collect();
        for r in &added {
            records.insert(r.id.clone(), r.clone());
        }
        drop(records);
        self.save();
        Ok(added)
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
    use crate::pipeline::legacy::{Stage, Ticket};

    fn ticket(id: &str) -> Ticket {
        Ticket {
            linear_id: format!("uuid-{id}"),
            id: id.into(),
            title: format!("Fix {id}"),
            url: format!("https://linear.app/acme/issue/{id}"),
            state: "Todo".into(),
        }
    }

    const NOW: &str = "2026-10-29T09:40:00+03:00";

    #[test]
    fn records_survive_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pipeline.json");
        let store = Store::load(file.clone());
        store
            .add(&[ticket("COM-1"), ticket("COM-2")], "r1", "you", NOW)
            .unwrap();
        let mut second = store.get("COM-2").unwrap();
        second.stage = Stage::Review;
        second.round = 1;
        store.put(second);
        let again = Store::load(file);
        assert_eq!(again.all().len(), 2);
        let second = again.get("COM-2").unwrap();
        assert_eq!(second.stage, Stage::Review);
        assert_eq!(second.round, 1);
    }

    #[test]
    fn a_running_ticket_is_not_added_twice() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::load(dir.path().join("pipeline.json"));
        store.add(&[ticket("COM-1")], "r1", "you", NOW).unwrap();
        let mut one = store.get("COM-1").unwrap();
        one.stage = Stage::Implement;
        store.put(one);
        let err = store.add(&[ticket("COM-1")], "r2", "you", NOW).unwrap_err();
        assert!(err.contains("COM-1 is already in a run"), "{err}");
        let mut one = store.get("COM-1").unwrap();
        one.stage = Stage::Done;
        store.put(one);
        let added = store.add(&[ticket("COM-1")], "r2", "you", NOW).unwrap();
        assert_eq!(added[0].stage, Stage::Queued);
        assert_eq!(store.get("COM-1").unwrap().run, "r2");
    }

    #[test]
    fn an_old_file_without_new_fields_loads() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pipeline.json");
        std::fs::write(
            &file,
            r#"{"COM-9": {"id": "COM-9", "title": "Old", "stage": "fix"}}"#,
        )
        .unwrap();
        let store = Store::load(file);
        let old = store.get("COM-9").unwrap();
        assert_eq!(old.stage, Stage::Fix);
        assert_eq!(old.round, 0);
        assert!(old.parked.is_none());
    }

    #[test]
    fn add_starts_queued() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::load(dir.path().join("pipeline.json"));
        let added = store
            .add(&[ticket("COM-1")], "r1", "trigger:nightly", NOW)
            .unwrap();
        let r = &added[0];
        assert_eq!(r.stage, Stage::Queued);
        assert_eq!(r.run, "r1");
        assert_eq!(r.started_by, "trigger:nightly");
        assert_eq!(r.linear_id, "uuid-COM-1");
        assert_eq!(r.history.len(), 1);
        assert_eq!(r.history[0].stage, Stage::Queued);
        assert_eq!(r.stage_since, NOW);
    }
}

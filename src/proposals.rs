use crate::dispatch::Refusal;
use chrono::{DateTime, Duration, Local};
use rand::Rng;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

const ID_LEN: usize = 8;
const KEEP_DAYS: i64 = 30;

// Changes outside MCP clients asked for, shaped like Dispatch's step events so the same cards draw
// them. Nothing in here has run until the person approves it.
pub struct Proposals {
    file: PathBuf,
    all: Mutex<Vec<Value>>,
    pushed: Mutex<Option<std::time::Instant>>,
}

const PUSH_EVERY: std::time::Duration = std::time::Duration::from_secs(5 * 60);

fn new_id() -> String {
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(ID_LEN)
        .map(|b| char::from(b).to_ascii_lowercase())
        .collect()
}

fn stamp(now: DateTime<Local>) -> String {
    now.to_rfc3339()
}

fn missing() -> Refusal {
    Refusal::Missing("there is no such proposal".into())
}

impl Proposals {
    pub fn load(file: PathBuf) -> Proposals {
        let all = match std::fs::read(&file).map(|bytes| serde_json::from_slice(&bytes)) {
            Ok(Ok(all)) => all,
            Ok(Err(e)) => {
                // Starting empty would overwrite every waiting proposal at the next save.
                let aside = file.with_extension("json.bad");
                tracing::warn!(error = %e, "{} cannot be read; moved to {}", file.display(), aside.display());
                let _ = std::fs::rename(&file, &aside);
                Vec::new()
            }
            Err(_) => Vec::new(),
        };
        let proposals = Proposals {
            file,
            all: Mutex::new(all),
            pushed: Mutex::new(None),
        };
        proposals.prune(Local::now());
        proposals
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Value>> {
        self.all.lock().expect("proposals lock")
    }

    pub fn add(&self, tool: &str, input: Value, from: &str, now: DateTime<Local>) -> Value {
        self.prune(now);
        let proposal = json!({
            "role": "action",
            "id": new_id(),
            "tool": tool,
            "input": input,
            "status": "pending",
            "by": "client",
            "from": from,
            "at": stamp(now),
        });
        self.lock().push(proposal.clone());
        self.save();
        proposal
    }

    pub fn list(&self) -> Vec<Value> {
        let mut all = self.lock().clone();
        all.reverse();
        all
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.lock().iter().find(|p| p["id"] == id).cloned()
    }

    // A burst of proposals tells the phone once; after the person looks, the next one tells it again.
    pub fn should_push(&self, now: std::time::Instant) -> bool {
        let mut pushed = self.pushed.lock().expect("proposals push lock");
        if pushed.is_some_and(|at| now.duration_since(at) < PUSH_EVERY) {
            return false;
        }
        *pushed = Some(now);
        true
    }

    pub fn seen(&self) {
        *self.pushed.lock().expect("proposals push lock") = None;
    }

    pub fn waiting(&self) -> usize {
        self.lock()
            .iter()
            .filter(|p| p["status"] == "pending")
            .count()
    }

    fn edit<T>(
        &self,
        id: &str,
        f: impl FnOnce(&mut Value) -> Result<T, Refusal>,
    ) -> Result<T, Refusal> {
        let mut all = self.lock();
        let p = all.iter_mut().find(|p| p["id"] == id).ok_or_else(missing)?;
        let out = f(p)?;
        drop(all);
        self.save();
        Ok(out)
    }

    fn undecided(p: &mut Value) -> Result<&mut Value, Refusal> {
        match p["status"].as_str().unwrap_or_default() {
            "pending" => Ok(p),
            decided => Err(Refusal::Taken(format!(
                "this proposal was already {decided}"
            ))),
        }
    }

    pub fn approve(
        &self,
        id: &str,
        edited: Option<Value>,
        now: DateTime<Local>,
    ) -> Result<(String, Value), Refusal> {
        self.edit(id, |p| {
            let p = Self::undecided(p)?;
            match edited.filter(|input| *input != p["input"]) {
                Some(input) => {
                    p["original"] = p["input"].take();
                    p["input"] = input;
                    p["status"] = json!("edited");
                }
                None => p["status"] = json!("approved"),
            }
            p["decided"] = json!(stamp(now));
            Ok((
                p["tool"].as_str().unwrap_or_default().to_string(),
                p["input"].clone(),
            ))
        })
    }

    pub fn reject(&self, id: &str, now: DateTime<Local>) -> Result<Value, Refusal> {
        self.edit(id, |p| {
            let p = Self::undecided(p)?;
            p["status"] = json!("rejected");
            p["decided"] = json!(stamp(now));
            Ok(p.clone())
        })
    }

    pub fn ran(&self, id: &str, outcome: &Result<Value, String>) -> Result<Value, Refusal> {
        self.edit(id, |p| {
            p["result"] = crate::dispatch::step_result(outcome, &stamp(Local::now()));
            Ok(p.clone())
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), Refusal> {
        let mut all = self.lock();
        let before = all.len();
        all.retain(|p| p["id"] != id);
        if all.len() == before {
            return Err(missing());
        }
        drop(all);
        self.save();
        Ok(())
    }

    pub fn clear_decided(&self) -> usize {
        let mut all = self.lock();
        let before = all.len();
        all.retain(|p| p["status"] == "pending");
        let cleared = before - all.len();
        drop(all);
        if cleared > 0 {
            self.save();
        }
        cleared
    }

    // Decided proposals go a month after their decision; one still waiting stays until decided.
    pub fn prune(&self, now: DateTime<Local>) {
        let cutoff = now - Duration::days(KEEP_DAYS);
        let mut all = self.lock();
        let before = all.len();
        all.retain(|p| {
            p["decided"]
                .as_str()
                .and_then(|d| DateTime::parse_from_rfc3339(d).ok())
                .is_none_or(|d| d >= cutoff)
        });
        let pruned = all.len() != before;
        drop(all);
        if pruned {
            self.save();
        }
    }

    fn save(&self) {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        // The lock is held until the file is renamed, so a later save can never land first.
        let all = self.lock();
        let bytes = serde_json::to_vec_pretty(&*all).unwrap_or_default();
        let tmp = self.file.with_extension("tmp");
        let written = self
            .file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(crate::config::PRIVATE_FILE)
                    .open(&tmp)
            })
            .and_then(|mut f| f.write_all(&bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.file));
        drop(all);
        if let Err(e) = written {
            tracing::warn!(error = %e, "could not save {}", self.file.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn proposals_are_kept_private_and_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("proposals.json");
        let now = Local::now();
        let proposals = Proposals::load(file.clone());
        let old = proposals.add("save_task", json!({}), "a", now - Duration::days(40));
        proposals
            .reject(old["id"].as_str().unwrap(), now - Duration::days(31))
            .unwrap();
        let waiting = proposals.add("save_task", json!({}), "b", now - Duration::days(40));
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let again = Proposals::load(file);
        let ids: Vec<Value> = again.list().iter().map(|p| p["id"].clone()).collect();
        assert_eq!(ids, vec![waiting["id"].clone()]);
    }

    #[test]
    fn a_file_that_cannot_be_read_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("proposals.json");
        std::fs::write(&file, "{ not json").unwrap();
        let proposals = Proposals::load(file.clone());
        assert!(proposals.list().is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("proposals.json.bad")).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn a_proposal_is_decided_once() {
        let dir = tempfile::tempdir().unwrap();
        let proposals = Proposals::load(dir.path().join("proposals.json"));
        let p = proposals.add("save_task", json!({ "name": "a" }), "x", Local::now());
        let id = p["id"].as_str().unwrap();
        proposals.approve(id, None, Local::now()).unwrap();
        match proposals.reject(id, Local::now()) {
            Err(Refusal::Taken(m)) => assert_eq!(m, "this proposal was already approved"),
            other => panic!("{other:?}"),
        }
        assert_eq!(proposals.waiting(), 0);
    }
}

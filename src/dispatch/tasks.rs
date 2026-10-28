use super::store::write_private;
use super::{Dispatch, ScanKind};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

impl Dispatch {
    fn tasks_file(&self) -> PathBuf {
        self.shared.dir.join("tasks.json")
    }

    fn hidden_file(&self) -> PathBuf {
        self.shared.dir.join("tasks-hidden.json")
    }

    // The defaults always come first. The file holds the user's own tasks and their edits of a
    // default, kept under the default's name. A deleted default is only hidden, so it can be
    // restored.
    pub fn tasks(&self) -> Vec<SavedTask> {
        let hidden = self.hidden_defaults();
        let saved = self.saved_tasks();
        let defaults = default_tasks();
        let mut tasks: Vec<SavedTask> = defaults
            .iter()
            .map(|d| SavedTask {
                text: saved
                    .iter()
                    .find(|t| t.name == d.name)
                    .map_or_else(|| d.text.clone(), |t| t.text.clone()),
                hidden: hidden.contains(&d.name),
                ..d.clone()
            })
            .collect();
        tasks.extend(
            saved
                .into_iter()
                .filter(|t| !is_default(&t.name))
                .map(|t| SavedTask {
                    builtin: false,
                    hidden: false,
                    ..t
                }),
        );
        tasks
    }

    fn hidden_defaults(&self) -> Vec<String> {
        std::fs::read(self.hidden_file())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write_hidden(&self, hidden: &[String]) -> Result<(), String> {
        write_private(
            &self.hidden_file(),
            &serde_json::to_vec_pretty(hidden).unwrap_or_default(),
        )
        .map_err(|e| format!("cannot save the tasks: {e}"))
    }

    fn hide_default(&self, name: &str) -> Result<(), String> {
        let mut hidden = self.hidden_defaults();
        if !hidden.iter().any(|h| h == name) {
            hidden.push(name.to_string());
        }
        self.write_hidden(&hidden)
    }

    fn saved_tasks(&self) -> Vec<SavedTask> {
        std::fs::read(self.tasks_file())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn restore_default_tasks(&self) -> Result<Vec<SavedTask>, String> {
        self.write_hidden(&[])?;
        let mut saved = self.saved_tasks();
        saved.retain(|t| !is_default(&t.name));
        self.write_tasks(&saved)?;
        Ok(self.tasks())
    }

    pub fn save_task(
        &self,
        name: &str,
        text: &str,
        replacing: Option<&str>,
    ) -> Result<Vec<SavedTask>, String> {
        let (name, text) = (name.trim(), text.trim());
        if name.is_empty() || text.is_empty() {
            return Err("a task needs a name and what to ask".into());
        }
        let replacing = replacing.map(str::trim).filter(|r| !r.is_empty());
        if replacing != Some(name) && self.tasks().iter().any(|t| t.name == name) {
            return Err(format!("there is already a task called {name}"));
        }
        let mut saved = self.saved_tasks();
        let task = SavedTask {
            name: name.to_string(),
            text: text.to_string(),
            builtin: false,
            hidden: false,
        };
        match replacing.and_then(|old| saved.iter().position(|t| t.name == old)) {
            Some(i) => saved[i] = task,
            None => saved.push(task),
        }
        // Renaming a default makes it a task of the user's own, so the default steps aside.
        if let Some(old) = replacing.filter(|old| *old != name && is_default(old)) {
            self.hide_default(old)?;
        }
        self.write_tasks(&saved)?;
        Ok(self.tasks())
    }

    pub fn delete_task(&self, name: &str) -> Result<Vec<SavedTask>, String> {
        if is_default(name) {
            self.hide_default(name)?;
        }
        let mut saved = self.saved_tasks();
        saved.retain(|t| t.name != name);
        self.write_tasks(&saved)?;
        Ok(self.tasks())
    }

    fn write_tasks(&self, tasks: &[SavedTask]) -> Result<(), String> {
        write_private(
            &self.tasks_file(),
            &serde_json::to_vec_pretty(tasks).unwrap_or_default(),
        )
        .map_err(|e| format!("cannot save the tasks: {e}"))
    }
}

fn is_default(name: &str) -> bool {
    default_tasks().iter().any(|d| d.name == name)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedTask {
    pub name: String,
    pub text: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

fn builtin(name: &str, text: &str) -> SavedTask {
    SavedTask {
        name: name.into(),
        text: text.into(),
        builtin: true,
        hidden: false,
    }
}

pub fn default_tasks() -> Vec<SavedTask> {
    vec![
        builtin(
            "What's going on?",
            "What's going on? Summarise every machine and session.",
        ),
        builtin(
            "Who needs me?",
            "List every session that is waiting for an answer, show what each one asks, and \
suggest a reply. Don't answer for me.",
        ),
        builtin(
            "Plan my Linear tickets",
            "Read my open Linear tickets that are assigned to me. Propose a plan to work through \
them across my machines, one session per ticket, with the machine, folder, agent and branch for \
each. Wait for my go-ahead before starting anything.",
        ),
        builtin(
            "Review finished branches",
            "For every session that is idle or ended on a branch other than main, start a review \
of its branch. List the branches you are reviewing.",
        ),
        builtin(
            "Tidy up sessions",
            "Find sessions that ended or have sat idle for a long time and suggest which to stop. \
Don't stop anything without my go-ahead.",
        ),
        scan_task("Security scan", ScanKind::Security),
        scan_task("Dead code scan", ScanKind::DeadCode),
        scan_task("Test gap scan", ScanKind::TestGaps),
    ]
}

// Scans run once per repository, so a task can run unattended; naming folders in the same
// message narrows it.
fn scan_task(name: &str, kind: ScanKind) -> SavedTask {
    builtin(
        name,
        &format!(
            "Start a {} with scan_folder, kind {}, of each repository in list_folders: once per \
repository rather than once per worktree, on the machine with the most room. When this message \
names folders, scan only those. List the scans you started.",
            kind.name(),
            kind.key()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    #[test]
    fn tasks_can_be_added_edited_renamed_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let dispatch = Dispatch::new(Arc::new(FakeRunner::default()), dir.path().to_path_buf());
        let own = |d: &Dispatch| {
            d.tasks()
                .into_iter()
                .filter(|t| !t.builtin)
                .map(|t| t.name)
                .collect::<Vec<_>>()
        };
        let defaults = default_tasks().len();
        assert_eq!(dispatch.tasks().len(), defaults);
        dispatch
            .save_task("Tests", "run the tests everywhere", None)
            .unwrap();
        assert!(
            dispatch.save_task("Tests", "again", None).is_err(),
            "names stay unique"
        );
        assert!(dispatch.save_task("What's going on?", "x", None).is_err());
        dispatch
            .save_task("Tests", "run all tests", Some("Tests"))
            .unwrap();
        dispatch
            .save_task("All tests", "run all tests", Some("Tests"))
            .unwrap();
        assert_eq!(own(&dispatch), ["All tests"]);
        assert_eq!(dispatch.tasks().len(), defaults + 1);
        let shown = |d: &Dispatch| d.tasks().into_iter().filter(|t| !t.hidden).count();
        dispatch.delete_task("What's going on?").unwrap();
        assert_eq!(shown(&dispatch), defaults);
        assert!(
            dispatch.save_task("What's going on?", "x", None).is_err(),
            "a deleted default keeps its name"
        );
        dispatch.restore_default_tasks().unwrap();
        assert_eq!(shown(&dispatch), defaults + 1);
        dispatch
            .save_task("What's going on?", "only hp", Some("What's going on?"))
            .unwrap();
        let first = &dispatch.tasks()[0];
        assert_eq!(
            (first.name.as_str(), first.text.as_str(), first.builtin),
            ("What's going on?", "only hp", true),
            "an edited default keeps its place"
        );
        dispatch
            .save_task("Status", "only hp", Some("What's going on?"))
            .unwrap();
        assert!(dispatch.tasks()[0].hidden, "a renamed default steps aside");
        assert!(own(&dispatch).contains(&"Status".to_string()));
        dispatch.restore_default_tasks().unwrap();
        let first = &dispatch.tasks()[0];
        assert!(!first.hidden);
        assert_eq!(first.text, default_tasks()[0].text);
        dispatch.delete_task("Status").unwrap();
        dispatch.delete_task("All tests").unwrap();
        assert!(own(&dispatch).is_empty());
        assert_eq!(dispatch.tasks().len(), defaults);
        assert!(dispatch.save_task(" ", "x", None).is_err());
    }

    #[test]
    fn scans_come_as_tasks_in_the_usual_format() {
        let scans: Vec<SavedTask> = default_tasks()
            .into_iter()
            .filter(|t| t.name.ends_with(" scan"))
            .collect();
        let names: Vec<&str> = scans.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["Security scan", "Dead code scan", "Test gap scan"]);
        assert!(scans[0].text.starts_with(
            "Start a security scan with scan_folder, kind security, of each repository"
        ));
        assert!(scans[1].text.contains("kind dead_code"));
        assert!(scans[2].text.contains("kind test_gaps"));
        let json = serde_json::to_value(&scans[0]).unwrap();
        let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["builtin", "name", "text"]);
    }
}

use super::diff::{words, Part};
use super::store::{now, write_private};
use super::{Dispatch, ScanKind};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// Each task keeps this many versions; saving past it drops the oldest.
pub const MAX_VERSIONS: usize = 30;

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
            .map(|d| match saved.iter().find(|t| t.name == d.name) {
                Some(t) => SavedTask {
                    text: t.text.clone(),
                    version: t.version(),
                    customised: t.text != d.text,
                    hidden: hidden.contains(&d.name),
                    ..d.clone()
                },
                None => SavedTask {
                    hidden: hidden.contains(&d.name),
                    ..d.clone()
                },
            })
            .collect();
        tasks.extend(
            saved
                .into_iter()
                .filter(|t| !is_default(&t.name))
                .map(|t| SavedTask {
                    version: t.version(),
                    name: t.name,
                    text: t.text,
                    builtin: false,
                    hidden: false,
                    customised: false,
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

    // A file from before versions were kept holds only each task's text, which becomes its first
    // version, dated when the file was last written. An edited default starts from the default.
    fn saved_tasks(&self) -> Vec<StoredTask> {
        let file = self.tasks_file();
        let Ok(bytes) = std::fs::read(&file) else {
            return Vec::new();
        };
        let mut saved: Vec<StoredTask> = serde_json::from_slice(&bytes).unwrap_or_default();
        let written = std::fs::metadata(&file)
            .and_then(|m| m.modified())
            .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
            .unwrap_or_default();
        for t in saved.iter_mut().filter(|t| t.versions.is_empty()) {
            if let Some(d) = default_text(&t.name) {
                t.versions.push(Version::first(&d, ""));
            }
            t.record(&t.text.clone(), &written, None);
        }
        saved
    }

    pub fn restore_default_tasks(&self) -> Result<Vec<SavedTask>, String> {
        self.write_hidden(&[])?;
        let mut saved = self.saved_tasks();
        for t in saved.iter_mut() {
            if let Some(d) = default_text(&t.name) {
                t.record(&d, &now(), Some(1));
            }
        }
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
        let at = now();
        match replacing.and_then(|old| saved.iter().position(|t| t.name == old)) {
            Some(i) => {
                saved[i].name = name.to_string();
                saved[i].record(text, &at, None);
            }
            None => {
                let mut task = StoredTask {
                    name: name.to_string(),
                    text: String::new(),
                    versions: Vec::new(),
                };
                if let Some(d) = replacing.and_then(default_text) {
                    task.versions.push(Version::first(&d, ""));
                    task.text = d;
                }
                task.record(text, &at, None);
                saved.push(task);
            }
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

    pub fn task_history(&self, name: &str) -> Result<History, String> {
        let builtin = is_default(name);
        let versions = match self.saved_tasks().into_iter().find(|t| t.name == name) {
            Some(t) => t.versions,
            None => vec![Version::first(
                &default_text(name).ok_or_else(|| format!("there is no task called {name}"))?,
                "",
            )],
        };
        Ok(History {
            name: name.to_string(),
            builtin,
            current: versions.last().map_or(1, |v| v.n),
            versions,
        })
    }

    pub fn task_diff(&self, name: &str, from: u32, to: u32) -> Result<Vec<Part>, String> {
        let history = self.task_history(name)?;
        let text = |n: u32| {
            history
                .versions
                .iter()
                .find(|v| v.n == n)
                .map(|v| v.text.as_str())
                .ok_or_else(|| format!("{name} has no version {n}"))
        };
        Ok(words(text(from)?, text(to)?))
    }

    // Restoring keeps every version and adds the restored text as the newest. A default's
    // version 1 is the text it comes with, even once older versions are pruned, so a default can
    // always be reset.
    pub fn restore_task_version(&self, name: &str, n: u32) -> Result<Vec<SavedTask>, String> {
        let history = self.task_history(name)?;
        let text = history
            .versions
            .iter()
            .find(|v| v.n == n)
            .map(|v| v.text.clone())
            .or_else(|| default_text(name).filter(|_| n == 1))
            .ok_or_else(|| format!("{name} has no version {n}"))?;
        if history.versions.last().is_some_and(|v| v.text == text) {
            return Err(format!(
                "version {n} is the same as the current text of {name}"
            ));
        }
        let mut saved = self.saved_tasks();
        match saved.iter_mut().find(|t| t.name == name) {
            Some(t) => t.record(&text, &now(), Some(n)),
            None => return Err(format!("{name} has no version {n}")),
        }
        self.write_tasks(&saved)?;
        Ok(self.tasks())
    }

    fn write_tasks(&self, tasks: &[StoredTask]) -> Result<(), String> {
        write_private(
            &self.tasks_file(),
            &serde_json::to_vec_pretty(tasks).unwrap_or_default(),
        )
        .map_err(|e| format!("cannot save the tasks: {e}"))
    }
}

fn is_default(name: &str) -> bool {
    default_text(name).is_some()
}

fn default_text(name: &str) -> Option<String> {
    default_tasks()
        .into_iter()
        .find(|d| d.name == name)
        .map(|d| d.text)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedTask {
    pub name: String,
    pub text: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(default = "first")]
    pub version: u32,
    // A default whose text is no longer the one Yardbell comes with.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub customised: bool,
}

fn first() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Version {
    pub n: u32,
    pub text: String,
    // Empty for the text a default comes with.
    #[serde(default)]
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored: Option<u32>,
}

impl Version {
    fn first(text: &str, at: &str) -> Version {
        Version {
            n: 1,
            text: text.to_string(),
            at: at.to_string(),
            restored: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct History {
    pub name: String,
    pub builtin: bool,
    pub current: u32,
    pub versions: Vec<Version>,
}

// The file's shape: `text` is the newest version's, so an older Yardbell still reads it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTask {
    name: String,
    text: String,
    #[serde(default)]
    versions: Vec<Version>,
}

impl StoredTask {
    fn version(&self) -> u32 {
        self.versions.last().map_or(1, |v| v.n)
    }

    fn record(&mut self, text: &str, at: &str, restored: Option<u32>) {
        self.text = text.to_string();
        if self.versions.last().is_some_and(|v| v.text == text) {
            return;
        }
        self.versions.push(Version {
            n: self.versions.last().map_or(1, |v| v.n + 1),
            text: text.to_string(),
            at: at.to_string(),
            restored,
        });
        let over = self.versions.len().saturating_sub(MAX_VERSIONS);
        self.versions.drain(..over);
    }
}

fn builtin(name: &str, text: &str) -> SavedTask {
    SavedTask {
        name: name.into(),
        text: text.into(),
        builtin: true,
        hidden: false,
        version: 1,
        customised: false,
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

    fn dispatch(dir: &tempfile::TempDir) -> Dispatch {
        Dispatch::new(Arc::new(FakeRunner::default()), dir.path().to_path_buf())
    }

    fn texts(h: &History) -> Vec<(u32, &str, Option<u32>)> {
        h.versions
            .iter()
            .map(|v| (v.n, v.text.as_str(), v.restored))
            .collect()
    }

    #[test]
    fn every_save_keeps_the_last_text_as_a_version() {
        let dir = tempfile::tempdir().unwrap();
        let d = dispatch(&dir);
        d.save_task("Tests", "run the tests", None).unwrap();
        d.save_task("Tests", "run the tests", Some("Tests"))
            .unwrap();
        d.save_task("Tests", "run all tests on hp", Some("Tests"))
            .unwrap();
        d.save_task("All tests", "run all tests on hp and pro", Some("Tests"))
            .unwrap();
        let h = d.task_history("All tests").unwrap();
        assert_eq!(
            texts(&h),
            [
                (1, "run the tests", None),
                (2, "run all tests on hp", None),
                (3, "run all tests on hp and pro", None)
            ],
            "saving the same text adds no version, and a rename keeps the history"
        );
        assert_eq!(h.current, 3);
        assert!(!h.builtin);
        assert!(h.versions.iter().all(|v| !v.at.is_empty()));
        let task = d
            .tasks()
            .into_iter()
            .find(|t| t.name == "All tests")
            .unwrap();
        assert_eq!(
            (task.version, task.text.as_str()),
            (3, "run all tests on hp and pro")
        );
        assert!(d.task_history("Tests").is_err());
    }

    #[test]
    fn diffs_compare_any_two_versions() {
        let dir = tempfile::tempdir().unwrap();
        let d = dispatch(&dir);
        d.save_task("Tests", "run the tests on hp", None).unwrap();
        d.save_task("Tests", "run all tests on hp", Some("Tests"))
            .unwrap();
        let parts = d.task_diff("Tests", 1, 2).unwrap();
        let ops: Vec<(super::super::diff::Op, &str)> =
            parts.iter().map(|p| (p.op, p.text.as_str())).collect();
        use super::super::diff::Op;
        assert_eq!(
            ops,
            [
                (Op::Same, "run "),
                (Op::Del, "the"),
                (Op::Add, "all"),
                (Op::Same, " tests on hp")
            ]
        );
        let back = d.task_diff("Tests", 2, 1).unwrap();
        assert_eq!(back[1].op, Op::Del);
        assert_eq!(back[1].text, "all");
        assert!(d.task_diff("Tests", 1, 9).is_err());
        assert!(d.task_diff("Nope", 1, 2).is_err());
    }

    #[test]
    fn restoring_a_version_adds_it_as_the_newest() {
        let dir = tempfile::tempdir().unwrap();
        let d = dispatch(&dir);
        d.save_task("Tests", "one", None).unwrap();
        d.save_task("Tests", "two", Some("Tests")).unwrap();
        let tasks = d.restore_task_version("Tests", 1).unwrap();
        let task = tasks.iter().find(|t| t.name == "Tests").unwrap();
        assert_eq!((task.text.as_str(), task.version), ("one", 3));
        assert_eq!(
            texts(&d.task_history("Tests").unwrap()),
            [(1, "one", None), (2, "two", None), (3, "one", Some(1))]
        );
        assert!(
            d.restore_task_version("Tests", 1).is_err(),
            "the current text is not restored again"
        );
        assert!(d.restore_task_version("Tests", 7).is_err());
    }

    #[test]
    fn defaults_are_version_one_and_can_be_customised_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        let d = dispatch(&dir);
        let name = "Who needs me?";
        let builtin = default_tasks()[1].text.clone();
        let h = d.task_history(name).unwrap();
        assert_eq!(texts(&h), [(1, builtin.as_str(), None)]);
        assert!(h.builtin && h.versions[0].at.is_empty());
        assert!(d.restore_task_version(name, 1).is_err());
        d.save_task(name, "Only hp sessions", Some(name)).unwrap();
        let t = d.tasks().into_iter().find(|t| t.name == name).unwrap();
        assert!(t.builtin && t.customised);
        assert_eq!(t.version, 2);
        d.restore_task_version(name, 1).unwrap();
        let t = d.tasks().into_iter().find(|t| t.name == name).unwrap();
        assert!(!t.customised);
        assert_eq!((t.text.as_str(), t.version), (builtin.as_str(), 3));
        d.save_task(name, "Only pro", Some(name)).unwrap();
        d.restore_default_tasks().unwrap();
        assert_eq!(
            texts(&d.task_history(name).unwrap()),
            [
                (1, builtin.as_str(), None),
                (2, "Only hp sessions", None),
                (3, builtin.as_str(), Some(1)),
                (4, "Only pro", None),
                (5, builtin.as_str(), Some(1)),
            ],
            "restoring the defaults keeps what they were"
        );
    }

    #[test]
    fn versions_are_capped_and_the_oldest_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let d = dispatch(&dir);
        d.save_task("Tests", "v1", None).unwrap();
        for i in 2..=(MAX_VERSIONS + 5) {
            d.save_task("Tests", &format!("v{i}"), Some("Tests"))
                .unwrap();
        }
        let h = d.task_history("Tests").unwrap();
        assert_eq!(h.versions.len(), MAX_VERSIONS);
        assert_eq!(h.versions[0].n, 6);
        assert_eq!(h.versions[0].text, "v6");
        assert_eq!(h.current as usize, MAX_VERSIONS + 5);
        assert!(d.restore_task_version("Tests", 1).is_err(), "pruned");
        d.restore_task_version("Tests", 6).unwrap();
        let h = d.task_history("Tests").unwrap();
        assert_eq!(h.versions.len(), MAX_VERSIONS);
        assert_eq!(h.versions.last().unwrap().text, "v6");
    }

    #[test]
    fn a_default_resets_after_its_first_version_is_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let d = dispatch(&dir);
        let name = "Tidy up sessions";
        for i in 0..=MAX_VERSIONS {
            d.save_task(name, &format!("tidy {i}"), Some(name)).unwrap();
        }
        assert_ne!(d.task_history(name).unwrap().versions[0].n, 1);
        d.restore_task_version(name, 1).unwrap();
        let t = d.tasks().into_iter().find(|t| t.name == name).unwrap();
        assert!(!t.customised);
        assert_eq!(
            d.task_history(name)
                .unwrap()
                .versions
                .last()
                .unwrap()
                .restored,
            Some(1)
        );
    }

    #[test]
    fn a_file_from_before_versions_migrates_to_one_version_each() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("tasks.json"),
            r#"[{"name":"Tests","text":"run the tests","builtin":false},
               {"name":"Who needs me?","text":"Only hp","builtin":false}]"#,
        )
        .unwrap();
        let d = dispatch(&dir);
        let own = d.task_history("Tests").unwrap();
        assert_eq!(texts(&own), [(1, "run the tests", None)]);
        assert!(
            chrono::DateTime::parse_from_rfc3339(&own.versions[0].at).is_ok(),
            "dated when the file was written"
        );
        let edited = d.task_history("Who needs me?").unwrap();
        assert_eq!(
            texts(&edited),
            [
                (1, default_tasks()[1].text.as_str(), None),
                (2, "Only hp", None)
            ]
        );
        d.save_task("Tests", "run all tests", Some("Tests"))
            .unwrap();
        let file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("tasks.json")).unwrap()).unwrap();
        let tests = file
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "Tests")
            .unwrap();
        assert_eq!(
            tests["text"], "run all tests",
            "an older Yardbell still reads it"
        );
        assert_eq!(tests["versions"].as_array().unwrap().len(), 2);
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
        assert_eq!(keys, ["builtin", "name", "text", "version"]);
    }
}

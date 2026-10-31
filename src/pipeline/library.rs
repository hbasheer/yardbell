use super::definition::{check, slug, Definition, MachineChoice, StepKind, Trigger, Workspace};
use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Saved {
    version: u32,
    saved: String,
    definition: Definition,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    history: Vec<Saved>,
}

impl File {
    fn current(&self) -> Option<&Definition> {
        self.history.first().map(|s| &s.definition)
    }
}

// Pipelines as files in a folder, newest version first in each, at most MAX_VERSIONS kept.
pub struct Library {
    dir: PathBuf,
    files: Mutex<BTreeMap<String, File>>,
}

impl Library {
    pub fn load(dir: PathBuf) -> Library {
        let mut files = BTreeMap::new();
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let file: Option<File> = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
            if let Some(file) = file.filter(|f| f.current().is_some()) {
                let id = file.current().map(|d| d.id.clone()).unwrap_or_default();
                files.insert(id, file);
            }
        }
        Library {
            dir,
            files: Mutex::new(files),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, File>> {
        self.files.lock().expect("pipelines lock")
    }

    pub fn list(&self) -> Vec<Definition> {
        self.lock()
            .values()
            .filter_map(|f| f.current().cloned())
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Definition> {
        self.lock().get(id).and_then(|f| f.current().cloned())
    }

    pub fn history(&self, id: &str) -> Vec<(u32, String, Definition)> {
        self.lock()
            .get(id)
            .map(|f| {
                f.history
                    .iter()
                    .map(|s| (s.version, s.saved.clone(), s.definition.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    // A new version of the pipeline. Whether it is on is not part of a version: an existing
    // pipeline keeps its switch, which only set_enabled changes.
    pub fn save(&self, mut def: Definition, cfg: &Config) -> Result<Definition, Vec<String>> {
        if let Some(current) = self.get(&def.id) {
            def.enabled = current.enabled;
        }
        check(&def, cfg)?;
        let mut files = self.lock();
        let file = files.entry(def.id.clone()).or_default();
        def.version = file.current().map_or(1, |d| d.version + 1);
        file.history.insert(
            0,
            Saved {
                version: def.version,
                saved: chrono::Local::now().to_rfc3339(),
                definition: def.clone(),
            },
        );
        file.history.truncate(crate::dispatch::MAX_VERSIONS);
        let written = write(&self.dir, &def.id, file);
        drop(files);
        written.map_err(|e| vec![e])?;
        Ok(def)
    }

    pub fn copy_template(&self, name: &str, cfg: &Config) -> Result<Definition, Vec<String>> {
        let mut def = super::templates::all()
            .into_iter()
            .find(|t| t.name == name)
            .ok_or_else(|| vec![format!("there is no template named {name}")])?;
        self.name_uniquely(&mut def);
        def.enabled = false;
        for step in &mut def.steps {
            // A template tests on devbox; without one, the test runs where the code already is.
            if let StepKind::Agent {
                machine,
                workspace: Workspace::Copy { from },
                ..
            } = &mut step.kind
            {
                if matches!(machine, MachineChoice::Name(m) if cfg.machine(m).is_none()) {
                    *machine = MachineChoice::SameAs(from.clone());
                }
            }
        }
        self.save(def, cfg)
    }

    pub fn create_empty(&self, cfg: &Config) -> Result<Definition, Vec<String>> {
        let mut def = Definition {
            id: String::new(),
            name: "New pipeline".into(),
            enabled: false,
            version: 0,
            trigger: Trigger::Manual,
            start: String::new(),
            steps: vec![],
        };
        self.name_uniquely(&mut def);
        self.save(def, cfg)
    }

    // A second copy of the same name becomes "Name 2", with the id to match.
    fn name_uniquely(&self, def: &mut Definition) {
        let taken: Vec<String> = self.lock().keys().cloned().collect();
        def.id = slug(&def.name, &taken);
        if let Some(n) = def
            .id
            .rsplit('-')
            .next()
            .and_then(|n| n.parse::<u32>().ok())
        {
            if def.id != slug(&def.name, &[]) {
                def.name = format!("{} {n}", def.name);
            }
        }
    }

    pub fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
        cfg: &Config,
    ) -> Result<Definition, Vec<String>> {
        let mut def = self
            .get(id)
            .ok_or_else(|| vec![format!("there is no pipeline {id}")])?;
        def.enabled = enabled;
        check(&def, cfg)?;
        let mut files = self.lock();
        let file = files.entry(id.to_string()).or_default();
        if let Some(newest) = file.history.first_mut() {
            newest.definition.enabled = enabled;
        }
        let written = write(&self.dir, id, file);
        drop(files);
        written.map_err(|e| vec![e])?;
        Ok(def)
    }

    pub fn restore(&self, id: &str, version: u32, cfg: &Config) -> Result<Definition, Vec<String>> {
        let old = self
            .history(id)
            .into_iter()
            .find(|(v, _, _)| *v == version)
            .map(|(_, _, d)| d)
            .ok_or_else(|| vec![format!("{id} has no version {version}")])?;
        self.save(old, cfg)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.lock().remove(id);
        match std::fs::remove_file(self.dir.join(format!("{id}.json"))) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

fn write(dir: &Path, id: &str, file: &File) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.json"));
    let tmp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes)
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("could not save {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::definition::tests::cfg;

    fn library() -> (Library, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Library::load(dir.path().join("pipelines")), dir)
    }

    #[test]
    fn saving_bumps_the_version_and_keeps_history() {
        let (lib, _dir) = library();
        let mut def = lib.copy_template("Implement my tickets", &cfg()).unwrap();
        assert_eq!(def.version, 1);
        def.steps[1].name = "Build it".into();
        let saved = lib.save(def, &cfg()).unwrap();
        assert_eq!(saved.version, 2);
        let history = lib.history(&saved.id);
        assert_eq!(history.iter().map(|h| h.0).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(history[1].2.steps[1].name, "Implement");
    }

    #[test]
    fn restore_brings_back_an_old_version() {
        let (lib, _dir) = library();
        let mut def = lib.copy_template("Implement my tickets", &cfg()).unwrap();
        def.steps[1].name = "Build it".into();
        let id = lib.save(def, &cfg()).unwrap().id;
        let restored = lib.restore(&id, 1, &cfg()).unwrap();
        assert_eq!(restored.version, 3);
        assert_eq!(restored.steps[1].name, "Implement");
        let again = Library::load(lib.dir().to_path_buf());
        assert_eq!(again.get(&id).unwrap().version, 3);
    }

    #[test]
    fn a_definition_that_fails_is_not_saved() {
        let (lib, _dir) = library();
        let mut def = lib.copy_template("Implement my tickets", &cfg()).unwrap();
        def.steps[1].next.pass = "nowhere".into();
        let problems = lib.save(def.clone(), &cfg()).unwrap_err();
        assert!(
            problems[0].contains("its pass line goes to a step that does not exist"),
            "{problems:?}"
        );
        assert_eq!(lib.get(&def.id).unwrap().version, 1);
    }

    #[test]
    fn copying_a_template_twice() {
        let (lib, _dir) = library();
        let a = lib
            .copy_template("Review my merge requests", &cfg())
            .unwrap();
        let b = lib
            .copy_template("Review my merge requests", &cfg())
            .unwrap();
        assert_eq!(
            (a.id.as_str(), a.name.as_str()),
            ("review-my-merge-requests", "Review my merge requests")
        );
        assert_eq!(
            (b.id.as_str(), b.name.as_str()),
            ("review-my-merge-requests-2", "Review my merge requests 2")
        );
        assert!(
            !a.enabled,
            "a copy starts switched off until its trigger is set"
        );
        assert_eq!(lib.list().len(), 2);
    }

    #[test]
    fn a_template_test_machine_you_do_not_have_tests_where_the_code_is() {
        let (lib, _dir) = library();
        let mut setup = cfg();
        setup.machines.retain(|m| m.name != "devbox");
        let def = lib.copy_template("Implement my tickets", &setup).unwrap();
        let qa = def.step("qa").unwrap();
        assert!(
            matches!(&qa.kind, StepKind::Agent { machine: MachineChoice::SameAs(s), .. } if s == "implement"),
            "{:?}",
            qa.kind
        );
        let kept = lib.copy_template("Implement my tickets", &cfg()).unwrap();
        assert!(matches!(
            &kept.step("qa").unwrap().kind,
            StepKind::Agent { machine: MachineChoice::Name(m), .. } if m == "devbox"
        ));
    }

    #[test]
    fn copying_an_empty_pipeline_twice_gives_new_pipeline_2() {
        let (lib, _dir) = library();
        let a = lib.create_empty(&cfg()).unwrap();
        let b = lib.create_empty(&cfg()).unwrap();
        assert_eq!(
            (a.id.as_str(), a.name.as_str(), a.steps.len(), a.enabled),
            ("new-pipeline", "New pipeline", 0, false)
        );
        assert_eq!(
            (b.id.as_str(), b.name.as_str()),
            ("new-pipeline-2", "New pipeline 2")
        );
        assert_eq!(a.version, 1);
    }

    #[test]
    fn switching_on_and_off_adds_no_version_and_restore_keeps_it() {
        let (lib, _dir) = library();
        let mut def = lib.copy_template("Implement my tickets", &cfg()).unwrap();
        def.steps[1].name = "Build it".into();
        lib.save(def.clone(), &cfg()).unwrap();
        let on = lib.set_enabled(&def.id, true, &cfg()).unwrap();
        assert!(on.enabled);
        assert_eq!(lib.history(&def.id).len(), 2, "a switch is not a version");
        let restored = lib.restore(&def.id, 1, &cfg()).unwrap();
        assert!(restored.enabled, "restoring keeps the pipeline on");
        let mut stale = restored.clone();
        stale.enabled = false;
        assert!(
            lib.save(stale, &cfg()).unwrap().enabled,
            "saving keeps the switch"
        );
    }

    #[test]
    fn switching_on_checks_the_trigger() {
        let (lib, _dir) = library();
        let def = lib
            .copy_template("Review my merge requests", &cfg())
            .unwrap();
        let problems = lib.set_enabled(&def.id, true, &cfg()).unwrap_err();
        assert!(
            problems.contains(&"gitlab_reviewer needs a host".to_string()),
            "{problems:?}"
        );
        lib.delete(&def.id).unwrap();
        assert!(lib.get(&def.id).is_none());
    }
}

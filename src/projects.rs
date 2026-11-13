use crate::state::SessionView;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const NAME_MAX: usize = 80;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "Saved")]
pub struct Projects {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<Added>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Added {
    pub machine: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
}

// 0.11.103 also kept hidden project ids, which no longer mean anything and are dropped, and display
// names by project id; a name kept under a folder's own name moves onto that folder.
#[derive(Deserialize)]
struct Saved {
    #[serde(default)]
    added: Vec<Added>,
    #[serde(default)]
    names: BTreeMap<String, String>,
}

impl From<Saved> for Projects {
    fn from(saved: Saved) -> Projects {
        let mut added = saved.added;
        for a in added.iter_mut().filter(|a| a.name.is_empty()) {
            if let Some(name) = saved.names.get(&format!("dir:{}", base(&a.path))) {
                a.name = name.clone();
            }
        }
        Projects { added }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Project {
    pub id: String,
    pub machine: String,
    pub path: String,
    pub name: String,
    pub repo: String,
    // Ids of the sessions running in the folder, below it or in one of its worktrees.
    pub sessions: Vec<String>,
}

pub fn id_of(machine: &str, path: &str) -> String {
    format!("{machine}:{path}")
}

impl Projects {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty()
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.added
            .iter()
            .position(|a| id_of(&a.machine, &a.path) == id)
    }

    pub fn get(&self, id: &str) -> Option<&Added> {
        self.position(id).map(|i| &self.added[i])
    }

    pub fn add(&mut self, machine: &str, path: &str) -> bool {
        if self.position(&id_of(machine, path)).is_some() {
            return false;
        }
        self.added.push(Added {
            machine: machine.to_string(),
            path: path.to_string(),
            name: String::new(),
        });
        true
    }

    pub fn delete(&mut self, id: &str) -> bool {
        match self.position(id) {
            Some(i) => {
                self.added.remove(i);
                true
            }
            None => false,
        }
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.chars().count() > NAME_MAX {
            return Err(format!(
                "a project name can be at most {NAME_MAX} characters"
            ));
        }
        if name.chars().any(char::is_control) {
            return Err("a project name cannot hold line breaks or tabs".into());
        }
        let i = self
            .position(id)
            .ok_or_else(|| "there is no such project".to_string())?;
        let a = &mut self.added[i];
        a.name = if name == base(&a.path) {
            String::new()
        } else {
            name.to_string()
        };
        Ok(())
    }
}

pub fn valid_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    let trimmed = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };
    if !trimmed.starts_with('/') {
        return Err("give the folder as a full path, starting with /".into());
    }
    if trimmed.len() > 1024 || trimmed.chars().any(char::is_control) {
        return Err("that folder path cannot be used".into());
    }
    if trimmed.split('/').any(|part| part == "..") {
        return Err("a folder path cannot go up with ..".into());
    }
    Ok(trimmed.to_string())
}

fn base(path: &str) -> &str {
    path.rsplit('/').find(|p| !p.is_empty()).unwrap_or(path)
}

// The folder itself, anything below it, and its worktrees, which Yardbell makes in <repo>-worktrees/<name>.
fn holds(project: &str, path: &str) -> bool {
    if project == "/" {
        return path.starts_with('/');
    }
    let Some(rest) = path.strip_prefix(project) else {
        return false;
    };
    rest.is_empty()
        || rest.starts_with('/')
        || rest
            .strip_prefix("-worktrees/")
            .is_some_and(|name| !name.is_empty())
}

fn place(s: &SessionView) -> &str {
    [&s.cwd, &s.path, &s.folder]
        .into_iter()
        .find(|p| p.starts_with('/'))
        .map_or("", |p| p.as_str())
}

// The deepest project that holds the folder, so a project inside another takes its own sessions.
pub fn owner<'a>(added: &'a [Added], machine: &str, path: &str) -> Option<&'a Added> {
    added
        .iter()
        .filter(|a| a.machine == machine && holds(&a.path, path))
        .max_by_key(|a| a.path.len())
}

pub fn group(sessions: &[SessionView], machines: &[&str], settings: &Projects) -> Vec<Project> {
    let mut projects: Vec<Project> = settings
        .added
        .iter()
        .filter(|a| machines.contains(&a.machine.as_str()))
        .map(|a| {
            let repo = base(&a.path).to_string();
            Project {
                id: id_of(&a.machine, &a.path),
                machine: a.machine.clone(),
                path: a.path.clone(),
                name: if a.name.is_empty() {
                    repo.clone()
                } else {
                    a.name.clone()
                },
                repo,
                sessions: Vec::new(),
            }
        })
        .collect();
    for s in sessions.iter().filter(|s| s.tmux.is_some()) {
        let Some(a) = owner(&settings.added, &s.machine, place(s)) else {
            continue;
        };
        let id = id_of(&a.machine, &a.path);
        if let Some(p) = projects.iter_mut().find(|p| p.id == id) {
            p.sessions.push(s.id.clone());
        }
    }
    projects.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.machine.cmp(&b.machine))
            .then_with(|| a.path.cmp(&b.path))
    });
    projects
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(machine: &str, tmux: &str, cwd: &str) -> SessionView {
        serde_json::from_value(serde_json::json!({
            "id": format!("{machine}:{tmux}"),
            "machine": machine,
            "agent": "claude",
            "pid": 1,
            "folder": cwd,
            "ticket": "-",
            "branch": "main",
            "activity": "idle",
            "attachable": true,
            "tmux": tmux,
            "stale": false,
            "ports": [],
            "cwd": cwd,
        }))
        .unwrap()
    }

    const MACHINES: &[&str] = &["hp", "mini"];

    fn settings(list: &[(&str, &str)]) -> Projects {
        let mut p = Projects::default();
        for (machine, path) in list {
            p.add(machine, path);
        }
        p
    }

    #[test]
    fn a_session_belongs_to_the_project_folder_below_it_and_its_worktrees() {
        let added = settings(&[("hp", "/home/u/web"), ("hp", "/home/u/web/docs")]).added;
        let at = |path: &str| owner(&added, "hp", path).map(|a| a.path.as_str());
        assert_eq!(at("/home/u/web"), Some("/home/u/web"));
        assert_eq!(at("/home/u/web/src/app"), Some("/home/u/web"));
        assert_eq!(at("/home/u/web-worktrees/eng-142"), Some("/home/u/web"));
        assert_eq!(at("/home/u/web-worktrees/eng-142/src"), Some("/home/u/web"));
        assert_eq!(
            at("/home/u/web/docs/guide"),
            Some("/home/u/web/docs"),
            "the deepest project wins"
        );
        assert_eq!(at("/home/u/website"), None);
        assert_eq!(at("/home/u/web-worktrees"), None);
        assert_eq!(at("/home/u/Desktop"), None);
        assert_eq!(
            owner(&added, "mini", "/home/u/web"),
            None,
            "another machine"
        );
    }

    #[test]
    fn projects_list_their_sessions_and_the_rest_stay_out() {
        let s = settings(&[("hp", "/home/u/web"), ("mini", "/Users/u/web")]);
        let sessions = [
            session("hp", "a", "/home/u/web"),
            session("hp", "b", "/home/u/web-worktrees/x"),
            session("hp", "c", "/home/u/Desktop"),
            session("mini", "d", "/Users/u/web/src"),
        ];
        let list = group(&sessions, MACHINES, &s);
        let got: Vec<_> = list
            .iter()
            .map(|p| (p.id.as_str(), p.name.as_str(), p.sessions.clone()))
            .collect();
        assert_eq!(
            got,
            [
                (
                    "hp:/home/u/web",
                    "web",
                    vec!["hp:a".to_string(), "hp:b".into()]
                ),
                ("mini:/Users/u/web", "web", vec!["mini:d".to_string()]),
            ]
        );
        let other: Vec<_> = sessions
            .iter()
            .filter(|s| !list.iter().any(|p| p.sessions.contains(&s.id)))
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(other, ["hp:c"], "a session outside every project is Other");
    }

    #[test]
    fn a_session_without_a_cwd_falls_back_to_its_folder_path() {
        let s = settings(&[("hp", "/r/app")]);
        let mut old = session("hp", "a", "app");
        old.cwd.clear();
        old.path = "/r/app".into();
        assert_eq!(group(&[old], MACHINES, &s)[0].sessions, ["hp:a"]);
    }

    #[test]
    fn a_project_on_a_machine_no_longer_configured_drops_out() {
        let s = settings(&[("gone", "/x"), ("hp", "/b"), ("hp", "/a")]);
        let ids: Vec<_> = group(&[], MACHINES, &s).into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["hp:/a", "hp:/b"]);
    }

    #[test]
    fn adding_deleting_and_renaming() {
        let mut s = Projects::default();
        assert!(s.add("hp", "/home/u/lab/thing"));
        assert!(!s.add("hp", "/home/u/lab/thing"));
        assert!(s.add("mini", "/home/u/lab/thing"), "one entry per machine");
        let id = id_of("hp", "/home/u/lab/thing");
        s.rename(&id, "  Thing ").unwrap();
        assert_eq!(s.get(&id).unwrap().name, "Thing");
        assert_eq!(group(&[], MACHINES, &s)[0].name, "Thing");
        s.rename(&id, "thing").unwrap();
        assert_eq!(s.get(&id).unwrap().name, "", "its own name clears it");
        assert!(s.rename(&id, &"a".repeat(NAME_MAX + 1)).is_err());
        assert!(s.rename(&id, "two\nlines").is_err());
        assert!(s.rename("hp:/nope", "x").is_err());
        assert!(s.delete(&id));
        assert!(!s.delete(&id));
        assert_eq!(s.added.len(), 1);
        assert_eq!(s.added[0].machine, "mini");
    }

    #[test]
    fn folder_paths_must_be_full_and_stay_put() {
        assert_eq!(valid_path("/home/u/web/").unwrap(), "/home/u/web");
        assert_eq!(valid_path("/").unwrap(), "/");
        assert!(valid_path("code/web").is_err());
        assert!(valid_path("~/code").is_err());
        assert!(valid_path("/home/u/../etc").is_err());
        assert!(valid_path("/home/u/a\nb").is_err());
    }

    #[test]
    fn the_older_section_keeps_its_folders_and_names_and_drops_hidden() {
        let old = "added:\n- machine: hp\n  path: /home/u/lab/thing\n- machine: hp\n  path: /home/u/web\nhidden:\n- git:github.com/acme/api\nnames:\n  dir:thing: Thing\n  git:github.com/acme/api: API\n";
        let p: Projects = serde_yaml::from_str(old).unwrap();
        assert_eq!(p.added.len(), 2);
        assert_eq!(p.added[0].name, "Thing");
        assert_eq!(p.added[1].name, "");
        let text = serde_yaml::to_string(&p).unwrap();
        assert_eq!(
            text,
            "added:\n- machine: hp\n  path: /home/u/lab/thing\n  name: Thing\n- machine: hp\n  path: /home/u/web\n"
        );
        assert_eq!(serde_yaml::from_str::<Projects>(&text).unwrap(), p);
        assert!(serde_yaml::from_str::<Projects>("hidden: [x]\n")
            .unwrap()
            .is_empty());
    }
}

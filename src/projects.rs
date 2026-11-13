use crate::state::{FolderView, SessionView};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const NAME_MAX: usize = 80;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Projects {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<Added>,
    // Project ids, for projects the workspace scan finds that the person took off the list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub names: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Added {
    pub machine: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Checkout {
    pub machine: String,
    pub folder: String,
    pub path: String,
    pub branch: String,
    pub worktree: bool,
    pub added: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub checkouts: Vec<Checkout>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Listing {
    pub projects: Vec<Project>,
    pub hidden: Vec<Project>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Removal {
    Deleted,
    Hidden,
}

impl Projects {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.hidden.is_empty() && self.names.is_empty()
    }

    fn is_added(&self, machine: &str, path: &str) -> bool {
        self.added
            .iter()
            .any(|a| a.machine == machine && a.path == path)
    }

    pub fn add(&mut self, machine: &str, path: &str) -> bool {
        if self.is_added(machine, path) {
            return false;
        }
        self.added.push(Added {
            machine: machine.to_string(),
            path: path.to_string(),
        });
        true
    }

    // An added checkout is deleted; one the scan finds would only come back, so the project hides.
    pub fn remove(&mut self, project: &Project) -> Removal {
        let added = |a: &Added| {
            project
                .checkouts
                .iter()
                .any(|c| c.added && c.machine == a.machine && c.path == a.path)
        };
        self.added.retain(|a| !added(a));
        if project.checkouts.iter().any(|c| !c.added) {
            if !self.hidden.contains(&project.id) {
                self.hidden.push(project.id.clone());
            }
            return Removal::Hidden;
        }
        self.names.remove(&project.id);
        Removal::Deleted
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
        if name.is_empty() {
            self.names.remove(id);
        } else {
            self.names.insert(id.to_string(), name.to_string());
        }
        Ok(())
    }

    pub fn show(&mut self, id: &str) -> bool {
        let before = self.hidden.len();
        self.hidden.retain(|h| h != id);
        self.hidden.len() != before
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

// git@github.com:acme/web.git, https://user:token@github.com/acme/web and ssh://git@github.com:22/acme/web
// all become github.com/acme/web, so the same repository groups whatever URL each machine cloned it by.
pub fn normalize_remote(url: &str) -> String {
    let url = url.trim();
    if url.is_empty() {
        return String::new();
    }
    let (rest, scheme) = match url.split_once("://") {
        Some((_, rest)) => (rest, true),
        None => (url, false),
    };
    if rest.starts_with('/') {
        return strip_git(rest).to_string();
    }
    let rest = match rest.split_once('/') {
        Some((head, _)) if head.contains('@') => &rest[head.rfind('@').map_or(0, |i| i + 1)..],
        None => rest.rsplit_once('@').map_or(rest, |(_, r)| r),
        _ => rest,
    };
    let (host, path) = if scheme {
        let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
        (host.split(':').next().unwrap_or(host), path)
    } else {
        match (rest.find(':'), rest.find('/')) {
            (Some(colon), slash) if slash.is_none_or(|s| colon < s) => {
                (&rest[..colon], &rest[colon + 1..])
            }
            _ => rest.split_once('/').unwrap_or((rest, "")),
        }
    };
    let path = strip_git(path.trim_matches('/'));
    if host.is_empty() {
        return path.to_string();
    }
    if path.is_empty() {
        return host.to_ascii_lowercase();
    }
    format!("{}/{}", host.to_ascii_lowercase(), path)
}

fn strip_git(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    path.strip_suffix(".git").unwrap_or(path)
}

// A Yardbell worktree lives at <repo>-worktrees/<branch>, so it groups with its repo by name.
fn repo_dir(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    match path.rsplit_once('/') {
        Some((parent, _)) if parent.ends_with("-worktrees") => {
            parent.strip_suffix("-worktrees").unwrap_or(parent)
        }
        _ => path,
    }
}

fn base(path: &str) -> &str {
    path.rsplit('/').find(|p| !p.is_empty()).unwrap_or("")
}

pub fn id_for(remote: &str, path: &str) -> String {
    if !remote.is_empty() {
        return format!("git:{remote}");
    }
    let name = base(repo_dir(path));
    format!("dir:{}", if name.is_empty() { "Other" } else { name })
}

fn repo_name(id: &str) -> String {
    if let Some(remote) = id.strip_prefix("git:") {
        let parts: Vec<&str> = remote.split('/').filter(|p| !p.is_empty()).collect();
        let keep = if parts.len() > 2 { 2 } else { 1 };
        return parts[parts.len().saturating_sub(keep)..].join("/");
    }
    id.strip_prefix("dir:").unwrap_or(id).to_string()
}

pub fn group(
    folders: &[FolderView],
    sessions: &[SessionView],
    machines: &[&str],
    settings: &Projects,
) -> Listing {
    let openable: Vec<&SessionView> = sessions
        .iter()
        .filter(|s| s.tmux.is_some() && (s.attachable || s.stale))
        .collect();
    // A folder known only because an agent outside tmux runs there is not a project of its own.
    let listed = |f: &&FolderView| {
        !f.by_agent
            || settings.is_added(&f.machine, &f.path)
            || openable
                .iter()
                .any(|s| s.machine == f.machine && s.folder == f.label)
    };
    let mut found: Vec<(String, Checkout)> = folders
        .iter()
        .filter(listed)
        .map(|f| {
            (
                id_for(&f.remote, &f.path),
                Checkout {
                    machine: f.machine.clone(),
                    folder: f.label.clone(),
                    path: f.path.clone(),
                    branch: f.branch.clone(),
                    worktree: f.worktree,
                    added: settings.is_added(&f.machine, &f.path),
                },
            )
        })
        .collect();
    for s in openable {
        let known = found
            .iter()
            .any(|(_, c)| c.machine == s.machine && c.folder == s.folder);
        if known {
            continue;
        }
        let at = if s.path.is_empty() {
            &s.folder
        } else {
            &s.path
        };
        found.push((
            id_for("", at),
            Checkout {
                machine: s.machine.clone(),
                folder: s.folder.clone(),
                path: s.path.clone(),
                branch: s.branch.clone(),
                worktree: s.worktree,
                added: false,
            },
        ));
    }
    for a in &settings.added {
        let listed = found
            .iter()
            .any(|(_, c)| c.machine == a.machine && c.path == a.path);
        if listed || !machines.contains(&a.machine.as_str()) {
            continue;
        }
        found.push((
            id_for("", &a.path),
            Checkout {
                machine: a.machine.clone(),
                folder: a.path.clone(),
                path: a.path.clone(),
                branch: String::new(),
                worktree: false,
                added: true,
            },
        ));
    }

    let rank = |m: &str| machines.iter().position(|n| *n == m).unwrap_or(usize::MAX);
    let mut by_id: BTreeMap<String, Vec<Checkout>> = BTreeMap::new();
    for (id, c) in found {
        by_id.entry(id).or_default().push(c);
    }
    let mut listing = Listing::default();
    for (id, mut checkouts) in by_id {
        checkouts.sort_by(|a, b| {
            a.worktree
                .cmp(&b.worktree)
                .then_with(|| rank(&a.machine).cmp(&rank(&b.machine)))
                .then_with(|| a.branch.cmp(&b.branch))
                .then_with(|| a.path.cmp(&b.path))
        });
        let repo = repo_name(&id);
        let project = Project {
            name: settings
                .names
                .get(&id)
                .cloned()
                .unwrap_or_else(|| repo.clone()),
            repo,
            id,
            checkouts,
        };
        if settings.hidden.contains(&project.id) {
            listing.hidden.push(project);
        } else {
            listing.projects.push(project);
        }
    }
    let by_name = |a: &Project, b: &Project| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    };
    listing.projects.sort_by(by_name);
    listing.hidden.sort_by(by_name);
    listing
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::Activity;

    fn folder(machine: &str, label: &str, path: &str, branch: &str, remote: &str) -> FolderView {
        FolderView {
            machine: machine.into(),
            label: label.into(),
            path: path.into(),
            branch: branch.into(),
            worktree: path.contains("-worktrees/"),
            remote: remote.into(),
            by_agent: false,
        }
    }

    fn session(machine: &str, folder: &str, path: &str) -> SessionView {
        serde_json::from_value(serde_json::json!({
            "id": format!("{machine}:{folder}"),
            "machine": machine,
            "agent": "claude",
            "pid": 1,
            "folder": folder,
            "ticket": "-",
            "branch": "main",
            "activity": Activity::Idle,
            "attachable": true,
            "tmux": format!("{machine}-x"),
            "stale": false,
            "ports": [],
            "path": path,
        }))
        .unwrap()
    }

    const MACHINES: &[&str] = &["hp", "mini", "devbox"];

    #[test]
    fn remotes_lose_their_scheme_user_and_suffix() {
        for (url, want) in [
            ("git@github.com:acme/web.git", "github.com/acme/web"),
            ("https://github.com/acme/web.git", "github.com/acme/web"),
            (
                "https://user:t0ken@GitHub.com/acme/web/",
                "github.com/acme/web",
            ),
            (
                "ssh://git@github.com:22/acme/web.git",
                "github.com/acme/web",
            ),
            (
                "git@gitlab.example.com:group/sub/api.git",
                "gitlab.example.com/group/sub/api",
            ),
            ("file:///srv/git/web.git", "/srv/git/web"),
            ("/srv/git/web.git", "/srv/git/web"),
            ("", ""),
        ] {
            assert_eq!(normalize_remote(url), want, "{url}");
        }
    }

    #[test]
    fn one_repo_on_two_machines_is_one_project_by_remote() {
        let folders = [
            folder(
                "hp",
                "web",
                "/home/u/code/web",
                "main",
                "github.com/acme/web",
            ),
            folder(
                "mini",
                "acme/web",
                "/Users/u/src/acme/web",
                "main",
                "github.com/acme/web",
            ),
            folder(
                "mini",
                "web-worktrees/eng-142",
                "/Users/u/src/acme/web-worktrees/eng-142",
                "eng-142",
                "github.com/acme/web",
            ),
            folder(
                "hp",
                "api",
                "/home/u/code/api",
                "main",
                "github.com/acme/api",
            ),
        ];
        let l = group(&folders, &[], MACHINES, &Projects::default());
        let names: Vec<_> = l.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["acme/api", "acme/web"]);
        let web = &l.projects[1];
        assert_eq!(web.id, "git:github.com/acme/web");
        let at: Vec<_> = web
            .checkouts
            .iter()
            .map(|c| (c.machine.as_str(), c.branch.as_str()))
            .collect();
        assert_eq!(at, [("hp", "main"), ("mini", "main"), ("mini", "eng-142")]);
    }

    #[test]
    fn without_a_remote_the_folder_name_groups_and_worktrees_join_their_repo() {
        let folders = [
            folder("hp", "yardbell", "/home/u/P/yardbell", "main", ""),
            folder("mini", "yardbell", "/Users/u/P/yardbell", "main", ""),
            folder(
                "hp",
                "yardbell-worktrees/x",
                "/home/u/P/yardbell-worktrees/x",
                "x",
                "",
            ),
            folder("hp", "notes", "/home/u/notes", "", ""),
        ];
        let l = group(&folders, &[], MACHINES, &Projects::default());
        assert_eq!(l.projects.len(), 2);
        let y = l.projects.iter().find(|p| p.id == "dir:yardbell").unwrap();
        assert_eq!(y.checkouts.len(), 3);
        assert_eq!(y.name, "yardbell");
    }

    #[test]
    fn a_session_outside_any_checkout_still_has_a_project() {
        let folders = [folder("hp", "web", "/home/u/web", "main", "")];
        let sessions = [
            session("hp", "web", "/home/u/web"),
            session("hp", "scratch", ""),
        ];
        let l = group(&folders, &sessions, MACHINES, &Projects::default());
        let ids: Vec<_> = l.projects.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["dir:scratch", "dir:web"]);
        assert_eq!(l.projects[1].checkouts.len(), 1);
    }

    #[test]
    fn a_folder_only_an_outside_agent_runs_in_is_left_out_until_a_session_opens_there() {
        let mut outside = folder("hp", "side", "/home/u/side", "main", "");
        outside.by_agent = true;
        let folders = [outside];
        assert!(group(&folders, &[], MACHINES, &Projects::default())
            .projects
            .is_empty());
        let sessions = [session("hp", "side", "/home/u/side")];
        let l = group(&folders, &sessions, MACHINES, &Projects::default());
        assert_eq!(l.projects[0].checkouts[0].branch, "main");
    }

    #[test]
    fn added_projects_show_before_the_scan_sees_them() {
        let mut settings = Projects::default();
        assert!(settings.add("mini", "/Users/u/lab/thing"));
        assert!(!settings.add("mini", "/Users/u/lab/thing"));
        settings.add("gone", "/x/y");
        let l = group(&[], &[], MACHINES, &settings);
        assert_eq!(
            l.projects.len(),
            1,
            "a machine no longer in the config drops out"
        );
        let c = &l.projects[0].checkouts[0];
        assert!(c.added);
        assert_eq!(
            (c.machine.as_str(), c.folder.as_str()),
            ("mini", "/Users/u/lab/thing")
        );
        let scanned = [folder("mini", "lab/thing", "/Users/u/lab/thing", "", "")];
        let l = group(&scanned, &[], MACHINES, &settings);
        assert_eq!(l.projects[0].checkouts.len(), 1);
        assert_eq!(l.projects[0].checkouts[0].folder, "lab/thing");
        assert!(l.projects[0].checkouts[0].added);
    }

    #[test]
    fn removing_deletes_an_added_project_and_hides_a_found_one() {
        let mut settings = Projects::default();
        settings.add("hp", "/home/u/lab/thing");
        settings.rename("dir:thing", "Thing").unwrap();
        let folders = [
            folder("hp", "lab/thing", "/home/u/lab/thing", "", ""),
            folder("hp", "web", "/home/u/web", "main", "github.com/acme/web"),
        ];
        let l = group(&folders, &[], MACHINES, &settings);
        let thing = l
            .projects
            .iter()
            .find(|p| p.id == "dir:thing")
            .unwrap()
            .clone();
        let web = l
            .projects
            .iter()
            .find(|p| p.id == "git:github.com/acme/web")
            .unwrap()
            .clone();
        assert_eq!(thing.name, "Thing");

        assert_eq!(settings.remove(&thing), Removal::Deleted);
        assert!(settings.added.is_empty());
        assert!(settings.names.is_empty());
        assert_eq!(settings.remove(&web), Removal::Hidden);
        assert_eq!(settings.hidden, ["git:github.com/acme/web"]);

        let l = group(&folders[1..], &[], MACHINES, &settings);
        assert!(l.projects.is_empty());
        assert_eq!(l.hidden.len(), 1);
        assert!(settings.show("git:github.com/acme/web"));
        assert!(!settings.show("git:github.com/acme/web"));
        assert_eq!(
            group(&folders[1..], &[], MACHINES, &settings)
                .projects
                .len(),
            1
        );
    }

    #[test]
    fn renaming_sets_and_clears_the_display_name() {
        let mut settings = Projects::default();
        settings
            .rename("git:github.com/acme/web", "  Web app ")
            .unwrap();
        let folders = [folder("hp", "web", "/w", "main", "github.com/acme/web")];
        let l = group(&folders, &[], MACHINES, &settings);
        assert_eq!(
            (l.projects[0].name.as_str(), l.projects[0].repo.as_str()),
            ("Web app", "acme/web")
        );
        settings.rename("git:github.com/acme/web", "").unwrap();
        assert!(settings.is_empty());
        assert!(settings.rename("x", &"a".repeat(NAME_MAX + 1)).is_err());
        assert!(settings.rename("x", "two\nlines").is_err());
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
    fn the_section_round_trips_through_yaml_and_stays_out_when_empty() {
        let mut p = Projects::default();
        p.add("hp", "/home/u/lab");
        p.hidden.push("dir:old".into());
        p.rename("dir:lab", "Lab").unwrap();
        let text = serde_yaml::to_string(&p).unwrap();
        assert_eq!(serde_yaml::from_str::<Projects>(&text).unwrap(), p);
        assert!(Projects::default().is_empty());
    }
}

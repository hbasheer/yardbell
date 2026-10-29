use crate::config::Machine;
use crate::shell::{expand_home, quote, Duration, Runner};
use crate::ssh::Ssh;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

const TIMEOUT: Duration = Duration::from_secs(10);
const WORKTREE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    pub name: String,
    pub git: bool,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Listing {
    pub path: String,
    pub git: bool,
    pub branch: String,
    // A worktree, whose .git is a file pointing at the main checkout's.
    pub linked: bool,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Branches {
    pub current: String,
    pub default_base: String,
    pub local: Vec<String>,
    pub remote: Vec<String>,
    pub worktrees: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub path: String,
    pub created: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Pick {
    pub branch: String,
    #[serde(default)]
    pub new_branch: bool,
    #[serde(default)]
    pub base: String,
}

pub fn valid_branch(b: &str) -> bool {
    let ok_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/');
    !b.is_empty()
        && b.len() <= 200
        && b.chars().all(ok_char)
        && !b.starts_with(['-', '/', '.'])
        && !b.ends_with(['/', '.'])
        && !b.ends_with(".lock")
        && !b.contains("..")
        && !b.contains("//")
}

pub fn worktree_dir(repo: &str, branch: &str) -> String {
    let slug: String = branch
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let repo = repo.trim_end_matches('/');
    format!("{repo}-worktrees/{slug}")
}

pub fn parse_listing(out: &str) -> Result<Listing, String> {
    if let Some(err) = out.lines().find_map(|l| l.strip_prefix("ERR ")) {
        return Err(err.to_string());
    }
    let mut l = Listing {
        path: String::new(),
        git: false,
        branch: String::new(),
        linked: false,
        entries: Vec::new(),
    };
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        match parts.as_slice() {
            ["PWD", p] => l.path = p.to_string(),
            ["SELF", b] => {
                l.git = true;
                l.branch = b.to_string();
            }
            ["LINKED"] => l.linked = true,
            ["GIT", name, b] => l.entries.push(Entry {
                name: name.to_string(),
                git: true,
                branch: b.to_string(),
            }),
            ["DIR", name] => l.entries.push(Entry {
                name: name.to_string(),
                git: false,
                branch: String::new(),
            }),
            _ => {}
        }
    }
    if l.path.is_empty() {
        return Err("could not read that folder".into());
    }
    Ok(l)
}

pub fn parse_branches(out: &str) -> Branches {
    let mut b = Branches::default();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        match parts.as_slice() {
            ["CUR", c] => b.current = c.to_string(),
            ["DEF", d] => b.default_base = d.to_string(),
            ["REF", r] => {
                if let Some(name) = r.strip_prefix("refs/heads/") {
                    b.local.push(name.to_string());
                } else if let Some(name) = r.strip_prefix("refs/remotes/origin/") {
                    if name != "HEAD" && !b.local.iter().any(|l| l == name) {
                        b.remote.push(name.to_string());
                    }
                }
            }
            ["WT", r, path] => {
                if let Some(name) = r.strip_prefix("refs/heads/") {
                    b.worktrees.insert(name.to_string(), path.to_string());
                }
            }
            _ => {}
        }
    }
    let local = b.local.clone();
    b.remote.retain(|r| !local.contains(r));
    b
}

pub struct Folders {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
}

impl Folders {
    pub fn new(runner: Arc<dyn Runner>, ssh: Ssh) -> Folders {
        Folders { runner, ssh }
    }

    pub(crate) async fn exec(
        &self,
        m: &Machine,
        script: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let out = self
            .runner
            .run(self.ssh.command(m, script), None, timeout)
            .await;
        if out.timed_out {
            return Err(format!("{} did not answer in time", m.name));
        }
        if !out.ok() && !out.stdout.contains("ERR ") {
            let err = out.stderr.trim();
            return Err(if err.is_empty() {
                format!("command failed on {}", m.name)
            } else {
                err.to_string()
            });
        }
        Ok(out.stdout)
    }

    pub async fn browse(&self, m: &Machine, path: &str) -> Result<Listing, String> {
        let script = format!(
            "{}; cd \"$p\" 2>/dev/null || {{ echo \"ERR not a folder: $p\"; exit 0; }}; \
             printf 'PWD\\t%s\\n' \"$(pwd)\"; \
             [ -e .git ] && printf 'SELF\\t%s\\n' \"$(git branch --show-current 2>/dev/null)\"; \
             [ -f .git ] && echo LINKED; \
             for d in */; do [ -d \"$d\" ] || continue; d=${{d%/}}; \
             if [ -e \"$d/.git\" ]; then printf 'GIT\\t%s\\t%s\\n' \"$d\" \"$(git -C \"$d\" branch --show-current 2>/dev/null)\"; \
             else printf 'DIR\\t%s\\n' \"$d\"; fi; done | head -300",
            expand_home(path)
        );
        parse_listing(&self.exec(m, &script, TIMEOUT).await?)
    }

    pub async fn branches(&self, m: &Machine, repo: &str) -> Result<Branches, String> {
        let script = format!(
            "cd {} || exit 3; \
             printf 'CUR\\t%s\\n' \"$(git branch --show-current)\"; \
             printf 'DEF\\t%s\\n' \"$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)\"; \
             git for-each-ref --sort=-committerdate --format='REF%09%(refname)' refs/heads refs/remotes | head -80; \
             git worktree list --porcelain | awk '/^worktree /{{w=substr($0,10)}} /^branch /{{print \"WT\\t\" $2 \"\\t\" w}}'",
            quote(repo)
        );
        Ok(parse_branches(&self.exec(m, &script, TIMEOUT).await?))
    }

    pub async fn prepare(
        &self,
        m: &Machine,
        repo: &str,
        pick: &Pick,
        current: &str,
    ) -> Result<Prepared, String> {
        if !valid_branch(&pick.branch)
            || (pick.new_branch && !pick.base.is_empty() && !valid_branch(&pick.base))
        {
            return Err("invalid branch name".into());
        }
        if !pick.new_branch && pick.branch == current {
            return Ok(Prepared {
                path: repo.to_string(),
                created: false,
            });
        }
        let target = worktree_dir(repo, &pick.branch);
        let parent = target.rsplit_once('/').map(|(p, _)| p).unwrap_or(&target);
        let b = quote(&pick.branch);
        let add = if pick.new_branch {
            let base = if pick.base.is_empty() {
                "HEAD".to_string()
            } else {
                pick.base.clone()
            };
            format!(
                "git worktree add -b {b} {} {}",
                quote(&target),
                quote(&base)
            )
        } else {
            format!(
                "if git show-ref --verify --quiet refs/heads/{0}; then git worktree add {1} {0}; \
                 else git fetch -q origin {0} 2>/dev/null || true; \
                 git worktree add --track -b {0} {1} {2}; fi",
                b,
                quote(&target),
                quote(&format!("origin/{}", pick.branch))
            )
        };
        let script = format!(
            "set -e; cd {}; \
             existing=$(git worktree list --porcelain | awk -v b=\"refs/heads/\"{b} '/^worktree /{{w=substr($0,10)}} $0==\"branch \" b {{print w}}'); \
             if [ -n \"$existing\" ]; then printf 'PATH\\t%s\\n' \"$existing\"; exit 0; fi; \
             mkdir -p {}; {add} >&2; printf 'PATH\\t%s\\nCREATED\\n' {}",
            quote(repo),
            quote(parent),
            quote(&target)
        );
        let out = self.exec(m, &script, WORKTREE_TIMEOUT).await?;
        let path = out
            .lines()
            .find_map(|l| l.strip_prefix("PATH\t"))
            .ok_or("git did not report the worktree folder")?;
        Ok(Prepared {
            path: path.to_string(),
            created: out.lines().any(|l| l == "CREATED"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Machine;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    fn machine() -> Machine {
        Machine {
            name: "hp".into(),
            ssh: Some("hp".into()),
            mesh_ip: None,
            port_prefix: Some(1),
            root: "~/Projects".into(),
            local: false,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        }
    }

    fn folders(fake: Arc<FakeRunner>) -> Folders {
        Folders::new(
            fake,
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        )
    }

    #[test]
    fn parses_listing() {
        let out =
            "PWD\t/home/u/Projects\nGIT\tacme-app\tmain\nDIR\tshop\nGIT\tyardbell\t\nSELF\t\n";
        let l = parse_listing(out).unwrap();
        assert_eq!(l.path, "/home/u/Projects");
        assert_eq!(l.entries.len(), 3);
        assert_eq!(
            l.entries[0],
            Entry {
                name: "acme-app".into(),
                git: true,
                branch: "main".into()
            }
        );
        assert!(!l.entries[1].git);
        assert!(l.git);
    }

    #[test]
    fn listing_error_is_reported() {
        assert_eq!(
            parse_listing("ERR not a folder: /nope\n").unwrap_err(),
            "not a folder: /nope"
        );
    }

    #[test]
    fn parses_branches() {
        let out = "CUR\tmain\nDEF\torigin/main\nREF\trefs/heads/eng-1301-inbox\nREF\trefs/heads/main\nREF\trefs/remotes/origin/HEAD\nREF\trefs/remotes/origin/eng-1290-csv\nREF\trefs/remotes/origin/main\nWT\trefs/heads/eng-1301-inbox\t/home/u/app-worktrees/eng-1301-inbox\n";
        let b = parse_branches(out);
        assert_eq!(b.current, "main");
        assert_eq!(b.default_base, "origin/main");
        assert_eq!(b.local, vec!["eng-1301-inbox", "main"]);
        assert_eq!(b.remote, vec!["eng-1290-csv"]);
        assert_eq!(
            b.worktrees.get("eng-1301-inbox").unwrap(),
            "/home/u/app-worktrees/eng-1301-inbox"
        );
    }

    #[test]
    fn worktree_dir_naming() {
        assert_eq!(
            worktree_dir("/home/u/code/acme/app", "ENG-1301/inbox filter"),
            "/home/u/code/acme/app-worktrees/eng-1301-inbox-filter"
        );
    }

    #[test]
    fn branch_names_validated() {
        for ok in ["eng-1301-inbox", "feature/x.y", "fix_2"] {
            assert!(valid_branch(ok), "{ok}");
        }
        for bad in [
            "", "-x", "a..b", "a b", "x;rm", "x.lock", "/x", "x/", "@{x}",
        ] {
            assert!(!valid_branch(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn browse_quotes_path() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("PWD", Output::ok_with("PWD\t/home/u/My Projects\n"));
        let l = folders(fake.clone())
            .browse(&machine(), "~/My Projects")
            .await
            .unwrap();
        assert_eq!(l.path, "/home/u/My Projects");
        assert!(fake.calls()[0]
            .last()
            .unwrap()
            .contains("p='~/My Projects'"));
    }

    #[tokio::test]
    async fn prepare_current_branch_uses_folder() {
        let fake = Arc::new(FakeRunner::default());
        let path = folders(fake.clone())
            .prepare(
                &machine(),
                "/r/app",
                &Pick {
                    branch: "main".into(),
                    new_branch: false,
                    base: String::new(),
                },
                "main",
            )
            .await
            .unwrap();
        assert_eq!(
            path,
            Prepared {
                path: "/r/app".into(),
                created: false
            }
        );
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn prepare_other_branch_makes_worktree() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "worktree",
            Output::ok_with("PATH\t/r/app-worktrees/eng-1290-csv\nCREATED\n"),
        );
        let pick = Pick {
            branch: "eng-1290-csv".into(),
            new_branch: false,
            base: String::new(),
        };
        let prepared = folders(fake.clone())
            .prepare(&machine(), "/r/app", &pick, "main")
            .await
            .unwrap();
        assert_eq!(prepared.path, "/r/app-worktrees/eng-1290-csv");
        assert!(prepared.created);
        let script = fake.calls()[0].last().unwrap().clone();
        assert!(script.contains("worktree add"), "{script}");
        assert!(script.contains("'/r/app-worktrees/eng-1290-csv'"));
        assert!(script.contains("'origin/eng-1290-csv'"));
    }

    #[tokio::test]
    async fn a_branch_only_on_the_remote_is_fetched_first() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "worktree",
            Output::ok_with("PATH\t/r/app-worktrees/com-1-mr\nCREATED\n"),
        );
        let pick = Pick {
            branch: "com-1-mr".into(),
            new_branch: false,
            base: String::new(),
        };
        folders(fake.clone())
            .prepare(&machine(), "/r/app", &pick, "main")
            .await
            .unwrap();
        let script = fake.calls()[0].last().unwrap().clone();
        let fetch = script
            .find("git fetch -q origin 'com-1-mr'")
            .expect(&script);
        assert!(
            fetch < script.find("worktree add --track").unwrap(),
            "{script}"
        );
    }

    #[tokio::test]
    async fn prepare_new_branch_from_base() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "worktree",
            Output::ok_with("PATH\t/r/app-worktrees/eng-1400-new\n"),
        );
        let pick = Pick {
            branch: "eng-1400-new".into(),
            new_branch: true,
            base: "origin/main".into(),
        };
        folders(fake.clone())
            .prepare(&machine(), "/r/app", &pick, "main")
            .await
            .unwrap();
        let script = fake.calls()[0].last().unwrap().clone();
        assert!(
            script.contains(
                "worktree add -b 'eng-1400-new' '/r/app-worktrees/eng-1400-new' 'origin/main'"
            ),
            "{script}"
        );
    }

    #[tokio::test]
    async fn prepare_rejects_bad_branch_and_reports_git_error() {
        let fake = Arc::new(FakeRunner::default());
        let bad = Pick {
            branch: "x;rm -rf".into(),
            new_branch: true,
            base: "main".into(),
        };
        assert_eq!(
            folders(fake.clone())
                .prepare(&machine(), "/r/app", &bad, "main")
                .await
                .unwrap_err(),
            "invalid branch name"
        );
        fake.stub(
            "worktree",
            Output::failed(128, "fatal: 'eng-1' is already checked out at '/x'"),
        );
        let pick = Pick {
            branch: "eng-1".into(),
            new_branch: false,
            base: String::new(),
        };
        let err = folders(fake)
            .prepare(&machine(), "/r/app", &pick, "main")
            .await
            .unwrap_err();
        assert!(err.contains("already checked out"), "{err}");
    }
}

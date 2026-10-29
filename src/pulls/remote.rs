use crate::config::Machine;
use crate::shell::{quote, Duration, Runner};
use crate::ssh::Ssh;
use std::sync::Arc;

const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    pub host: String,
    pub project: String,
}

// Accepts scheme://[user@]host[:port]/path and scp-like user@host:path. Any user or password in
// the address is dropped here, so it never reaches a log or an error.
pub fn parse(url: &str) -> Option<Repo> {
    let url = url.trim();
    let (authority, path) = match url.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?,
        None => url.split_once(':').filter(|(a, _)| !a.contains('/'))?,
    };
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?.to_ascii_lowercase();
    let path = path.trim_start_matches('/');
    let path = path.strip_suffix('/').unwrap_or(path);
    let project = path.strip_suffix(".git").unwrap_or(path);
    if host.is_empty() || !project.contains('/') || project.split('/').any(str::is_empty) {
        return None;
    }
    Some(Repo {
        host,
        project: project.to_string(),
    })
}

pub fn remote_command(branch: &str) -> String {
    format!(
        "r=$(git config --get {} || echo origin); git config --get \"remote.$r.url\"",
        quote(&format!("branch.{branch}.remote"))
    )
}

pub struct Remotes {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
}

impl Remotes {
    pub fn new(runner: Arc<dyn Runner>, ssh: Ssh) -> Remotes {
        Remotes { runner, ssh }
    }

    pub async fn read(&self, m: &Machine, path: &str, branch: &str) -> Option<Repo> {
        let script = format!(
            "cd {} 2>/dev/null || exit 1; {}",
            quote(path),
            remote_command(branch)
        );
        let out = self
            .runner
            .run(self.ssh.command(m, &script), None, TIMEOUT)
            .await;
        if !out.ok() {
            return None;
        }
        parse(out.stdout.lines().next()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use crate::worktrees::testing::machine;

    fn repo(host: &str, project: &str) -> Option<Repo> {
        Some(Repo {
            host: host.into(),
            project: project.into(),
        })
    }

    #[test]
    fn remotes_parse_into_a_host_and_a_project() {
        for (url, want) in [
            (
                "git@git.commslayer.com:commslayer/app.git",
                repo("git.commslayer.com", "commslayer/app"),
            ),
            (
                "ssh://git@Host.Example.com:2222/group/sub/app.git",
                repo("host.example.com", "group/sub/app"),
            ),
            (
                "https://gitlab.com/group/app",
                repo("gitlab.com", "group/app"),
            ),
            (
                "https://gitlab.com/group/app/",
                repo("gitlab.com", "group/app"),
            ),
            ("/srv/git/app.git", None),
            ("app", None),
            ("", None),
        ] {
            assert_eq!(parse(url), want, "{url}");
        }
    }

    #[test]
    fn credentials_in_a_remote_are_dropped() {
        let got = parse("https://oauth2:glpat-secret@git.commslayer.com/commslayer/app.git");
        assert_eq!(got, repo("git.commslayer.com", "commslayer/app"));
        assert!(!format!("{got:?}").contains("glpat"));
    }

    #[tokio::test]
    async fn the_remote_is_read_from_the_branch_or_origin() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "git config --get",
            Output::ok_with("git@git.commslayer.com:commslayer/app.git\n"),
        );
        let dir = tempfile::tempdir().unwrap();
        let remotes = Remotes::new(fake.clone(), Ssh::new(dir.path().to_path_buf()));
        let got = remotes.read(&machine("hp"), "/r/app", "eng-1").await;
        assert_eq!(got, repo("git.commslayer.com", "commslayer/app"));
        let call = fake.calls()[0].join(" ");
        assert!(call.contains("cd '/r/app'"), "{call}");
        assert!(call.contains("branch.eng-1.remote"), "{call}");
        assert!(call.contains("|| echo origin"), "{call}");

        let failing = Arc::new(FakeRunner::default());
        failing.stub("git config --get", Output::failed(1, ""));
        let remotes = Remotes::new(failing, Ssh::new(dir.path().to_path_buf()));
        assert_eq!(remotes.read(&machine("hp"), "/r/app", "eng-1").await, None);
    }
}

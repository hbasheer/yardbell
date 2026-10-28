use crate::config::Machine;
use crate::shell::{without_shell_noise, Duration, Runner};
use crate::ssh::Ssh;
use std::sync::Arc;

pub mod cleanup;
pub mod handoff;
pub mod integrate;
pub mod scan;
pub mod setup;

#[cfg(test)]
mod real_git;

// Merges and cherry-picks need an identity, and a machine that only runs agents may have none.
const IDENTITY: &str = "git var GIT_COMMITTER_IDENT >/dev/null 2>&1 || { \
GIT_AUTHOR_NAME=Yardbell; GIT_AUTHOR_EMAIL=yardbell@localhost; \
GIT_COMMITTER_NAME=Yardbell; GIT_COMMITTER_EMAIL=yardbell@localhost; \
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL; }; ";

const TEMP_DIR: &str = "tmp=$(mktemp -d 2>/dev/null || mktemp -d -t yardbell) || exit 1; \
trap 'rm -rf \"$tmp\"' EXIT; ";

#[derive(Clone)]
pub struct Worktrees {
    runner: Arc<dyn Runner>,
    ssh: Ssh,
}

impl Worktrees {
    pub fn new(runner: Arc<dyn Runner>, ssh: Ssh) -> Worktrees {
        Worktrees { runner, ssh }
    }

    // Scripts report a refusal they can explain as an ERR line and exit 0, so that message wins
    // over whatever git printed on the way.
    async fn run(
        &self,
        m: &Machine,
        script: &str,
        input: Option<String>,
        timeout: Duration,
    ) -> Result<String, String> {
        let out = self
            .runner
            .run(self.ssh.command(m, script), input, timeout)
            .await;
        if out.timed_out {
            return Err(format!("{} did not answer in time", m.name));
        }
        if let Some(err) = out.stdout.lines().find_map(|l| l.strip_prefix("ERR ")) {
            return Err(err.to_string());
        }
        if !out.ok() {
            let err = without_shell_noise(&out.stderr);
            return Err(if err.is_empty() {
                format!("git failed on {}", m.name)
            } else {
                err
            });
        }
        Ok(out.stdout)
    }
}

fn field<'a>(out: &'a str, key: &str) -> Option<&'a str> {
    out.lines()
        .find_map(|l| l.strip_prefix(key).and_then(|rest| rest.strip_prefix('\t')))
}

fn fields<'a>(out: &'a str, key: &'a str) -> impl Iterator<Item = &'a str> {
    out.lines()
        .filter_map(move |l| l.strip_prefix(key).and_then(|rest| rest.strip_prefix('\t')))
}

fn flag(out: &str, key: &str) -> bool {
    out.lines().any(|l| l == key)
}

#[cfg(test)]
pub(crate) mod testing {
    use crate::config::Machine;

    pub fn machine(name: &str) -> Machine {
        Machine {
            name: name.into(),
            ssh: Some(name.into()),
            mesh_ip: None,
            port_prefix: Some(1),
            root: "/r".into(),
            local: false,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        }
    }

    pub fn local(name: &str, root: &str) -> Machine {
        Machine {
            name: name.into(),
            ssh: None,
            mesh_ip: None,
            port_prefix: None,
            root: root.into(),
            local: true,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        }
    }

    pub fn script(fake: &crate::testing::FakeRunner, i: usize) -> String {
        fake.calls()[i].last().unwrap().clone()
    }
}

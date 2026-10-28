use super::{field, fields, flag, Worktrees};
use crate::config::Machine;
use crate::shell::{quote, Duration};
use serde::Serialize;

const TIMEOUT: Duration = Duration::from_secs(20);
const REMOVE_TIMEOUT: Duration = Duration::from_secs(120);
const LISTED: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Inspection {
    pub path: String,
    pub main: String,
    pub branch: String,
    pub linked: bool,
    // `git status --porcelain` lines: changed, staged and untracked files, not ignored ones.
    pub dirty: Vec<String>,
    // Commits on this branch that no remote branch and no other local branch has.
    pub unpushed: Vec<String>,
    pub merged_into: String,
}

impl Inspection {
    pub fn at_risk(&self) -> bool {
        !self.dirty.is_empty() || !self.unpushed.is_empty()
    }

    pub fn loss(&self) -> String {
        let count = |n: usize, one: &str, many: &str| {
            if n == 1 {
                format!("1 {one}")
            } else {
                format!("{n} {many}")
            }
        };
        let mut parts = Vec::new();
        if !self.dirty.is_empty() {
            parts.push(count(
                self.dirty.len(),
                "uncommitted change",
                "uncommitted changes",
            ));
        }
        if !self.unpushed.is_empty() {
            parts.push(format!(
                "{} that no remote or other branch has",
                count(self.unpushed.len(), "commit", "commits")
            ));
        }
        parts.join(" and ")
    }
}

#[derive(Debug, PartialEq)]
pub enum RemoveError {
    MainCheckout(String),
    AtRisk(Box<Inspection>),
    Failed(String),
}

impl RemoveError {
    pub fn message(&self) -> String {
        match self {
            RemoveError::MainCheckout(path) => format!(
                "{path} is the repository's main checkout, not a worktree. Yardbell only removes worktrees."
            ),
            RemoveError::AtRisk(ins) => format!(
                "{} has {}. Confirm to remove it anyway, and they are lost.",
                ins.path,
                ins.loss()
            ),
            RemoveError::Failed(e) => e.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Removal {
    pub path: String,
    pub branch: String,
    pub branch_deleted: bool,
    pub note: String,
}

pub fn inspect_script(path: &str) -> String {
    format!(
        "cd {path} 2>/dev/null || {{ echo 'ERR not a folder: '{path}; exit 0; }}; \
         top=$(git rev-parse --show-toplevel 2>/dev/null) || {{ echo 'ERR not a git checkout: '{path}; exit 0; }}; \
         cd \"$top\"; \
         gd=$(cd \"$(git rev-parse --git-dir)\" && pwd -P); cd_=$(cd \"$(git rev-parse --git-common-dir)\" && pwd -P); \
         main=$(git worktree list --porcelain | sed -n '1s/^worktree //p'); \
         printf 'TOP\\t%s\\nMAIN\\t%s\\n' \"$top\" \"$main\"; \
         [ \"$gd\" != \"$cd_\" ] && echo LINKED; \
         b=$(git branch --show-current); printf 'BRANCH\\t%s\\n' \"$b\"; \
         git status --porcelain=v1 --untracked-files=all 2>/dev/null | head -{LISTED} | sed 's/^/DIRTY\\t/'; \
         if [ -n \"$b\" ]; then \
         git log --format='AHEAD%x09%h %s' HEAD --not --remotes --exclude=\"$b\" --branches 2>/dev/null | head -{LISTED}; \
         base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); \
         [ -n \"$base\" ] || base=$(git -C \"$main\" branch --show-current 2>/dev/null); \
         [ -n \"$base\" ] && [ \"$base\" != \"$b\" ] && git merge-base --is-ancestor HEAD \"$base\" 2>/dev/null && printf 'MERGED\\t%s\\n' \"$base\"; \
         else git log --format='AHEAD%x09%h %s' HEAD --not --remotes --branches 2>/dev/null | head -{LISTED}; fi; \
         true",
        path = quote(path),
    )
}

pub fn parse_inspection(out: &str) -> Result<Inspection, String> {
    let path = field(out, "TOP").ok_or("git did not describe that folder")?;
    Ok(Inspection {
        path: path.to_string(),
        main: field(out, "MAIN").unwrap_or_default().to_string(),
        branch: field(out, "BRANCH").unwrap_or_default().to_string(),
        linked: flag(out, "LINKED"),
        dirty: fields(out, "DIRTY").map(str::to_string).collect(),
        unpushed: fields(out, "AHEAD").map(str::to_string).collect(),
        merged_into: field(out, "MERGED").unwrap_or_default().to_string(),
    })
}

// The main checkout is checked twice: by the inspection, and again on the machine right before
// git removes anything, by comparing real paths.
pub fn remove_script(ins: &Inspection, force: bool, delete_branch: bool) -> String {
    let force = if force { " --force" } else { "" };
    let delete = if delete_branch && !ins.branch.is_empty() && !ins.merged_into.is_empty() {
        format!(
            "if git merge-base --is-ancestor {b} {base} 2>/dev/null && git branch -D {short} >/dev/null 2>&1; \
             then echo DELETED; else echo KEPT; fi; ",
            b = quote(&format!("refs/heads/{}", ins.branch)),
            base = quote(&ins.merged_into),
            short = quote(&ins.branch),
        )
    } else {
        String::new()
    };
    format!(
        "cd {main} 2>/dev/null || {{ echo 'ERR the main checkout is missing: '{main}; exit 0; }}; \
         [ \"$(cd {path} 2>/dev/null && pwd -P)\" = \"$(pwd -P)\" ] && {{ echo 'ERR that is the main checkout'; exit 0; }}; \
         git worktree list --porcelain | grep -qxF {listed} || {{ echo 'ERR git does not list '{path}' as a worktree of '{main}; exit 0; }}; \
         git worktree remove{force} {path} || exit 1; \
         {delete}git worktree prune; echo REMOVED",
        main = quote(&ins.main),
        path = quote(&ins.path),
        listed = quote(&format!("worktree {}", ins.path)),
    )
}

impl Worktrees {
    pub async fn inspect(&self, m: &Machine, path: &str) -> Result<Inspection, String> {
        parse_inspection(&self.run(m, &inspect_script(path), None, TIMEOUT).await?)
    }

    // Removes a worktree that inspect described, or refuses: never the main checkout, and
    // nothing that would lose work unless forced.
    pub async fn remove(
        &self,
        m: &Machine,
        ins: &Inspection,
        force: bool,
        delete_branch: bool,
    ) -> Result<Removal, RemoveError> {
        if !ins.linked || ins.main.is_empty() || ins.main == ins.path {
            return Err(RemoveError::MainCheckout(ins.path.clone()));
        }
        if ins.at_risk() && !force {
            return Err(RemoveError::AtRisk(Box::new(ins.clone())));
        }
        let script = remove_script(ins, force && ins.at_risk(), delete_branch);
        let out = self
            .run(m, &script, None, REMOVE_TIMEOUT)
            .await
            .map_err(RemoveError::Failed)?;
        if !flag(&out, "REMOVED") {
            return Err(RemoveError::Failed(format!(
                "git did not remove {} on {}",
                ins.path, m.name
            )));
        }
        let branch_deleted = flag(&out, "DELETED");
        let note = match (delete_branch, branch_deleted) {
            (true, true) => format!("Removed {} and deleted branch {}.", ins.path, ins.branch),
            (true, false) if ins.merged_into.is_empty() => format!(
                "Removed {}. Branch {} was kept because it is not merged.",
                ins.path, ins.branch
            ),
            (true, false) => format!("Removed {}. Git kept branch {}.", ins.path, ins.branch),
            (false, _) => format!("Removed {}.", ins.path),
        };
        Ok(Removal {
            path: ins.path.clone(),
            branch: ins.branch.clone(),
            branch_deleted,
            note,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::{machine, script};
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    fn worktrees(fake: Arc<FakeRunner>) -> Worktrees {
        Worktrees::new(
            fake,
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        )
    }

    const CLEAN: &str =
        "TOP\t/r/app-worktrees/eng-1\nMAIN\t/r/app\nLINKED\nBRANCH\teng-1\nMERGED\torigin/main\n";

    #[tokio::test]
    async fn the_main_checkout_is_never_removed() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub(
            "worktree list",
            Output::ok_with("TOP\t/r/app\nMAIN\t/r/app\nBRANCH\tmain\n"),
        );
        let w = worktrees(fake.clone());
        let ins = w.inspect(&machine("hp"), "/r/app").await.unwrap();
        assert!(!ins.linked);
        let err = w
            .remove(&machine("hp"), &ins, true, true)
            .await
            .unwrap_err();
        assert_eq!(
            err.message(),
            "/r/app is the repository's main checkout, not a worktree. Yardbell only removes worktrees."
        );
        assert_eq!(fake.calls().len(), 1, "nothing ran after the inspection");
    }

    #[tokio::test]
    async fn uncommitted_changes_or_unpushed_commits_need_confirming() {
        let fake = Arc::new(FakeRunner::default());
        let risky = format!(
            "{CLEAN}DIRTY\t M src/a.rs\nDIRTY\t?? notes.txt\nAHEAD\tabc1234 Fix the login\n"
        );
        fake.stub("status --porcelain", Output::ok_with(&risky));
        let w = worktrees(fake.clone());
        let ins = w
            .inspect(&machine("hp"), "/r/app-worktrees/eng-1")
            .await
            .unwrap();
        assert_eq!(ins.dirty, [" M src/a.rs", "?? notes.txt"]);
        assert_eq!(ins.unpushed, ["abc1234 Fix the login"]);
        let err = w
            .remove(&machine("hp"), &ins, false, false)
            .await
            .unwrap_err();
        assert_eq!(
            err.message(),
            "/r/app-worktrees/eng-1 has 2 uncommitted changes and 1 commit that no remote or other \
branch has. Confirm to remove it anyway, and they are lost."
        );
        assert!(matches!(err, RemoveError::AtRisk(_)));
        assert_eq!(fake.calls().len(), 1);

        fake.stub("worktree remove", Output::ok_with("REMOVED\n"));
        let done = w.remove(&machine("hp"), &ins, true, false).await.unwrap();
        assert_eq!(done.note, "Removed /r/app-worktrees/eng-1.");
        let sent = script(&fake, 1);
        assert!(
            sent.contains("git worktree remove --force '/r/app-worktrees/eng-1'"),
            "{sent}"
        );
        assert!(sent.contains("cd '/r/app'"), "{sent}");
        assert!(sent.contains("git worktree prune"), "{sent}");
        assert!(!sent.contains("branch -D"), "{sent}");
    }

    #[tokio::test]
    async fn a_clean_merged_worktree_goes_with_its_branch() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("worktree remove", Output::ok_with("DELETED\nREMOVED\n"));
        fake.stub("status --porcelain", Output::ok_with(CLEAN));
        let w = worktrees(fake.clone());
        let ins = w
            .inspect(&machine("hp"), "/r/app-worktrees/eng-1")
            .await
            .unwrap();
        assert!(!ins.at_risk());
        let done = w.remove(&machine("hp"), &ins, false, true).await.unwrap();
        assert!(done.branch_deleted);
        assert_eq!(
            done.note,
            "Removed /r/app-worktrees/eng-1 and deleted branch eng-1."
        );
        let sent = script(&fake, 1);
        assert!(
            sent.contains("git worktree remove '/r/app-worktrees/eng-1'"),
            "{sent}"
        );
        assert!(
            sent.contains("git merge-base --is-ancestor 'refs/heads/eng-1' 'origin/main'"),
            "{sent}"
        );
    }

    #[tokio::test]
    async fn an_unmerged_branch_is_kept_and_git_errors_are_reported() {
        let fake = Arc::new(FakeRunner::default());
        let unmerged = CLEAN.replace("MERGED\torigin/main\n", "");
        fake.stub("status --porcelain", Output::ok_with(&unmerged));
        fake.stub("worktree remove", Output::ok_with("REMOVED\n"));
        let w = worktrees(fake.clone());
        let ins = w
            .inspect(&machine("hp"), "/r/app-worktrees/eng-1")
            .await
            .unwrap();
        let done = w.remove(&machine("hp"), &ins, false, true).await.unwrap();
        assert!(!done.branch_deleted);
        assert_eq!(
            done.note,
            "Removed /r/app-worktrees/eng-1. Branch eng-1 was kept because it is not merged."
        );
        assert!(!script(&fake, 1).contains("branch -D"));
        fake.restub(
            "worktree remove",
            Output::ok_with(
                "ERR git does not list '/r/app-worktrees/eng-1' as a worktree of /r/app\n",
            ),
        );
        let err = w
            .remove(&machine("hp"), &ins, false, false)
            .await
            .unwrap_err();
        assert!(matches!(err, RemoveError::Failed(_)), "{err:?}");
    }
}

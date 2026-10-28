use super::{fields, Worktrees, IDENTITY, TEMP_DIR};
use crate::config::Machine;
use crate::folders::{valid_branch, Folders, Pick};
use crate::shell::{quote, Duration};
use serde::{Deserialize, Serialize};

const TIMEOUT: Duration = Duration::from_secs(300);
const MAX_BRANCHES: usize = 20;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    #[default]
    Merge,
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Integration {
    pub base: String,
    pub branches: Vec<String>,
    pub into: String,
    #[serde(default)]
    pub method: Method,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    pub branch: String,
    pub files: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Integrated {
    pub path: String,
    pub branch: String,
    pub base: String,
    pub method: Method,
    pub merged: Vec<String>,
    pub conflict: Option<Conflict>,
    pub pending: Vec<String>,
    // Branches whose worktree has changes that are not committed, and so not integrated.
    pub uncommitted: Vec<String>,
}

impl Integrated {
    pub fn summary(&self) -> String {
        let merged = if self.merged.is_empty() {
            "nothing yet".to_string()
        } else {
            self.merged.join(", ")
        };
        let mut text = format!("{} in {} holds {merged}.", self.branch, self.path);
        if let Some(c) = &self.conflict {
            let files = if c.files.is_empty() {
                c.message.clone()
            } else {
                c.files.join(", ")
            };
            text.push_str(&format!(" Stopped at {}: {files}.", c.branch));
            if !self.pending.is_empty() {
                text.push_str(&format!(" Not tried: {}.", self.pending.join(", ")));
            }
        }
        if !self.uncommitted.is_empty() {
            text.push_str(&format!(
                " Uncommitted changes in {} were left out.",
                self.uncommitted.join(", ")
            ));
        }
        text
    }
}

impl Integration {
    pub fn check(&self) -> Result<(), String> {
        if self.branches.is_empty() {
            return Err("give the branches to integrate".into());
        }
        if self.branches.len() > MAX_BRANCHES {
            return Err(format!("integrate at most {MAX_BRANCHES} branches at once"));
        }
        for b in self.branches.iter().chain([&self.into, &self.base]) {
            if !valid_branch(b) {
                return Err(format!("{b:?} is not a branch name Yardbell accepts"));
            }
        }
        if self.branches.contains(&self.into) {
            return Err(format!(
                "{} is one of the branches to integrate; pick a new name for the integration branch",
                self.into
            ));
        }
        if let Some(twice) = self
            .branches
            .iter()
            .enumerate()
            .find(|(i, b)| self.branches[..*i].contains(b))
        {
            return Err(format!("{} is listed twice", twice.1));
        }
        Ok(())
    }
}

// One branch at a time onto the integration branch, in the order given. A conflict is undone at
// once, so the worktree always holds the branches merged so far and nothing half merged.
pub fn script(path: &str, plan: &Integration) -> String {
    let branches: Vec<String> = plan.branches.iter().map(|b| quote(b)).collect();
    let step = match plan.method {
        Method::Merge => {
            "if git merge --no-ff --no-edit -m \"Integrate $b\" \"$ref\" >\"$tmp/out\" 2>&1; \
             then printf 'MERGED\\t%s\\n' \"$b\"; \
             else conflict \"$b\"; git merge --abort >/dev/null 2>&1; exit 0; fi"
        }
        Method::Rebase => {
            "for c in $(git rev-list --reverse --no-merges \"HEAD..$ref\"); do \
             git cherry-pick --keep-redundant-commits \"$c\" >\"$tmp/out\" 2>&1 || \
             { conflict \"$b\"; git cherry-pick --abort >/dev/null 2>&1; exit 0; }; done; \
             printf 'MERGED\\t%s\\n' \"$b\""
        }
    };
    format!(
        "cd {path} 2>/dev/null || {{ echo 'ERR the integration worktree is missing: '{path}; exit 0; }}; \
         {IDENTITY}{TEMP_DIR}\
         conflict() {{ printf 'CONFLICT\\t%s\\n' \"$1\"; git diff --name-only --diff-filter=U | sed 's/^/FILE\\t/'; \
         tail -n 5 \"$tmp/out\" | sed 's/^/MSG\\t/'; }}; \
         for b in {list}; do \
         ref=$(git rev-parse -q --verify \"refs/heads/$b^{{commit}}\" || git rev-parse -q --verify \"refs/remotes/origin/$b^{{commit}}\"); \
         [ -n \"$ref\" ] || {{ printf 'MISSING\\t%s\\n' \"$b\"; exit 0; }}; \
         wt=$(git worktree list --porcelain | awk -v r=\"branch refs/heads/$b\" '/^worktree /{{w=substr($0,10)}} $0==r {{print w}}'); \
         [ -n \"$wt\" ] && [ -n \"$(git -C \"$wt\" status --porcelain 2>/dev/null | head -n 1)\" ] && printf 'UNCOMMITTED\\t%s\\n' \"$b\"; \
         {step}; \
         done; true",
        path = quote(path),
        list = branches.join(" "),
    )
}

pub fn parse(path: &str, plan: &Integration, out: &str) -> Result<Integrated, String> {
    if let Some(missing) = fields(out, "MISSING").next() {
        return Err(format!(
            "there is no branch {missing}, locally or on origin, so nothing was integrated past it"
        ));
    }
    let merged: Vec<String> = fields(out, "MERGED").map(str::to_string).collect();
    let conflict = fields(out, "CONFLICT").next().map(|branch| Conflict {
        branch: branch.to_string(),
        files: fields(out, "FILE").map(str::to_string).collect(),
        message: fields(out, "MSG").collect::<Vec<_>>().join("\n"),
    });
    let pending = match &conflict {
        Some(c) => plan
            .branches
            .iter()
            .skip_while(|b| **b != c.branch)
            .skip(1)
            .cloned()
            .collect(),
        None => Vec::new(),
    };
    Ok(Integrated {
        path: path.to_string(),
        branch: plan.into.clone(),
        base: plan.base.clone(),
        method: plan.method,
        merged,
        conflict,
        pending,
        uncommitted: fields(out, "UNCOMMITTED").map(str::to_string).collect(),
    })
}

impl Worktrees {
    // The integration branch is new and gets a worktree of its own, so neither the main checkout
    // nor any branch being integrated is changed.
    pub async fn integrate(
        &self,
        folders: &Folders,
        m: &Machine,
        repo: &str,
        plan: &Integration,
    ) -> Result<Integrated, String> {
        plan.check()?;
        let pick = Pick {
            branch: plan.into.clone(),
            new_branch: true,
            base: plan.base.clone(),
        };
        let prepared = folders.prepare(m, repo, &pick, "").await?;
        if !prepared.created {
            return Err(format!(
                "{} already exists in {}; pick a new name for the integration branch",
                plan.into, prepared.path
            ));
        }
        let out = self
            .run(m, &script(&prepared.path, plan), None, TIMEOUT)
            .await?;
        parse(&prepared.path, plan, &out)
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::{machine, script as sent};
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    fn plan(branches: &[&str], method: Method) -> Integration {
        Integration {
            base: "main".into(),
            branches: branches.iter().map(|b| b.to_string()).collect(),
            into: "eng-1-together".into(),
            method,
        }
    }

    fn rig() -> (Arc<FakeRunner>, Worktrees, Folders) {
        let fake = Arc::new(FakeRunner::default());
        let ssh = crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep());
        (
            fake.clone(),
            Worktrees::new(fake.clone(), ssh.clone()),
            Folders::new(fake, ssh),
        )
    }

    #[tokio::test]
    async fn branches_go_in_one_at_a_time_in_the_given_order() {
        let (fake, w, folders) = rig();
        fake.stub(
            "worktree add -b",
            Output::ok_with("PATH\t/r/app-worktrees/eng-1-together\nCREATED\n"),
        );
        fake.stub(
            "Integrate",
            Output::ok_with("MERGED\teng-1-api\nUNCOMMITTED\teng-1-web\nMERGED\teng-1-web\n"),
        );
        let p = plan(&["eng-1-api", "eng-1-web"], Method::Merge);
        let done = w
            .integrate(&folders, &machine("hp"), "/r/app", &p)
            .await
            .unwrap();
        assert_eq!(done.merged, ["eng-1-api", "eng-1-web"]);
        assert_eq!(done.conflict, None);
        assert_eq!(done.uncommitted, ["eng-1-web"]);
        assert!(sent(&fake, 0)
            .contains("worktree add -b 'eng-1-together' '/r/app-worktrees/eng-1-together' 'main'"));
        let merge = sent(&fake, 1);
        assert!(
            merge.contains("for b in 'eng-1-api' 'eng-1-web'; do"),
            "{merge}"
        );
        assert!(merge.contains("git merge --no-ff"), "{merge}");
        assert!(!merge.contains("push"), "{merge}");
    }

    #[tokio::test]
    async fn the_first_conflict_stops_it_and_names_the_files() {
        let (fake, w, folders) = rig();
        fake.stub("worktree add -b", Output::ok_with("PATH\t/r/w\nCREATED\n"));
        fake.stub(
            "cherry-pick",
            Output::ok_with(
                "MERGED\ta\nCONFLICT\tb\nFILE\tsrc/login.js\nFILE\tREADME.md\nMSG\tCONFLICT (content): Merge conflict in src/login.js\n",
            ),
        );
        let p = plan(&["a", "b", "c"], Method::Rebase);
        let done = w
            .integrate(&folders, &machine("hp"), "/r/app", &p)
            .await
            .unwrap();
        assert_eq!(done.merged, ["a"]);
        let c = done.conflict.clone().unwrap();
        assert_eq!(c.branch, "b");
        assert_eq!(c.files, ["src/login.js", "README.md"]);
        assert_eq!(done.pending, ["c"]);
        assert_eq!(
            done.summary(),
            "eng-1-together in /r/w holds a. Stopped at b: src/login.js, README.md. Not tried: c."
        );
        assert!(sent(&fake, 1).contains("git cherry-pick --abort"));
    }

    #[tokio::test]
    async fn an_existing_branch_or_a_bad_plan_is_refused() {
        let (fake, w, folders) = rig();
        fake.stub("worktree add -b", Output::ok_with("PATH\t/r/w\n"));
        let p = plan(&["a"], Method::Merge);
        let err = w
            .integrate(&folders, &machine("hp"), "/r/app", &p)
            .await
            .unwrap_err();
        assert_eq!(
            err,
            "eng-1-together already exists in /r/w; pick a new name for the integration branch"
        );
        let mut twice = plan(&["a", "a"], Method::Merge);
        assert_eq!(twice.check().unwrap_err(), "a is listed twice");
        twice.branches = vec!["eng-1-together".into()];
        assert!(twice.check().unwrap_err().contains("pick a new name"));
        twice.branches = vec!["x;rm".into()];
        assert_eq!(
            twice.check().unwrap_err(),
            "\"x;rm\" is not a branch name Yardbell accepts"
        );
        assert_eq!(
            plan(&[], Method::Merge).check().unwrap_err(),
            "give the branches to integrate"
        );
    }
}

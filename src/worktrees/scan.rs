use super::{field, Worktrees};
use crate::config::Machine;
use crate::folders::valid_branch;
use crate::shell::{quote, Duration};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

const READ_TIMEOUT: Duration = Duration::from_secs(60);
const PUSH_TIMEOUT: Duration = Duration::from_secs(180);
const PATCH_MAX: usize = 30_000_000;
// A shorter value turns up in ordinary text too often to mean anything.
const SECRET_MIN: usize = 8;
const LISTED: usize = 20;

static PATTERNS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        (
            "a private key",
            r"-----BEGIN ((RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY( BLOCK)?-----",
        ),
        ("an AWS access key", r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
        (
            "an AWS secret key",
            r#"(?i)aws_secret_access_key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}"#,
        ),
        (
            "a GitHub token",
            r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}",
        ),
        ("a GitHub token", r"\bgithub_pat_[A-Za-z0-9_]{50,}"),
        ("a GitLab token", r"\bglpat-[A-Za-z0-9_-]{20,}"),
        ("a Slack token", r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
        (
            "a Slack webhook",
            r"https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+",
        ),
        ("a Stripe key", r"\b(sk|rk)_live_[A-Za-z0-9]{20,}"),
        ("a Google API key", r"\bAIza[0-9A-Za-z_-]{35}"),
        ("an Anthropic API key", r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
        ("an OpenAI API key", r"\bsk-(proj-)?[A-Za-z0-9_-]{32,}"),
        ("a Linear API key", r"\blin_api_[A-Za-z0-9]{32,}"),
        ("an npm token", r"\bnpm_[A-Za-z0-9]{36}\b"),
        ("a Yardbell MCP token", r"\byb_[A-Za-z0-9]{40}\b"),
    ]
    .into_iter()
    .map(|(what, re)| (what, Regex::new(re).expect("static regex")))
    .collect()
});

// Where a possible secret is: never the text that matched.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    pub file: String,
    pub line: u32,
    pub commit: String,
    pub what: String,
}

impl Hit {
    pub fn place(&self) -> String {
        format!("{}:{}", self.file, self.line)
    }
}

pub fn describe(hits: &[Hit]) -> String {
    let listed: Vec<String> = hits
        .iter()
        .take(LISTED)
        .map(|h| {
            let commit: String = h.commit.chars().take(7).collect();
            format!("{} (commit {commit}) {}", h.place(), h.what)
        })
        .collect();
    let more = match hits.len().saturating_sub(LISTED) {
        0 => String::new(),
        n => format!(" and {n} more"),
    };
    let count = if hits.len() == 1 {
        "a possible secret".to_string()
    } else {
        format!("{} possible secrets", hits.len())
    };
    format!(
        "Push blocked: the commits to push hold {count}: {}{more}. Remove them from the \
commits before pushing; the values are not shown here.",
        listed.join("; ")
    )
}

fn added_file(line: &str) -> Option<String> {
    let path = line.strip_prefix("+++ ")?;
    if path == "/dev/null" {
        return None;
    }
    let path = path.trim_matches('"');
    Some(path.strip_prefix("b/").unwrap_or(path).to_string())
}

// "@@ -1,2 +3,4 @@" or, for a merge's combined diff, "@@@ -1 -2 +3,4 @@@": the markers' width
// and where the new side starts.
fn hunk(line: &str) -> Option<(usize, u32)> {
    let ats = line.chars().take_while(|c| *c == '@').count();
    if ats < 2 {
        return None;
    }
    let new = line[ats..]
        .split_whitespace()
        .find_map(|part| part.strip_prefix('+'))?;
    let start = new.split(',').next()?.parse().ok()?;
    Some((ats - 1, start))
}

// Reads `git log -p` and checks every line the commits add, each where it was added, so a secret
// committed and later deleted is still found: pushing the commits pushes it too.
pub fn scan(patch: &str, secrets: &[(String, String)]) -> Vec<Hit> {
    let secrets: Vec<&(String, String)> = secrets
        .iter()
        .filter(|(_, value)| value.len() >= SECRET_MIN)
        .collect();
    let mut hits = Vec::new();
    let (mut commit, mut file) = (String::new(), None::<String>);
    let (mut width, mut line) = (1usize, 0u32);
    let mut in_hunk = false;
    for text in patch.lines() {
        if let Some(sha) = text.strip_prefix("commit ") {
            commit = sha.trim().to_string();
            file = None;
            in_hunk = false;
            continue;
        }
        if text.starts_with("diff --") {
            file = None;
            in_hunk = false;
            continue;
        }
        if !in_hunk && text.starts_with("+++ ") {
            file = added_file(text);
            continue;
        }
        if let Some((w, start)) = hunk(text) {
            width = w;
            line = start;
            in_hunk = true;
            continue;
        }
        let Some(name) = file.as_ref().filter(|_| in_hunk) else {
            continue;
        };
        if text.len() < width || text.starts_with('\\') {
            continue;
        }
        let (marks, body) = text.split_at(width);
        if marks.contains('-') {
            continue;
        }
        if !marks.contains('+') {
            line += 1;
            continue;
        }
        let what = PATTERNS
            .iter()
            .find(|(_, re)| re.is_match(body))
            .map(|(what, _)| what.to_string())
            .or_else(|| {
                secrets
                    .iter()
                    .find(|(_, value)| body.contains(value.as_str()))
                    .map(|(name, _)| format!("holds the value of the secret {name}"))
            });
        if let Some(what) = what {
            let what = if what.starts_with("holds") {
                what
            } else {
                format!("looks like {what}")
            };
            hits.push(Hit {
                file: name.clone(),
                line,
                commit: commit.clone(),
                what,
            });
        }
        line += 1;
    }
    hits
}

pub fn valid_remote(remote: &str) -> bool {
    !remote.is_empty()
        && remote.len() <= 100
        && !remote.starts_with('-')
        && remote
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// The commits a push would send: those on the branch that no remote-tracking branch has yet.
// Merges show only what their resolution added.
pub fn outgoing_script(path: &str, branch: &str) -> String {
    format!(
        "cd {path} 2>/dev/null || {{ echo 'ERR not a folder: '{path}; exit 0; }}; \
         git rev-parse -q --verify {r} >/dev/null || {{ echo 'ERR there is no branch '{b}' in '{path}; exit 0; }}; \
         printf 'COUNT\\t%s\\nPATCH\\n' \"$(git rev-list --count {r} --not --remotes)\"; \
         git -c core.quotepath=off log -p --cc -U0 --no-color --no-ext-diff --no-textconv --format='commit %H' {r} --not --remotes | head -c {PATCH_MAX}",
        path = quote(path),
        b = quote(branch),
        r = quote(&format!("refs/heads/{branch}")),
    )
}

// Never forced: no --force, and a branch name cannot start with +.
pub fn push_script(path: &str, branch: &str, remote: &str) -> String {
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    format!(
        "cd {path} 2>/dev/null || {{ echo 'ERR not a folder: '{path}; exit 0; }}; \
         git remote get-url {remote} >/dev/null 2>&1 || {{ echo 'ERR there is no remote named '{remote}; exit 0; }}; \
         GIT_TERMINAL_PROMPT=0 git push --porcelain --set-upstream {remote} {refspec} 2>&1 && echo PUSHED",
        path = quote(path),
        remote = quote(remote),
        refspec = quote(&refspec),
    )
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pushed {
    pub branch: String,
    pub remote: String,
    pub commits: usize,
    pub output: String,
}

impl Worktrees {
    pub async fn outgoing(
        &self,
        m: &Machine,
        path: &str,
        branch: &str,
    ) -> Result<(usize, String), String> {
        let out = self
            .run(m, &outgoing_script(path, branch), None, READ_TIMEOUT)
            .await?;
        if out.len() >= PATCH_MAX {
            return Err(format!(
                "the commits to push are over {} MB, too large to check for secrets, so Yardbell \
does not push them",
                PATCH_MAX / 1_000_000
            ));
        }
        let count = field(&out, "COUNT")
            .and_then(|c| c.trim().parse().ok())
            .unwrap_or(0);
        let patch = out
            .split_once("\nPATCH\n")
            .map(|(_, p)| p)
            .unwrap_or_default();
        Ok((count, patch.to_string()))
    }

    // Checks first, pushes only when nothing turned up.
    pub async fn push(
        &self,
        m: &Machine,
        path: &str,
        branch: &str,
        remote: &str,
        secrets: &[(String, String)],
    ) -> Result<Pushed, String> {
        if !valid_branch(branch) {
            return Err(format!("{branch:?} is not a branch name Yardbell accepts"));
        }
        if !valid_remote(remote) {
            return Err(format!("{remote:?} is not a remote name Yardbell accepts"));
        }
        let (commits, patch) = self.outgoing(m, path, branch).await?;
        let hits = scan(&patch, secrets);
        if !hits.is_empty() {
            return Err(describe(&hits));
        }
        let out = self
            .run(m, &push_script(path, branch, remote), None, PUSH_TIMEOUT)
            .await?;
        if !out.lines().any(|l| l == "PUSHED") {
            return Err(format!("git push did not finish: {}", out.trim()));
        }
        Ok(Pushed {
            branch: branch.to_string(),
            remote: remote.to_string(),
            commits,
            output: out.replace("PUSHED", "").trim().to_string(),
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

    // Built at run time, so this file holds nothing a scanner would flag.
    fn github_token() -> String {
        format!("ghp_{}", "A1b2C3d4".repeat(5))
    }

    fn aws_key() -> String {
        format!("AKIA{}", "Q7XW".repeat(4))
    }

    fn patch(added: &[&str]) -> String {
        let body: String = added.iter().map(|l| format!("+{l}\n")).collect();
        format!(
            "commit 1111111aaaaaaa\n\ndiff --git a/src/config.rs b/src/config.rs\nindex 1..2 100644\n\
--- a/src/config.rs\n+++ b/src/config.rs\n@@ -10,0 +11,{} @@\n{body}",
            added.len()
        )
    }

    #[test]
    fn known_token_shapes_are_found_with_their_place() {
        let token = github_token();
        let key = aws_key();
        let lines = [
            "let a = 1;".to_string(),
            format!("let t = \"{token}\";"),
            format!("aws = {key}"),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let hits = scan(&patch(&refs), &[]);
        assert_eq!(
            hits,
            [
                Hit {
                    file: "src/config.rs".into(),
                    line: 12,
                    commit: "1111111aaaaaaa".into(),
                    what: "looks like a GitHub token".into()
                },
                Hit {
                    file: "src/config.rs".into(),
                    line: 13,
                    commit: "1111111aaaaaaa".into(),
                    what: "looks like an AWS access key".into()
                },
            ]
        );
        let text = describe(&hits);
        assert_eq!(
            text,
            "Push blocked: the commits to push hold 2 possible secrets: src/config.rs:12 (commit \
1111111) looks like a GitHub token; src/config.rs:13 (commit 1111111) looks like an AWS access \
key. Remove them from the commits before pushing; the values are not shown here."
        );
        assert!(!text.contains(&token) && !text.contains(&key));
    }

    #[test]
    fn secrets_store_values_are_matched_but_never_printed() {
        let value = "s3cr3t-linear-value-42".to_string();
        let secrets = vec![
            ("linear".to_string(), value.clone()),
            ("pin".to_string(), "1234".to_string()),
        ];
        let line = format!("LINEAR={value}");
        let hits = scan(&patch(&["x = 1234", &line]), &secrets);
        assert_eq!(hits.len(), 1, "a short value is not matched: {hits:?}");
        assert_eq!(hits[0].place(), "src/config.rs:12");
        assert_eq!(hits[0].what, "holds the value of the secret linear");
        let text = describe(&hits);
        assert!(!text.contains(&value), "{text}");
        assert!(!format!("{hits:?}").contains(&value));
    }

    #[test]
    fn removed_lines_and_context_are_not_hits_and_merges_count_their_own_lines() {
        let token = github_token();
        let log = format!(
            "commit aaa\n\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-{token}\n same\n+fine\n\
commit bbb\n\ndiff --cc b.txt\n--- a/b.txt\n+++ b/b.txt\n@@@ -1,1 -1,1 +1,3 @@@\n  kept\n- {token}\n++{token}\n"
        );
        let hits = scan(&log, &[]);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(
            (hits[0].file.as_str(), hits[0].line, hits[0].commit.as_str()),
            ("b.txt", 2, "bbb")
        );
    }

    #[tokio::test]
    async fn a_hit_blocks_the_push_and_a_clean_branch_is_pushed_without_force() {
        let fake = Arc::new(FakeRunner::default());
        let leak = patch(&[&format!("token: {}", github_token())]);
        fake.stub(
            "--not --remotes",
            Output::ok_with(&format!("COUNT\t1\nPATCH\n{leak}")),
        );
        fake.stub("git push", Output::ok_with("To origin\nPUSHED\n"));
        let w = Worktrees::new(
            fake.clone(),
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        );
        let err = w
            .push(&machine("hp"), "/r/w", "eng-1", "origin", &[])
            .await
            .unwrap_err();
        assert!(err.starts_with("Push blocked"), "{err}");
        assert!(!err.contains(&github_token()));
        assert_eq!(fake.calls().len(), 1, "git push never ran");

        fake.restub(
            "--not --remotes",
            Output::ok_with(&format!("COUNT\t2\nPATCH\n{}", patch(&["ok"]))),
        );
        let pushed = w
            .push(&machine("hp"), "/r/w", "eng-1", "origin", &[])
            .await
            .unwrap();
        assert_eq!(pushed.commits, 2);
        let sent = script(&fake, 2);
        assert!(
            sent.contains(
                "git push --porcelain --set-upstream 'origin' 'refs/heads/eng-1:refs/heads/eng-1'"
            ),
            "{sent}"
        );
        assert!(!sent.contains("force") && !sent.contains("'+"), "{sent}");
        assert_eq!(
            w.push(&machine("hp"), "/r/w", "+eng-1", "origin", &[])
                .await
                .unwrap_err(),
            "\"+eng-1\" is not a branch name Yardbell accepts"
        );
        assert_eq!(
            w.push(&machine("hp"), "/r/w", "eng-1", "--force", &[])
                .await
                .unwrap_err(),
            "\"--force\" is not a remote name Yardbell accepts"
        );
    }
}

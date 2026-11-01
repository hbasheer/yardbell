use super::diff::{err_of, field, prelude, valid_sha};
use crate::config::Machine;
use crate::folders::Folders;
use crate::shell::Duration;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_UNTRACKED: usize = 2000;
const TIMEOUT: Duration = Duration::from_secs(20);
const UNSURE: &str = "unsure";

// The code a reviewer reads: the commit, and a hash of what differs from it, because a reviewer
// also sees changes not yet committed. `changes` is empty on a clean tree. A pin that failed, or
// could not take in every change, never counts as the same code as anything.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Pin {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub head: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub top: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub changes: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
}

impl Pin {
    pub fn failed(error: impl Into<String>) -> Pin {
        Pin {
            error: error.into(),
            ..Pin::default()
        }
    }

    fn usable(&self) -> bool {
        self.error.is_empty() && !self.head.is_empty() && self.changes != UNSURE
    }

    pub fn same_code(&self, other: &Pin) -> bool {
        self.usable() && other.usable() && self == other
    }

    pub fn short(&self) -> &str {
        &self.head[..self.head.len().min(7)]
    }

    // "commit ab12cd3" or "commit ab12cd3 with uncommitted changes".
    pub fn words(&self) -> String {
        let extra = if self.changes.is_empty() {
            ""
        } else {
            " with uncommitted changes"
        };
        format!("commit {}{extra}", self.short())
    }
}

// How the code now stands against the code a review read.
pub fn standing(read: &Pin, now: &Pin) -> &'static str {
    if !read.error.is_empty() || !now.error.is_empty() {
        "unknown"
    } else if read.head != now.head {
        "moved"
    } else if read.same_code(now) {
        "same"
    } else {
        "uncommitted"
    }
}

// `git diff` rewrites the index when a file was only touched, even with GIT_OPTIONAL_LOCKS=0, so
// this uses diff-index, which never does. hash-object without -w stores nothing.
fn script(path: &str) -> String {
    format!(
        "{}head=$(git rev-parse -q --verify HEAD 2>/dev/null); printf 'HEAD\\t%s\\n' \"$head\"; \
         [ -n \"$head\" ] || exit 0; \
         git diff-index --quiet HEAD -- >/dev/null 2>&1; rc=$?; \
         n=$(git ls-files -o --exclude-standard | wc -l | tr -d ' '); \
         if [ \"$rc\" -gt 1 ] || [ \"$n\" -gt {MAX_UNTRACKED} ]; then c={UNSURE}; else \
         c=$({{ git diff-index -p --binary --no-renames --no-color --no-ext-diff --no-textconv HEAD --; \
         git ls-files -o --exclude-standard | while IFS= read -r f; do printf 'U %s ' \"$f\"; \
         if [ -L \"$f\" ]; then readlink \"$f\"; else git hash-object --no-filters -- \"$f\" 2>/dev/null || echo unreadable; fi; \
         done; }} | git hash-object --stdin); \
         [ \"$c\" = \"$(git hash-object --stdin </dev/null)\" ] && c=; fi; \
         printf 'TOP\\t%s\\nCHANGES\\t%s\\n' \"$top\" \"$c\"",
        prelude(path)
    )
}

fn parse(out: &str) -> Pin {
    if let Some(e) = err_of(out) {
        return Pin::failed(e);
    }
    let head = field(out, "HEAD");
    if !valid_sha(head) {
        return Pin::failed("this folder has no commits yet");
    }
    Pin {
        head: head.to_string(),
        top: field(out, "TOP").to_string(),
        changes: field(out, "CHANGES").to_string(),
        error: String::new(),
    }
}

pub async fn read(folders: &Folders, m: &Machine, path: &str) -> Pin {
    match folders.exec(m, &script(path), TIMEOUT).await {
        Ok(out) => parse(&out),
        Err(e) => Pin::failed(e),
    }
}

fn pin_of(v: &Value) -> Option<Pin> {
    serde_json::from_value(v.clone()).ok()
}

fn is_review(of: &Value, machine: &str, pin: &Pin) -> bool {
    of["machine"] == machine
        && !of["scan"].is_string()
        && pin_of(&of["pin"]).is_some_and(|p| p.same_code(pin))
}

fn verdict_word(card: &Value) -> &'static str {
    if card["verdict"] == "ready" {
        "ready"
    } else {
        "changes needed"
    }
}

// What the person or Dispatch reads when a review of this code exists already.
fn already(pin: &Pin, doing: String, conversation: &str, at: &Value) -> Value {
    let what = pin.words();
    json!({
        "text": format!("{} {doing}.", capital(&what)),
        "conversation": conversation,
        "at": at,
    })
}

fn capital(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

// A review of this code in one conversation: one still running first, else the newest finished.
// A finished review counts only when the code stayed the same until it ended.
pub(in crate::dispatch) fn earlier_in(
    conversation: &str,
    events: &[Value],
    running: impl Iterator<Item = (String, Value)>,
    machine: &str,
    pin: &Pin,
) -> Option<Value> {
    for (name, of) in running {
        if is_review(&of, machine, pin) {
            let doing = format!("already has a review running in {name}");
            return Some(already(pin, doing, conversation, &Value::Null));
        }
    }
    let starting = events.iter().any(|e| {
        e["role"] == "action"
            && matches!(e["status"].as_str(), Some("approved" | "edited"))
            && e["result"].is_null()
            && is_review(&e["review"], machine, pin)
    });
    if starting {
        let doing = "already has a review starting".to_string();
        return Some(already(pin, doing, conversation, &Value::Null));
    }
    let finished = events.iter().rev().find(|e| {
        e["role"] == "review"
            && is_review(&e["of"], machine, pin)
            && (e["read_changed"].is_null() || e["read_changed"] == "same")
    })?;
    let doing = format!(
        "already has a finished review, which said {}, by {}",
        verdict_word(finished),
        finished["name"].as_str().unwrap_or("a reviewer")
    );
    Some(already(pin, doing, conversation, &finished["at"]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::process::Command;
    use std::sync::Arc;

    const HEAD: &str = "2222222222222222222222222222222222222222";

    fn pin(head: &str, changes: &str) -> Pin {
        Pin {
            head: head.into(),
            top: "/r/app".into(),
            changes: changes.into(),
            error: String::new(),
        }
    }

    #[test]
    fn a_clean_head_match_alone_is_not_the_same_code() {
        assert!(pin("a", "").same_code(&pin("a", "")));
        assert!(pin("a", "x").same_code(&pin("a", "x")));
        assert!(!pin("a", "").same_code(&pin("a", "x")), "new uncommitted");
        assert!(
            !pin("a", "x").same_code(&pin("a", "y")),
            "other uncommitted"
        );
        assert!(!pin("a", "").same_code(&pin("b", "")), "new commit");
        let mut other_folder = pin("a", "");
        other_folder.top = "/r/other".into();
        assert!(!pin("a", "").same_code(&other_folder));
    }

    #[test]
    fn a_pin_that_cannot_be_sure_never_matches() {
        assert!(!Pin::failed("gone").same_code(&Pin::failed("gone")));
        assert!(!pin("a", UNSURE).same_code(&pin("a", UNSURE)));
        assert!(!Pin::default().same_code(&Pin::default()));
    }

    #[test]
    fn standing_says_what_moved() {
        assert_eq!(standing(&pin("a", ""), &pin("a", "")), "same");
        assert_eq!(standing(&pin("a", ""), &pin("b", "")), "moved");
        assert_eq!(standing(&pin("a", ""), &pin("a", "x")), "uncommitted");
        assert_eq!(standing(&pin("a", ""), &Pin::failed("down")), "unknown");
        assert_eq!(
            standing(&pin("a", UNSURE), &pin("a", UNSURE)),
            "uncommitted"
        );
    }

    #[test]
    fn words_name_the_commit_and_the_changes() {
        assert_eq!(pin(HEAD, "").words(), "commit 2222222");
        assert_eq!(
            pin(HEAD, "x").words(),
            "commit 2222222 with uncommitted changes"
        );
    }

    #[test]
    fn output_is_read_into_a_pin() {
        let got = parse(&format!("HEAD\t{HEAD}\nTOP\t/r/app\nCHANGES\tabc\n"));
        assert_eq!((got.head.as_str(), got.changes.as_str()), (HEAD, "abc"));
        assert_eq!(got.top, "/r/app");
        assert_eq!(
            parse("ERR the folder /r/app is gone\n").error,
            "the folder /r/app is gone"
        );
        assert_eq!(parse("HEAD\t\n").error, "this folder has no commits yet");
        assert_eq!(parse("").error, "this folder has no commits yet");
    }

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

    #[tokio::test]
    async fn the_read_goes_through_the_runner_on_the_machine() {
        let runner = Arc::new(FakeRunner::default());
        runner.stub(
            "diff-index",
            Output::ok_with(&format!("HEAD\t{HEAD}\nTOP\t/r/app\nCHANGES\t\n")),
        );
        let ssh = crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep());
        let folders = Folders::new(runner.clone(), ssh);
        let got = read(&folders, &machine(), "/r/app").await;
        assert_eq!(got.head, HEAD);
        let ran = runner.calls().concat().join(" ");
        assert!(ran.contains("ssh"), "{ran}");
        assert!(ran.contains("hash-object"), "{ran}");
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let done = Command::new("git")
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(done.status.success(), "{args:?}: {done:?}");
    }

    fn read_real(dir: &std::path::Path) -> Pin {
        let out = Command::new("sh")
            .args(["-c", &script(dir.to_str().unwrap())])
            .output()
            .unwrap();
        parse(&String::from_utf8_lossy(&out.stdout))
    }

    // A real repository, because a fake cannot show that the script changes nothing there.
    #[test]
    fn the_script_sees_every_change_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "first"]);

        let clean = read_real(root);
        assert!(clean.error.is_empty(), "{clean:?}");
        assert_eq!(clean.changes, "", "a clean tree has no changes hash");
        assert!(clean.same_code(&read_real(root)), "stable");

        let index = root.join(".git/index");
        let before = std::fs::read(&index).unwrap();
        let objects = || walk(&root.join(".git/objects"));
        let stored = objects();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        assert!(clean.same_code(&read_real(root)), "only touched");
        assert_eq!(std::fs::read(&index).unwrap(), before, "index unchanged");

        std::fs::write(root.join("ignored"), "x").unwrap();
        assert!(clean.same_code(&read_real(root)), "ignored file");

        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        let edited = read_real(root);
        assert_eq!(edited.head, clean.head);
        assert!(!edited.changes.is_empty());
        assert!(!clean.same_code(&edited), "unstaged edit");

        std::fs::write(root.join("a.txt"), "three\n").unwrap();
        let again = read_real(root);
        assert!(!edited.same_code(&again), "a different edit");

        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        let untracked = read_real(root);
        assert!(!clean.same_code(&untracked), "new file");
        std::fs::write(root.join("new.txt"), "newer\n").unwrap();
        assert!(!untracked.same_code(&read_real(root)), "its contents count");
        assert_eq!(std::fs::read(&index).unwrap(), before, "index unchanged");
        assert_eq!(objects(), stored, "nothing was stored");

        std::fs::remove_file(root.join("new.txt")).unwrap();
        std::fs::write(root.join("a.txt"), "staged\n").unwrap();
        git(root, &["add", "a.txt"]);
        assert!(!clean.same_code(&read_real(root)), "staged edit");
        git(root, &["commit", "-qm", "second"]);
        let moved = read_real(root);
        assert_ne!(moved.head, clean.head);
        assert_eq!(moved.changes, "");
        assert_eq!(standing(&clean, &moved), "moved");
    }

    fn walk(dir: &std::path::Path) -> Vec<String> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            if entry.path().is_dir() {
                found.extend(walk(&entry.path()));
            } else {
                found.push(entry.path().display().to_string());
            }
        }
        found.sort();
        found
    }

    #[test]
    fn a_folder_without_git_or_commits_says_so() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_real(dir.path())
            .error
            .contains("not in a git repository"));
        git(dir.path(), &["init", "-q"]);
        assert_eq!(
            read_real(dir.path()).error,
            "this folder has no commits yet"
        );
    }

    fn of(p: &Pin) -> Value {
        json!({ "machine": "hp", "name": "hp-app", "path": "/r/app", "pin": p })
    }

    #[test]
    fn a_finished_review_of_the_same_code_is_found() {
        let p = pin(HEAD, "");
        let card = json!({ "role": "review", "name": "hp-app-2", "of": of(&p), "verdict": "ready", "at": "t" });
        let found = earlier_in(
            "c1",
            std::slice::from_ref(&card),
            std::iter::empty(),
            "hp",
            &p,
        )
        .unwrap();
        assert_eq!(
            found["text"],
            "Commit 2222222 already has a finished review, which said ready, by hp-app-2."
        );
        assert_eq!(found["conversation"], "c1");
        assert_eq!(
            earlier_in(
                "c1",
                std::slice::from_ref(&card),
                std::iter::empty(),
                "mini",
                &p
            ),
            None
        );
        let edited = pin(HEAD, "x");
        assert_eq!(
            earlier_in(
                "c1",
                std::slice::from_ref(&card),
                std::iter::empty(),
                "hp",
                &edited
            ),
            None
        );
        let mut moved_during = card;
        moved_during["read_changed"] = json!("moved");
        assert_eq!(
            earlier_in("c1", &[moved_during], std::iter::empty(), "hp", &p),
            None
        );
    }

    #[test]
    fn a_review_running_or_starting_is_found_and_old_or_scan_cards_are_not() {
        let p = pin(HEAD, "x");
        let running = vec![("hp-app-2".to_string(), of(&p))];
        let found = earlier_in("c1", &[], running.into_iter(), "hp", &p).unwrap();
        assert_eq!(
            found["text"],
            "Commit 2222222 with uncommitted changes already has a review running in hp-app-2."
        );
        let starting = json!({ "role": "action", "status": "approved", "review": of(&p) });
        assert!(earlier_in("c1", &[starting], std::iter::empty(), "hp", &p).is_some());
        let waiting = json!({ "role": "action", "status": "pending", "review": of(&p) });
        assert_eq!(
            earlier_in("c1", &[waiting], std::iter::empty(), "hp", &p),
            None
        );
        let old = json!({ "role": "review", "name": "x", "verdict": "ready", "of": { "machine": "hp", "name": "y" } });
        assert_eq!(earlier_in("c1", &[old], std::iter::empty(), "hp", &p), None);
        let mut scan_of = of(&p);
        scan_of["scan"] = json!("security");
        let scan = json!({ "role": "review", "name": "x", "verdict": "clean", "of": scan_of });
        assert_eq!(
            earlier_in("c1", &[scan], std::iter::empty(), "hp", &p),
            None
        );
    }
}

use crate::config::Machine;
use crate::dispatch::valid_review_path as valid_path;
use crate::dispatch::{parse_git_diff, DiffLine, GIT, GIT_DIFF, GIT_DIFF_BYTES};
use crate::files::{error_of, in_sh, prelude, FileError};
use crate::folders::Folders;
use crate::shell::{quote, Duration};
use serde::Serialize;
use std::collections::HashMap;

pub const MAX_FILES: usize = 500;
pub const MAX_UNTRACKED: usize = 100;
pub const PAGE_LINES: usize = 5000;
pub const MAX_CONTEXT: u32 = 100_000;
const LIST_BYTES: usize = 1_000_000;
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const DIFF_TIMEOUT: Duration = Duration::from_secs(20);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);
const STATUS: &str = "@@YB-STATUS@@\n";
const UNSTAGED: &str = "\n@@YB-UNSTAGED@@\n";
const STAGED: &str = "\n@@YB-STAGED@@\n";
const UNTRACKED: &str = "\n@@YB-UNTRACKED@@\n";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Change {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: &'static str,
    pub staged: bool,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Changes {
    pub branch: String,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub files: Vec<Change>,
    pub truncated: bool,
}

impl Changes {
    pub fn find(&self, path: &str, staged: bool) -> Option<&Change> {
        self.files
            .iter()
            .find(|f| f.path == path && f.staged == staged)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChangeDiff {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: &'static str,
    pub staged: bool,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
    pub notes: Vec<String>,
    pub lines: Vec<DiffLine>,
    pub from: usize,
    pub next: usize,
    pub total: usize,
    pub cut: bool,
}

fn repo(machine_root: &str, root: &str, known: bool) -> String {
    format!(
        "{}; cd \"$B\" || exit 0; export GIT_LITERAL_PATHSPECS=1; \
         git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {{ echo 'ERR notrepo'; exit 0; }}; ",
        prelude(machine_root, root, known)
    )
}

fn marker(text: &str) -> String {
    text.replace('\n', "\\n")
}

pub fn status_command(machine_root: &str, root: &str, known: bool) -> String {
    let numstat = format!("{GIT} {GIT_DIFF} --numstat -z --relative");
    in_sh(&format!(
        "{}export GIT_OPTIONAL_LOCKS=0; printf 'PREFIX\\t%s\\n' \"$(git rev-parse --show-prefix)\"; \
         printf '{}'; {GIT} status --porcelain=v2 -z --branch --untracked-files=all -- . | head -c {LIST_BYTES}; \
         printf '{}'; {numstat} -- . | head -c {LIST_BYTES}; \
         printf '{}'; {numstat} --cached -M -- . | head -c {LIST_BYTES}; \
         printf '{}'; {GIT} ls-files -o --exclude-standard | head -n {} | while IFS= read -r f; do \
         case \"$f\" in \\\"*) continue ;; esac; \
         printf 'U\\t%s\\t%s\\n' \"$(git diff --no-index --numstat -- /dev/null \"$f\" 2>/dev/null | cut -f1,2)\" \"$f\"; done; true",
        repo(machine_root, root, known),
        marker(STATUS),
        marker(UNSTAGED),
        marker(STAGED),
        marker(UNTRACKED),
        MAX_UNTRACKED + 1
    ))
}

fn word(letter: char) -> Option<&'static str> {
    match letter {
        'M' | 'T' | 'U' => Some("modified"),
        'A' | 'C' => Some("added"),
        'D' => Some("deleted"),
        'R' => Some("renamed"),
        _ => None,
    }
}

fn count(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}

type Counts = HashMap<String, (Option<u64>, Option<u64>, bool)>;

// `git diff --numstat -z`: "added\tremoved\tpath\0", or "added\tremoved\t\0old\0new\0" for a rename.
fn parse_numstat(data: &str) -> Counts {
    let mut out = HashMap::new();
    let mut tokens = data.trim_start_matches('\n').split('\0');
    while let Some(token) = tokens.next() {
        let mut parts = token.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            tokens.next();
            tokens.next().unwrap_or_default()
        } else {
            path
        };
        let binary = added == "-" && removed == "-";
        out.insert(path.to_string(), (count(added), count(removed), binary));
    }
    out
}

fn parse_untracked(text: &str) -> Counts {
    text.lines()
        .filter_map(|l| l.strip_prefix("U\t"))
        .filter_map(|rest| {
            let parts: Vec<&str> = rest.splitn(3, '\t').collect();
            match parts.as_slice() {
                [a, r, p] => Some((p.to_string(), (count(a), count(r), *a == "-"))),
                [_, p] => Some((p.to_string(), (None, None, false))),
                _ => None,
            }
        })
        .collect()
}

pub fn parse_status(out: &str) -> Result<Changes, FileError> {
    if let Some(e) = error_of(out) {
        return Err(e);
    }
    let (head, rest) = out
        .split_once(STATUS)
        .ok_or_else(|| FileError::Failed("git did not list the changes".into()))?;
    let prefix = head
        .lines()
        .find_map(|l| l.strip_prefix("PREFIX\t"))
        .unwrap_or_default()
        .trim_end_matches('\n');
    let (status, rest) = rest.split_once(UNSTAGED).unwrap_or((rest, ""));
    let (unstaged, rest) = rest.split_once(STAGED).unwrap_or((rest, ""));
    let (staged, untracked) = rest.split_once(UNTRACKED).unwrap_or((rest, ""));
    let mut truncated = !status.is_empty() && !status.ends_with('\0');
    let mut changes = Changes {
        branch: String::new(),
        head: None,
        upstream: None,
        ahead: None,
        behind: None,
        files: Vec::new(),
        truncated: false,
    };
    let local = |p: &str| {
        p.strip_prefix(prefix)
            .filter(|p| valid_path(p))
            .map(str::to_string)
    };
    let mut tokens = status.split('\0');
    while let Some(token) = tokens.next() {
        if let Some(header) = token.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => changes.head = Some(value.to_string()),
                "branch.head" => changes.branch = value.to_string(),
                "branch.upstream" => changes.upstream = Some(value.to_string()),
                "branch.ab" => {
                    let mut ab = value.split(' ');
                    changes.ahead = ab
                        .next()
                        .and_then(|a| a.trim_start_matches('+').parse().ok());
                    changes.behind = ab
                        .next()
                        .and_then(|b| b.trim_start_matches('-').parse().ok());
                }
                _ => {}
            }
            continue;
        }
        let (kind, fields) = token.split_once(' ').unwrap_or((token, ""));
        let (xy, path, old) = match kind {
            "1" => (fields, fields.splitn(8, ' ').nth(7), None),
            "2" => (fields, fields.splitn(9, ' ').nth(8), tokens.next()),
            "u" => ("UU", fields.splitn(10, ' ').nth(9), None),
            "?" => ("?", Some(fields), None),
            _ => continue,
        };
        let Some(path) = path.and_then(local) else {
            continue;
        };
        if xy == "?" {
            changes.files.push(Change {
                path,
                old_path: None,
                status: "untracked",
                staged: false,
                added: None,
                removed: None,
                binary: false,
            });
            continue;
        }
        let mut letters = xy.chars();
        let (x, y) = (letters.next().unwrap_or('.'), letters.next().unwrap_or('.'));
        let sides = if kind == "u" {
            vec![(y, false)]
        } else {
            vec![(x, true), (y, false)]
        };
        for (letter, staged) in sides {
            let Some(status) = word(letter) else { continue };
            let old_path = (letter == 'R').then(|| old.and_then(local)).flatten();
            changes.files.push(Change {
                path: path.clone(),
                old_path,
                status,
                staged,
                added: None,
                removed: None,
                binary: false,
            });
        }
    }
    let (unstaged, staged, untracked) = (
        parse_numstat(unstaged),
        parse_numstat(staged),
        parse_untracked(untracked),
    );
    for f in &mut changes.files {
        let counts = match (f.status, f.staged) {
            ("untracked", _) => &untracked,
            (_, true) => &staged,
            _ => &unstaged,
        };
        if let Some((added, removed, binary)) = counts.get(&f.path) {
            (f.added, f.removed, f.binary) = (*added, *removed, *binary);
        }
    }
    if changes.files.len() > MAX_FILES {
        changes.files.truncate(MAX_FILES);
        truncated = true;
    }
    changes.truncated = truncated;
    Ok(changes)
}

pub fn diff_command(
    machine_root: &str,
    root: &str,
    known: bool,
    change: &Change,
    context: u32,
) -> String {
    let context = context.min(MAX_CONTEXT);
    let what = if change.status == "untracked" {
        format!(
            "{GIT} {GIT_DIFF} --no-index -U{context} -- /dev/null {}",
            quote(&change.path)
        )
    } else {
        let mut paths = quote(&change.path);
        if let Some(old) = change.old_path.as_deref().filter(|_| change.staged) {
            paths = format!("{} {paths}", quote(old));
        }
        let cached = if change.staged { " --cached -M" } else { "" };
        format!("{GIT} {GIT_DIFF}{cached} -U{context} -- {paths}")
    };
    in_sh(&format!(
        "{}export GIT_OPTIONAL_LOCKS=0; {what} | head -c {}; true",
        repo(machine_root, root, known),
        GIT_DIFF_BYTES + 1
    ))
}

pub fn commit_command(
    machine_root: &str,
    root: &str,
    known: bool,
    paths: &[String],
    untracked: &[String],
) -> String {
    let spec = if paths.is_empty() {
        ".".to_string()
    } else {
        paths.iter().map(|p| quote(p)).collect::<Vec<_>>().join(" ")
    };
    let add = if paths.is_empty() {
        "git add -A -- .".to_string()
    } else if untracked.is_empty() {
        "true".to_string()
    } else {
        format!(
            "git add -- {}",
            untracked
                .iter()
                .map(|p| quote(p))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    in_sh(&format!(
        "{}one() {{ printf '%s' \"$1\" | tr '\\n' ' ' | cut -c1-400; }}; \
         o=$({add} 2>&1) || {{ printf 'ERR could not stage the changes: %s\\n' \"$(one \"$o\")\"; exit 0; }}; \
         o=$(git commit -q --cleanup=verbatim -F - -- {spec} 2>&1) || {{ printf 'ERR %s\\n' \"$(one \"$o\")\"; exit 0; }}; \
         printf 'SHA\\t%s\\n' \"$(git rev-parse HEAD)\"",
        repo(machine_root, root, known)
    ))
}

pub fn parse_commit(out: &str) -> Result<String, FileError> {
    if let Some(e) = error_of(out) {
        return Err(e);
    }
    out.lines()
        .find_map(|l| l.strip_prefix("SHA\t"))
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() >= 7 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| FileError::Failed("git did not say which commit it made".into()))
}

fn named(paths: &[&str]) -> String {
    let names: Vec<&str> = paths
        .iter()
        .map(|p| p.rsplit('/').next().unwrap_or(p))
        .collect();
    match names.as_slice() {
        [] => String::new(),
        [one] => one.to_string(),
        [a, b] => format!("{a} and {b}"),
        [a, b, c] => format!("{a}, {b} and {c}"),
        [a, b, rest @ ..] => format!("{a}, {b} and {} more files", rest.len()),
    }
}

// A first line from the files alone: what was added, removed or changed, by name.
pub fn draft(files: &[Change]) -> String {
    let mut seen: Vec<(&str, &str)> = Vec::new();
    for f in files {
        if !seen.iter().any(|(p, _)| *p == f.path) {
            seen.push((f.path.as_str(), f.status));
        }
    }
    let of = |want: &[&str]| -> Vec<&str> {
        seen.iter()
            .filter(|(_, s)| want.contains(s))
            .map(|(p, _)| *p)
            .collect()
    };
    let added = of(&["added", "untracked"]);
    let removed = of(&["deleted"]);
    let changed = of(&["modified", "renamed"]);
    let mut parts = Vec::new();
    if !changed.is_empty() {
        parts.push(format!("Update {}", named(&changed)));
    }
    if !added.is_empty() {
        parts.push(format!(
            "{} {}",
            if parts.is_empty() { "Add" } else { "add" },
            named(&added)
        ));
    }
    if !removed.is_empty() {
        parts.push(format!(
            "{} {}",
            if parts.is_empty() { "Remove" } else { "remove" },
            named(&removed)
        ));
    }
    parts.join(", ")
}

impl Folders {
    pub async fn changes(
        &self,
        m: &Machine,
        root: &str,
        known: bool,
    ) -> Result<Changes, FileError> {
        let out = self
            .exec(m, &status_command(&m.root, root, known), LIST_TIMEOUT)
            .await
            .map_err(FileError::Failed)?;
        parse_status(&out)
    }

    pub async fn change_diff(
        &self,
        m: &Machine,
        root: &str,
        known: bool,
        change: &Change,
        context: u32,
        from: usize,
    ) -> Result<ChangeDiff, FileError> {
        let script = diff_command(&m.root, root, known, change, context);
        let out = self
            .exec(m, &script, DIFF_TIMEOUT)
            .await
            .map_err(FileError::Failed)?;
        if let Some(e) = error_of(&out) {
            return Err(e);
        }
        let (lines, binary, notes, cut) = parse_git_diff(&out);
        let from = from.min(lines.len());
        let next = (from + PAGE_LINES).min(lines.len());
        Ok(ChangeDiff {
            path: change.path.clone(),
            old_path: change.old_path.clone(),
            status: change.status,
            staged: change.staged,
            added: change.added,
            removed: change.removed,
            binary: binary || change.binary,
            notes,
            total: lines.len(),
            lines: lines[from..next].to_vec(),
            from,
            next,
            cut,
        })
    }

    pub async fn commit(
        &self,
        m: &Machine,
        root: &str,
        known: bool,
        paths: &[String],
        untracked: &[String],
        message: &str,
    ) -> Result<String, FileError> {
        let script = commit_command(&m.root, root, known, paths, untracked);
        let mut message = message.to_string();
        if !message.ends_with('\n') {
            message.push('\n');
        }
        let out = self
            .exec_input(m, &script, message, COMMIT_TIMEOUT)
            .await
            .map_err(FileError::Failed)?;
        parse_commit(&out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::RealRunner;
    use std::path::Path;
    use std::process::Command;
    use std::sync::Arc;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(dir: &Path, path: &str, text: &[u8]) {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    struct Repo {
        _home: tempfile::TempDir,
        path: std::path::PathBuf,
        root: String,
        folders: Folders,
        m: Machine,
    }

    impl Repo {
        fn root(&self) -> &str {
            &self.root
        }
    }

    // A machine root holding one repository with a staged edit, an edit left unstaged, a file
    // edited on both sides, a staged rename, a deletion, a new binary file and untracked text.
    fn repo() -> Repo {
        let home = tempfile::tempdir().unwrap();
        let machine_root = home.path().join("code");
        let path = machine_root.join("app");
        std::fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-q", "-b", "main"]);
        git(&path, &["config", "user.name", "t"]);
        git(&path, &["config", "user.email", "t@example.invalid"]);
        write(&path, "src/staged.rs", b"fn a() {}\n");
        write(&path, "src/edited.js", b"one\ntwo\nthree\n");
        write(&path, "both.txt", b"1\n2\n");
        write(&path, "old name.txt", b"same text\nfor the rename\n");
        write(&path, "gone.txt", b"bye\n");
        write(&path, ".gitignore", b"*.log\n");
        git(&path, &["add", "-A"]);
        git(&path, &["commit", "-q", "-m", "init"]);
        write(&path, "src/staged.rs", b"fn a() {}\nfn b() {}\n");
        git(&path, &["add", "src/staged.rs"]);
        write(&path, "src/edited.js", b"one\nTWO\nthree\nfour\n");
        write(&path, "both.txt", b"1\n2\n3\n");
        git(&path, &["add", "both.txt"]);
        write(&path, "both.txt", b"1\n2\n3\n4\n");
        git(&path, &["mv", "old name.txt", "new name.txt"]);
        std::fs::remove_file(path.join("gone.txt")).unwrap();
        write(&path, "notes/todo.md", b"- one\n- two\n");
        write(&path, "logo.png", b"\x89PNG\r\n\x1a\n\0\0\0\x01");
        write(&path, "debug.log", b"ignored\n");
        let m = Machine {
            name: "mini".into(),
            ssh: None,
            mesh_ip: None,
            port_prefix: None,
            root: machine_root.to_string_lossy().into_owned(),
            local: true,
            workspaces: None,
            mesh: None,
            recent: Vec::new(),
        };
        let folders = Folders::new(
            Arc::new(RealRunner::default()),
            crate::ssh::Ssh::new(home.path().join("state")),
        );
        let root = path.to_string_lossy().into_owned();
        Repo {
            _home: home,
            path,
            root,
            folders,
            m,
        }
    }

    type Brief<'a> = (&'a str, &'a str, bool, Option<u64>, Option<u64>, bool);

    fn brief(c: &Changes) -> Vec<Brief<'_>> {
        c.files
            .iter()
            .map(|f| {
                (
                    f.path.as_str(),
                    f.status,
                    f.staged,
                    f.added,
                    f.removed,
                    f.binary,
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn every_kind_of_change_is_listed_with_its_side_and_counts() {
        let r = repo();
        let c = r.folders.changes(&r.m, r.root(), false).await.unwrap();
        assert_eq!(c.branch, "main");
        assert!(c.head.as_deref().is_some_and(|h| h.len() == 40));
        assert_eq!(
            (c.upstream.as_deref(), c.ahead, c.behind),
            (None, None, None)
        );
        let mut got = brief(&c);
        got.sort();
        assert_eq!(
            got,
            vec![
                ("both.txt", "modified", false, Some(1), Some(0), false),
                ("both.txt", "modified", true, Some(1), Some(0), false),
                ("gone.txt", "deleted", false, Some(0), Some(1), false),
                ("logo.png", "untracked", false, None, None, true),
                ("new name.txt", "renamed", true, Some(0), Some(0), false),
                ("notes/todo.md", "untracked", false, Some(2), Some(0), false),
                ("src/edited.js", "modified", false, Some(2), Some(1), false),
                ("src/staged.rs", "modified", true, Some(1), Some(0), false),
            ]
        );
        let renamed = c.find("new name.txt", true).unwrap();
        assert_eq!(renamed.old_path.as_deref(), Some("old name.txt"));
        assert!(!c.truncated);
    }

    #[tokio::test]
    async fn a_subfolder_lists_only_its_own_changes_relative_to_itself() {
        let r = repo();
        let sub = format!("{}/src", r.root);
        let c = r.folders.changes(&r.m, &sub, false).await.unwrap();
        let mut paths: Vec<_> = c
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.staged))
            .collect();
        paths.sort();
        assert_eq!(paths, vec![("edited.js", false), ("staged.rs", true)]);
        assert_eq!(c.find("edited.js", false).unwrap().added, Some(2));
    }

    #[tokio::test]
    async fn ahead_and_behind_come_from_the_upstream() {
        let r = repo();
        let remote = r._home.path().join("remote.git");
        git(
            r._home.path(),
            &["init", "-q", "--bare", remote.to_str().unwrap()],
        );
        git(
            &r.path,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&r.path, &["push", "-q", "-u", "origin", "main"]);
        git(&r.path, &["commit", "-q", "-m", "staged work"]);
        let c = r.folders.changes(&r.m, r.root(), false).await.unwrap();
        assert_eq!(c.upstream.as_deref(), Some("origin/main"));
        assert_eq!((c.ahead, c.behind), (Some(1), Some(0)));
    }

    async fn diff_of(r: &Repo, path: &str, staged: bool) -> ChangeDiff {
        let c = r.folders.changes(&r.m, r.root(), false).await.unwrap();
        let change = c.find(path, staged).unwrap().clone();
        r.folders
            .change_diff(&r.m, r.root(), false, &change, 3, 0)
            .await
            .unwrap()
    }

    fn kinds(d: &ChangeDiff) -> Vec<(&str, Option<u64>, Option<u64>, &str)> {
        d.lines
            .iter()
            .map(|l| (l.k, l.o, l.n, l.t.as_str()))
            .collect()
    }

    #[tokio::test]
    async fn each_kind_of_change_has_its_diff() {
        let r = repo();
        let unstaged = diff_of(&r, "src/edited.js", false).await;
        assert_eq!(
            kinds(&unstaged),
            vec![
                ("hunk", None, None, "@@ -1,3 +1,4 @@"),
                ("ctx", Some(1), Some(1), "one"),
                ("del", Some(2), None, "two"),
                ("add", None, Some(2), "TWO"),
                ("ctx", Some(3), Some(3), "three"),
                ("add", None, Some(4), "four"),
            ]
        );
        let staged = diff_of(&r, "both.txt", true).await;
        assert_eq!(
            staged.lines.last().unwrap().t,
            "3",
            "against HEAD, the index side"
        );
        let worktree = diff_of(&r, "both.txt", false).await;
        assert_eq!(worktree.lines.last().unwrap().t, "4", "against the index");
        let untracked = diff_of(&r, "notes/todo.md", false).await;
        assert_eq!(
            kinds(&untracked)[1..],
            [
                ("add", None, Some(1), "- one"),
                ("add", None, Some(2), "- two")
            ]
        );
        let deleted = diff_of(&r, "gone.txt", false).await;
        assert_eq!(kinds(&deleted)[1], ("del", Some(1), None, "bye"));
        let renamed = diff_of(&r, "new name.txt", true).await;
        assert!(renamed.lines.is_empty());
        assert_eq!(renamed.notes, ["Renamed, 100% the same"]);
        let binary = diff_of(&r, "logo.png", false).await;
        assert!(binary.binary && binary.lines.is_empty());
        assert_eq!((binary.total, binary.next), (0, 0));
    }

    #[tokio::test]
    async fn whole_file_context_shows_every_line() {
        let r = repo();
        let body: String = (1..=40).map(|i| format!("line {i}\n")).collect();
        write(&r.path, "long.txt", body.as_bytes());
        git(&r.path, &["add", "long.txt"]);
        git(&r.path, &["commit", "-q", "-m", "long", "--", "long.txt"]);
        write(
            &r.path,
            "long.txt",
            body.replace("line 20\n", "line twenty\n").as_bytes(),
        );
        let c = r.folders.changes(&r.m, r.root(), false).await.unwrap();
        let change = c.find("long.txt", false).unwrap().clone();
        let near = r
            .folders
            .change_diff(&r.m, r.root(), false, &change, 3, 0)
            .await
            .unwrap();
        assert_eq!(near.total, 1 + 3 + 2 + 3);
        let all = r
            .folders
            .change_diff(&r.m, r.root(), false, &change, MAX_CONTEXT, 0)
            .await
            .unwrap();
        assert_eq!(all.total, 1 + 40 + 1);
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_repository_or_lies_outside_is_refused() {
        let r = repo();
        let plain = r._home.path().join("code/plain");
        std::fs::create_dir_all(&plain).unwrap();
        let err = r
            .folders
            .changes(&r.m, plain.to_str().unwrap(), false)
            .await
            .unwrap_err();
        assert_eq!(err, FileError::NotRepo);
        let outside = r._home.path().to_string_lossy().into_owned();
        let err = r.folders.changes(&r.m, &outside, false).await.unwrap_err();
        assert_eq!(err, FileError::Outside);
    }

    #[tokio::test]
    async fn a_commit_of_some_paths_leaves_the_rest() {
        let r = repo();
        let message =
            "Fix \"quotes\" and 'apostrophes'\n\nA body with $(id) and `ticks`;\n  indented line\n";
        let sha = r
            .folders
            .commit(
                &r.m,
                r.root(),
                false,
                &["src/edited.js".into(), "notes/todo.md".into()],
                &["notes/todo.md".into()],
                message,
            )
            .await
            .unwrap();
        assert_eq!(git(&r.path, &["rev-parse", "HEAD"]).trim(), sha);
        assert_eq!(
            git(&r.path, &["log", "-1", "--format=%B"]),
            format!("{message}\n")
        );
        let shown = git(&r.path, &["show", "--name-only", "--format=", "HEAD"]);
        assert_eq!(shown, "notes/todo.md\nsrc/edited.js\n");
        let c = r.folders.changes(&r.m, r.root(), false).await.unwrap();
        assert!(c.find("src/edited.js", false).is_none());
        assert!(
            c.find("src/staged.rs", true).is_some(),
            "staged work outside the paths stays staged"
        );
    }

    #[tokio::test]
    async fn a_commit_of_everything_takes_renames_deletions_and_new_files() {
        let r = repo();
        r.folders
            .commit(&r.m, r.root(), false, &[], &[], "Everything")
            .await
            .unwrap();
        assert_eq!(
            git(&r.path, &["log", "-1", "--format=%B"]),
            "Everything\n\n"
        );
        let c = r.folders.changes(&r.m, r.root(), false).await.unwrap();
        assert!(c.files.is_empty(), "{:?}", c.files);
        let shown = git(
            &r.path,
            &["show", "--name-status", "--format=", "-M", "HEAD"],
        );
        assert!(
            shown.contains("R100\told name.txt\tnew name.txt"),
            "{shown}"
        );
        assert!(
            shown.contains("D\tgone.txt") && shown.contains("A\tlogo.png"),
            "{shown}"
        );
        assert!(!shown.contains("debug.log"), "ignored files stay out");
    }

    #[tokio::test]
    async fn a_failed_commit_says_why() {
        let r = repo();
        let err = r
            .folders
            .commit(&r.m, r.root(), false, &["missing.txt".into()], &[], "x")
            .await
            .unwrap_err();
        let FileError::Failed(why) = err else {
            panic!("{err:?}")
        };
        assert!(why.contains("missing.txt"), "{why}");
    }

    #[test]
    fn a_status_is_parsed_from_porcelain_v2() {
        let out = format!(
            "PREFIX\tsub/\n{STATUS}# branch.oid {sha}\0# branch.head topic\0# branch.upstream origin/topic\0# branch.ab +2 -3\0\
             1 .M N... 100644 100644 100644 {sha} {sha} sub/a b.txt\0\
             2 R. N... 100644 100644 100644 {sha} {sha} R100 sub/new.txt\0sub/old.txt\0\
             1 M. N... 100644 100644 100644 {sha} {sha} other/x.txt\0\
             u UU N... 100644 100644 100644 100644 {sha} {sha} {sha} sub/c.txt\0\
             ? sub/u.txt\0? sub/../x\0{UNSTAGED}1\t2\ta b.txt\0{STAGED}0\t0\t\0old.txt\0new.txt\0{UNTRACKED}U\t3\t0\tu.txt\n",
            sha = "a".repeat(40)
        );
        let c = parse_status(&out).unwrap();
        assert_eq!(
            (c.branch.as_str(), c.upstream.as_deref()),
            ("topic", Some("origin/topic"))
        );
        assert_eq!((c.ahead, c.behind), (Some(2), Some(3)));
        assert_eq!(
            brief(&c),
            vec![
                ("a b.txt", "modified", false, Some(1), Some(2), false),
                ("new.txt", "renamed", true, Some(0), Some(0), false),
                ("c.txt", "modified", false, None, None, false),
                ("u.txt", "untracked", false, Some(3), Some(0), false),
            ]
        );
        assert_eq!(c.files[1].old_path.as_deref(), Some("old.txt"));
        assert!(!c.truncated);
        let cut = out.replace("? sub/u.txt\0? sub/../x\0", "? sub/u.t");
        assert!(parse_status(&cut).unwrap().truncated);
        assert_eq!(
            parse_status("ERR notrepo\n").unwrap_err(),
            FileError::NotRepo
        );
        let unborn = format!("PREFIX\t\n{STATUS}# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(parse_status(&unborn).unwrap().head, None);
    }

    #[test]
    fn a_draft_names_the_files() {
        let f = |path: &str, status: &'static str, staged: bool| Change {
            path: path.into(),
            old_path: None,
            status,
            staged,
            added: None,
            removed: None,
            binary: false,
        };
        assert_eq!(
            draft(&[
                f("src/a.rs", "modified", true),
                f("src/a.rs", "modified", false),
                f("b.js", "modified", false)
            ]),
            "Update a.rs and b.js"
        );
        assert_eq!(
            draft(&[
                f("a.rs", "modified", false),
                f("n/new.md", "untracked", false),
                f("old.txt", "deleted", true)
            ]),
            "Update a.rs, add new.md, remove old.txt"
        );
        assert_eq!(
            draft(&[
                f("1", "added", true),
                f("2", "added", true),
                f("3", "added", true),
                f("4", "added", true)
            ]),
            "Add 1, 2 and 2 more files"
        );
        assert_eq!(draft(&[]), "");
    }
}

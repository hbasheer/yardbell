use crate::config::Machine;
use crate::folders::Folders;
use crate::shell::{quote, Duration};
use serde::{Deserialize, Serialize};

pub const MAX_FILES: usize = 500;
pub const MAX_UNTRACKED: usize = 100;
pub const PAGE_LINES: usize = 400;
const LIST_BYTES: usize = 1_000_000;
const DIFF_BYTES: usize = 2_000_000;
const LINE_CHARS: usize = 2000;
const AROUND: usize = 40;
const TIMEOUT: Duration = Duration::from_secs(20);
const TRACKED: &str = "@@YB-TRACKED@@\n";
const UNTRACKED: &str = "\n@@YB-UNTRACKED@@\n";
const GIT: &str = "git -c core.quotepath=off";
const DIFF: &str = "diff --no-color --no-ext-diff --no-textconv";

// Where the diff of a review starts: the base the reviewer named or Yardbell found, the commit
// the branch shares with it, and the branch's commit when the review finished.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Anchor {
    pub base: String,
    pub merge_base: String,
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileStat {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Listing {
    pub base: String,
    pub merge_base: String,
    pub head: String,
    pub files: Vec<FileStat>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Line {
    pub k: &'static str,
    pub o: Option<u64>,
    pub n: Option<u64>,
    pub t: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileDiff {
    pub path: String,
    pub binary: bool,
    pub notes: Vec<String>,
    pub lines: Vec<Line>,
    pub from: usize,
    pub next: usize,
    pub total: usize,
    pub cut: bool,
}

pub fn valid_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.chars().all(|c| c.is_ascii_hexdigit())
}

// A branch name or a commit the reviewer reports as its base, before it goes into a git command.
pub fn valid_base(text: &str) -> bool {
    let ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '~' | '^');
    !text.is_empty()
        && text.len() <= 200
        && text.chars().all(ok)
        && !text.starts_with(['-', '/', '.'])
        && !text.contains("..")
}

pub fn valid_path(file: &str) -> bool {
    !file.is_empty()
        && file.len() <= 4096
        && !file.starts_with('/')
        && !file.chars().any(char::is_control)
        && !file
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

pub(super) fn prelude(path: &str) -> String {
    format!(
        "cd {0} 2>/dev/null || {{ echo 'ERR the folder {1} is gone'; exit 0; }}; \
         top=$(git rev-parse --show-toplevel 2>/dev/null) || {{ echo 'ERR {1} is not in a git repository'; exit 0; }}; \
         cd \"$top\" || exit 3; export GIT_OPTIONAL_LOCKS=0; ",
        quote(path),
        path.replace('\'', "")
    )
}

// The same base the review prompt describes: the branch it was made from, usually main, or
// origin/main when this is main. A base the reviewer named wins when git knows it.
pub(super) fn anchor_script(want: &str) -> String {
    let want = if valid_base(want) { want } else { "" };
    format!(
        "head=$(git rev-parse -q --verify HEAD 2>/dev/null); want={}; \
         cur=$(git branch --show-current 2>/dev/null); \
         def=$(git symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null); def=${{def:-origin/main}}; \
         base=; \
         if [ -n \"$want\" ] && git rev-parse -q --verify \"$want^{{commit}}\" >/dev/null 2>&1; then base=$want; \
         else if [ \"$cur\" = \"${{def#origin/}}\" ]; then set -- \"$def\"; \
         else set -- \"${{def#origin/}}\" \"$def\" main origin/main master origin/master; fi; \
         for c in \"$@\"; do if git rev-parse -q --verify \"$c^{{commit}}\" >/dev/null 2>&1; then base=$c; break; fi; done; fi; \
         mb=; [ -n \"$base\" ] && mb=$(git merge-base HEAD \"$base\" 2>/dev/null); mb=${{mb:-$head}}; \
         printf 'HEAD\\t%s\\nBASE\\t%s\\nMB\\t%s\\n' \"$head\" \"$base\" \"$mb\"; ",
        quote(want)
    )
}

fn fixed_anchor(anchor: &Anchor) -> String {
    format!(
        "head=$(git rev-parse -q --verify HEAD 2>/dev/null); mb={}; \
         git cat-file -e \"$mb^{{commit}}\" 2>/dev/null || {{ echo 'ERR the commit this review started from is gone'; exit 0; }}; \
         printf 'HEAD\\t%s\\nBASE\\t%s\\nMB\\t%s\\n' \"$head\" {} \"$mb\"; ",
        quote(&anchor.merge_base),
        quote(&anchor.base)
    )
}

pub(super) fn gather_prelude(path: &str, want: &str) -> String {
    format!("{}{}", prelude(path), anchor_script(want))
}

pub(super) fn err_of(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.strip_prefix("ERR "))
        .map(str::to_string)
}

pub(super) fn field<'a>(out: &'a str, key: &str) -> &'a str {
    out.lines()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix('\t'))
        .unwrap_or_default()
        .trim()
}

pub(super) fn parse_anchor(out: &str) -> Result<Anchor, String> {
    if let Some(e) = err_of(out) {
        return Err(e);
    }
    let anchor = Anchor {
        base: field(out, "BASE").to_string(),
        merge_base: field(out, "MB").to_string(),
        head: field(out, "HEAD").to_string(),
    };
    if !valid_sha(&anchor.head) || !valid_sha(&anchor.merge_base) {
        return Err("this folder has no commits yet".into());
    }
    Ok(anchor)
}

fn count(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}

// `git diff --raw --numstat -z`: every raw entry, then every numstat entry, in the same order.
fn parse_tracked(data: &str) -> (Vec<FileStat>, bool) {
    let data = data.strip_suffix('\n').unwrap_or(data);
    let cut = !data.is_empty() && !data.ends_with('\0');
    let mut tokens: Vec<&str> = data.split('\0').collect();
    if tokens.last() == Some(&"") || cut {
        tokens.pop();
    }
    let mut files = Vec::new();
    let mut i = 0;
    while i < tokens.len() && tokens[i].starts_with(':') {
        let status = tokens[i].rsplit(' ').next().unwrap_or_default();
        let letter: String = status.chars().take(1).collect();
        let pair = matches!(letter.as_str(), "R" | "C");
        let (old, path) = if pair {
            (tokens.get(i + 1).copied(), tokens.get(i + 2).copied())
        } else {
            (None, tokens.get(i + 1).copied())
        };
        let Some(path) = path else { break };
        files.push(FileStat {
            path: path.to_string(),
            old_path: old.map(str::to_string),
            status: letter,
            added: None,
            removed: None,
            binary: false,
            untracked: false,
        });
        i += if pair { 3 } else { 2 };
    }
    let mut n = 0;
    while i < tokens.len() {
        let mut parts = tokens[i].splitn(3, '\t');
        let (added, removed, path) = (
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
        );
        let path = if path.is_empty() {
            i += 2;
            tokens.get(i).copied().unwrap_or_default()
        } else {
            path
        };
        i += 1;
        let Some(file) = files.get_mut(n).filter(|f| f.path == path) else {
            n += 1;
            continue;
        };
        file.binary = added == "-" && removed == "-";
        file.added = count(added);
        file.removed = count(removed);
        n += 1;
    }
    (files, cut)
}

fn parse_untracked(text: &str) -> Vec<FileStat> {
    text.lines()
        .filter_map(|l| l.strip_prefix("U\t"))
        .filter_map(|rest| {
            let parts: Vec<&str> = rest.splitn(3, '\t').collect();
            let (added, removed, path) = match parts.as_slice() {
                [a, r, p] => (*a, *r, *p),
                [_, p] => ("", "", *p),
                _ => return None,
            };
            Some(FileStat {
                path: path.to_string(),
                old_path: None,
                status: "A".into(),
                added: count(added),
                removed: count(removed),
                binary: added == "-",
                untracked: true,
            })
        })
        .collect()
}

pub fn parse_listing(out: &str) -> Result<Listing, String> {
    let anchor = parse_anchor(out)?;
    let (_, rest) = out
        .split_once(TRACKED)
        .ok_or("git did not list the changes")?;
    let (tracked, untracked) = rest.split_once(UNTRACKED).unwrap_or((rest, ""));
    let (mut files, cut) = parse_tracked(tracked);
    let mut extra = parse_untracked(untracked);
    let mut truncated = cut || extra.len() > MAX_UNTRACKED;
    extra.truncate(MAX_UNTRACKED);
    files.retain(|f| valid_path(&f.path));
    extra.retain(|f| valid_path(&f.path) && !files.iter().any(|t| t.path == f.path));
    files.extend(extra);
    if files.len() > MAX_FILES {
        files.truncate(MAX_FILES);
        truncated = true;
    }
    Ok(Listing {
        base: anchor.base,
        merge_base: anchor.merge_base,
        head: anchor.head,
        files,
        truncated,
    })
}

fn listing_script(path: &str, anchor: Option<&Anchor>, want: &str) -> String {
    let start = match anchor.filter(|a| valid_sha(&a.merge_base)) {
        Some(a) => fixed_anchor(a),
        None => anchor_script(want),
    };
    format!(
        "{}{start}\
         [ -n \"$mb\" ] || {{ echo 'ERR this folder has no commits yet'; exit 0; }}; \
         printf '{}'; {GIT} {DIFF} -M --raw --numstat -z \"$mb\" -- | head -c {LIST_BYTES}; \
         printf '{}'; {GIT} ls-files -o --exclude-standard | head -n {} | while IFS= read -r f; do \
         case \"$f\" in \\\"*) continue ;; esac; \
         printf 'U\\t%s\\t%s\\n' \"$(git diff --no-index --numstat -- /dev/null \"$f\" 2>/dev/null | cut -f1,2)\" \"$f\"; done",
        prelude(path),
        TRACKED.replace('\n', "\\n"),
        UNTRACKED.replace('\n', "\\n"),
        MAX_UNTRACKED + 1
    )
}

pub async fn changed_files(
    folders: &Folders,
    m: &Machine,
    path: &str,
    anchor: Option<&Anchor>,
    want: &str,
) -> Result<Listing, String> {
    let out = folders
        .exec(m, &listing_script(path, anchor, want), TIMEOUT)
        .await?;
    parse_listing(&out)
}

fn clip(text: &str) -> String {
    if text.chars().count() <= LINE_CHARS {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(LINE_CHARS).collect();
    cut.push('…');
    cut
}

fn hunk_start(header: &str, mark: char) -> u64 {
    header
        .split_whitespace()
        .find_map(|w| w.strip_prefix(mark))
        .and_then(|w| w.split(',').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(1)
}

pub fn parse_diff(out: &str) -> (Vec<Line>, bool, Vec<String>, bool) {
    let cut = out.len() > DIFF_BYTES;
    let mut text = &out[..out.floor_char_boundary(DIFF_BYTES.min(out.len()))];
    if cut {
        text = text.rsplit_once('\n').map(|(head, _)| head).unwrap_or("");
    }
    let mut lines = Vec::new();
    let mut notes = Vec::new();
    let mut binary = false;
    let (mut old, mut new) = (0u64, 0u64);
    let mut in_hunk = false;
    for raw in text.lines() {
        if raw.starts_with("diff --git ") {
            in_hunk = false;
            continue;
        }
        if raw.starts_with("@@") {
            in_hunk = true;
            old = hunk_start(raw, '-');
            new = hunk_start(raw, '+');
            lines.push(Line {
                k: "hunk",
                o: None,
                n: None,
                t: clip(raw),
            });
            continue;
        }
        if !in_hunk {
            if raw.starts_with("Binary files ") || raw == "GIT binary patch" {
                binary = true;
            } else if let Some(p) = raw.strip_prefix("similarity index ") {
                notes.push(format!("Renamed, {p} the same"));
            } else if let Some(mode) = raw.strip_prefix("new mode ") {
                notes.push(format!("Mode changed to {mode}"));
            } else if raw.starts_with("new file mode 120000") {
                notes.push("A symbolic link".into());
            }
            continue;
        }
        let (k, o, n) = match raw.chars().next() {
            Some('+') => ("add", None, Some(new)),
            Some('-') => ("del", Some(old), None),
            Some('\\') => ("meta", None, None),
            _ => ("ctx", Some(old), Some(new)),
        };
        if o.is_some() {
            old += 1;
        }
        if n.is_some() {
            new += 1;
        }
        let body = if k == "meta" {
            raw
        } else {
            raw.get(1..).unwrap_or("")
        };
        lines.push(Line {
            k,
            o,
            n,
            t: clip(body),
        });
    }
    (lines, binary, notes, cut)
}

pub fn page(lines: &[Line], from: usize, line: Option<u64>) -> (usize, usize) {
    let from = from.min(lines.len());
    let mut end = (from + PAGE_LINES).min(lines.len());
    if let Some(want) = line {
        if let Some(at) = lines
            .iter()
            .position(|l| l.n.is_some_and(|n| n >= want) && l.k != "hunk")
        {
            end = end.max((at + AROUND).min(lines.len()));
        }
    }
    (from, end)
}

pub async fn changed_file(
    folders: &Folders,
    m: &Machine,
    path: &str,
    listing: &Listing,
    file: &str,
    from: usize,
    line: Option<u64>,
) -> Result<FileDiff, String> {
    let stat = listing
        .files
        .iter()
        .find(|f| f.path == file && valid_path(file))
        .ok_or_else(|| format!("{file} is not in this review's changes"))?;
    if !valid_sha(&listing.merge_base) {
        return Err("this review has no base to compare with".into());
    }
    let what = if stat.untracked {
        format!("{GIT} {DIFF} --no-index -- /dev/null {}", quote(&stat.path))
    } else {
        let mut paths = quote(&stat.path);
        if let Some(old) = stat.old_path.as_deref().filter(|o| valid_path(o)) {
            paths = format!("{} {paths}", quote(old));
        }
        format!("{GIT} {DIFF} -M {} -- {paths}", listing.merge_base)
    };
    let script = format!("{}{what} | head -c {}", prelude(path), DIFF_BYTES + 1);
    let out = folders.exec(m, &script, TIMEOUT).await?;
    if let Some(e) = err_of(&out) {
        return Err(e);
    }
    let (lines, binary, notes, cut) = parse_diff(&out);
    let (from, next) = page(&lines, from, line);
    Ok(FileDiff {
        path: stat.path.clone(),
        binary: binary || stat.binary,
        notes,
        total: lines.len(),
        lines: lines[from..next].to_vec(),
        from,
        next,
        cut,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    const MB: &str = "1111111111111111111111111111111111111111";
    const HEAD: &str = "2222222222222222222222222222222222222222";

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

    fn listing_output() -> String {
        format!(
            "HEAD\t{HEAD}\nBASE\tmain\nMB\t{MB}\n{TRACKED}\
             :100644 100644 de98044 0000000 M\0a.txt\0\
             :100644 000000 2fa992c 0000000 D\0gone.txt\0\
             :000000 100644 0000000 45a21f1 A\0img.png\0\
             :100644 100644 587be6b 587be6b R100\0old.txt\0new.txt\0\
             3\t1\ta.txt\0\
             0\t1\tgone.txt\0\
             -\t-\timg.png\0\
             0\t0\t\0old.txt\0new.txt\0\
             {UNTRACKED}U\t1\t0\tnotes/todo.md\nU\t-\t-\tshot.bin\n"
        )
    }

    #[test]
    fn a_listing_has_every_kind_of_change() {
        let l = parse_listing(&listing_output()).unwrap();
        assert_eq!((l.base.as_str(), l.merge_base.as_str()), ("main", MB));
        assert!(!l.truncated);
        let brief: Vec<_> = l
            .files
            .iter()
            .map(|f| {
                (
                    f.status.as_str(),
                    f.path.as_str(),
                    f.added,
                    f.removed,
                    f.binary,
                    f.untracked,
                )
            })
            .collect();
        assert_eq!(
            brief,
            [
                ("M", "a.txt", Some(3), Some(1), false, false),
                ("D", "gone.txt", Some(0), Some(1), false, false),
                ("A", "img.png", None, None, true, false),
                ("R", "new.txt", Some(0), Some(0), false, false),
                ("A", "notes/todo.md", Some(1), Some(0), false, true),
                ("A", "shot.bin", None, None, true, true),
            ]
        );
        assert_eq!(l.files[3].old_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn a_listing_cut_short_or_too_long_says_so() {
        let full = listing_output();
        let cut = full.replace("0\t0\t\0old.txt\0new.txt\0", "0\t0\t\0old.t");
        let l = parse_listing(&cut).unwrap();
        assert!(l.truncated);
        assert_eq!(l.files[3].added, None, "the cut entry has no counts");

        let many: String = (0..MAX_UNTRACKED + 1)
            .map(|i| format!("U\t1\t0\tf{i}.txt\n"))
            .collect();
        let out = format!("HEAD\t{HEAD}\nBASE\t\nMB\t{HEAD}\n{TRACKED}{UNTRACKED}{many}");
        let l = parse_listing(&out).unwrap();
        assert!(l.truncated);
        assert_eq!(l.files.len(), MAX_UNTRACKED);
        assert_eq!(l.merge_base, l.head, "no base: only uncommitted changes");

        assert_eq!(
            parse_listing("ERR the folder /r/app is gone\n").unwrap_err(),
            "the folder /r/app is gone"
        );
        assert_eq!(
            parse_listing("HEAD\t\nBASE\t\nMB\t\n").unwrap_err(),
            "this folder has no commits yet"
        );
    }

    #[test]
    fn paths_and_bases_are_checked() {
        for good in [
            "a.txt",
            "src/web/mod.rs",
            ".github/ci.yml",
            "dir with space/x",
        ] {
            assert!(valid_path(good), "{good}");
        }
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../../x",
            "a/./b",
            "a//b",
            "a\nb",
            "a\0b",
            "dir/",
        ] {
            assert!(!valid_path(bad), "{bad:?}");
        }
        for good in ["main", "origin/main", "HEAD~3", "v1.2", MB] {
            assert!(valid_base(good), "{good}");
        }
        for bad in ["", "-x", "a b", "x;rm -rf ~", "$(id)", "a..b", "`id`"] {
            assert!(!valid_base(bad), "{bad}");
        }
        assert!(valid_sha(MB) && !valid_sha("abc") && !valid_sha(&"g".repeat(40)));
    }

    #[test]
    fn a_file_diff_is_numbered_from_its_hunks() {
        let out = "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@ fn x\n a\n-b\n+B\n c\n+d\n\\ No newline at end of file\n@@ -10,2 +11,2 @@\n x\n-y\n+z\n";
        let (lines, binary, notes, cut) = parse_diff(out);
        assert!(!binary && !cut && notes.is_empty());
        let brief: Vec<_> = lines
            .iter()
            .map(|l| (l.k, l.o, l.n, l.t.as_str()))
            .collect();
        assert_eq!(
            brief,
            [
                ("hunk", None, None, "@@ -1,3 +1,4 @@ fn x"),
                ("ctx", Some(1), Some(1), "a"),
                ("del", Some(2), None, "b"),
                ("add", None, Some(2), "B"),
                ("ctx", Some(3), Some(3), "c"),
                ("add", None, Some(4), "d"),
                ("meta", None, None, "\\ No newline at end of file"),
                ("hunk", None, None, "@@ -10,2 +11,2 @@"),
                ("ctx", Some(10), Some(11), "x"),
                ("del", Some(11), None, "y"),
                ("add", None, Some(12), "z"),
            ]
        );
        let (lines, binary, ..) = parse_diff(
            "diff --git a/i.png b/i.png\nnew file mode 100644\nBinary files /dev/null and b/i.png differ\n",
        );
        assert!(binary && lines.is_empty());
        let (_, _, notes, _) =
            parse_diff("diff --git a/o b/n\nsimilarity index 100%\nrename from o\nrename to n\n");
        assert_eq!(notes, ["Renamed, 100% the same"]);
    }

    #[test]
    fn large_diffs_are_cut_and_paged() {
        let body: String = (0..30_000)
            .map(|i| format!("+line {i} {}\n", "x".repeat(80)))
            .collect();
        let out = format!("@@ -0,0 +1,30000 @@\n{body}");
        let (lines, _, _, cut) = parse_diff(&out);
        assert!(cut, "over {DIFF_BYTES} bytes");
        assert!(lines.len() < 30_001);
        assert!(lines.last().unwrap().t.starts_with("line "));
        assert_eq!(page(&lines, 0, None), (0, PAGE_LINES));
        assert_eq!(page(&lines, PAGE_LINES, None), (PAGE_LINES, 2 * PAGE_LINES));
        assert_eq!(page(&lines, 0, Some(1000)), (0, 1000 + AROUND));
        assert_eq!(
            page(&lines, lines.len() + 5, None),
            (lines.len(), lines.len())
        );
        let (long, ..) = parse_diff(&format!("@@ -1 +1 @@\n+{}\n", "y".repeat(5000)));
        assert_eq!(long[1].t.chars().count(), LINE_CHARS + 1);
    }

    #[tokio::test]
    async fn only_files_in_the_listing_are_diffed() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("@@YB-TRACKED@@", Output::ok_with(&listing_output()));
        fake.stub("--no-textconv -M", Output::ok_with("@@ -1 +1 @@\n-x\n+y\n"));
        fake.stub(
            "--no-index -- /dev/null",
            Output::ok_with("@@ -0,0 +1 @@\n+u\n"),
        );
        let f = folders(fake.clone());
        let anchor = Anchor {
            base: "main".into(),
            merge_base: MB.into(),
            head: HEAD.into(),
        };
        let l = changed_files(&f, &machine(), "/r/app", Some(&anchor), "")
            .await
            .unwrap();
        let script = fake.calls()[0].last().unwrap().clone();
        assert!(script.contains(&format!("mb='{MB}'")), "{script}");
        assert!(script.contains("GIT_OPTIONAL_LOCKS=0"));
        assert!(script.contains("--no-ext-diff --no-textconv"));

        let err = changed_file(&f, &machine(), "/r/app", &l, "../etc/passwd", 0, None)
            .await
            .unwrap_err();
        assert_eq!(err, "../etc/passwd is not in this review's changes");
        assert!(
            changed_file(&f, &machine(), "/r/app", &l, "src/other.rs", 0, None)
                .await
                .is_err()
        );
        assert_eq!(fake.calls().len(), 1, "nothing ran for a refused path");

        let d = changed_file(&f, &machine(), "/r/app", &l, "new.txt", 0, None)
            .await
            .unwrap();
        assert_eq!(d.lines.len(), 3);
        let script = fake.calls()[1].last().unwrap().clone();
        assert!(
            script.contains(&format!("-M {MB} -- 'old.txt' 'new.txt' | head -c")),
            "{script}"
        );
        let u = changed_file(&f, &machine(), "/r/app", &l, "notes/todo.md", 0, None)
            .await
            .unwrap();
        assert_eq!(u.lines[1].k, "add");
        assert!(fake.calls()[2]
            .last()
            .unwrap()
            .contains("--no-index -- /dev/null 'notes/todo.md'"));
    }

    #[tokio::test]
    async fn without_an_anchor_the_base_is_found_like_the_reviewer_does() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("@@YB-TRACKED@@", Output::ok_with(&listing_output()));
        let f = folders(fake.clone());
        changed_files(&f, &machine(), "/r/app", None, "$(id)")
            .await
            .unwrap();
        let script = fake.calls()[0].last().unwrap().clone();
        assert!(
            script.contains("want='';"),
            "an unsafe base is dropped: {script}"
        );
        assert!(script.contains("git merge-base HEAD"));
        changed_files(&f, &machine(), "/r/app", None, "develop")
            .await
            .unwrap();
        assert!(fake.calls()[1].last().unwrap().contains("want='develop';"));
    }
}

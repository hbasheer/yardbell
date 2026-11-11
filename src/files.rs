use crate::config::Machine;
use crate::folders::Folders;
use crate::shell::{expand_home, quote, Duration};
use serde::Serialize;

pub const LIST_MAX: usize = 2000;
pub const READ_MAX: u64 = 1024 * 1024;
pub const FIND_MAX: usize = 200;
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const FIND_TIMEOUT: Duration = Duration::from_secs(15);
const FIND_SECONDS: u32 = 10;
const SNIFF: usize = 8192;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileText {
    pub path: String,
    pub size: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Found {
    pub matches: Vec<String>,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FileError {
    Refused(String),
    Outside,
    Missing,
    NotFolder,
    NotFile,
    NotRepo,
    Binary,
    TooLarge(u64),
    Failed(String),
}

impl FileError {
    pub fn message(&self, path: &str) -> String {
        let name = if path.is_empty() { "that folder" } else { path };
        match self {
            FileError::Refused(why) => why.clone(),
            FileError::Outside => format!("{name} is outside this folder"),
            FileError::Missing => format!("{name} does not exist"),
            FileError::NotFolder => format!("{name} is not a folder"),
            FileError::NotFile => format!("{name} is not a regular file"),
            FileError::NotRepo => format!("{name} is not in a git repository"),
            FileError::Binary => format!("{name} is a binary file, so it is not shown"),
            FileError::TooLarge(size) => format!(
                "{name} is {}, larger than the {} Yardbell shows",
                size_words(*size),
                size_words(READ_MAX)
            ),
            FileError::Failed(why) => why.clone(),
        }
    }
}

fn size_words(bytes: u64) -> String {
    match bytes {
        b if b >= 1024 * 1024 => format!("{:.1} MB", b as f64 / (1024.0 * 1024.0)),
        b if b >= 1024 => format!("{} KB", b / 1024),
        b => format!("{b} bytes"),
    }
}

fn plain(text: &str) -> bool {
    !text.contains(['\0', '\n', '\r', '\t'])
}

// A folder to look in: absolute or under the home folder, never stepping up out of itself.
pub fn check_root(root: &str) -> Result<(), FileError> {
    let refused = |why: &str| Err(FileError::Refused(why.into()));
    if root.is_empty() {
        return refused("no folder was given");
    }
    if !(root.starts_with('/') || root == "~" || root.starts_with("~/")) {
        return refused("the folder must be an absolute path");
    }
    if !plain(root) || root.split('/').any(|part| part == "..") {
        return refused("that folder path is not allowed");
    }
    Ok(())
}

// A path inside the folder, written relative to it, with no way back out.
pub fn check_relative(path: &str) -> Result<String, FileError> {
    let refused = |why: &str| Err(FileError::Refused(why.into()));
    if path.starts_with('/') || path.starts_with('~') {
        return refused("paths are relative to the folder, not absolute");
    }
    if !plain(path) {
        return refused("that path is not allowed");
    }
    let parts: Vec<&str> = path
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.contains(&"..") {
        return refused("a path cannot leave the folder with ..");
    }
    Ok(parts.join("/"))
}

pub fn within(path: &str, base: &str) -> bool {
    let base = base.trim_end_matches('/');
    !base.is_empty()
        && (path == base || path.starts_with(&format!("{base}/")))
        && !path.split('/').any(|part| part == "..")
}

// Where the folder really is, and a check that it is one Yardbell knows or lies under the
// machine's root once links are followed. Every path after this must stay under it too.
pub(crate) fn prelude(machine_root: &str, root: &str, known: bool) -> String {
    format!(
        "{}; R=$(cd \"$p\" 2>/dev/null && pwd -P); \
         {}; B=$(cd \"$p\" 2>/dev/null && pwd -P); \
         [ -n \"$B\" ] || {{ echo 'ERR missing'; exit 0; }}; \
         if [ {} != 1 ]; then case \"$B/\" in \"${{R:-//}}\"/*) ;; *) echo 'ERR outside'; exit 0 ;; esac; fi; \
         inside() {{ case \"$1/\" in \"$B\"/*) return 0 ;; esac; return 1; }}",
        expand_home(machine_root),
        expand_home(root),
        u8::from(known)
    )
}

fn enter(dir: &str) -> String {
    format!(
        "cd \"$B\" || exit 0; [ -e ./{0} ] || {{ echo 'ERR missing'; exit 0; }}; \
         cd ./{0} 2>/dev/null || {{ echo 'ERR notfolder'; exit 0; }}; \
         D=$(pwd -P); inside \"$D\" || {{ echo 'ERR outside'; exit 0; }}",
        quote(dir)
    )
}

pub(crate) fn in_sh(script: &str) -> String {
    format!("sh -c {}", quote(script))
}

pub fn list_command(machine_root: &str, root: &str, dir: &str, known: bool) -> String {
    in_sh(&format!(
        "{}; {}; \
         if stat -c %s / >/dev/null 2>&1; then s() {{ stat -L --printf '%F\\t%s\\t%n\\n' -- \"$@\"; }}; \
         else s() {{ stat -L -f '%HT%t%z%t%N%n' -- \"$@\"; }}; fi; \
         set -- .[!.]* ..?* *; s \"$@\" 2>/dev/null | head -n {}; true",
        prelude(machine_root, root, known),
        enter(dir),
        LIST_MAX + 1
    ))
}

pub fn read_command(machine_root: &str, root: &str, path: &str, known: bool) -> String {
    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
    in_sh(&format!(
        "{}; {}; f={}; \
         if [ -L \"$f\" ]; then t=$(realpath -- \"$f\" 2>/dev/null || readlink -f -- \"$f\" 2>/dev/null); \
         [ -n \"$t\" ] && inside \"$t\" || {{ echo 'ERR outside'; exit 0; }}; fi; \
         [ -e \"$f\" ] || {{ echo 'ERR missing'; exit 0; }}; \
         [ -f \"$f\" ] || {{ echo 'ERR notfile'; exit 0; }}; \
         n=$(wc -c < \"$f\" | tr -d ' '); \
         [ \"$n\" -le {max} ] || {{ echo \"ERR large $n\"; exit 0; }}; \
         a=$(head -c {sniff} -- \"$f\" | wc -c); b=$(head -c {sniff} -- \"$f\" | tr -d '\\000' | wc -c); \
         [ \"$a\" -eq \"$b\" ] || {{ echo 'ERR binary'; exit 0; }}; \
         printf 'SIZE\\t%s\\n' \"$n\"; head -c {max} -- \"$f\"; true",
        prelude(machine_root, root, known),
        enter(dir),
        quote(name),
        max = READ_MAX,
        sniff = SNIFF,
    ))
}

fn glob_escape(text: &str) -> String {
    text.chars()
        .flat_map(|c| match c {
            '*' | '?' | '[' | ']' | '\\' => vec!['\\', c],
            c => vec![c],
        })
        .collect()
}

pub fn search_command(
    machine_root: &str,
    root: &str,
    query: &str,
    contents: bool,
    known: bool,
) -> String {
    let skip = ".git node_modules target";
    let search = if contents {
        let dirs: Vec<String> = skip
            .split(' ')
            .map(|d| format!("--exclude-dir={d}"))
            .collect();
        format!(
            "$T grep -rIl -i -F {} -e {} . 2>/dev/null",
            dirs.join(" "),
            quote(query)
        )
    } else {
        let prune: Vec<String> = skip.split(' ').map(|d| format!("-name {d}")).collect();
        format!(
            "$T find . \\( {} \\) -prune -o -type f -iname {} -print 2>/dev/null",
            prune.join(" -o "),
            quote(&format!("*{}*", glob_escape(query)))
        )
    };
    in_sh(&format!(
        "{}; cd \"$B\" || exit 0; T=; command -v timeout >/dev/null 2>&1 && T='timeout {FIND_SECONDS}'; \
         {search} | head -n {}; true",
        prelude(machine_root, root, known),
        FIND_MAX + 1
    ))
}

pub(crate) fn error_of(out: &str) -> Option<FileError> {
    let first = out.lines().next()?;
    let what = first.strip_prefix("ERR ")?;
    Some(match what.split_once(' ') {
        Some(("large", size)) => FileError::TooLarge(size.trim().parse().unwrap_or(0)),
        _ => match what {
            "outside" => FileError::Outside,
            "missing" => FileError::Missing,
            "notfolder" => FileError::NotFolder,
            "notfile" => FileError::NotFile,
            "notrepo" => FileError::NotRepo,
            "binary" => FileError::Binary,
            other => FileError::Failed(other.to_string()),
        },
    })
}

pub fn parse_list(out: &str, path: &str) -> Result<Listing, FileError> {
    if let Some(e) = error_of(out) {
        return Err(e);
    }
    let mut entries: Vec<Entry> = out
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let kind = parts.next()?.to_lowercase();
            let size = parts.next()?.parse().ok()?;
            let name = parts.next()?;
            if name.is_empty() || name.contains('/') {
                return None;
            }
            let kind = if kind.contains("directory") {
                "dir"
            } else {
                "file"
            };
            Some(Entry {
                name: name.to_string(),
                kind,
                size,
            })
        })
        .collect();
    let more = entries.len() > LIST_MAX;
    entries.truncate(LIST_MAX);
    entries.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing {
        path: path.to_string(),
        entries,
        more,
    })
}

pub fn parse_read(out: &str, path: &str) -> Result<FileText, FileError> {
    if let Some(e) = error_of(out) {
        return Err(e);
    }
    let (head, text) = out.split_once('\n').unwrap_or((out, ""));
    let size = head
        .strip_prefix("SIZE\t")
        .and_then(|n| n.trim().parse().ok())
        .ok_or_else(|| FileError::Failed("the machine did not send the file".into()))?;
    Ok(FileText {
        path: path.to_string(),
        size,
        text: text.to_string(),
    })
}

pub fn parse_search(out: &str) -> Result<Found, FileError> {
    if let Some(e) = error_of(out) {
        return Err(e);
    }
    let mut matches: Vec<String> = out
        .lines()
        .filter_map(|l| l.strip_prefix("./"))
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let more = matches.len() > FIND_MAX;
    matches.truncate(FIND_MAX);
    matches.sort();
    Ok(Found { matches, more })
}

impl Folders {
    pub async fn list_files(
        &self,
        m: &Machine,
        root: &str,
        dir: &str,
        known: bool,
    ) -> Result<Listing, FileError> {
        let out = self
            .exec(m, &list_command(&m.root, root, dir, known), LIST_TIMEOUT)
            .await
            .map_err(FileError::Failed)?;
        parse_list(&out, dir)
    }

    pub async fn read_file(
        &self,
        m: &Machine,
        root: &str,
        path: &str,
        known: bool,
    ) -> Result<FileText, FileError> {
        let out = self
            .exec(m, &read_command(&m.root, root, path, known), READ_TIMEOUT)
            .await
            .map_err(FileError::Failed)?;
        parse_read(&out, path)
    }

    pub async fn search_files(
        &self,
        m: &Machine,
        root: &str,
        query: &str,
        contents: bool,
        known: bool,
    ) -> Result<Found, FileError> {
        let script = search_command(&m.root, root, query, contents, known);
        let out = self
            .exec(m, &script, FIND_TIMEOUT)
            .await
            .map_err(FileError::Failed)?;
        parse_search(&out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn run(script: &str, home: &Path) -> String {
        let out = std::process::Command::new("sh")
            .args(["-c", script])
            .env("HOME", home)
            .output()
            .unwrap();
        assert!(out.status.success(), "{script}");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    // A home with a machine root holding one project, and a secret file beside the root.
    fn sandbox() -> (tempfile::TempDir, String) {
        let home = tempfile::tempdir().unwrap();
        let app = home.path().join("code/app");
        std::fs::create_dir_all(app.join("src/deep")).unwrap();
        std::fs::create_dir_all(app.join(".git")).unwrap();
        std::fs::write(app.join("README.md"), "# app\nhello world\n").unwrap();
        std::fs::write(
            app.join("src/main.rs"),
            "fn main() { println!(\"Hello\"); }\n",
        )
        .unwrap();
        std::fs::write(app.join("src/deep/notes.txt"), "nothing here\n").unwrap();
        std::fs::write(app.join(".env"), "TOKEN=x\n").unwrap();
        std::fs::write(app.join("logo.png"), b"\x89PNG\r\n\x1a\n\0\0\0").unwrap();
        std::fs::write(home.path().join("secret.txt"), "top secret\n").unwrap();
        std::os::unix::fs::symlink(home.path().join("secret.txt"), app.join("leak.txt")).unwrap();
        std::os::unix::fs::symlink(home.path(), app.join("up")).unwrap();
        let root = home.path().join("code/app").to_string_lossy().into_owned();
        (home, root)
    }

    #[test]
    fn roots_and_paths_cannot_step_out() {
        assert!(check_root("/r/app").is_ok());
        assert!(check_root("~/code/app").is_ok());
        for bad in ["", "code/app", "/r/../etc", "/r/app\n", "~root/x"] {
            assert!(check_root(bad).is_err(), "{bad:?}");
        }
        assert_eq!(check_relative("").unwrap(), "");
        assert_eq!(check_relative("./src//main.rs").unwrap(), "src/main.rs");
        for bad in ["../x", "src/../../x", "/etc/passwd", "~/x", "a\tb"] {
            assert!(check_relative(bad).is_err(), "{bad:?}");
        }
        assert!(within("/r/app/src", "/r/app"));
        assert!(within("/r/app", "/r/app/"));
        assert!(!within("/r/apple", "/r/app"));
        assert!(!within("/r/app/../etc", "/r/app"));
    }

    #[test]
    fn a_folder_lists_everything_folders_first() {
        let (home, root) = sandbox();
        let out = run(&list_command("~/code", &root, "", false), home.path());
        let l = parse_list(&out, "").unwrap();
        let names: Vec<(&str, &str)> = l
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.kind))
            .collect();
        assert_eq!(
            names,
            vec![
                (".git", "dir"),
                ("src", "dir"),
                ("up", "dir"),
                (".env", "file"),
                ("leak.txt", "file"),
                ("logo.png", "file"),
                ("README.md", "file"),
            ]
        );
        let readme = l.entries.iter().find(|e| e.name == "README.md").unwrap();
        assert_eq!(readme.size, 18);
        assert!(!l.more);
        let src = parse_list(
            &run(&list_command("~/code", &root, "src", false), home.path()),
            "src",
        )
        .unwrap();
        assert_eq!(src.entries.len(), 2);
    }

    #[test]
    fn links_out_of_the_folder_and_folders_outside_the_root_are_refused() {
        let (home, root) = sandbox();
        let up = run(&list_command("~/code", &root, "up", false), home.path());
        assert_eq!(parse_list(&up, "up").unwrap_err(), FileError::Outside);
        let leak = run(
            &read_command("~/code", &root, "leak.txt", false),
            home.path(),
        );
        assert_eq!(
            parse_read(&leak, "leak.txt").unwrap_err(),
            FileError::Outside
        );
        let home_root = home.path().to_string_lossy().into_owned();
        let outside = run(&list_command("~/code", &home_root, "", false), home.path());
        assert_eq!(parse_list(&outside, "").unwrap_err(), FileError::Outside);
        let known = run(&list_command("~/code", &home_root, "", true), home.path());
        assert!(parse_list(&known, "").is_ok(), "a folder Yardbell knows");
    }

    #[test]
    fn a_text_file_is_read_and_a_binary_one_refused() {
        let (home, root) = sandbox();
        let out = run(
            &read_command("~/code", &root, "src/main.rs", false),
            home.path(),
        );
        let f = parse_read(&out, "src/main.rs").unwrap();
        assert_eq!(f.text, "fn main() { println!(\"Hello\"); }\n");
        assert_eq!(f.size, f.text.len() as u64);
        let png = run(
            &read_command("~/code", &root, "logo.png", false),
            home.path(),
        );
        assert_eq!(parse_read(&png, "logo.png").unwrap_err(), FileError::Binary);
        let dir = run(&read_command("~/code", &root, "src", false), home.path());
        assert_eq!(parse_read(&dir, "src").unwrap_err(), FileError::NotFile);
        let gone = run(
            &read_command("~/code", &root, "nope.rs", false),
            home.path(),
        );
        assert_eq!(
            parse_read(&gone, "nope.rs").unwrap_err(),
            FileError::Missing
        );
    }

    #[test]
    fn a_file_over_the_limit_is_refused_with_its_size() {
        let (home, root) = sandbox();
        std::fs::write(
            Path::new(&root).join("big.log"),
            "x".repeat(READ_MAX as usize + 10),
        )
        .unwrap();
        let out = run(
            &read_command("~/code", &root, "big.log", false),
            home.path(),
        );
        let err = parse_read(&out, "big.log").unwrap_err();
        assert_eq!(err, FileError::TooLarge(READ_MAX + 10));
        assert!(err.message("big.log").contains("larger than the 1.0 MB"));
    }

    #[test]
    fn search_by_name_or_contents_skips_git() {
        let (home, root) = sandbox();
        std::fs::write(Path::new(&root).join(".git/main-config"), "Hello").unwrap();
        let names = run(
            &search_command("~/code", &root, "MAIN", false, false),
            home.path(),
        );
        assert_eq!(parse_search(&names).unwrap().matches, vec!["src/main.rs"]);
        let contents = run(
            &search_command("~/code", &root, "hello", true, false),
            home.path(),
        );
        assert_eq!(
            parse_search(&contents).unwrap().matches,
            vec!["README.md", "src/main.rs"]
        );
        let glob = run(
            &search_command("~/code", &root, "*", false, false),
            home.path(),
        );
        assert!(parse_search(&glob).unwrap().matches.is_empty());
    }
}

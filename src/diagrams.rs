use crate::pipeline::record::TicketRef;
use crate::shell::{expand_home, quote};
use serde::Serialize;

pub const ARCHIFY_VERSION: &str = "3.2.0";
const ZIP_URL: &str = "https://github.com/tt-a1i/archify/releases/download/v3.2.0/archify.zip";
const ZIP_SHA256: &str = "70e210265c59f24dcbdf2a502ff671104b5454e7ee7d3554aecd86bad32384f5";
const INSTALL_DIR: &str = "$HOME/.local/share/yardbell/archify/3.2.0";
const NODE_MAJOR: u32 = 18;
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
const ROW: &str = "yardbell-diagram";
pub const SOURCE: &str = "diagram";
pub const SOURCE_MAX: u64 = 256 * 1024;
const SOURCE_FILE: &str = "candidate.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Setup {
    pub node: String,
    pub installed: bool,
}

impl Setup {
    pub fn state(&self) -> &'static str {
        let major = self
            .node
            .trim_start_matches('v')
            .split('.')
            .next()
            .and_then(|n| n.parse::<u32>().ok());
        if major.is_none_or(|m| m < NODE_MAJOR) {
            "needs_node"
        } else if self.installed {
            "installed"
        } else {
            "not_installed"
        }
    }
}

pub fn status_script() -> String {
    format!(
        "echo \"yardbell-node=$(node --version 2>/dev/null)\"; \
         if [ -f \"{INSTALL_DIR}/SKILL.md\" ] && [ -f \"{INSTALL_DIR}/bin/archify.mjs\" ]; then \
         echo yardbell-installed=1; fi; true"
    )
}

pub fn parse_status(text: &str) -> Setup {
    let mut setup = Setup::default();
    for line in text.lines() {
        if let Some(version) = line.strip_prefix("yardbell-node=") {
            setup.node = version.trim().to_string();
        }
        if line.trim() == "yardbell-installed=1" {
            setup.installed = true;
        }
    }
    setup
}

// Downloaded to a temporary folder and moved into place only once it is verified, so a failure at
// any point leaves nothing behind.
pub fn install_script() -> String {
    format!(
        "set -e; t=$(mktemp -d); trap 'rm -rf \"$t\"' EXIT; \
         for tool in curl unzip; do command -v $tool >/dev/null || \
         {{ echo \"$tool is not installed on this machine\" >&2; exit 2; }}; done; \
         curl -fsSL --max-time 120 -o \"$t/archify.zip\" {url}; \
         if command -v sha256sum >/dev/null; then s=$(sha256sum \"$t/archify.zip\" | cut -d' ' -f1); \
         else s=$(shasum -a 256 \"$t/archify.zip\" | cut -d' ' -f1); fi; \
         [ \"$s\" = {sha} ] || {{ echo \"the download's checksum does not match, so nothing was installed\" >&2; exit 3; }}; \
         unzip -q \"$t/archify.zip\" -d \"$t/out\"; \
         node \"$t/out/archify/bin/archify.mjs\" doctor >/dev/null; \
         rm -rf \"{INSTALL_DIR}\"; mkdir -p \"$(dirname \"{INSTALL_DIR}\")\"; mv \"$t/out/archify\" \"{INSTALL_DIR}\"",
        url = quote(ZIP_URL),
        sha = ZIP_SHA256,
    )
}

pub fn remove_script() -> String {
    format!("rm -rf \"{INSTALL_DIR}\"")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diagram {
    pub folder: String,
    pub dir: String,
    pub file: String,
    pub modified: i64,
    pub bytes: u64,
}

// A symlink could point anywhere on the machine, so one is never listed, read or deleted.
pub fn list_script(folders: &[(String, String)]) -> String {
    let mut script = format!(
        "list() {{ label=$1; [ -d \"$p/.archify\" ] && [ ! -L \"$p/.archify\" ] || return 0; \
         for f in \"$p\"/.archify/*/*.html; do d=$(dirname \"$f\"); \
         [ -f \"$f\" ] && [ ! -L \"$f\" ] && [ ! -L \"$d\" ] || continue; \
         m=$(stat -c %Y \"$f\" 2>/dev/null || stat -f %m \"$f\"); s=$(wc -c <\"$f\" | tr -d ' '); \
         printf '{ROW}\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$label\" \"$(basename \"$d\")\" \"$(basename \"$f\")\" \"$m\" \"$s\"; done; }}; "
    );
    for (label, path) in folders {
        script.push_str(&format!("{}; list {}; ", expand_home(path), quote(label)));
    }
    script.push_str("true");
    script
}

pub fn parse_list(text: &str) -> Vec<Diagram> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            if parts.next()? != ROW {
                return None;
            }
            let found = Diagram {
                folder: parts.next()?.to_string(),
                dir: parts.next()?.to_string(),
                file: parts.next()?.to_string(),
                modified: parts.next()?.parse().ok()?,
                bytes: parts.next()?.parse().ok()?,
            };
            (safe_name(&found.dir) && safe_name(&found.file)).then_some(found)
        })
        .collect()
}

pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\n', '\r', '\t', '\0'])
}

pub fn read_script(path: &str, dir: &str, file: &str) -> String {
    format!(
        "{}; d=\"$p/.archify/\"{}; f=\"$d/\"{}; \
         if [ -L \"$p/.archify\" ] || [ -L \"$d\" ] || [ -L \"$f\" ] || [ ! -f \"$f\" ]; then echo 'that diagram is not there' >&2; exit 4; fi; \
         [ \"$(wc -c <\"$f\")\" -le {MAX_BYTES} ] || {{ echo 'that diagram is too large to show' >&2; exit 5; }}; \
         cat \"$f\"",
        expand_home(path),
        quote(dir),
        quote(file),
    )
}

pub fn delete_script(path: &str, dir: &str) -> String {
    format!(
        "{}; d=\"$p/.archify/\"{}; \
         if [ -L \"$p/.archify\" ] || [ -L \"$d\" ] || [ ! -d \"$d\" ]; then echo 'that diagram is not there' >&2; exit 4; fi; \
         rm -rf \"$d\"",
        expand_home(path),
        quote(dir),
    )
}

// What the diagram was built from, which is far easier for an agent to read than the page.
pub fn source_script(path: &str, dir: &str) -> String {
    format!(
        "{}; d=\"$p/.archify/\"{}; f=\"$d/{SOURCE_FILE}\"; \
         if [ -L \"$p/.archify\" ] || [ -L \"$d\" ] || [ -L \"$f\" ] || [ ! -f \"$f\" ]; then echo 'that diagram has no source to read' >&2; exit 4; fi; \
         [ \"$(wc -c <\"$f\")\" -le {SOURCE_MAX} ] || {{ echo 'that diagram is too large to read' >&2; exit 5; }}; \
         cat \"$f\"",
        expand_home(path),
        quote(dir),
    )
}

pub fn title_of(dir: &str) -> String {
    slug_of(dir).replace(['-', '_'], " ")
}

fn slug_of(dir: &str) -> &str {
    let parts: Vec<&str> = dir.rsplitn(3, '-').collect();
    match parts[..] {
        [time, date, rest] if time.len() == 6 && date.len() == 8 => rest,
        _ => dir,
    }
}

// A run keeps its own copy, so a worktree does not need the file, which stays out of git, and
// drawing again cannot change a run that has started.
pub fn work_item(machine: &str, folder: &str, dir: &str, source: &str) -> TicketRef {
    TicketRef {
        source: SOURCE.to_string(),
        item_id: dir.to_string(),
        id: slug_of(dir).to_string(),
        title: title_of(dir),
        url: String::new(),
        description: format!(
            "An architecture diagram of the folder {folder} on {machine}, as the JSON it was drawn from.\n\n{source}"
        ),
        fields: Default::default(),
    }
}

// A folder that is not a git repository has nothing to keep it out of, and still gets its diagram.
pub fn exclude_script(path: &str) -> String {
    format!(
        "{}; cd \"$p\" || exit 0; e=$(git rev-parse --git-path info/exclude 2>/dev/null) || exit 0; \
         mkdir -p \"$(dirname \"$e\")\"; grep -qxF '.archify/' \"$e\" 2>/dev/null || echo '.archify/' >>\"$e\"",
        expand_home(path),
    )
}

pub fn draw_prompt(focus: &str) -> String {
    let dir = INSTALL_DIR.replace("$HOME", "~");
    let mut prompt = format!(
        "Draw an architecture diagram of this repository, backed by its source. Read {dir}/SKILL.md and \
         follow it, using {dir}/bin/archify.mjs as its command, with ARCHIFY_UPDATE_CHECK_DISABLED=1 in \
         front of every Archify command. Do not change any file outside .archify/.\n\n\
         If finalize fails only because no browser was found, keep the HTML and say the browser check was \
         skipped. Any other failure is a real failure to repair."
    );
    let focus = focus.trim();
    if !focus.is_empty() {
        prompt.push_str(&format!("\n\nFocus on: {focus}"));
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn sh(script: &str, home: &Path) -> std::process::Output {
        std::process::Command::new("sh")
            .args(["-c", script])
            .env("HOME", home)
            .output()
            .unwrap()
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn a_machine_needs_node_18_then_archify() {
        let seen = |text: &str| parse_status(text).state();
        assert_eq!(seen("yardbell-node=\n"), "needs_node");
        assert_eq!(
            seen("yardbell-node=v16.20.0\nyardbell-installed=1\n"),
            "needs_node"
        );
        assert_eq!(seen("yardbell-node=v18.0.0\n"), "not_installed");
        assert_eq!(
            seen("noise from a login shell\nyardbell-node=v22.11.0\nyardbell-installed=1\n"),
            "installed"
        );
    }

    #[test]
    fn the_status_script_sees_what_is_installed() {
        let home = tempfile::tempdir().unwrap();
        let out = sh(&status_script(), home.path());
        assert!(!parse_status(&String::from_utf8_lossy(&out.stdout)).installed);
        write(
            &home
                .path()
                .join(".local/share/yardbell/archify/3.2.0/SKILL.md"),
            "x",
        );
        write(
            &home
                .path()
                .join(".local/share/yardbell/archify/3.2.0/bin/archify.mjs"),
            "x",
        );
        let out = sh(&status_script(), home.path());
        assert!(parse_status(&String::from_utf8_lossy(&out.stdout)).installed);
    }

    #[test]
    fn a_wrong_checksum_installs_nothing() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin");
        write(&bin.join("curl"), "#!/bin/sh\nwhile [ $# -gt 0 ]; do [ \"$1\" = -o ] && echo tampered > \"$2\"; shift; done\n");
        std::process::Command::new("chmod")
            .arg("+x")
            .arg(bin.join("curl"))
            .status()
            .unwrap();
        let script = format!("PATH={}:$PATH; {}", bin.display(), install_script());
        let out = sh(&script, home.path());
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("checksum"));
        assert!(!home
            .path()
            .join(".local/share/yardbell/archify/3.2.0")
            .exists());
    }

    #[test]
    fn install_pins_the_release_and_its_checksum() {
        let script = install_script();
        assert!(script.contains("releases/download/v3.2.0/archify.zip"));
        assert!(script.contains("70e210265c59f24dcbdf2a502ff671104b5454e7ee7d3554aecd86bad32384f5"));
        assert!(!script.contains("skills"), "no agent's skills folder");
    }

    #[test]
    fn remove_only_touches_its_own_folder() {
        let home = tempfile::tempdir().unwrap();
        write(
            &home
                .path()
                .join(".local/share/yardbell/archify/3.2.0/SKILL.md"),
            "x",
        );
        write(&home.path().join(".local/share/yardbell/keep"), "x");
        assert!(sh(&remove_script(), home.path()).status.success());
        assert!(!home
            .path()
            .join(".local/share/yardbell/archify/3.2.0")
            .exists());
        assert!(home.path().join(".local/share/yardbell/keep").exists());
    }

    fn folders(path: &Path) -> Vec<(String, String)> {
        vec![
            ("app".to_string(), path.display().to_string()),
            ("it's gone".to_string(), "/no/such/folder".to_string()),
        ]
    }

    #[test]
    fn diagrams_are_found_under_each_folder() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("app");
        write(&repo.join(".archify/architecture-api-1/out.html"), "<html>");
        write(
            &repo.join(".archify/architecture-api-1/out.delivery.json"),
            "{}",
        );
        write(&repo.join(".archify/loose.html"), "<html>");
        let out = sh(&list_script(&folders(&repo)), home.path());
        assert!(out.status.success(), "{out:?}");
        let found = parse_list(&String::from_utf8_lossy(&out.stdout));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].folder, "app");
        assert_eq!(found[0].dir, "architecture-api-1");
        assert_eq!(found[0].file, "out.html");
        assert_eq!(found[0].bytes, 6);
        assert!(found[0].modified > 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_never_counts_as_a_diagram() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("app");
        write(&home.path().join("secret.html"), "secret");
        write(&repo.join(".archify/real/keep.txt"), "x");
        std::os::unix::fs::symlink(
            home.path().join("secret.html"),
            repo.join(".archify/real/out.html"),
        )
        .unwrap();
        std::os::unix::fs::symlink(home.path(), repo.join(".archify/linked")).unwrap();
        let out = sh(&list_script(&folders(&repo)), home.path());
        assert_eq!(parse_list(&String::from_utf8_lossy(&out.stdout)), []);
        let out = sh(
            &read_script(&repo.display().to_string(), "real", "out.html"),
            home.path(),
        );
        assert!(!out.status.success());
        assert!(!String::from_utf8_lossy(&out.stdout).contains("secret"));
        let out = sh(
            &delete_script(&repo.display().to_string(), "linked"),
            home.path(),
        );
        assert!(!out.status.success());
        assert!(home.path().join("secret.html").exists());
    }

    #[test]
    fn only_plain_names_are_accepted() {
        for good in ["architecture-api-20261101-120000", "out.html", "a b"] {
            assert!(safe_name(good), "{good}");
        }
        for bad in ["", ".", "..", "a/b", "../x", "a\\b", "a\nb", "a\tb", "a\0b"] {
            assert!(!safe_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_large_file_is_refused_when_read() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("app");
        let big = repo.join(".archify/d/out.html");
        write(&big, "x");
        std::fs::File::options()
            .write(true)
            .open(&big)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        let out = sh(
            &read_script(&repo.display().to_string(), "d", "out.html"),
            home.path(),
        );
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("too large"));
    }

    #[test]
    fn a_diagram_is_read_and_deleted_on_its_own() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("app");
        write(&repo.join(".archify/one/out.html"), "<html>one");
        write(&repo.join(".archify/two/out.html"), "<html>two");
        let path = repo.display().to_string();
        let out = sh(&read_script(&path, "one", "out.html"), home.path());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "<html>one");
        assert!(sh(&delete_script(&path, "one"), home.path())
            .status
            .success());
        assert!(!repo.join(".archify/one").exists());
        assert!(repo.join(".archify/two/out.html").exists());
    }

    #[test]
    fn diagrams_are_kept_out_of_git_once() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("app");
        std::fs::create_dir_all(&repo).unwrap();
        let path = repo.display().to_string();
        assert!(
            sh(&exclude_script(&path), home.path()).status.success(),
            "not a repository is fine"
        );
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(sh(&exclude_script(&path), home.path()).status.success());
        assert!(sh(&exclude_script(&path), home.path()).status.success());
        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| *l == ".archify/").count(), 1);
    }

    #[test]
    fn a_diagrams_source_is_read_for_agents() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("app");
        write(&repo.join(".archify/d/candidate.json"), "{\"nodes\":[]}");
        let path = repo.display().to_string();
        let out = sh(&source_script(&path, "d"), home.path());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "{\"nodes\":[]}");
        let missing = sh(&source_script(&path, "gone"), home.path());
        assert!(!missing.status.success());
        assert!(String::from_utf8_lossy(&missing.stderr).contains("no source"));
    }

    #[cfg(unix)]
    #[test]
    fn a_diagrams_source_is_never_a_symlink_or_too_large() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("app");
        write(&home.path().join("secret.json"), "secret");
        write(&repo.join(".archify/d/keep"), "x");
        std::os::unix::fs::symlink(
            home.path().join("secret.json"),
            repo.join(".archify/d/candidate.json"),
        )
        .unwrap();
        let path = repo.display().to_string();
        let out = sh(&source_script(&path, "d"), home.path());
        assert!(!out.status.success());
        assert!(!String::from_utf8_lossy(&out.stdout).contains("secret"));
        write(&repo.join(".archify/big/candidate.json"), "x");
        std::fs::File::options()
            .write(true)
            .open(repo.join(".archify/big/candidate.json"))
            .unwrap()
            .set_len(SOURCE_MAX + 1)
            .unwrap();
        let out = sh(&source_script(&path, "big"), home.path());
        assert!(String::from_utf8_lossy(&out.stderr).contains("too large"));
    }

    #[test]
    fn a_diagram_becomes_a_work_item() {
        let ticket = work_item(
            "hp",
            "app",
            "architecture-billing-flow-20261101-120000",
            "{\"nodes\":[]}",
        );
        assert_eq!(ticket.source, SOURCE);
        assert_eq!(ticket.item_id, "architecture-billing-flow-20261101-120000");
        assert_eq!(ticket.id, "architecture-billing-flow");
        assert_eq!(ticket.title, "architecture billing flow");
        assert!(ticket.description.contains("the folder app on hp"));
        assert!(ticket.description.contains("{\"nodes\":[]}"));
        assert!(ticket.url.is_empty());
    }

    #[test]
    fn the_prompt_says_how_to_draw_and_what_not_to_touch() {
        let prompt = draw_prompt("the billing flow");
        assert!(prompt.contains("~/.local/share/yardbell/archify/3.2.0/SKILL.md"));
        assert!(prompt.contains("ARCHIFY_UPDATE_CHECK_DISABLED=1"));
        assert!(prompt.contains("outside .archify/"));
        assert!(prompt.contains("no browser"));
        assert!(prompt.contains("the billing flow"));
        assert!(!draw_prompt("  ").contains("Focus on"));
    }
}

use super::diff::{gather_prelude, parse_anchor};
use crate::config::Machine;
use crate::dispatch::store::{new_id, write_private};
use crate::folders::Folders;
use crate::shell::{quote, Duration};
use base64::Engine;
use serde_json::{json, Value};
use std::path::Path;

pub const MAX_SHOTS: usize = 6;
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_STORED: u64 = 24 * 1024 * 1024;
const MAX_NAME: usize = 80;
const TIMEOUT: Duration = Duration::from_secs(30);
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

pub fn valid_name(name: &str) -> bool {
    let ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_');
    name.len() <= MAX_NAME
        && name.chars().all(ok)
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name.to_ascii_lowercase().ends_with(".png")
        && name.len() > 4
}

pub fn valid_file(file: &str) -> bool {
    file.strip_suffix(".png").is_some_and(|id| {
        id.len() == 16
            && id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    })
}

pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(PNG) || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
    Some((word(16), word(20))).filter(|(w, h)| *w > 0 && *h > 0)
}

enum Read {
    File(Vec<u8>),
    Missing,
    Big(u64),
}

fn script(path: &str, want: &str, folder: &str, names: &[String]) -> String {
    let mut text = gather_prelude(path, want);
    if names.is_empty() {
        return text;
    }
    let list: Vec<String> = names.iter().map(|n| quote(n)).collect();
    text.push_str(&format!(
        "d=$(git rev-parse --git-path {}); case \"$d\" in /*) ;; *) d=\"$PWD/$d\" ;; esac; \
         printf 'DIR\\t%s\\n' \"$d\"; \
         for f in {}; do p=\"$d/$f\"; \
         if [ -L \"$p\" ] || [ ! -f \"$p\" ]; then printf 'MISSING\\t%s\\n' \"$f\"; continue; fi; \
         n=$(wc -c < \"$p\" | tr -d ' '); \
         if [ \"$n\" -gt {MAX_BYTES} ]; then printf 'BIG\\t%s\\t%s\\n' \"$f\" \"$n\"; continue; fi; \
         printf 'FILE\\t%s\\n' \"$f\"; base64 < \"$p\"; printf '\\nEND\\n'; done",
        quote(&format!("yardbell-review/{folder}")),
        list.join(" ")
    ));
    text
}

fn parse_files(out: &str) -> Vec<(String, Read)> {
    let mut found = Vec::new();
    let mut lines = out.lines();
    while let Some(line) = lines.next() {
        if let Some(name) = line.strip_prefix("MISSING\t") {
            found.push((name.to_string(), Read::Missing));
        } else if let Some(rest) = line.strip_prefix("BIG\t") {
            let (name, size) = rest.split_once('\t').unwrap_or((rest, "0"));
            found.push((
                name.to_string(),
                Read::Big(size.trim().parse().unwrap_or(0)),
            ));
        } else if let Some(name) = line.strip_prefix("FILE\t") {
            let body: String = lines
                .by_ref()
                .take_while(|l| *l != "END")
                .flat_map(|l| l.chars().filter(|c| !c.is_whitespace()))
                .collect();
            let read = base64::engine::general_purpose::STANDARD
                .decode(body)
                .map(Read::File)
                .unwrap_or(Read::Missing);
            found.push((name.to_string(), read));
        }
    }
    found
}

fn stored_bytes(store: &Path) -> u64 {
    std::fs::read_dir(store)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_048_576.0)
}

fn wanted(card: &Value) -> Vec<(usize, String)> {
    card["findings"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .flat_map(|(i, f)| {
            f["shots"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(move |name| (i, name.to_string()))
        })
        .collect()
}

// Copies the screenshots a finished review names into Yardbell's state, and notes where its
// diff starts, while the reviewer's folder is still as it left it. Copies, so the card keeps
// them when the worktree is removed or the machine is down, and nothing is read from the
// machine again when the card is shown.
pub async fn gather(mut card: Value, store: &Path, folders: &Folders, m: &Machine) -> Value {
    let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let path = Some(text(&card["of"]["path"]))
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| text(&card["path"]));
    let folder = text(&card["of"]["evidence"]);
    let named = wanted(&card);
    let mut names: Vec<String> = Vec::new();
    for (_, name) in &named {
        if valid_name(name) && !names.contains(name) && names.len() < MAX_SHOTS {
            names.push(name.clone());
        }
    }
    let usable = folder.len() == 12 && folder.chars().all(|c| c.is_ascii_alphanumeric());
    if !usable {
        names.clear();
    }
    let out = folders
        .exec(
            m,
            &script(&path, &text(&card["base"]), &folder, &names),
            TIMEOUT,
        )
        .await;
    let out = match out {
        Ok(out) => out,
        Err(e) => {
            card["diff"] = json!({ "error": e });
            String::new()
        }
    };
    if !out.is_empty() {
        card["diff"] = match parse_anchor(&out) {
            Ok(anchor) => json!(anchor),
            Err(e) => json!({ "error": e }),
        };
    }
    if named.is_empty() {
        return card;
    }
    let dir = out
        .lines()
        .find_map(|l| l.strip_prefix("DIR\t"))
        .unwrap_or_default()
        .to_string();
    let mut read = parse_files(&out);
    let mut kept: Vec<(String, Value)> = Vec::new();
    let mut used = stored_bytes(store);
    let mut evidence = Vec::new();
    for (finding, name) in named {
        let entry = |more: Value| {
            let mut e = json!({ "finding": finding, "name": name });
            for (k, v) in more.as_object().into_iter().flatten() {
                e[k] = v.clone();
            }
            e
        };
        if let Some((_, done)) = kept.iter().find(|(n, _)| *n == name) {
            evidence.push(entry(done.clone()));
            continue;
        }
        let outcome = if !valid_name(&name) {
            json!({ "error": "not a PNG file name Yardbell can use" })
        } else if !usable {
            json!({ "error": "this review was not offered screenshots" })
        } else if !names.contains(&name) {
            json!({ "error": format!("more than {MAX_SHOTS} screenshots") })
        } else {
            match read
                .iter()
                .position(|(n, _)| *n == name)
                .map(|i| read.remove(i).1)
            {
                None if out.is_empty() => json!({ "error": format!("{} did not answer", m.name) }),
                None | Some(Read::Missing) => json!({ "error": "not found in the review folder" }),
                Some(Read::Big(n)) => {
                    json!({ "error": format!("{} is over the {} limit", mb(n), mb(MAX_BYTES)) })
                }
                Some(Read::File(bytes)) => keep(&bytes, store, &mut used, &format!("{dir}/{name}")),
            }
        };
        kept.push((name.clone(), outcome.clone()));
        evidence.push(entry(outcome));
    }
    card["evidence"] = json!(evidence);
    card
}

fn keep(bytes: &[u8], store: &Path, used: &mut u64, source: &str) -> Value {
    let size = bytes.len() as u64;
    let Some((width, height)) = png_size(bytes) else {
        return json!({ "error": "not a PNG image" });
    };
    if size > MAX_BYTES {
        return json!({ "error": format!("{} is over the {} limit", mb(size), mb(MAX_BYTES)) });
    }
    if *used + size > MAX_STORED {
        return json!({ "error": format!("this conversation already keeps {} of screenshots, the most it can", mb(MAX_STORED)) });
    }
    let file = format!("{}.png", new_id());
    if let Err(e) = write_private(&store.join(&file), bytes) {
        tracing::warn!(error = %e, "could not keep a review screenshot");
        return json!({ "error": format!("could not be saved: {e}") });
    }
    *used += size;
    json!({ "file": file, "bytes": size, "width": width, "height": height, "source": source })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Output;
    use crate::testing::FakeRunner;
    use std::sync::Arc;

    const MB: &str = "1111111111111111111111111111111111111111";
    const HEAD: &str = "2222222222222222222222222222222222222222";

    fn png(width: u32, height: u32, pad: usize) -> Vec<u8> {
        let mut bytes = PNG.to_vec();
        bytes.extend([0, 0, 0, 13]);
        bytes.extend(b"IHDR");
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend(vec![0u8; pad]);
        bytes
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

    fn card(shots: &[&[&str]]) -> Value {
        json!({
            "role": "review",
            "path": "/r/app",
            "of": { "machine": "hp", "name": "hp-app", "path": "/r/app", "evidence": "abcdef123456" },
            "base": "main",
            "findings": shots.iter().map(|s| json!({ "severity": "high", "place": "a.rs:1", "text": "x", "shots": s })).collect::<Vec<_>>(),
        })
    }

    fn encoded(bytes: &[u8]) -> String {
        let text = base64::engine::general_purpose::STANDARD.encode(bytes);
        text.as_bytes()
            .chunks(76)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn rig() -> (Arc<FakeRunner>, Folders, tempfile::TempDir) {
        let fake = Arc::new(FakeRunner::default());
        let folders = Folders::new(
            fake.clone(),
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        );
        (fake, folders, tempfile::tempdir().unwrap())
    }

    #[test]
    fn names_files_and_pngs_are_checked() {
        for good in ["login.png", "Step-2_after.PNG", "a.b.png"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in [
            ".png",
            "../x.png",
            "a/b.png",
            "-x.png",
            ".hidden.png",
            "x.jpg",
            "a b.png",
            "x.png;id",
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(valid_name(&format!("{}.png", "a".repeat(MAX_NAME - 4))));
        assert!(!valid_name(&format!("{}.png", "a".repeat(MAX_NAME))));
        assert!(valid_file("abcdefgh12345678.png"));
        for bad in [
            "../abcdefgh1234567.png",
            "ABCDEFGH12345678.png",
            "abcdefgh12345678.svg",
            "abc.png",
        ] {
            assert!(!valid_file(bad), "{bad}");
        }
        assert_eq!(png_size(&png(1280, 800, 0)), Some((1280, 800)));
        assert_eq!(png_size(b"GIF89a................."), None);
        assert_eq!(png_size(&png(0, 800, 0)), None);
    }

    #[tokio::test]
    async fn screenshots_are_copied_with_their_size_and_the_base_is_noted() {
        let (fake, folders, store) = rig();
        let image = png(640, 400, 100);
        let out = format!(
            "HEAD\t{HEAD}\nBASE\tmain\nMB\t{MB}\nDIR\t/r/app/.git/yardbell-review/abcdef123456\n\
             FILE\tlogin.png\n{}\nEND\nMISSING\tgone.png\nBIG\thuge.png\t9000000\nFILE\tfake.png\n{}\nEND\n",
            encoded(&image),
            encoded(b"<svg onload=alert(1)>")
        );
        fake.stub("yardbell-review/abcdef123456", Output::ok_with(&out));
        let shots: &[&[&str]] = &[
            &["login.png", "gone.png"],
            &["huge.png", "fake.png", "login.png", "../../x.png"],
        ];
        let done = gather(card(shots), store.path(), &folders, &machine()).await;
        assert_eq!(
            done["diff"],
            json!({ "base": "main", "merge_base": MB, "head": HEAD })
        );
        let ev = done["evidence"].as_array().unwrap();
        assert_eq!(ev.len(), 6);
        assert_eq!(
            (
                ev[0]["finding"].clone(),
                ev[0]["width"].clone(),
                ev[0]["height"].clone()
            ),
            (json!(0), json!(640), json!(400))
        );
        assert_eq!(
            ev[0]["source"],
            "/r/app/.git/yardbell-review/abcdef123456/login.png"
        );
        let file = ev[0]["file"].as_str().unwrap();
        assert!(valid_file(file));
        assert_eq!(std::fs::read(store.path().join(file)).unwrap(), image);
        assert_eq!(ev[1]["error"], "not found in the review folder");
        assert_eq!(ev[2]["error"], "8.6 MB is over the 2.0 MB limit");
        assert_eq!(ev[3]["error"], "not a PNG image");
        assert_eq!(
            (ev[4]["finding"].clone(), ev[4]["file"].clone()),
            (json!(1), json!(file)),
            "kept once"
        );
        assert_eq!(ev[5]["error"], "not a PNG file name Yardbell can use");
        assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 1);

        let script = fake.calls()[0].last().unwrap().clone();
        assert!(
            script.contains("for f in 'login.png' 'gone.png' 'huge.png' 'fake.png'; do"),
            "{script}"
        );
        assert!(script.contains("want='main';"));
        assert!(script.contains("[ -L \"$p\" ]"), "links are not followed");
    }

    #[tokio::test]
    async fn the_limits_hold() {
        let (fake, folders, store) = rig();
        let names: Vec<String> = (0..MAX_SHOTS + 1).map(|i| format!("s{i}.png")).collect();
        let image = png(10, 10, (MAX_BYTES as usize) - 40);
        let mut out = format!("HEAD\t{HEAD}\nBASE\tmain\nMB\t{MB}\nDIR\t/d\n");
        for name in &names {
            out.push_str(&format!("FILE\t{name}\n{}\nEND\n", encoded(&image)));
        }
        fake.stub("yardbell-review", Output::ok_with(&out));
        std::fs::write(
            store.path().join("aaaaaaaaaaaaaaaa.png"),
            vec![0u8; (MAX_STORED - 3 * MAX_BYTES) as usize],
        )
        .unwrap();
        let list: Vec<&str> = names.iter().map(String::as_str).collect();
        let done = gather(card(&[&list]), store.path(), &folders, &machine()).await;
        let errors: Vec<&str> = done["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["error"].as_str().unwrap_or("kept"))
            .collect();
        assert_eq!(
            errors,
            [
                "kept",
                "kept",
                "kept",
                "this conversation already keeps 24.0 MB of screenshots, the most it can",
                "this conversation already keeps 24.0 MB of screenshots, the most it can",
                "this conversation already keeps 24.0 MB of screenshots, the most it can",
                "more than 6 screenshots",
            ]
        );
        let script = fake.calls()[0].last().unwrap().clone();
        assert!(!script.contains("'s6.png'"), "the seventh is not read");
        assert!(stored_bytes(store.path()) <= MAX_STORED);
    }

    #[tokio::test]
    async fn a_review_without_screenshots_or_a_machine_still_gets_its_card() {
        let (fake, folders, store) = rig();
        let mut plain = card(&[&[]]);
        plain["of"]["evidence"] = json!("");
        fake.stub(
            "merge-base",
            Output::ok_with(&format!("HEAD\t{HEAD}\nBASE\t\nMB\t{HEAD}\n")),
        );
        let done = gather(plain, store.path(), &folders, &machine()).await;
        assert!(done.get("evidence").is_none());
        assert_eq!(done["diff"]["merge_base"], HEAD);
        assert!(!fake.calls()[0].last().unwrap().contains("yardbell-review"));

        let (fake, folders, store) = rig();
        fake.stub("ssh", Output::timeout());
        let done = gather(card(&[&["a.png"]]), store.path(), &folders, &machine()).await;
        assert_eq!(done["diff"]["error"], "hp did not answer in time");
        assert_eq!(done["evidence"][0]["error"], "hp did not answer");

        let (_, folders, store) = rig();
        let mut unoffered = card(&[&["a.png"]]);
        unoffered["of"]["evidence"] = json!("");
        let done = gather(unoffered, store.path(), &folders, &machine()).await;
        assert_eq!(
            done["evidence"][0]["error"],
            "this review was not offered screenshots"
        );
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
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
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn a_real_repository_gives_its_base_and_screenshots() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("app");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let base = git(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.join("a.txt"), "b\n").unwrap();
        git(&repo, &["commit", "-q", "-am", "change"]);
        let head = git(&repo, &["rev-parse", "HEAD"]);
        let shots = repo.join(".git/yardbell-review/abcdef123456");
        std::fs::create_dir_all(&shots).unwrap();
        let image = png(8, 6, 10);
        std::fs::write(shots.join("login.png"), &image).unwrap();
        std::os::unix::fs::symlink(repo.join("a.txt"), shots.join("link.png")).unwrap();

        let folders = Folders::new(
            Arc::new(crate::shell::RealRunner::default()),
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        );
        let mut local = machine();
        local.ssh = None;
        local.local = true;
        let mut review = card(&[&["login.png", "link.png"]]);
        review["of"]["path"] = json!(repo.join("..").join("app").display().to_string());
        review["base"] = json!("");
        let store = tempfile::tempdir().unwrap();
        let done = gather(review, store.path(), &folders, &local).await;
        assert_eq!(
            done["diff"],
            json!({ "base": "main", "merge_base": base, "head": head }),
            "{done}"
        );
        let ev = &done["evidence"];
        assert_eq!(
            (&ev[0]["width"], &ev[0]["height"]),
            (&json!(8), &json!(6)),
            "{ev}"
        );
        let kept = store.path().join(ev[0]["file"].as_str().unwrap());
        assert_eq!(std::fs::read(kept).unwrap(), image);
        assert_eq!(
            ev[1]["error"], "not found in the review folder",
            "links are refused"
        );
        assert_eq!(
            git(&repo, &["status", "--porcelain"]),
            "",
            "nothing changed"
        );
    }
}

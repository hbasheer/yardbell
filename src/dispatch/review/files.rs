use super::diff::{page, valid_path, Line};
use crate::config::Machine;
use crate::folders::Folders;
use crate::shell::{quote, Duration};
use serde::Serialize;
use serde_json::Value;

const FILE_BYTES: usize = 2_000_000;
const LINE_CHARS: usize = 2000;
const TIMEOUT: Duration = Duration::from_secs(20);
const MARK: &str = "@@YB-FILE@@";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileView {
    pub path: String,
    pub binary: bool,
    pub lines: Vec<Line>,
    pub from: usize,
    pub next: usize,
    pub total: usize,
    pub cut: bool,
}

// "src/a.rs:88", "src/a.rs:88-92" or "./src/a.rs" all point at src/a.rs, as the card's links do:
// the path ends at the first colon that only numbers follow.
pub fn place_path(place: &str) -> Option<String> {
    let place = place.trim().trim_matches('`');
    let numbers = |t: &str| {
        t.starts_with(|c: char| c.is_ascii_digit())
            && t.chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | ','))
    };
    let path = place
        .match_indices(':')
        .find(|(at, _)| *at > 0 && numbers(&place[at + 1..]))
        .map_or(place, |(at, _)| &place[..at]);
    let path = path.strip_prefix("./").unwrap_or(path);
    valid_path(path).then(|| path.to_string())
}

// The files a card's findings point at, each once, in the order the findings name them. Only
// these can be shown, so a card cannot be used to read anything else in the folder.
pub fn places(card: &Value) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for f in card["findings"].as_array().into_iter().flatten() {
        if let Some(path) = f["place"].as_str().and_then(place_path) {
            if !files.contains(&path) {
                files.push(path);
            }
        }
    }
    files
}

// Reads the file as it is now, refusing a symbolic link and anything that resolves outside the
// folder. It only reads.
fn script(folder: &str, file: &str) -> String {
    format!(
        "cd {0} 2>/dev/null || {{ echo 'ERR the folder {1} is gone'; exit 0; }}; \
         top=$(pwd -P); f={2}; \
         real=$(cd -- \"$(dirname -- \"$f\")\" 2>/dev/null && pwd -P) || {{ echo 'ERR missing'; exit 0; }}; \
         case \"$real/\" in \"$top\"/*) ;; *) echo 'ERR outside'; exit 0 ;; esac; \
         [ -L \"$f\" ] && {{ echo 'ERR link'; exit 0; }}; \
         [ -f \"$f\" ] || {{ echo 'ERR missing'; exit 0; }}; \
         printf '{MARK}\\n'; head -c {3} -- \"$f\"",
        quote(folder),
        folder.replace('\'', ""),
        quote(file),
        FILE_BYTES + 1
    )
}

fn clip(text: &str) -> String {
    if text.chars().count() <= LINE_CHARS {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(LINE_CHARS).collect();
    cut.push('…');
    cut
}

pub fn parse_file(file: &str, out: &str) -> Result<(Vec<Line>, bool, bool), String> {
    let Some((head, body)) = out.split_once(&format!("{MARK}\n")) else {
        let why = head_error(out).unwrap_or("missing");
        return Err(match why {
            "outside" => format!("{file} is outside the scanned folder"),
            "link" => format!("{file} is a symbolic link, so it is not shown"),
            "missing" => format!("{file} is not in the scanned folder"),
            other => other.to_string(),
        });
    };
    if let Some(e) = head_error(head) {
        return Err(e.to_string());
    }
    let cut = body.len() > FILE_BYTES;
    let mut text = &body[..body.floor_char_boundary(FILE_BYTES.min(body.len()))];
    if cut {
        text = text.rsplit_once('\n').map(|(h, _)| h).unwrap_or("");
    }
    if text.contains('\0') {
        return Ok((Vec::new(), true, false));
    }
    let lines = text
        .lines()
        .enumerate()
        .map(|(i, t)| Line {
            k: "ctx",
            o: None,
            n: Some(i as u64 + 1),
            t: clip(t),
        })
        .collect();
    Ok((lines, false, cut))
}

fn head_error(head: &str) -> Option<&str> {
    head.lines().find_map(|l| l.strip_prefix("ERR "))
}

pub async fn file_view(
    folders: &Folders,
    m: &Machine,
    folder: &str,
    card: &Value,
    file: &str,
    from: usize,
    line: Option<u64>,
) -> Result<FileView, String> {
    if !valid_path(file) || !places(card).iter().any(|p| p == file) {
        return Err(format!("no finding points at {file}"));
    }
    let out = folders.exec(m, &script(folder, file), TIMEOUT).await?;
    let (lines, binary, cut) = parse_file(file, &out)?;
    let (from, next) = page(&lines, from, line);
    Ok(FileView {
        path: file.to_string(),
        binary,
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
    use serde_json::json;
    use std::sync::Arc;

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

    fn card() -> Value {
        json!({ "findings": [
            { "place": "src/a.rs:88-92" },
            { "place": "./src/a.rs:3" },
            { "place": "`Cargo.lock`" },
            { "place": "../etc/passwd:1" },
            { "place": "/etc/passwd" },
            { "place": "" },
            { "place": "config/app.yml:4:2" },
        ] })
    }

    #[test]
    fn only_safe_places_in_the_findings_are_files() {
        assert_eq!(
            places(&card()),
            ["src/a.rs", "Cargo.lock", "config/app.yml"]
        );
        assert_eq!(
            place_path("notes:todo.md").as_deref(),
            Some("notes:todo.md")
        );
        assert_eq!(place_path("a:b:3").as_deref(), Some("a:b"));
        assert_eq!(place_path("a/../b.rs:1"), None);
        assert!(places(&json!({})).is_empty());
    }

    #[test]
    fn a_file_is_numbered_and_its_errors_named() {
        let (lines, binary, cut) =
            parse_file("a.rs", "@@YB-FILE@@\nfn a() {}\n\nERR not an error\n").unwrap();
        assert!(!binary && !cut);
        let brief: Vec<_> = lines.iter().map(|l| (l.n, l.t.as_str())).collect();
        assert_eq!(
            brief,
            [
                (Some(1), "fn a() {}"),
                (Some(2), ""),
                (Some(3), "ERR not an error")
            ]
        );
        let (lines, binary, _) = parse_file("i.png", "@@YB-FILE@@\n\u{89}PNG\0\0").unwrap();
        assert!(binary && lines.is_empty());
        for (out, err) in [
            ("ERR outside\n", "x is outside the scanned folder"),
            ("ERR link\n", "x is a symbolic link, so it is not shown"),
            ("ERR missing\n", "x is not in the scanned folder"),
            (
                "ERR the folder /r/app is gone\n",
                "the folder /r/app is gone",
            ),
            ("", "x is not in the scanned folder"),
        ] {
            assert_eq!(parse_file("x", out).unwrap_err(), err);
        }
        let long = format!("@@YB-FILE@@\n{}", "y\n".repeat(FILE_BYTES));
        let (lines, _, cut) = parse_file("big", &long).unwrap();
        assert!(cut && lines.len() < FILE_BYTES / 2 + 1);
    }

    #[tokio::test]
    async fn only_files_a_finding_names_are_read() {
        let fake = Arc::new(FakeRunner::default());
        fake.stub("@@YB-FILE@@", Output::ok_with("@@YB-FILE@@\none\ntwo\n"));
        let folders = Folders::new(
            fake.clone(),
            crate::ssh::Ssh::new(tempfile::tempdir().unwrap().keep()),
        );
        for bad in ["../etc/passwd", "/etc/passwd", "src/other.rs", "src/a.rs\n"] {
            let err = file_view(&folders, &machine(), "/r/app", &card(), bad, 0, None)
                .await
                .unwrap_err();
            assert_eq!(err, format!("no finding points at {bad}"));
        }
        assert!(fake.calls().is_empty(), "nothing ran for a refused path");
        let view = file_view(
            &folders,
            &machine(),
            "/r/app",
            &card(),
            "src/a.rs",
            0,
            Some(2),
        )
        .await
        .unwrap();
        assert_eq!((view.total, view.lines[1].t.as_str()), (2, "two"));
        let script = fake.calls()[0].last().unwrap().clone();
        assert!(script.contains("; cd '/r/app' 2>/dev/null"), "{script}");
        assert!(script.contains("f='src/a.rs';"), "{script}");
        assert!(script.contains("[ -L \"$f\" ]"));
        assert!(script.contains("case \"$real/\" in \"$top\"/*)"));
        for writes in [" > ", ">>", "rm ", "git "] {
            assert!(!script.contains(writes), "{writes} in {script}");
        }
    }
}

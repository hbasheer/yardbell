use super::store::write_private;
use crate::config::RunsOn;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const KB: usize = 1024;
const MB: usize = 1024 * KB;
const MAX_FILES: usize = 10;
const MAX_IMAGE: usize = 5 * MB;
const MAX_PDF: usize = 32 * MB;
const MAX_TEXT: usize = 256 * KB;
const MAX_TOTAL: usize = 40 * MB;
const NAME_CHARS: usize = 80;

pub struct Attachment {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Pdf,
    Text,
}

impl Kind {
    pub fn of(bytes: &[u8]) -> Option<Kind> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Kind::Png)
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            Some(Kind::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Kind::Gif)
        } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
            Some(Kind::Webp)
        } else if bytes.starts_with(b"%PDF-") {
            Some(Kind::Pdf)
        } else if !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok() {
            Some(Kind::Text)
        } else {
            None
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Kind::Png => "image/png",
            Kind::Jpeg => "image/jpeg",
            Kind::Gif => "image/gif",
            Kind::Webp => "image/webp",
            Kind::Pdf => "application/pdf",
            Kind::Text => "text/plain; charset=utf-8",
        }
    }

    pub fn group(self) -> &'static str {
        match self {
            Kind::Pdf => "pdf",
            Kind::Text => "text",
            _ => "image",
        }
    }

    fn limit(self) -> (usize, &'static str) {
        match self {
            Kind::Pdf => (MAX_PDF, "32 MB"),
            Kind::Text => (MAX_TEXT, "256 KB"),
            _ => (MAX_IMAGE, "5 MB"),
        }
    }
}

pub fn check(files: &[Attachment], runs_on: RunsOn) -> Result<(), String> {
    if files.len() > MAX_FILES {
        return Err(format!("attach at most {MAX_FILES} files to one message"));
    }
    for f in files {
        let name = &f.name;
        if f.bytes.is_empty() {
            return Err(format!("{name} is empty"));
        }
        let kind = Kind::of(&f.bytes)
            .ok_or_else(|| format!("{name} is not an image, a PDF or a text file"))?;
        if kind == Kind::Pdf && runs_on == RunsOn::Codex {
            return Err(codex_pdf(name));
        }
        let (limit, words) = kind.limit();
        if f.bytes.len() > limit {
            return Err(format!("{name} is over {words}"));
        }
    }
    if files.iter().map(|f| f.bytes.len()).sum::<usize>() > MAX_TOTAL {
        return Err("these files come to more than 40 MB together".into());
    }
    Ok(())
}

pub fn codex_pdf(name: &str) -> String {
    format!("Codex cannot read PDFs, so {name} cannot be sent in this conversation")
}

fn allowed(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')
}

pub fn clean(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mapped: String = last
        .chars()
        .map(|c| if allowed(c) { c } else { '_' })
        .collect();
    let cut: String = mapped
        .trim_start_matches('.')
        .chars()
        .take(NAME_CHARS)
        .collect();
    if cut.is_empty() {
        "file".into()
    } else {
        cut
    }
}

pub fn valid_file(file: &str) -> bool {
    let Some((n, name)) = file.split_once('-') else {
        return false;
    };
    !n.is_empty()
        && n.bytes().all(|b| b.is_ascii_digit())
        && !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(allowed)
}

pub fn folder(dir: &Path, conversation: &str) -> PathBuf {
    dir.join("attachments").join(conversation)
}

pub struct File {
    pub kind: Kind,
    pub shown: String,
    pub name: String,
    pub file: String,
    pub path: PathBuf,
    pub bytes: Vec<u8>,
}

impl File {
    pub fn event(&self) -> Value {
        json!({
            "file": self.file,
            "name": self.shown,
            "kind": self.kind.group(),
            "size": self.bytes.len(),
        })
    }
}

pub fn prepare(dir: &Path, conversation: &str, first: usize, files: Vec<Attachment>) -> Vec<File> {
    let folder = folder(dir, conversation);
    files
        .into_iter()
        .enumerate()
        .map(|(i, a)| {
            let name = clean(&a.name);
            let file = format!("{}-{name}", first + i);
            File {
                kind: Kind::of(&a.bytes).unwrap_or(Kind::Text),
                path: folder.join(&file),
                shown: a.name,
                name,
                file,
                bytes: a.bytes,
            }
        })
        .collect()
}

pub fn write(files: &[File]) -> Result<(), String> {
    for f in files {
        write_private(&f.path, &f.bytes).map_err(|e| format!("could not save {}: {e}", f.shown))?;
    }
    Ok(())
}

pub fn text_block(name: &str, bytes: &[u8]) -> String {
    format!(
        "<file name=\"{name}\">\n{}\n</file>",
        String::from_utf8_lossy(bytes)
    )
}

pub fn read(dir: &Path, conversation: &str, file: &str) -> Option<(Kind, Vec<u8>)> {
    if !valid_file(file) {
        return None;
    }
    let bytes = std::fs::read(folder(dir, conversation).join(file)).ok()?;
    Some((Kind::of(&bytes)?, bytes))
}

pub fn recorded(events: &[Value]) -> usize {
    events
        .iter()
        .filter(|e| e["role"] == "user")
        .filter_map(|e| e["attachments"].as_array())
        .map(Vec::len)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";
    const PDF: &[u8] = b"%PDF-1.7";

    fn file(name: &str, bytes: &[u8]) -> Attachment {
        Attachment {
            name: name.into(),
            bytes: bytes.to_vec(),
        }
    }

    fn sized(name: &str, head: &[u8], size: usize) -> Attachment {
        let mut bytes = head.to_vec();
        bytes.resize(size, b'a');
        file(name, &bytes)
    }

    #[test]
    fn kinds_come_from_the_bytes() {
        assert_eq!(Kind::of(PNG), Some(Kind::Png));
        assert_eq!(Kind::of(b"\xff\xd8\xffrest"), Some(Kind::Jpeg));
        assert_eq!(Kind::of(b"GIF89arest"), Some(Kind::Gif));
        assert_eq!(Kind::of(b"GIF87arest"), Some(Kind::Gif));
        assert_eq!(Kind::of(b"RIFF\0\0\0\0WEBPrest"), Some(Kind::Webp));
        assert_eq!(Kind::of(PDF), Some(Kind::Pdf));
        assert_eq!(Kind::of("café log\n".as_bytes()), Some(Kind::Text));
        assert_eq!(Kind::of(b"PK\x03\x04\x14\0\0\0"), None);
        assert_eq!(Kind::of(b"a\0b"), None);
        assert_eq!(Kind::of(&[0xe9, b'a']), None);
    }

    #[test]
    fn each_limit_at_and_over_the_edge() {
        for (name, head, limit, words) in [
            ("big.png", PNG, 5 * MB, "5 MB"),
            ("big.pdf", PDF, 32 * MB, "32 MB"),
            ("big.log", b"x".as_slice(), 256 * KB, "256 KB"),
        ] {
            assert_eq!(
                check(&[sized(name, head, limit)], RunsOn::Claude),
                Ok(()),
                "{name} at its limit"
            );
            assert_eq!(
                check(&[sized(name, head, limit + 1)], RunsOn::Claude),
                Err(format!("{name} is over {words}"))
            );
        }
    }

    #[test]
    fn too_many_or_too_much_together() {
        let many: Vec<_> = (0..11).map(|n| file(&format!("{n}.txt"), b"hi")).collect();
        assert_eq!(
            check(&many, RunsOn::Claude),
            Err("attach at most 10 files to one message".into())
        );
        assert_eq!(check(&many[..10], RunsOn::Claude), Ok(()));
        let two = [sized("a.pdf", PDF, 21 * MB), sized("b.pdf", PDF, 21 * MB)];
        assert_eq!(
            check(&two, RunsOn::Claude),
            Err("these files come to more than 40 MB together".into())
        );
    }

    #[test]
    fn refusals_name_the_file() {
        assert_eq!(
            check(
                &[file("trace.zip", b"PK\x03\x04\x14\0\0\0")],
                RunsOn::Claude
            ),
            Err("trace.zip is not an image, a PDF or a text file".into())
        );
        assert_eq!(
            check(&[file("notes.txt", b"")], RunsOn::Claude),
            Err("notes.txt is empty".into())
        );
    }

    #[test]
    fn codex_refuses_pdfs_claude_does_not() {
        assert_eq!(
            check(&[file("a.pdf", PDF)], RunsOn::Codex),
            Err("Codex cannot read PDFs, so a.pdf cannot be sent in this conversation".into())
        );
        assert_eq!(check(&[file("a.pdf", PDF)], RunsOn::Claude), Ok(()));
        assert_eq!(check(&[file("a.png", PNG)], RunsOn::Codex), Ok(()));
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean("../../etc/passwd"), "passwd");
        assert_eq!(clean("C:\\Users\\me\\shot.png"), "shot.png");
        assert_eq!(clean("résumé final.pdf"), "r_sum__final.pdf");
        assert_eq!(clean("..."), "file");
        assert_eq!(clean(".env"), "env");
        assert_eq!(clean(""), "file");
        assert_eq!(clean(&"a".repeat(300)).len(), 80);
    }

    #[test]
    fn files_are_numbered_from_first_and_stay_in_their_folder() {
        let dir = tempfile::tempdir().unwrap();
        let files = prepare(
            dir.path(),
            "c1",
            3,
            vec![file("a.png", PNG), file("../a.png", PNG)],
        );
        assert_eq!(
            files.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(),
            ["3-a.png", "4-a.png"]
        );
        assert_eq!(files[1].shown, "../a.png");
        assert_eq!(files[1].name, "a.png");
        for f in &files {
            assert!(f.path.starts_with(folder(dir.path(), "c1")), "{:?}", f.path);
        }
        write(&files).unwrap();
        assert_eq!(
            read(dir.path(), "c1", "4-a.png"),
            Some((Kind::Png, PNG.to_vec()))
        );
        assert_eq!(
            files[0].event(),
            json!({ "file": "3-a.png", "name": "a.png", "kind": "image", "size": PNG.len() })
        );
    }

    #[test]
    fn only_numbered_clean_names_are_valid() {
        assert!(valid_file("3-a.png"));
        assert!(valid_file("12-notes.log"));
        for bad in ["a.png", "3-../x", "3-a/b", "", "3-", "-a.png", "3-.env"] {
            assert!(!valid_file(bad), "{bad}");
        }
    }

    #[test]
    fn text_files_become_a_tagged_block() {
        assert_eq!(
            text_block("notes.log", b"hi"),
            "<file name=\"notes.log\">\nhi\n</file>"
        );
    }

    #[test]
    fn recorded_counts_the_files_on_user_messages() {
        let events = [
            json!({ "role": "user", "text": "a", "attachments": [{ "file": "0-a.png" }, { "file": "1-b.png" }] }),
            json!({ "role": "assistant", "text": "b" }),
            json!({ "role": "user", "text": "c" }),
        ];
        assert_eq!(recorded(&events), 2);
    }
}

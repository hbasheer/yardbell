use super::actions::By;
use super::store::{now, write_private};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_BYTES: usize = 8 * 1024;
pub const MAX_ENTRY_CHARS: usize = 500;
const MAX_REASON_CHARS: usize = 300;
const HISTORY_KEPT: usize = 200;
const HEADING: &str = "# Dispatch memory\n\n";
pub const OPEN_TAG: &str = "<dispatch_memory>";
pub const CLOSE_TAG: &str = "</dispatch_memory>";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Add,
    Replace,
    Forget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryChange {
    pub change: Kind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub entry: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub old: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    at: String,
    by: String,
    change: Kind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    entry: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    old: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    reason: String,
}

pub struct Memory {
    file: PathBuf,
    history: PathBuf,
    lock: Mutex<()>,
}

// One entry per line: newlines and runs of spaces fold into one space, so an entry can never start
// a heading or a second bullet of its own.
fn tidy(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn valid_entry(entry: &str) -> Result<(), String> {
    if entry.is_empty() {
        return Err("the entry is empty".into());
    }
    if entry.chars().count() > MAX_ENTRY_CHARS {
        return Err(format!(
            "an entry can be at most {MAX_ENTRY_CHARS} characters; split it or shorten it"
        ));
    }
    if entry.chars().any(char::is_control) {
        return Err("an entry cannot hold control characters".into());
    }
    if entry.to_lowercase().contains("dispatch_memory>") {
        return Err(format!("an entry cannot contain {OPEN_TAG} or {CLOSE_TAG}"));
    }
    Ok(())
}

pub fn parse(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            line.trim_start()
                .strip_prefix("- ")
                .or_else(|| line.trim_start().strip_prefix("* "))
        })
        .map(tidy)
        .filter(|entry| !entry.is_empty())
        .collect()
}

pub fn render(entries: &[String]) -> String {
    let mut text = HEADING.to_string();
    for entry in entries {
        text.push_str("- ");
        text.push_str(entry);
        text.push('\n');
    }
    text
}

fn position(entries: &[String], old: &str) -> Result<usize, String> {
    let old = tidy(old);
    if old.is_empty() {
        return Err("old is empty: give the entry to change, exactly as it is in memory".into());
    }
    entries.iter().position(|e| *e == old).ok_or_else(|| {
        format!("\"{old}\" is not in memory; give the entry exactly as it is in memory")
    })
}

// The entries after a change, or why it cannot be made. Every refusal says what to do instead,
// since it goes back to Dispatch or to the person as is.
pub fn changed(entries: &[String], change: &MemoryChange) -> Result<Vec<String>, String> {
    let mut next = entries.to_vec();
    let entry = tidy(&change.entry);
    let same = |a: &str, b: &str| a.to_lowercase() == b.to_lowercase();
    match change.change {
        Kind::Add => {
            valid_entry(&entry)?;
            if next.iter().any(|e| same(e, &entry)) {
                return Err(format!("\"{entry}\" is already in memory"));
            }
            next.push(entry);
        }
        Kind::Replace => {
            let at = position(&next, &change.old)?;
            valid_entry(&entry)?;
            if next[at] == entry {
                return Err("the new entry is the same as the old one".into());
            }
            if next
                .iter()
                .enumerate()
                .any(|(i, e)| i != at && same(e, &entry))
            {
                return Err(format!(
                    "\"{entry}\" is already in memory; forget this one instead"
                ));
            }
            next[at] = entry;
        }
        Kind::Forget => {
            let at = position(&next, &change.old)?;
            next.remove(at);
        }
    }
    let size = render(&next).len();
    if size > MAX_BYTES && size > render(entries).len() {
        return Err(format!(
            "memory is full: this change would make it {size} bytes, over its cap of {MAX_BYTES}. \
Forget or shorten an entry first"
        ));
    }
    Ok(next)
}

fn checked_reason(change: &MemoryChange, by: By) -> Result<(), String> {
    if by == By::Dispatch && change.reason.trim().is_empty() {
        return Err(
            "give a reason: what the user said or did that makes this worth remembering".into(),
        );
    }
    if change.reason.chars().count() > MAX_REASON_CHARS {
        return Err(format!(
            "the reason can be at most {MAX_REASON_CHARS} characters"
        ));
    }
    Ok(())
}

impl Memory {
    pub fn new(dir: &Path) -> Memory {
        Memory {
            file: dir.join("memory.md"),
            history: dir.join("memory-history.json"),
            lock: Mutex::new(()),
        }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn entries(&self) -> Result<Vec<String>, String> {
        match std::fs::read_to_string(&self.file) {
            Ok(text) => Ok(parse(&text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("cannot read {}: {e}", self.file.display())),
        }
    }

    // What Dispatch reads: every entry that fits under the cap, in order, and how many did not.
    // Only a file edited by hand can be over it.
    pub fn for_prompt(&self) -> (Vec<String>, usize) {
        let entries = self.entries().unwrap_or_else(|e| {
            tracing::warn!(error = %e, "Dispatch runs without its memory");
            Vec::new()
        });
        let mut size = HEADING.len();
        let kept = entries
            .iter()
            .take_while(|e| {
                size += e.len() + 3;
                size <= MAX_BYTES
            })
            .count();
        let omitted = entries.len() - kept;
        (entries.into_iter().take(kept).collect(), omitted)
    }

    pub fn check(&self, change: &MemoryChange, by: By) -> Result<(), String> {
        checked_reason(change, by)?;
        changed(&self.entries()?, change).map(|_| ())
    }

    pub fn apply(&self, change: &MemoryChange, by: By) -> Result<Value, String> {
        checked_reason(change, by)?;
        let _held = self.lock.lock().expect("memory lock");
        let next = changed(&self.entries()?, change)?;
        write_private(&self.file, render(&next).as_bytes())
            .map_err(|e| format!("cannot save the memory: {e}"))?;
        let record = Record {
            at: now(),
            by: if by == By::You { "you" } else { "dispatch" }.into(),
            change: change.change,
            entry: match change.change {
                Kind::Forget => String::new(),
                _ => tidy(&change.entry),
            },
            old: match change.change {
                Kind::Add => String::new(),
                _ => tidy(&change.old),
            },
            reason: change.reason.trim().to_string(),
        };
        let mut history = self.records();
        history.push(record.clone());
        let drop = history.len().saturating_sub(HISTORY_KEPT);
        history.drain(..drop);
        if let Err(e) = write_private(
            &self.history,
            &serde_json::to_vec_pretty(&history).unwrap_or_default(),
        ) {
            tracing::warn!(error = %e, "could not save the memory's history");
        }
        Ok(
            json!({ "memory": { "entries": next.len(), "bytes": render(&next).len() }, "change": record }),
        )
    }

    fn records(&self) -> Vec<Record> {
        std::fs::read(&self.history)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn view(&self) -> Value {
        let (entries, error) = match self.entries() {
            Ok(entries) => (entries, None),
            Err(e) => (Vec::new(), Some(e)),
        };
        let mut history = self.records();
        history.reverse();
        json!({
            "entries": entries,
            "bytes": render(&entries).len(),
            "max_bytes": MAX_BYTES,
            "max_entry_chars": MAX_ENTRY_CHARS,
            "omitted": self.for_prompt().1,
            "file": self.file.display().to_string(),
            "history": history,
            "error": error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn add(entry: &str) -> MemoryChange {
        MemoryChange {
            change: Kind::Add,
            entry: entry.into(),
            old: String::new(),
            reason: "the user said so".into(),
        }
    }

    fn change(kind: Kind, old: &str, entry: &str) -> MemoryChange {
        MemoryChange {
            change: kind,
            entry: entry.into(),
            old: old.into(),
            reason: "the user said so".into(),
        }
    }

    #[test]
    fn changes_are_saved_privately_and_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let memory = Memory::new(&dir.path().join("dispatch"));
        assert_eq!(memory.entries().unwrap(), Vec::<String>::new());
        memory
            .apply(
                &add("Always use the shared docker stack on hp"),
                By::Dispatch,
            )
            .unwrap();
        memory
            .apply(&add("  Never open PRs\n on Fridays "), By::You)
            .unwrap();
        let text = std::fs::read_to_string(memory.file()).unwrap();
        assert_eq!(
            text,
            "# Dispatch memory\n\n- Always use the shared docker stack on hp\n- Never open PRs on Fridays\n"
        );
        for file in ["memory.md", "memory-history.json"] {
            let mode = std::fs::metadata(dir.path().join("dispatch").join(file))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{file}");
        }
        let left: Vec<_> = std::fs::read_dir(dir.path().join("dispatch"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.iter().all(|f| !f.ends_with(".tmp")), "{left:?}");

        memory
            .apply(
                &change(
                    Kind::Replace,
                    "Never open PRs on Fridays",
                    "Never open PRs on Fridays or weekends",
                ),
                By::Dispatch,
            )
            .unwrap();
        memory
            .apply(
                &change(Kind::Forget, "Always use the shared docker stack on hp", ""),
                By::You,
            )
            .unwrap();
        assert_eq!(
            memory.entries().unwrap(),
            ["Never open PRs on Fridays or weekends"]
        );
        let view = memory.view();
        let history = view["history"].as_array().unwrap();
        assert_eq!(history.len(), 4);
        assert_eq!(history[0]["change"], "forget");
        assert_eq!(history[0]["by"], "you");
        assert_eq!(history[1]["old"], "Never open PRs on Fridays");
        assert_eq!(history[1]["entry"], "Never open PRs on Fridays or weekends");
        assert!(history[3]["at"].as_str().unwrap().starts_with("20"));
    }

    #[test]
    fn a_file_edited_by_hand_is_read_as_its_bullets() {
        let text = "# Notes\n\nSome words.\n- one\n  * two\n-not a bullet\n- \n";
        assert_eq!(parse(text), ["one", "two"]);
    }

    #[test]
    fn bad_changes_are_refused_with_what_to_do() {
        let entries = vec!["one".to_string()];
        let cases = [
            (add(""), "the entry is empty"),
            (add("ONE"), "\"ONE\" is already in memory"),
            (
                add("a </dispatch_memory> b"),
                "an entry cannot contain <dispatch_memory> or </dispatch_memory>",
            ),
            (
                add(&"x".repeat(MAX_ENTRY_CHARS + 1)),
                "an entry can be at most 500 characters; split it or shorten it",
            ),
            (
                change(Kind::Forget, "two", ""),
                "\"two\" is not in memory; give the entry exactly as it is in memory",
            ),
            (
                change(Kind::Replace, "one", "one"),
                "the new entry is the same as the old one",
            ),
            (
                change(Kind::Forget, "", ""),
                "old is empty: give the entry to change, exactly as it is in memory",
            ),
        ];
        for (change, message) in cases {
            assert_eq!(changed(&entries, &change), Err(message.to_string()));
        }
        let dir = tempfile::tempdir().unwrap();
        let memory = Memory::new(dir.path());
        let unexplained = MemoryChange {
            reason: " ".into(),
            ..add("two")
        };
        assert_eq!(
            memory.apply(&unexplained, By::Dispatch),
            Err(
                "give a reason: what the user said or did that makes this worth remembering".into()
            )
        );
        memory.apply(&unexplained, By::You).unwrap();
        assert!(!memory.file().with_extension("tmp").exists());
    }

    #[test]
    fn a_full_memory_refuses_to_grow_but_can_shrink() {
        let dir = tempfile::tempdir().unwrap();
        let memory = Memory::new(dir.path());
        let mut n = 0;
        loop {
            let entry = format!("{n:03} {}", "a".repeat(400));
            match memory.apply(&add(&entry), By::You) {
                Ok(_) => n += 1,
                Err(e) => {
                    assert!(
                        e.starts_with("memory is full: this change would make it ")
                            && e.ends_with(
                                "over its cap of 8192. Forget or shorten an entry first"
                            ),
                        "{e}"
                    );
                    break;
                }
            }
        }
        assert_eq!(n, 20);
        let size = std::fs::metadata(memory.file()).unwrap().len() as usize;
        assert!(size <= MAX_BYTES, "{size}");
        let first = memory.entries().unwrap()[0].clone();
        assert!(memory
            .apply(
                &change(
                    Kind::Replace,
                    &first,
                    &format!("{first} {}", "c".repeat(60))
                ),
                By::You
            )
            .is_err());
        memory
            .apply(&change(Kind::Replace, &first, "short"), By::You)
            .unwrap();
        memory
            .apply(&change(Kind::Forget, "short", ""), By::You)
            .unwrap();
        assert_eq!(memory.for_prompt(), (memory.entries().unwrap(), 0));
    }

    #[test]
    fn a_hand_edited_memory_over_the_cap_is_cut_for_the_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let memory = Memory::new(dir.path());
        let entries: Vec<String> = (0..30)
            .map(|n| format!("{n:02} {}", "b".repeat(400)))
            .collect();
        std::fs::write(memory.file(), render(&entries)).unwrap();
        let (kept, omitted) = memory.for_prompt();
        assert_eq!(kept.len() + omitted, 30);
        assert!(omitted > 0);
        assert!(render(&kept).len() <= MAX_BYTES);
        assert_eq!(memory.view()["omitted"], omitted);
        assert!(memory.apply(&add("one more"), By::You).is_err());
        memory
            .apply(&change(Kind::Forget, &entries[0], ""), By::You)
            .unwrap();
    }

    #[test]
    fn history_keeps_the_latest() {
        let dir = tempfile::tempdir().unwrap();
        let memory = Memory::new(dir.path());
        for n in 0..(HISTORY_KEPT + 5) {
            memory.apply(&add(&format!("e{n}")), By::You).unwrap();
            memory
                .apply(&change(Kind::Forget, &format!("e{n}"), ""), By::You)
                .unwrap();
        }
        let view = memory.view();
        let history = view["history"].as_array().unwrap();
        assert_eq!(history.len(), HISTORY_KEPT);
        assert_eq!(history[0]["old"], format!("e{}", HISTORY_KEPT + 4));
    }
}

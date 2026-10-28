mod diff;
mod evidence;
mod files;
mod scan;

pub use diff::{changed_file, changed_files, valid_base, valid_path, Anchor};
pub use evidence::{gather, valid_file as valid_evidence_file};
pub use files::{file_view, places};
pub use scan::{prompt as scan_prompt, Kind as ScanKind};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const START: &str = "YARDBELL REVIEW";
const END: &str = "END REVIEW";
pub(crate) const MAX_FINDINGS: usize = 30;
const MAX_TEXT: usize = 600;
const SHOT_TAG: &str = "[screenshot";

// The session a reviewer looks at, so its findings can go back to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewOf {
    pub machine: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub branch: String,
    // The folder under the repository's git dir where this reviewer may save screenshots.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub evidence: String,
    // A scan looks through the whole folder for one kind of problem instead of reviewing a branch.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub scan: String,
}

impl ReviewOf {
    pub fn scan_kind(&self) -> Option<ScanKind> {
        ScanKind::parse(&self.scan)
    }
}

// The apps the reviewer can open, offered only when the reviewed folder has one running.
#[derive(Debug, Clone, PartialEq)]
pub struct Screenshots {
    pub folder: String,
    pub apps: Vec<String>,
}

pub fn evidence_folder() -> String {
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(12)
        .map(|b| char::from(b).to_ascii_lowercase())
        .collect()
}

pub fn prompt(branch: &str, focus: &str, shots: Option<&Screenshots>) -> String {
    let what = if branch.is_empty() {
        "the current branch".to_string()
    } else {
        format!("branch {branch}")
    };
    let mut text = format!(
        "Review the work on {what} in this folder: the commits that are not on the branch it was \
made from (usually main, or origin/main when this is main) and any uncommitted changes. Run the \
project's tests and linters if it has them. Do not change, stage or commit any files in the \
branch."
    );
    let focus = focus.trim();
    if !focus.is_empty() {
        text.push_str(&format!(" Pay special attention to this: {focus}"));
    }
    if let Some(shots) = shots.filter(|s| !s.apps.is_empty()) {
        text.push_str(&format!(
            "\n\nThe app is running at {}. Screenshots are optional: when one shows a problem better \
than words, take it with a headless browser, save it as a PNG in the folder that `git rev-parse \
--git-path yardbell-review/{}` prints (create it; it is inside .git, so the branch does not change), \
and end that finding's line with [screenshot: name.png]. Use short file names of letters, digits, \
dots, dashes and underscores, and at most {} screenshots of up to {} MB each.",
            shots.apps.join(", "),
            shots.folder,
            evidence::MAX_SHOTS,
            evidence::MAX_BYTES / (1024 * 1024)
        ));
    }
    text.push_str(&format!(
        "\n\nWhen you are done, end your reply with this report and nothing after it:\n\n{START}\n\
verdict: ready, or changes needed\nbase: the branch or commit you compared against\n\
summary: one or two sentences\n\
- high: path/to/file:line: what is wrong and how to fix it\n- medium: ...\n- low: ...\n{END}\n\n\
List only real problems, most serious first, one line each. Write \"- none\" when there are none."
    ));
    text
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub severity: &'static str,
    pub place: String,
    pub text: String,
    pub shots: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub ready: bool,
    pub summary: String,
    pub base: String,
    pub findings: Vec<Finding>,
}

impl Report {
    pub fn to_scan_json(&self) -> Value {
        let mut report = self.to_json();
        report["verdict"] = json!(if self.ready { "clean" } else { "issues" });
        if let Some(o) = report.as_object_mut() {
            o.remove("base");
        }
        report
    }

    pub fn to_json(&self) -> Value {
        let mut report = json!({
            "verdict": if self.ready { "ready" } else { "changes" },
            "summary": self.summary,
            "findings": self.findings.iter().map(|f| {
                let mut finding = json!({
                    "severity": f.severity,
                    "place": f.place,
                    "text": f.text,
                });
                if !f.shots.is_empty() {
                    finding["shots"] = json!(f.shots);
                }
                finding
            }).collect::<Vec<_>>(),
        });
        if valid_base(&self.base) {
            report["base"] = json!(self.base);
        }
        report
    }
}

// What the agent's terminal adds around its reply: Claude Code's reply marker, the frame of the
// input box and the margin.
pub(super) fn unframed(line: &str) -> &str {
    line.trim()
        .trim_start_matches(|c: char| {
            matches!(c, '⏺' | '●' | '▌' | '▐') || ('\u{2500}'..='\u{257f}').contains(&c)
        })
        .trim_end_matches(|c: char| ('\u{2500}'..='\u{257f}').contains(&c))
        .trim()
}

pub(super) fn bare(text: &str) -> &str {
    text.trim_matches(|c: char| matches!(c, '*' | '_' | '`' | '#') || c.is_whitespace())
}

pub(super) fn value_of<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let line = bare(line);
    let (name, rest) = line.split_once(':')?;
    bare(name)
        .eq_ignore_ascii_case(key)
        .then(|| bare(rest.trim_start_matches(['*', '_'])))
}

pub(super) fn bullet(line: &str) -> Option<&str> {
    for mark in ["- ", "* ", "• ", "◦ ", "– "] {
        if let Some(rest) = line.strip_prefix(mark) {
            return Some(rest.trim());
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    let rest = &line[digits..];
    (digits > 0)
        .then(|| rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")))
        .flatten()
        .map(str::trim)
}

fn severity(word: &str) -> Option<&'static str> {
    match word.to_ascii_lowercase().as_str() {
        "high" | "critical" | "major" | "severe" | "blocker" => Some("high"),
        "medium" | "moderate" | "med" => Some("medium"),
        "low" | "minor" | "nit" | "info" => Some("low"),
        _ => None,
    }
}

pub(super) fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(MAX_TEXT).collect();
    cut.push('…');
    cut
}

fn finding(item: &str) -> Finding {
    let item = item.trim_start_matches(['[', '(', '*', '_']);
    let word: String = item.chars().take_while(char::is_ascii_alphabetic).collect();
    let (level, rest) = match severity(&word) {
        Some(level) => (
            level,
            item[word.len()..].trim_start_matches(|c: char| {
                matches!(c, ']' | ')' | '*' | '_' | ':' | '-' | '–') || c.is_whitespace()
            }),
        ),
        None => ("medium", item),
    };
    let (place, text) = match rest.split_once(": ") {
        Some((head, tail)) if !head.contains(' ') && (head.contains('/') || head.contains('.')) => {
            (head.trim_matches('`').to_string(), tail.trim())
        }
        _ => (String::new(), rest.trim()),
    };
    Finding {
        severity: level,
        place,
        text: text.to_string(),
        shots: Vec::new(),
    }
}

// "[screenshot: a.png]" or "[screenshots: a.png, b.png]" anywhere in a finding's text names the
// screenshots that go with it, and is taken out of the text.
fn take_shots(finding: &mut Finding) {
    let mut text = finding.text.clone();
    while let Some(at) = text.to_ascii_lowercase().find(SHOT_TAG) {
        let Some(len) = text[at..].find(']') else {
            break;
        };
        let tag = &text[at + 1..at + len];
        let names = tag.split_once(':').map(|(_, n)| n).unwrap_or_default();
        for name in names.split([',', ' ']).map(|n| n.trim_matches('`')) {
            if !name.is_empty() && !finding.shots.iter().any(|s| s == name) {
                finding.shots.push(name.to_string());
            }
        }
        text.replace_range(at..at + len + 1, "");
    }
    finding.text = clip(
        text.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .as_str(),
    );
}

pub(super) fn is_marker(line: &str, marker: &str) -> bool {
    bare(bullet(line).unwrap_or(line)).eq_ignore_ascii_case(marker)
}

// The report block a prompt asks for: its markers, and how its verdict reads (true for ready or
// clean, None for anything else).
pub(crate) struct Block {
    pub start: &'static str,
    pub end: &'static str,
    pub verdict: fn(&str) -> Option<bool>,
}

fn review_verdict(text: &str) -> Option<bool> {
    match text.trim_end_matches('.').to_ascii_lowercase().as_str() {
        "ready" => Some(true),
        "changes needed" | "changes requested" | "needs changes" => Some(false),
        _ => None,
    }
}

const REVIEW: Block = Block {
    start: START,
    end: END,
    verdict: review_verdict,
};

// The report the review prompt asks for, the last one on the screen. A screen that only shows the
// prompt (the template's verdict is not a verdict) or a report still being written gives None.
pub fn parse(screen: &str) -> Option<Report> {
    parse_block(screen, &REVIEW)
}

pub fn parse_scan(screen: &str) -> Option<Report> {
    parse_block(screen, &scan::BLOCK)
}

fn parse_block(screen: &str, block: &Block) -> Option<Report> {
    let lines: Vec<&str> = screen.lines().map(unframed).collect();
    let start = lines.iter().rposition(|l| is_marker(l, block.start))?;
    let end = start
        + lines[start..]
            .iter()
            .position(|l| is_marker(l, block.end))?;
    let mut ready = None;
    let mut summary = String::new();
    let mut base = String::new();
    let mut findings: Vec<Finding> = Vec::new();
    let mut in_summary = false;
    for line in lines[start + 1..end].iter().filter(|l| !l.is_empty()) {
        if let Some(verdict) = value_of(line, "verdict") {
            ready = Some((block.verdict)(verdict)?);
            in_summary = false;
        } else if let Some(text) = value_of(line, "summary") {
            summary = text.to_string();
            in_summary = true;
        } else if let Some(text) = value_of(line, "base") {
            base = text.trim_matches('`').to_string();
            in_summary = false;
        } else if let Some(item) = bullet(line) {
            in_summary = false;
            if bare(item)
                .trim_end_matches('.')
                .eq_ignore_ascii_case("none")
            {
                continue;
            }
            if findings.len() < MAX_FINDINGS {
                findings.push(finding(item));
            }
        } else if in_summary {
            summary = format!("{summary} {line}");
        } else if let Some(last) = findings.last_mut() {
            last.text = format!("{} {line}", last.text);
        }
    }
    findings.iter_mut().for_each(take_shots);
    Some(Report {
        ready: ready?,
        summary: clip(summary.trim()),
        base,
        findings,
    })
}

// The findings picked on a review card, each with the screenshots kept for it, so the session
// that fixes them can open the same files.
pub fn picked(review: &Value, picks: &[usize]) -> Vec<Value> {
    let all = review["findings"].as_array().cloned().unwrap_or_default();
    picks
        .iter()
        .filter_map(|&i| {
            let mut f = all.get(i)?.clone();
            let shots: Vec<Value> = review["evidence"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|e| e["finding"] == i && e["file"].is_string())
                .filter_map(|e| e.get("source").cloned())
                .collect();
            if !shots.is_empty() {
                f["screenshots"] = json!(shots);
            }
            Some(f)
        })
        .collect()
}

// What found the problems, as the start of the request that sends them to a session.
pub fn found_by(of: &Value) -> String {
    let path = of["path"].as_str().unwrap_or_default();
    match ScanKind::parse(of["scan"].as_str().unwrap_or_default()) {
        Some(kind) if !path.is_empty() => format!("A {} of {path}", kind.name()),
        Some(kind) => format!("A {} of this folder", kind.name()),
        None => "A review of this branch".into(),
    }
}

// One line, so an agent that sends on Enter gets the whole request at once.
pub fn fix_request(source: &str, findings: &[Value]) -> String {
    let items: Vec<String> = findings
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let place = f["place"].as_str().unwrap_or_default();
            let at = if place.is_empty() {
                String::new()
            } else {
                format!(" {place}:")
            };
            let shots: Vec<&str> = f["screenshots"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let seen = if shots.is_empty() {
                String::new()
            } else {
                format!(" (screenshot: {})", shots.join(", "))
            };
            format!(
                "{}) {}{at} {}{seen}",
                i + 1,
                f["severity"].as_str().unwrap_or("medium"),
                f["text"].as_str().unwrap_or_default()
            )
        })
        .collect();
    format!(
        "{source} found {}. Fix {}, run the tests, and tell me what you changed. {}",
        if items.len() == 1 {
            "this problem".to_string()
        } else {
            format!("these {} problems", items.len())
        },
        if items.len() == 1 { "it" } else { "them" },
        items.join(" ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_SCREEN: &str = "\
> Review the work on branch eng-1234-checkout in this folder: ...

⏺ Bash(cargo test)
  ⎿  test result: ok. 41 passed; 0 failed

⏺ YARDBELL REVIEW
  verdict: changes needed
  summary: The retry loop never gives up, and the flaky test is
  skipped instead of fixed.
  - high: src/checkout.rs:88: The retry loop has no limit, so a payment
    provider that is down hangs the request forever. Stop after 3 tries.
  - medium: tests/checkout_test.rs:12: The flaky test is marked #[ignore]
    rather than fixed.
  - low: README.md: Mention CHECKOUT_RETRIES.
  END REVIEW

╭──────────────────────────────────────────────────╮
│ >                                                │
╰──────────────────────────────────────────────────╯
  ? for shortcuts";

    #[test]
    fn a_report_is_read_from_a_claude_code_screen() {
        let report = parse(CLAUDE_SCREEN).unwrap();
        assert!(!report.ready);
        assert_eq!(
            report.summary,
            "The retry loop never gives up, and the flaky test is skipped instead of fixed."
        );
        assert_eq!(report.findings.len(), 3);
        assert_eq!(
            report.findings[0],
            Finding {
                severity: "high",
                place: "src/checkout.rs:88".into(),
                text: "The retry loop has no limit, so a payment provider that is down hangs the request forever. Stop after 3 tries.".into(),
                shots: vec![],
            }
        );
        assert_eq!(
            report.findings[1].text,
            "The flaky test is marked #[ignore] rather than fixed."
        );
        assert_eq!(
            (
                report.findings[2].severity,
                report.findings[2].place.as_str()
            ),
            ("low", "README.md")
        );
    }

    #[test]
    fn the_prompt_alone_is_not_a_report() {
        let echoed = format!("> {}\n\n⏺ Reading the diff.", prompt("eng-1", "", None));
        assert_eq!(parse(&echoed), None, "the template's verdict is not one");
        assert_eq!(
            parse(CLAUDE_SCREEN.replace("  END REVIEW", "").as_str()),
            None
        );
        assert_eq!(parse("nothing here"), None);
    }

    #[test]
    fn other_shapes_of_a_report_are_read_too() {
        let screen = "• YARDBELL REVIEW\n**Verdict:** Ready.\n**Summary:** Looks good.\n1. [low] `src/a.rs:3`: Rename x.\n- Nit - spelling in docs\nEND REVIEW";
        let report = parse(screen).unwrap();
        assert!(report.ready);
        assert_eq!(report.summary, "Looks good.");
        assert_eq!(
            report.findings,
            [
                Finding {
                    severity: "low",
                    place: "src/a.rs:3".into(),
                    text: "Rename x.".into(),
                    shots: vec![],
                },
                Finding {
                    severity: "low",
                    place: String::new(),
                    text: "spelling in docs".into(),
                    shots: vec![],
                },
            ]
        );
        let clean =
            parse("YARDBELL REVIEW\nverdict: ready\nsummary: Fine.\n- none\nEND REVIEW").unwrap();
        assert!(clean.ready && clean.findings.is_empty());
    }

    #[test]
    fn the_prompt_names_the_branch_and_the_focus() {
        let text = prompt("eng-1", "  the migration ", None);
        assert!(text.starts_with("Review the work on branch eng-1 in this folder"));
        assert!(text.contains("Pay special attention to this: the migration"));
        assert!(text.contains("\n\nYARDBELL REVIEW\nverdict: ready, or changes needed\n"));
        assert!(prompt("", "", None).starts_with("Review the work on the current branch"));
        assert!(text.contains("\nbase: the branch or commit you compared against\n"));
        assert!(!text.contains("screenshot"), "no app, no screenshots");
        let shots = Screenshots {
            folder: "abcdef123456".into(),
            apps: vec!["http://localhost:3020 (rails)".into()],
        };
        let text = prompt("eng-1", "", Some(&shots));
        assert!(text.contains(
            "The app is running at http://localhost:3020 (rails). Screenshots are optional"
        ));
        assert!(text.contains("`git rev-parse --git-path yardbell-review/abcdef123456`"));
        assert!(text.contains("[screenshot: name.png]"));
        assert!(text.contains("at most 6 screenshots of up to 2 MB each"));
        assert_eq!(parse(&format!("> {text}")), None);
        assert_eq!(evidence_folder().len(), 12);
    }

    #[test]
    fn a_report_names_its_base_and_screenshots() {
        let screen = "YARDBELL REVIEW\nverdict: changes needed\nbase: `origin/develop`\nsummary: One.\n\
- high: web/login.html:12: The button is under the footer on a phone. [screenshot: login-phone.png]\n\
- medium: a.rs:1: Two views [screenshots: `a.png`, b.png] disagree,\n  see [Screenshot: c.png] too.\n\
- low: b.rs: No picture [screenshot]\nEND REVIEW";
        let report = parse(screen).unwrap();
        assert_eq!(report.base, "origin/develop");
        let f = &report.findings;
        assert_eq!(f[0].text, "The button is under the footer on a phone.");
        assert_eq!(f[0].shots, ["login-phone.png"]);
        assert_eq!(f[1].text, "Two views disagree, see too.");
        assert_eq!(f[1].shots, ["a.png", "b.png", "c.png"]);
        assert_eq!((f[2].text.as_str(), f[2].shots.len()), ("No picture", 0));
        let json = report.to_json();
        assert_eq!(json["base"], "origin/develop");
        assert_eq!(json["findings"][0]["shots"], json!(["login-phone.png"]));
        assert!(json["findings"][2].get("shots").is_none());
        let unsafe_base = parse(&screen.replace("`origin/develop`", "$(rm -rf ~)")).unwrap();
        assert!(unsafe_base.to_json().get("base").is_none());
    }

    #[test]
    fn findings_go_back_as_one_line() {
        let report = parse(CLAUDE_SCREEN).unwrap().to_json();
        let all = report["findings"].as_array().unwrap();
        let text = fix_request("A review of this branch", &all[..2]);
        assert!(!text.contains('\n'));
        assert!(text.starts_with("A review of this branch found these 2 problems. Fix them,"));
        assert!(text.contains("1) high src/checkout.rs:88: The retry loop"));
        assert!(fix_request("A review of this branch", &all[2..])
            .contains("found this problem. Fix it,"));
        let of = json!({ "path": "/r/app", "scan": "security" });
        assert_eq!(found_by(&of), "A security scan of /r/app");
        assert!(fix_request(&found_by(&of), &all[..1])
            .starts_with("A security scan of /r/app found this problem. Fix it,"));
        assert_eq!(found_by(&json!({ "name": "x" })), "A review of this branch");
    }

    #[test]
    fn picked_findings_carry_their_screenshots() {
        let review = json!({
            "findings": [{ "severity": "high", "place": "a.rs:1", "text": "Off." }, { "severity": "low", "place": "", "text": "Nit." }],
            "evidence": [
                { "finding": 0, "name": "a.png", "file": "aaaaaaaaaaaaaaaa.png", "source": "/r/.git/yardbell-review/x/a.png" },
                { "finding": 0, "name": "b.png", "error": "not found in the review folder" },
            ],
        });
        let chosen = picked(&review, &[0, 1, 9]);
        assert_eq!(chosen.len(), 2);
        let text = fix_request("A review of this branch", &chosen);
        assert!(
            text.contains(
                "1) high a.rs:1: Off. (screenshot: /r/.git/yardbell-review/x/a.png) 2) low Nit."
            ),
            "{text}"
        );
    }
}

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const START: &str = "YARDBELL REVIEW";
const END: &str = "END REVIEW";
const MAX_FINDINGS: usize = 30;
const MAX_TEXT: usize = 600;

// The session a reviewer looks at, so its findings can go back to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewOf {
    pub machine: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub branch: String,
}

pub fn prompt(branch: &str, focus: &str) -> String {
    let what = if branch.is_empty() {
        "the current branch".to_string()
    } else {
        format!("branch {branch}")
    };
    let mut text = format!(
        "Review the work on {what} in this folder: the commits that are not on the branch it was \
made from (usually main, or origin/main when this is main) and any uncommitted changes. Run the \
project's tests and linters if it has them. Do not change, stage or commit any files."
    );
    let focus = focus.trim();
    if !focus.is_empty() {
        text.push_str(&format!(" Pay special attention to this: {focus}"));
    }
    text.push_str(&format!(
        "\n\nWhen you are done, end your reply with this report and nothing after it:\n\n{START}\n\
verdict: ready, or changes needed\nsummary: one or two sentences\n\
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub ready: bool,
    pub summary: String,
    pub findings: Vec<Finding>,
}

impl Report {
    pub fn to_json(&self) -> Value {
        json!({
            "verdict": if self.ready { "ready" } else { "changes" },
            "summary": self.summary,
            "findings": self.findings.iter().map(|f| json!({
                "severity": f.severity,
                "place": f.place,
                "text": f.text,
            })).collect::<Vec<_>>(),
        })
    }
}

// What the agent's terminal adds around its reply: Claude Code's reply marker, the frame of the
// input box and the margin.
fn unframed(line: &str) -> &str {
    line.trim()
        .trim_start_matches(|c: char| {
            matches!(c, '⏺' | '●' | '▌' | '▐') || ('\u{2500}'..='\u{257f}').contains(&c)
        })
        .trim_end_matches(|c: char| ('\u{2500}'..='\u{257f}').contains(&c))
        .trim()
}

fn bare(text: &str) -> &str {
    text.trim_matches(|c: char| matches!(c, '*' | '_' | '`' | '#') || c.is_whitespace())
}

fn value_of<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let line = bare(line);
    let (name, rest) = line.split_once(':')?;
    bare(name)
        .eq_ignore_ascii_case(key)
        .then(|| bare(rest.trim_start_matches(['*', '_'])))
}

fn bullet(line: &str) -> Option<&str> {
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

fn clip(text: &str) -> String {
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
        text: clip(text),
    }
}

fn is_marker(line: &str, marker: &str) -> bool {
    bare(bullet(line).unwrap_or(line)).eq_ignore_ascii_case(marker)
}

// The report the review prompt asks for, the last one on the screen. A screen that only shows the
// prompt (the template's verdict is not a verdict) or a report still being written gives None.
pub fn parse(screen: &str) -> Option<Report> {
    let lines: Vec<&str> = screen.lines().map(unframed).collect();
    let start = lines.iter().rposition(|l| is_marker(l, START))?;
    let end = start + lines[start..].iter().position(|l| is_marker(l, END))?;
    let mut ready = None;
    let mut summary = String::new();
    let mut findings: Vec<Finding> = Vec::new();
    let mut in_summary = false;
    for line in lines[start + 1..end].iter().filter(|l| !l.is_empty()) {
        if let Some(verdict) = value_of(line, "verdict") {
            let verdict = verdict.trim_end_matches('.').to_ascii_lowercase();
            ready = match verdict.as_str() {
                "ready" => Some(true),
                "changes needed" | "changes requested" | "needs changes" => Some(false),
                _ => return None,
            };
            in_summary = false;
        } else if let Some(text) = value_of(line, "summary") {
            summary = text.to_string();
            in_summary = true;
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
            last.text = clip(&format!("{} {line}", last.text));
        }
    }
    Some(Report {
        ready: ready?,
        summary: clip(summary.trim()),
        findings,
    })
}

// One line, so an agent that sends on Enter gets the whole request at once.
pub fn fix_request(findings: &[Value]) -> String {
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
            format!(
                "{}) {}{at} {}",
                i + 1,
                f["severity"].as_str().unwrap_or("medium"),
                f["text"].as_str().unwrap_or_default()
            )
        })
        .collect();
    format!(
        "A review of this branch found {}. Fix {}, run the tests, and tell me what you changed. {}",
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
        let echoed = format!("> {}\n\n⏺ Reading the diff.", prompt("eng-1", ""));
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
                    text: "Rename x.".into()
                },
                Finding {
                    severity: "low",
                    place: String::new(),
                    text: "spelling in docs".into()
                },
            ]
        );
        let clean =
            parse("YARDBELL REVIEW\nverdict: ready\nsummary: Fine.\n- none\nEND REVIEW").unwrap();
        assert!(clean.ready && clean.findings.is_empty());
    }

    #[test]
    fn the_prompt_names_the_branch_and_the_focus() {
        let text = prompt("eng-1", "  the migration ");
        assert!(text.starts_with("Review the work on branch eng-1 in this folder"));
        assert!(text.contains("Pay special attention to this: the migration"));
        assert!(text.contains("\n\nYARDBELL REVIEW\nverdict: ready, or changes needed\n"));
        assert!(prompt("", "").starts_with("Review the work on the current branch"));
    }

    #[test]
    fn findings_go_back_as_one_line() {
        let report = parse(CLAUDE_SCREEN).unwrap().to_json();
        let all = report["findings"].as_array().unwrap();
        let text = fix_request(&all[..2]);
        assert!(!text.contains('\n'));
        assert!(text.starts_with("A review of this branch found these 2 problems. Fix them,"));
        assert!(text.contains("1) high src/checkout.rs:88: The retry loop"));
        assert!(fix_request(&all[2..]).contains("found this problem. Fix it,"));
    }
}

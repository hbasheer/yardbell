use super::{Block, MAX_FINDINGS};

pub(super) const BLOCK: Block = Block {
    start: "YARDBELL SCAN",
    end: "END SCAN",
    verdict: scan_verdict,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    DeadCode,
    TestGaps,
    Security,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::DeadCode, Kind::TestGaps, Kind::Security];

    pub fn parse(text: &str) -> Option<Kind> {
        let key = text.trim().to_ascii_lowercase().replace(['-', ' '], "_");
        Kind::ALL.into_iter().find(|k| k.key() == key)
    }

    pub fn key(self) -> &'static str {
        match self {
            Kind::DeadCode => "dead_code",
            Kind::TestGaps => "test_gaps",
            Kind::Security => "security",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::DeadCode => "dead code scan",
            Kind::TestGaps => "test gap scan",
            Kind::Security => "security scan",
        }
    }

    fn task(self) -> &'static str {
        match self {
            Kind::DeadCode => {
                "Look for dead code: functions, methods, classes and modules that nothing calls \
or imports; routes and endpoints that nothing links to or calls; assets such as images, styles, \
scripts and templates that nothing references; and config keys, environment variables and \
feature flags that nothing reads. Before you report something, search the whole folder for every \
use of it, including tests, templates, config, build scripts and lookups by name, and say how \
sure you are when a use could be dynamic. The public API of a library is not dead just because \
this folder does not call it."
            }
            Kind::TestGaps => {
                "Look for test gaps: important code paths that no test covers, such as request \
handlers, changes to stored data, payments, permissions, parsing of outside input, error handling \
and the fixes in recent commits. First find the project's own test command, from its README, \
Makefile, package.json, Cargo.toml, CI config and the like, and run it to see what passes and \
what fails; say in the summary which command you ran, or that you found none. For each gap, name \
the file and line of the code without a test and say what the missing test should check. A test \
that fails is a high finding."
            }
            Kind::Security => {
                "Look for security problems: secrets committed to the repository (keys, tokens, \
passwords, private certificates, .env files that git tracks), injection (SQL, shell commands, \
HTML and templates, file paths), unsafe deserialization, server-side request forgery, routes and \
actions that skip authentication or authorization checks, weak cryptography and dangerous \
defaults. When the audit tool for the project's ecosystem is installed (cargo audit, npm audit, \
pnpm audit, yarn audit, pip-audit, bundle audit, govulncheck and the like), run it without its \
fix option and report the advisories that apply. Never print a secret's value: name its file and \
line and what kind of secret it is. Rate each finding by how easily it can be exploited."
            }
        }
    }
}

fn scan_verdict(text: &str) -> Option<bool> {
    let text = text.trim_end_matches('.').to_ascii_lowercase();
    let words: Vec<&str> = text.split_whitespace().collect();
    match words.as_slice() {
        ["clean"] | ["no", "issues"] | ["no", "issues", "found"] => Some(true),
        ["issues", "found"] | ["issue", "found"] => Some(false),
        [n, "issues" | "issue", "found"] if n.parse::<usize>().is_ok() => Some(false),
        _ => None,
    }
}

pub fn prompt(kind: Kind, focus: &str) -> String {
    let mut text = format!(
        "Run a {} of this folder. This is a scan of the code as it is now, not a review of a \
branch: look through every file in the folder, not only recent changes.\n\n{}",
        kind.name(),
        kind.task()
    );
    let focus = focus.trim();
    if !focus.is_empty() {
        text.push_str(&format!(" Pay special attention to this: {focus}"));
    }
    text.push_str(
        "\n\nThis scan is read-only. Do not change, create, delete, stage or commit any file, do \
not install, update or remove packages, and do not run formatters, fixers, code generators or \
anything else that writes to the folder. Reading files and running commands that only read is \
fine, and so is build output or a cache that git ignores.",
    );
    text.push_str(&format!(
        "\n\nWhen you are done, end your reply with this report and nothing after it:\n\n{}\n\
verdict: clean, or issues found\nsummary: one or two sentences\n\
- high: path/to/file:line: what is wrong and how to fix it\n- medium: ...\n- low: ...\n{}\n\n\
Give each path relative to this folder. List only real problems, most serious first, one line \
each, at most {MAX_FINDINGS}. Write \"- none\" when there are none.",
        BLOCK.start, BLOCK.end
    ));
    text
}

#[cfg(test)]
mod tests {
    use super::super::parse_scan;
    use super::*;

    #[test]
    fn kinds_are_named_in_several_spellings() {
        for (text, kind) in [
            ("dead_code", Kind::DeadCode),
            ("Dead code", Kind::DeadCode),
            ("test-gaps", Kind::TestGaps),
            (" SECURITY ", Kind::Security),
        ] {
            assert_eq!(Kind::parse(text), Some(kind), "{text}");
        }
        for bad in ["", "lint", "dead", "security_scan"] {
            assert_eq!(Kind::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn each_kind_has_its_own_read_only_prompt() {
        let prompts: Vec<String> = Kind::ALL.iter().map(|k| prompt(*k, "")).collect();
        for (kind, text) in Kind::ALL.iter().zip(&prompts) {
            assert!(
                text.starts_with(&format!("Run a {} of this folder.", kind.name())),
                "{text}"
            );
            assert!(text.contains("not a review of a branch"));
            assert!(text.contains("This scan is read-only. Do not change, create, delete"));
            assert!(text.contains("\n\nYARDBELL SCAN\nverdict: clean, or issues found\n"));
            assert!(text.contains("relative to this folder"));
            assert!(!text.contains('\u{2014}'), "no em dashes");
            assert_eq!(
                parse_scan(&format!("> {text}")),
                None,
                "the template is no report"
            );
        }
        assert!(prompts[0].contains("routes and endpoints that nothing links to"));
        assert!(prompts[1].contains("find the project's own test command"));
        assert!(prompts[2].contains("cargo audit, npm audit"));
        assert!(prompts[2].contains("Never print a secret's value"));
        assert!(prompt(Kind::Security, " the login form ")
            .contains("Pay special attention to this: the login form\n\nThis scan is read-only"));
    }

    #[test]
    fn a_scan_report_becomes_a_card() {
        let screen = "\
> Run a security scan of this folder.

⏺ Bash(cargo audit)
  ⎿  1 vulnerability found

⏺ YARDBELL SCAN
  verdict: 3 issues found
  summary: A committed token, a shell injection
  and an advisory.
  - high: config/deploy.yml:12: A GitHub token is committed. Revoke it and read it from the
    environment.
  - high: src/run.rs:40: The branch name goes into sh -c unquoted.
  - medium: Cargo.lock: RUSTSEC-2024-0001 in time 0.1.
  END SCAN
";
        let report = parse_scan(screen).unwrap();
        assert!(!report.ready);
        assert_eq!(
            report.summary,
            "A committed token, a shell injection and an advisory."
        );
        assert_eq!(report.findings.len(), 3);
        assert_eq!(report.findings[0].place, "config/deploy.yml:12");
        assert_eq!(
            report.findings[0].text,
            "A GitHub token is committed. Revoke it and read it from the environment."
        );
        assert_eq!(
            (
                report.findings[2].severity,
                report.findings[2].place.as_str()
            ),
            ("medium", "Cargo.lock")
        );
        let json = report.to_scan_json();
        assert_eq!(json["verdict"], "issues");
        assert!(json.get("base").is_none());

        let clean = parse_scan(
            "YARDBELL SCAN\nverdict: Clean.\nsummary: Nothing unused.\n- none\nEND SCAN",
        )
        .unwrap();
        assert!(clean.ready && clean.findings.is_empty());
        assert_eq!(clean.to_scan_json()["verdict"], "clean");
        for verdict in ["issues found", "1 issue found", "No issues"] {
            let screen = format!("YARDBELL SCAN\nverdict: {verdict}\nsummary: x\nEND SCAN");
            assert!(parse_scan(&screen).is_some(), "{verdict}");
        }
        assert_eq!(
            parse_scan("YARDBELL SCAN\nverdict: changes needed\nsummary: x\nEND SCAN"),
            None,
            "a review's verdict is not a scan's"
        );
        assert_eq!(
            parse_scan(&screen.replace("END SCAN", "")),
            None,
            "still being written"
        );
        assert_eq!(
            super::super::parse(screen),
            None,
            "a scan report is not a review"
        );
    }
}

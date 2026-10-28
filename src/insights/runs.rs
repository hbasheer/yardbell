use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const MAX_TEXT: usize = 140;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunKind {
    Tool,
    Test,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub kind: RunKind,
    pub text: String,
    // For a test result: whether it passed. A test command alone says nothing yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
}

struct Patterns {
    claude_tool: Regex,
    codex_tool: Regex,
    shell_test: Regex,
    test_command: Regex,
    cargo: Regex,
    pytest: Regex,
    jest: Regex,
    vitest: Regex,
    go: Regex,
    rspec: Regex,
    minitest: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let re = |p: &str| Regex::new(p).expect("run pattern");
        Patterns {
            // Claude Code: "⏺ Bash(cargo test)", "⏺ Update(src/main.rs)".
            claude_tool: re(r"^\s*[⏺●]\s+([A-Z][A-Za-z]+)\((.*)\)\s*$"),
            // Codex: "• Ran cargo test", "• Edited src/main.rs (+3 -1)".
            codex_tool: re(r"^\s*•\s+(Ran|Edited|Added|Deleted|Explored)\s+(.+?)\s*$"),
            shell_test: re(r"(?:^|[$#%>❯]\s+)((?:cargo|npm|pnpm|yarn|npx|pytest|python3?|go|bundle|rspec|bin/rails|rails|make|mix|vitest|jest)\b.*)$"),
            test_command: re(r"^(?:cargo (?:test|nextest)|(?:npm|pnpm|yarn)(?: run)? test|npx (?:jest|vitest)|pytest|python3? -m pytest|go test|bundle exec (?:rspec|rails test)|rspec|bin/rails test|rails test|make test|mix test|vitest|jest)\b"),
            cargo: re(r"test result: (ok|FAILED)\. \d+ passed; \d+ failed"),
            pytest: re(r"^=+ (.*\b(?:passed|failed|error|errors)\b.*) in [\d.]+s(?: \([^)]*\))? =+\s*$"),
            jest: re(r"^Tests:\s+(.*\btotal)\s*$"),
            vitest: re(r"^\s*Tests\s+((?:\d+ failed \| )?\d+ passed.*?)\s*$"),
            go: re(r"^(ok|FAIL)\s+\S+\s+[\d.]+s\s*$"),
            rspec: re(r"^(\d+ examples?, (\d+) failures?.*?)\s*$"),
            minitest: re(r"^(\d+ runs, \d+ assertions, (\d+) failures, (\d+) errors.*?)\s*$"),
        }
    })
}

fn clip(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

fn is_test_command(command: &str) -> bool {
    patterns().test_command.is_match(command.trim())
}

fn tool(name: &str, what: &str) -> Run {
    let command = matches!(name, "Bash" | "Ran");
    Run {
        kind: if command && is_test_command(what) {
            RunKind::Test
        } else {
            RunKind::Tool
        },
        text: clip(&format!("{name}: {what}")),
        ok: None,
    }
}

fn result(text: &str, ok: bool) -> Run {
    Run {
        kind: RunKind::Test,
        text: clip(text),
        ok: Some(ok),
    }
}

fn line_run(line: &str) -> Option<Run> {
    let p = patterns();
    if let Some(c) = p.claude_tool.captures(line) {
        return Some(tool(&c[1], &c[2]));
    }
    if let Some(c) = p.codex_tool.captures(line) {
        return Some(tool(&c[1], &c[2]));
    }
    if let Some(c) = p.cargo.captures(line) {
        return Some(result(c.get(0)?.as_str(), &c[1] == "ok"));
    }
    if let Some(c) = p.pytest.captures(line) {
        let ok = !c[1].contains("failed") && !c[1].contains("error");
        return Some(result(&c[1], ok));
    }
    if let Some(c) = p.jest.captures(line) {
        return Some(result(
            &format!("Tests: {}", &c[1]),
            !c[1].contains("failed"),
        ));
    }
    if let Some(c) = p.vitest.captures(line) {
        return Some(result(
            &format!("Tests {}", &c[1]),
            !c[1].contains("failed"),
        ));
    }
    if let Some(c) = p.go.captures(line) {
        return Some(result(line, &c[1] == "ok"));
    }
    if let Some(c) = p.rspec.captures(line) {
        return Some(result(&c[1], &c[2] == "0"));
    }
    if let Some(c) = p.minitest.captures(line) {
        return Some(result(&c[1], &c[2] == "0" && &c[3] == "0"));
    }
    let c = p.shell_test.captures(line)?;
    is_test_command(&c[1]).then(|| Run {
        kind: RunKind::Test,
        text: clip(&c[1]),
        ok: None,
    })
}

// The tool calls and test runs a screen or its scrollback shows, in order, where an agent's
// output makes them plain: Claude Code's and Codex's tool lines, test commands typed at a shell
// prompt, and the summary lines of common test runners.
pub fn runs(screen: &str) -> Vec<Run> {
    screen.lines().filter_map(line_run).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(screen: &str) -> Vec<(RunKind, String, Option<bool>)> {
        runs(screen)
            .into_iter()
            .map(|r| (r.kind, r.text, r.ok))
            .collect()
    }

    #[test]
    fn claude_and_codex_tool_lines_are_recognised() {
        let screen = "⏺ Read(src/main.rs)\n  ⎿  Read 40 lines\n⏺ Bash(cargo test --lib)\n  ⎿  running 3 tests\n\
                      test result: ok. 3 passed; 0 failed; 0 ignored\n⏺ I fixed the bug.\n\
                      • Ran npm test\n• Edited src/app.ts (+3 -1)\n";
        assert_eq!(
            texts(screen),
            [
                (RunKind::Tool, "Read: src/main.rs".into(), None),
                (RunKind::Test, "Bash: cargo test --lib".into(), None),
                (
                    RunKind::Test,
                    "test result: ok. 3 passed; 0 failed".into(),
                    Some(true)
                ),
                (RunKind::Test, "Ran: npm test".into(), None),
                (RunKind::Tool, "Edited: src/app.ts (+3 -1)".into(), None),
            ]
        );
    }

    #[test]
    fn test_runner_summaries_say_whether_they_passed() {
        let screen = "\
test result: FAILED. 2 passed; 1 failed; 0 ignored
========= 1 failed, 4 passed in 0.31s =========
Tests:       1 failed, 5 passed, 6 total
      Tests  7 passed (7)
ok  \tgithub.com/acme/api\t0.012s
FAIL\tgithub.com/acme/web\t0.200s
12 examples, 0 failures
3 runs, 5 assertions, 0 failures, 1 errors, 0 skips
";
        let oks: Vec<Option<bool>> = runs(screen).into_iter().map(|r| r.ok).collect();
        assert_eq!(
            oks,
            [
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(true),
                Some(false),
                Some(true),
                Some(false)
            ]
        );
    }

    #[test]
    fn a_test_typed_at_a_prompt_counts_and_other_commands_do_not() {
        assert_eq!(
            texts("me@hp:~/app$ cargo test\nme@hp:~/app$ ls -la\n$ echo cargo test\n❯ pytest -k login\n"),
            [
                (RunKind::Test, "cargo test".into(), None),
                (RunKind::Test, "pytest -k login".into(), None),
            ]
        );
        assert!(runs("I will run cargo test next.\n⏺ Done.\n").is_empty());
    }

    #[test]
    fn long_commands_are_cut() {
        let long = format!("⏺ Bash({})", "x".repeat(400));
        let run = &runs(&long)[0];
        assert!(run.text.chars().count() <= MAX_TEXT + 1);
        assert!(run.text.ends_with('…'));
    }
}

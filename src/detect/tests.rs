use super::*;

const CLAUDE_PROMPT_BOX: &str = "\
────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────
  ? for shortcuts";

#[test]
fn every_bundled_manifest_parses() {
    for text in MANIFESTS {
        parse(text).unwrap();
    }
    assert_eq!(manifests().len(), MANIFESTS.len());
}

#[test]
fn claude_idle_at_its_prompt() {
    let screen = format!("● Done. The tests pass.\n\n{CLAUDE_PROMPT_BOX}");
    assert_eq!(
        detect("claude", &screen, "✳ Claude Code"),
        Some(ScreenState::Idle)
    );
}

#[test]
fn claude_working_while_its_spinner_runs() {
    let screen = format!(
        "● Reading the config.\n\n✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)\n\n{CLAUDE_PROMPT_BOX}"
    );
    assert_eq!(detect("claude", &screen, ""), Some(ScreenState::Working));
}

#[test]
fn claude_working_from_its_title_spinner() {
    assert_eq!(
        detect("claude", "", "⠂ Fix the login bug"),
        Some(ScreenState::Working)
    );
}

#[test]
fn claude_blocked_on_a_bash_permission_prompt() {
    let screen = "\
● Bash(rm -rf build)
────────────────────────────────────────────────────────────────
 Bash command

   rm -rf build
   Remove the build folder

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in /home/u/app
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel · Tab to amend · ctrl+e to explain";
    assert_eq!(detect("claude", screen, ""), Some(ScreenState::Blocked));
}

#[test]
fn codex_blocked_from_its_title() {
    assert_eq!(
        detect("codex", "› ", "Action Required"),
        Some(ScreenState::Blocked)
    );
}

#[test]
fn aliases_find_the_manifest() {
    assert!(knows("cursor-agent"));
    assert!(knows("copilot"));
    assert!(!knows("aider"));
}

#[test]
fn agents_without_rules_have_no_screen_state() {
    assert_eq!(detect("aider", "Proceed? (Y)es/(N)o", ""), None);
}

#[test]
fn rules_that_hide_the_state_defer_to_the_caller() {
    let screen = "\
  some transcript text
  Showing detailed transcript · ctrl+o to toggle";
    assert_eq!(detect("claude", screen, ""), None);
}

#[test]
fn horizontal_rules_and_regions() {
    assert!(is_horizontal_rule("────"));
    assert!(is_horizontal_rule("  ─── name ──"));
    assert!(!is_horizontal_rule("─ a"));
    assert!(!is_horizontal_rule("text"));
    let screen = "a\n\nb\nc\n\n";
    assert_eq!(bottom_non_empty_lines(screen, 2), "b\nc\n\n");
    assert_eq!(top_non_empty_lines(screen, 1), "a\n");
    assert_eq!(after_last_horizontal_rule("x\n────\ny\n"), "y\n");
    assert_eq!(prompt_box_body(CLAUDE_PROMPT_BOX).map(str::trim), Some("❯"));
}

const CODEX_COMPOSER: &str = "\
› Ask Codex to do anything

  100% context left · ⏎ send";

#[test]
fn claude_stopped_on_an_api_error() {
    let screen = format!(
        "⏺ Bash(cargo test)\n  ⎿  running 3 tests\n  ⎿  API Error: 529 {{\"type\":\"error\",\"error\":{{\"type\":\"overloaded_error\"}}}}\n\n{CLAUDE_PROMPT_BOX}"
    );
    assert_eq!(
        stopped("claude", &screen).as_deref(),
        Some("API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}")
    );
}

#[test]
fn claude_stopped_at_its_usage_limit() {
    let screen = format!(
        "● Reading the logs.\n  ⎿  You've hit your limit · resets 3pm\n\n{CLAUDE_PROMPT_BOX}"
    );
    assert_eq!(
        stopped("claude", &screen).as_deref(),
        Some("You've hit your limit · resets 3pm")
    );
}

#[test]
fn an_error_answered_since_is_not_where_it_stopped() {
    let screen = format!("  ⎿  API Error: Request timed out.\n\n> try again\n\n● Done. The tests pass.\n\n{CLAUDE_PROMPT_BOX}");
    assert_eq!(stopped("claude", &screen), None);
    let fine = format!("● Done. The tests pass.\n\n{CLAUDE_PROMPT_BOX}");
    assert_eq!(stopped("claude", &fine), None);
}

#[test]
fn a_retry_still_under_way_is_not_a_stop() {
    let screen = format!(
        "  ⎿  API Error (Request timed out.) · Retrying in 5 seconds… (attempt 2/10)\n\n{CLAUDE_PROMPT_BOX}"
    );
    assert_eq!(stopped("claude", &screen), None);
}

#[test]
fn codex_stopped_on_an_error_but_not_on_an_interrupt() {
    let screen = format!(
        "• Ran cargo test\n\n■ stream disconnected before completion: error sending request\n\n{CODEX_COMPOSER}"
    );
    assert_eq!(
        stopped("codex", &screen).as_deref(),
        Some("stream disconnected before completion: error sending request")
    );
    let limit = format!("■ You've hit your usage limit. Try again at 3:00 PM.\n\n{CODEX_COMPOSER}");
    assert!(stopped("codex", &limit).is_some_and(|s| s.starts_with("You've hit your usage limit")));
    let interrupted = format!(
        "■ Conversation interrupted - tell the model what to do differently.\n\n{CODEX_COMPOSER}"
    );
    assert_eq!(stopped("codex", &interrupted), None);
    let answered = format!("■ stream disconnected\n\n› again\n\n• Fixed it.\n\n{CODEX_COMPOSER}");
    assert_eq!(stopped("codex", &answered), None);
}

#[test]
fn agents_without_error_signs_never_stop() {
    let screen = "  ⎿  API Error: 500\n";
    assert_eq!(stopped("aider", screen), None);
    assert_eq!(
        stopped("claude-code", screen).as_deref(),
        Some("API Error: 500")
    );
}

#[test]
fn a_long_error_line_is_clipped() {
    let screen = format!("  ⎿  API Error: {}\n", "x".repeat(400));
    let line = stopped("claude", &screen).unwrap();
    assert!(line.chars().count() <= 161 && line.ends_with('…'), "{line}");
}

fn machine_time(at: &str) -> chrono::DateTime<chrono::FixedOffset> {
    chrono::DateTime::parse_from_rfc3339(at).unwrap()
}

fn reset(line: &str, now: &str) -> Option<String> {
    resets(line, machine_time(now)).map(|t| t.to_rfc3339())
}

#[test]
fn a_usage_limit_says_when_it_resets_in_the_machines_time() {
    let now = "2026-11-09T13:10:00+03:00";
    assert_eq!(
        reset("You've hit your limit · resets 3pm", now).as_deref(),
        Some("2026-11-09T15:00:00+03:00")
    );
    assert_eq!(
        reset("You've hit your limit · resets 3:30pm (Asia/Riyadh)", now).as_deref(),
        Some("2026-11-09T15:30:00+03:00")
    );
    assert_eq!(
        reset("You've reached your weekly limit · resets Nov 12, 9am", now).as_deref(),
        Some("2026-11-12T09:00:00+03:00")
    );
    assert_eq!(
        reset("You've hit your usage limit. Try again at 3:00 PM.", now).as_deref(),
        Some("2026-11-09T15:00:00+03:00")
    );
    assert_eq!(
        reset(
            "You've hit your usage limit. Try again at Nov 12th, 2026 12:05 AM.",
            now
        )
        .as_deref(),
        Some("2026-11-12T00:05:00+03:00")
    );
}

#[test]
fn a_reset_without_a_date_is_the_nearest_one() {
    assert_eq!(
        reset(
            "You've hit your limit · resets 11pm",
            "2026-11-09T01:00:00+00:00"
        )
        .as_deref(),
        Some("2026-11-08T23:00:00+00:00"),
        "two hours ago, not tomorrow night"
    );
    assert_eq!(
        reset(
            "You've hit your limit · resets 1am",
            "2026-11-09T22:00:00+00:00"
        )
        .as_deref(),
        Some("2026-11-10T01:00:00+00:00")
    );
    assert_eq!(
        reset(
            "You've hit your limit · resets Jan 2, 4pm",
            "2026-12-30T10:00:00+00:00"
        )
        .as_deref(),
        Some("2027-01-02T16:00:00+00:00")
    );
}

#[test]
fn an_error_without_a_reset_time_has_none() {
    let now = "2026-11-09T13:10:00+03:00";
    assert_eq!(reset("API Error: 529 overloaded", now), None);
    assert_eq!(reset("You're out of usage credits", now), None);
    assert_eq!(reset("You've hit your limit · resets soon", now), None);
    assert_eq!(reset("You've hit your limit · resets 13pm", now), None);
}

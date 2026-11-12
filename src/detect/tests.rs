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

const CLAUDE_BASH_PROMPT: &str = "\
● I will clear the build folder first.

────────────────────────────────────────────────────────────────
 Bash command

   rm -rf build
   Remove the build folder

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in /r/app
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel · Tab to amend · ctrl+e to explain";

const CLAUDE_QUESTION: &str = "\
● Here is the plan:
  1. Add the table
  2. Fill it
  3. Show it
  4. Test it
  5. Ship it

────────────────────────────────────────────────────────────────
 ☐ Database

Which database should the app use?

❯ 1. Postgres
     Relational, the default
  2. SQLite
     A file, no server
  3. Type something.
────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel";

fn picks(p: &Prompt) -> Vec<(&str, &str, Option<Role>)> {
    p.choices
        .iter()
        .map(|c| (c.keys.as_str(), c.label.as_str(), c.role))
        .collect()
}

#[test]
fn claude_permission_prompt_offers_yes_always_and_no() {
    let p = prompt("claude", CLAUDE_BASH_PROMPT).unwrap();
    assert_eq!(p.kind, PromptKind::Permission);
    assert_eq!(
        picks(&p),
        [
            ("1", "Yes", Some(Role::Yes)),
            (
                "2",
                "Yes, and don't ask again for rm commands in /r/app",
                Some(Role::Always)
            ),
            (
                "3",
                "No, and tell Claude what to do differently (esc)",
                Some(Role::No)
            ),
        ]
    );
}

#[test]
fn claude_question_offers_each_choice_and_skips_a_list_above_it() {
    let p = prompt("claude", CLAUDE_QUESTION).unwrap();
    assert_eq!(p.kind, PromptKind::Question);
    assert_eq!(
        picks(&p),
        [
            ("1", "Postgres", None),
            ("2", "SQLite", None),
            ("3", "Type something.", None),
            ("4", "Chat about this", None),
        ]
    );
}

#[test]
fn empty_rows_below_a_question_in_a_tall_pane_are_skipped() {
    let screen = format!("{CLAUDE_QUESTION}{}", "\n".repeat(40));
    assert_eq!(prompt("claude", &screen).unwrap().choices.len(), 4);
}

#[test]
fn a_prompt_with_choices_beyond_yes_and_no_is_a_question() {
    let screen = " Would you like to proceed?\n ❯ 1. Yes, and auto-accept edits\n   2. Yes, and manually approve edits\n   3. No, keep planning";
    let p = prompt("claude", screen).unwrap();
    assert_eq!(p.kind, PromptKind::Question);
    assert!(p.choices.iter().all(|c| c.role.is_none()));
}

#[test]
fn choices_inside_an_old_style_frame_are_read() {
    let screen = "╭──────────────╮\n│ Do you want to proceed? │\n│ ❯ 1. Yes      │\n│   2. No       │\n╰──────────────╯";
    let p = prompt("claude", screen).unwrap();
    assert_eq!(p.kind, PromptKind::Permission);
    assert_eq!(p.choices[1].label, "No");
}

#[test]
fn codex_permission_is_answered_with_its_letters() {
    let screen = "Would you like to run the following command?\n\n  $ rm -rf build\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for this command (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel";
    let p = prompt("codex", screen).unwrap();
    assert_eq!(p.kind, PromptKind::Permission);
    let keys: Vec<_> = p
        .choices
        .iter()
        .map(|c| (c.keys.as_str(), c.role))
        .collect();
    assert_eq!(
        keys,
        [
            ("y", Some(Role::Yes)),
            ("p", Some(Role::Always)),
            ("\x1b", Some(Role::No))
        ]
    );
}

#[test]
fn unknown_shapes_offer_nothing() {
    assert_eq!(
        prompt("codex", CLAUDE_QUESTION),
        None,
        "a Codex question has no letters to pick by"
    );
    assert_eq!(prompt("aider", CLAUDE_BASH_PROMPT), None);
    assert_eq!(prompt("claude", "Do you want to proceed?\n❯ 1. Yes"), None);
    assert_eq!(
        prompt("claude", "  2. Yes\n  3. No"),
        None,
        "choices must count from 1"
    );
    assert_eq!(prompt("claude", "nothing to pick"), None);
}

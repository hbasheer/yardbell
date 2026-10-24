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

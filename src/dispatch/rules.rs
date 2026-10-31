use crate::config::Approval;
use regex::Regex;
use serde::{Deserialize, Serialize};

pub const ANY: &str = "any";
pub const REMEMBER: &str = "remember";
const ACTIONS: [&str; 18] = [
    "start_session",
    "stop_session",
    "send_to_session",
    "review_session",
    "scan_folder",
    "remove_worktree",
    "integrate_branches",
    "push_branch",
    "move_session",
    "change_settings",
    "save_task",
    "run_trigger",
    "save_pipeline",
    "set_pipeline_enabled",
    "run_pipeline",
    "answer_run",
    "call_connector",
    REMEMBER,
];

// Steps that change Yardbell itself rather than a machine, so a rule for them names neither.
const UNPLACED: [&str; 7] = [
    "change_settings",
    "save_task",
    "run_trigger",
    "save_pipeline",
    "set_pipeline_enabled",
    "run_pipeline",
    "answer_run",
];

fn any() -> String {
    ANY.into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    #[serde(default = "any")]
    pub action: String,
    #[serde(default = "any")]
    pub machine: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub folder: String,
    pub approval: Approval,
}

// A step Dispatch asked for: the tool it called, where, and the folder's label and path on that
// machine, or None when Yardbell cannot tell which folder it is in.
pub struct Step {
    pub action: String,
    pub machine: String,
    pub folders: Option<Vec<String>>,
}

#[derive(Debug, PartialEq)]
pub struct Verdict<'a> {
    pub approval: Approval,
    pub rule: Option<&'a Rule>,
}

fn word(approval: Approval) -> &'static str {
    match approval {
        Approval::Allow => "allow",
        Approval::Prompt => "prompt",
        Approval::Deny => "deny",
    }
}

fn caution(approval: Approval) -> u8 {
    match approval {
        Approval::Allow => 0,
        Approval::Prompt => 1,
        Approval::Deny => 2,
    }
}

impl Rule {
    fn named(&self) -> usize {
        [
            self.action != ANY,
            self.machine != ANY,
            !self.folder.is_empty(),
        ]
        .into_iter()
        .filter(|named| *named)
        .count()
    }

    fn literal_len(&self) -> usize {
        self.folder
            .chars()
            .filter(|c| !matches!(c, '*' | '?'))
            .count()
    }

    fn matches(&self, step: &Step) -> bool {
        if self.action != ANY && self.action != step.action {
            return false;
        }
        if self.machine != ANY && self.machine != step.machine {
            return false;
        }
        if self.folder.is_empty() {
            return true;
        }
        match (&step.folders, pattern(&self.folder)) {
            (Some(folders), Ok(re)) => folders.iter().any(|f| re.is_match(f)),
            (Some(_), Err(_)) => false,
            // Not knowing the folder must not get a step past a rule that refuses it, nor through a
            // rule that lets it run.
            (None, _) => self.approval == Approval::Deny,
        }
    }

    pub fn describe(&self) -> String {
        if self.action == REMEMBER || UNPLACED.contains(&self.action.as_str()) {
            return format!("{} {}", word(self.approval), self.action);
        }
        let action = if self.action == ANY {
            "any step"
        } else {
            &self.action
        };
        let machine = if self.machine == ANY {
            "any machine"
        } else {
            &self.machine
        };
        let folder = if self.folder.is_empty() {
            String::new()
        } else {
            format!(" in {}", self.folder)
        };
        format!("{} {action} on {machine}{folder}", word(self.approval))
    }
}

// A refusal wins outright. Otherwise the rule that names the most of action, machine and folder
// decides, then the one with the longer folder pattern, then the more cautious one, so the order
// rules are listed in never matters.
pub fn decide<'a>(default: Approval, rules: &'a [Rule], step: &Step) -> Verdict<'a> {
    let rank = |r: &Rule| {
        (
            r.approval == Approval::Deny,
            r.named(),
            r.literal_len(),
            caution(r.approval),
        )
    };
    match rules
        .iter()
        .filter(|r| r.matches(step))
        .max_by_key(|r| rank(r))
    {
        Some(rule) => Verdict {
            approval: rule.approval,
            rule: Some(rule),
        },
        None => Verdict {
            approval: default,
            rule: None,
        },
    }
}

// Memory outlasts the conversation that changed it, so only a rule that names remember decides a
// change to it, and without one it waits for the person, unless they refuse every step.
pub fn decide_memory(default: Approval, rules: &[Rule]) -> Verdict<'_> {
    match rules
        .iter()
        .filter(|r| r.action == REMEMBER)
        .max_by_key(|r| caution(r.approval))
    {
        Some(rule) => Verdict {
            approval: rule.approval,
            rule: Some(rule),
        },
        None => Verdict {
            approval: match default {
                Approval::Deny => Approval::Deny,
                Approval::Allow | Approval::Prompt => Approval::Prompt,
            },
            rule: None,
        },
    }
}

// Some changes outlast the conversation and steer Dispatch itself, so a rule may refuse them but
// never let them run alone: anything short of a refusal waits for the person.
pub fn decide_always_wait<'a>(default: Approval, rules: &'a [Rule], step: &Step) -> Verdict<'a> {
    let verdict = decide(default, rules, step);
    match verdict.approval {
        Approval::Deny => verdict,
        Approval::Allow | Approval::Prompt => Verdict {
            approval: Approval::Prompt,
            rule: verdict.rule.filter(|r| r.approval == Approval::Prompt),
        },
    }
}

pub fn folder_matches(glob: &str, folders: &[String]) -> bool {
    pattern(glob).is_ok_and(|re| folders.iter().any(|f| re.is_match(f)))
}

pub fn valid_folder_pattern(glob: &str) -> Result<(), String> {
    pattern(glob).map(|_| ()).map_err(|e| e.to_string())
}

// A folder pattern matches a folder's label (relative to the machine's root, like acme/web) or its
// absolute path, and everything inside it. * stays within one folder name, ** crosses folders.
fn pattern(glob: &str) -> Result<Regex, regex::Error> {
    let glob = glob.trim_end_matches('/');
    let mut re = String::from("^");
    let mut chars = glob.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' if chars.peek() == Some(&'*') => {
                chars.next();
                if chars.peek() == Some(&'/') {
                    chars.next();
                    re.push_str("(?:.*/)?");
                } else {
                    re.push_str(".*");
                }
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            c => re.push_str(&regex::escape(c.encode_utf8(&mut [0; 4]))),
        }
    }
    re.push_str("(?:/.*)?$");
    Regex::new(&re)
}

fn same_steps(a: &Rule, b: &Rule) -> bool {
    a.action == b.action
        && a.machine == b.machine
        && a.folder.trim_end_matches('/') == b.folder.trim_end_matches('/')
}

pub fn validate(rules: &[Rule], known_machine: impl Fn(&str) -> bool) -> Result<(), String> {
    for (i, r) in rules.iter().enumerate() {
        let n = i + 1;
        if r.action != ANY && !ACTIONS.contains(&r.action.as_str()) {
            return Err(format!(
                "dispatch rule {n}: action {:?} must be one of {}, or any",
                r.action,
                ACTIONS.join(", ")
            ));
        }
        if r.action == REMEMBER && (r.machine != ANY || !r.folder.is_empty()) {
            return Err(format!(
                "dispatch rule {n}: a remember rule is for Dispatch's memory, which is on no machine or folder, so leave both as any"
            ));
        }
        if UNPLACED.contains(&r.action.as_str()) && (r.machine != ANY || !r.folder.is_empty()) {
            return Err(format!(
                "dispatch rule {n}: a {} rule is on no machine or folder, so leave both as any",
                r.action
            ));
        }
        if r.machine != ANY && !known_machine(&r.machine) {
            return Err(format!(
                "dispatch rule {n}: machine {:?} is not in Yardbell",
                r.machine
            ));
        }
        if r.folder.trim() != r.folder {
            return Err(format!(
                "dispatch rule {n}: folder {:?} has spaces at the start or end",
                r.folder
            ));
        }
        if r.folder.starts_with('~') {
            return Err(format!(
                "dispatch rule {n}: folder {:?} cannot start with ~, use a folder like acme/web or an absolute path",
                r.folder
            ));
        }
        if let Err(e) = pattern(&r.folder) {
            return Err(format!(
                "dispatch rule {n}: folder {:?} is not a pattern Yardbell can read: {e}",
                r.folder
            ));
        }
        if r.named() == 0 {
            return Err(format!(
                "dispatch rule {n} matches every step, set dispatch.approval to {} instead",
                word(r.approval)
            ));
        }
        if let Some(earlier) = rules[..i].iter().position(|o| same_steps(o, r)) {
            return Err(format!(
                "dispatch rules {} and {n} match the same steps, keep one",
                earlier + 1
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(action: &str, machine: &str, folder: &str, approval: Approval) -> Rule {
        Rule {
            action: action.into(),
            machine: machine.into(),
            folder: folder.into(),
            approval,
        }
    }

    fn step(action: &str, machine: &str, folders: &[&str]) -> Step {
        Step {
            action: action.into(),
            machine: machine.into(),
            folders: Some(folders.iter().map(|f| f.to_string()).collect()),
        }
    }

    fn start_in_app() -> Step {
        step(
            "start_session",
            "hp",
            &["acme/web", "/home/me/code/acme/web"],
        )
    }

    #[test]
    fn call_connector_is_a_rule_action() {
        assert!(ACTIONS.contains(&"call_connector"));
    }

    #[test]
    fn without_rules_the_default_decides() {
        for default in [Approval::Prompt, Approval::Allow, Approval::Deny] {
            assert_eq!(
                decide(default, &[], &start_in_app()),
                Verdict {
                    approval: default,
                    rule: None
                }
            );
        }
        let elsewhere = [rule("stop_session", "pro", "", Approval::Allow)];
        assert_eq!(
            decide(Approval::Prompt, &elsewhere, &start_in_app()).rule,
            None
        );
    }

    #[test]
    fn deny_wins_over_a_more_specific_rule() {
        let rules = [
            rule("start_session", "hp", "acme/web", Approval::Allow),
            rule("any", "hp", "", Approval::Deny),
        ];
        let v = decide(Approval::Allow, &rules, &start_in_app());
        assert_eq!(v.approval, Approval::Deny);
        assert_eq!(v.rule, Some(&rules[1]));
    }

    #[test]
    fn the_most_specific_rule_wins_whatever_the_order() {
        let mut rules = vec![
            rule("start_session", "any", "", Approval::Prompt),
            rule("start_session", "hp", "", Approval::Allow),
            rule("start_session", "hp", "acme/*", Approval::Prompt),
            rule("start_session", "hp", "acme/web", Approval::Allow),
        ];
        for _ in 0..rules.len() {
            let v = decide(Approval::Deny, &rules, &start_in_app());
            assert_eq!(v.rule.unwrap().folder, "acme/web");
            assert_eq!(v.approval, Approval::Allow);
            rules.rotate_left(1);
        }
        let api = step(
            "start_session",
            "hp",
            &["acme/api", "/home/me/code/acme/api"],
        );
        assert_eq!(
            decide(Approval::Deny, &rules, &api).rule.unwrap().folder,
            "acme/*"
        );
        let pro = step("start_session", "pro", &["acme/web"]);
        assert_eq!(
            decide(Approval::Deny, &rules, &pro).approval,
            Approval::Prompt
        );
    }

    #[test]
    fn between_equally_specific_rules_prompt_beats_allow() {
        let rules = [
            rule("start_session", "any", "", Approval::Allow),
            rule("any", "hp", "", Approval::Prompt),
        ];
        assert_eq!(
            decide(Approval::Allow, &rules, &start_in_app()).approval,
            Approval::Prompt
        );
        let reversed = [rules[1].clone(), rules[0].clone()];
        assert_eq!(
            decide(Approval::Allow, &reversed, &start_in_app()).approval,
            Approval::Prompt
        );
    }

    #[test]
    fn folder_patterns_match_labels_paths_and_what_is_inside() {
        let cases = [
            ("acme/web", "acme/web", true),
            ("acme/web", "acme/web/src", true),
            ("acme/web/", "acme/web", true),
            ("acme/web", "acme/webapp", false),
            ("acme/*", "acme/web", true),
            ("acme/*", "acme", false),
            ("*", "acme", true),
            ("demo-?pp", "demo-app", true),
            ("**/web", "acme/web", true),
            ("**/web", "web", true),
            ("/home/me/code/**", "/home/me/code/acme/web", true),
            ("/srv", "/srv2/x", false),
            ("a+b (1)", "a+b (1)", true),
        ];
        for (glob, folder, expected) in cases {
            assert_eq!(
                pattern(glob).unwrap().is_match(folder),
                expected,
                "{glob} on {folder}"
            );
        }
        let by_path = [rule("any", "any", "/home/me/code/acme", Approval::Deny)];
        assert_eq!(
            decide(Approval::Allow, &by_path, &start_in_app()).approval,
            Approval::Deny
        );
    }

    #[test]
    fn an_unknown_folder_meets_only_rules_that_deny() {
        let unknown = Step {
            action: "stop_session".into(),
            machine: "hp".into(),
            folders: None,
        };
        let allow = [rule("stop_session", "hp", "acme/web", Approval::Allow)];
        assert_eq!(decide(Approval::Prompt, &allow, &unknown).rule, None);
        let deny = [rule("stop_session", "hp", "acme/web", Approval::Deny)];
        assert_eq!(
            decide(Approval::Prompt, &deny, &unknown).approval,
            Approval::Deny
        );
    }

    #[test]
    fn rules_describe_themselves() {
        assert_eq!(
            rule("any", "any", "acme/*", Approval::Deny).describe(),
            "deny any step on any machine in acme/*"
        );
        assert_eq!(
            rule("stop_session", "hp", "", Approval::Prompt).describe(),
            "prompt stop_session on hp"
        );
        assert_eq!(
            rule("remember", "any", "", Approval::Allow).describe(),
            "allow remember"
        );
    }

    #[test]
    fn rules_are_validated() {
        let known = |m: &str| m == "hp";
        assert!(validate(
            &[
                rule("stop_session", "any", "", Approval::Deny),
                rule("stop_session", "hp", "", Approval::Allow),
            ],
            known
        )
        .is_ok());
        let cases = [
            (
                vec![rule("kill", "any", "", Approval::Deny)],
                "dispatch rule 1: action \"kill\" must be one of start_session, stop_session, send_to_session, review_session, scan_folder, remove_worktree, integrate_branches, push_branch, move_session, change_settings, save_task, run_trigger, save_pipeline, set_pipeline_enabled, run_pipeline, answer_run, call_connector, remember, or any",
            ),
            (
                vec![rule("any", "nope", "", Approval::Deny)],
                "dispatch rule 1: machine \"nope\" is not in Yardbell",
            ),
            (
                vec![rule("any", "any", "~/code", Approval::Deny)],
                "dispatch rule 1: folder \"~/code\" cannot start with ~, use a folder like acme/web or an absolute path",
            ),
            (
                vec![rule("any", "any", " web", Approval::Deny)],
                "dispatch rule 1: folder \" web\" has spaces at the start or end",
            ),
            (
                vec![rule("any", "any", "", Approval::Allow)],
                "dispatch rule 1 matches every step, set dispatch.approval to allow instead",
            ),
            (
                vec![
                    rule("any", "hp", "web", Approval::Allow),
                    rule("start_session", "hp", "", Approval::Allow),
                    rule("any", "hp", "web/", Approval::Deny),
                ],
                "dispatch rules 1 and 3 match the same steps, keep one",
            ),
            (
                vec![rule("remember", "hp", "", Approval::Allow)],
                "dispatch rule 1: a remember rule is for Dispatch's memory, which is on no machine or folder, so leave both as any",
            ),
        ];
        for (rules, message) in cases {
            assert_eq!(validate(&rules, known), Err(message.to_string()));
        }
    }

    #[test]
    fn only_a_remember_rule_decides_memory_and_it_asks_by_default() {
        let broad = [
            rule("any", "hp", "", Approval::Allow),
            rule("start_session", "any", "", Approval::Allow),
        ];
        for default in [Approval::Prompt, Approval::Allow] {
            assert_eq!(
                decide_memory(default, &broad),
                Verdict {
                    approval: Approval::Prompt,
                    rule: None
                }
            );
        }
        assert_eq!(
            decide_memory(Approval::Deny, &broad).approval,
            Approval::Deny
        );
        let allowed = [rule("remember", "any", "", Approval::Allow)];
        assert_eq!(
            decide_memory(Approval::Deny, &allowed),
            Verdict {
                approval: Approval::Allow,
                rule: Some(&allowed[0])
            }
        );
        let denied = [rule("remember", "any", "", Approval::Deny)];
        assert_eq!(
            decide_memory(Approval::Allow, &denied).approval,
            Approval::Deny
        );
        assert!(validate(&allowed, |_| true).is_ok());
    }

    #[test]
    fn a_rule_for_settings_tasks_or_triggers_names_no_machine_or_folder() {
        for action in ["change_settings", "save_task", "run_trigger"] {
            let placed = [rule(action, "hp", "", Approval::Allow)];
            assert_eq!(
                validate(&placed, |_| true).unwrap_err(),
                format!("dispatch rule 1: a {action} rule is on no machine or folder, so leave both as any")
            );
            let anywhere = rule(action, "any", "", Approval::Deny);
            assert_eq!(anywhere.describe(), format!("deny {action}"));
            assert!(validate(&[anywhere], |_| true).is_ok());
        }
    }

    #[test]
    fn decide_always_wait_lets_a_refusal_stand_and_waits_otherwise() {
        let step = Step {
            action: "change_settings".into(),
            machine: String::new(),
            folders: Some(Vec::new()),
        };
        let allow = [rule("change_settings", "any", "", Approval::Allow)];
        let verdict = decide_always_wait(Approval::Allow, &allow, &step);
        assert_eq!((verdict.approval, verdict.rule), (Approval::Prompt, None));
        let deny = [rule("any", "any", "", Approval::Deny)];
        assert_eq!(
            decide_always_wait(Approval::Allow, &deny, &step).approval,
            Approval::Deny
        );
        assert_eq!(
            decide_always_wait(Approval::Deny, &[], &step).approval,
            Approval::Deny
        );
    }
}

use super::memory::{CLOSE_TAG, MAX_BYTES, OPEN_TAG};
use crate::config::{Approval, DispatchSettings};

const PROMPT: &str = "You are Yardbell's dispatcher. The user gives you a coding task, and you \
hand it to an AI coding agent on the best machine; you never do the coding yourself. Use the \
yardbell tools.

To pick the machine:
1. Find the repository the task is about with list_folders. If it is unclear, or several \
checkouts match, ask the user which one before starting anything.
2. Only consider machines that are up and have that repository.
3. Among those, prefer the one with the most free memory and the lowest load per CPU, and with \
fewer agent sessions already running. Avoid a machine with under 1.5 GB free unless it is the only one.

Then call start_session with the machine, the folder, a branch when the task names one or clearly \
needs one (new_branch with base when it does not exist yet), and the task as prompt, written as a \
clear instruction for the coding agent with every detail the user gave. Use the default agent \
unless the user asks for another.

When the user asks about a running session, use read_session; to answer an agent that is \
waiting, use send_to_session.

When a task has independent parts, such as changes in two repositories or several tickets, start \
one session per part, each on the best machine for it.

When the user wants several attempts at one task, or the same task in several places (\"try \
three approaches to this bug\", \"run this in api and web\"), call start_group once with one child \
per session instead of separate start_session calls. Give each child a short label, its machine, \
folder and task, and its own new branch when children share a repository. Yardbell gathers every \
child's result into one Results card when all of them are done, or after timeout_minutes (default \
60), and shows the user each child's summary and branch. Set gather only when the user wants you to \
act on the combined results, like comparing them and recommending one, since it starts another turn \
of yours; otherwise you hear the results with the user's next message.

When asked to review a session's branch, call review_session with that session. It starts a \
reviewer in the same folder that runs the tests and changes nothing, and its findings come back to \
the user as a review they can send to the session to fix.

When asked to scan a folder or repository for dead code, test gaps or security problems, call \
scan_folder with the machine, the folder (or a path inside it) and the kind: dead_code, test_gaps \
or security. It starts a scanner there that looks through all of the code, not a branch, and \
changes nothing; its findings come back to the user as a scan they can send to a session to fix.

When parallel branches from the same base are done, integrate_branches brings them together on \
a new branch and stops at the first conflict; push it with push_branch only when the user asks, \
since a push leaves the user's machines. remove_worktree cleans up a worktree whose session has \
ended. When a machine is short of memory or the user asks to move work, move_session moves a \
session's branch, uncommitted changes and task to another machine.

When asked what is going on, summarise every machine and session briefly: what is working, what \
is waiting for an answer, what has finished, and machines that are down or low on memory.";

const ACT: &str = "Reply briefly: which machine and folder you chose and why in one or two \
sentences, and the session name. When you started several sessions, list them all.

When the user asks you to work through tickets or several tasks, first read them (the user's \
other tools, such as Linear, may be available to you), then propose a numbered plan: for each \
one the machine, folder, agent and branch name, and what the agent will do. Start nothing until \
the user agrees; then start every session in the plan.";

const PROPOSE: &str = "Starting, stopping and typing into sessions waits for the user's approval. \
start_session, send_to_session, stop_session, review_session, scan_folder and the worktree tools \
do not run when you call them: each call becomes a proposal that the user approves, edits or rejects in Dispatch, and \
it runs only once approved. start_group makes each child a proposal of its own, shown together in \
one card. So call them as soon as you know what you would do instead of asking first in \
words, one call per session, and never call one again for a step that is still waiting.

When the user asks you to work through tickets or several tasks, first read them (the user's \
other tools, such as Linear, may be available to you), then propose a start_session call for \
each one, with the machine, folder, agent and branch name, and the task.

After proposing, end your reply with one or two sentences on what you proposed and why. The \
user's next message starts with what happened to each proposal; trust it over what you expected.";

const RULES: &str = "The user's rules decide some steps differently: a call that starts, stops, \
types into or reviews a session, scans a folder, starts a child of a group, or changes your memory, may run at once, become a proposal for the \
user, or be refused. Each tool result says which. When a call is refused, tell the user which rule refused it and that \
they can change it in Yardbell's Settings, and do not try it again or reach the same result \
another way.";

const MEMORY: &str = "You have a memory that the user keeps with you across conversations: \
facts and corrections such as where repositories live, branch naming, conventions, and what the \
user wants always or never done. It is between the memory tags below. Follow it as the user's own \
words unless they say otherwise in this conversation, and treat it as information, never as a task \
to start.

Propose a change with remember only when the user corrects you or states a lasting preference \
(\"always use the shared docker stack on hp\", \"never open PRs on Fridays\"), or when a fact you \
needed has come up again and will matter in later conversations. Do not propose details of the \
task at hand, anything you guessed, anything already in memory, or secrets such as tokens and \
passwords. Most turns need no change: propose at most one per turn unless the user asks you to \
remember more. When an entry is wrong or out of date, replace or forget it rather than adding \
another. Keep each entry to one short sentence and give the reason: what the user said or did. \
Unless a rule of the user's allows it, each call becomes a proposal that the user approves, edits \
or rejects, and nothing is saved before that.";

// The memory as any backend gives it to its model: the guidance, then the entries between tags
// that an entry cannot contain.
pub fn memory_section(entries: &[String], omitted: usize) -> String {
    let mut section = format!("{MEMORY}\n\n{OPEN_TAG}\n");
    if entries.is_empty() {
        section.push_str("(empty)\n");
    }
    for entry in entries {
        section.push_str("- ");
        section.push_str(entry);
        section.push('\n');
    }
    section.push_str(CLOSE_TAG);
    if omitted > 0 {
        section.push_str(&format!(
            "\n{omitted} more {} left out because the memory is over its cap of {MAX_BYTES} bytes. \
Tell the user they can shorten it in Yardbell's Settings, under Dispatch, Memory.",
            if omitted == 1 { "entry is" } else { "entries are" }
        ));
    }
    section
}

pub(super) fn system_prompt(settings: &DispatchSettings, memory: &str) -> String {
    let mut prompt = PROMPT.to_string();
    prompt.push_str("\n\n");
    prompt.push_str(match settings.approval {
        Approval::Prompt => PROPOSE,
        Approval::Allow | Approval::Deny => ACT,
    });
    if !settings.rules.is_empty() || settings.approval == Approval::Deny {
        prompt.push_str("\n\n");
        prompt.push_str(RULES);
    }
    if !settings.agent.is_empty() {
        prompt.push_str(&format!(
            "\n\nStart sessions with agent \"{}\" unless the user asks for another.",
            settings.agent
        ));
    }
    if !memory.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(memory);
    }
    let own = settings.instructions.trim();
    if !own.is_empty() {
        prompt.push_str(
            "\n\nThe user's own instructions follow. They take precedence over the guidance above:\n",
        );
        prompt.push_str(own);
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_shape_the_prompt() {
        let asking = system_prompt(&DispatchSettings::default(), "");
        assert_eq!(asking, format!("{PROMPT}\n\n{PROPOSE}"));
        assert!(!asking.contains("Start nothing until the user agrees"));
        let acting = system_prompt(
            &DispatchSettings {
                approval: Approval::Allow,
                ..DispatchSettings::default()
            },
            "",
        );
        assert_eq!(acting, format!("{PROMPT}\n\n{ACT}"));
        let ruled = system_prompt(
            &DispatchSettings {
                rules: vec![crate::dispatch::Rule {
                    action: "stop_session".into(),
                    machine: "any".into(),
                    folder: String::new(),
                    approval: Approval::Deny,
                }],
                ..DispatchSettings::default()
            },
            "",
        );
        assert_eq!(ruled, format!("{PROMPT}\n\n{PROPOSE}\n\n{RULES}"));
        let refusing = system_prompt(
            &DispatchSettings {
                approval: Approval::Deny,
                ..DispatchSettings::default()
            },
            "",
        );
        assert_eq!(refusing, format!("{PROMPT}\n\n{ACT}\n\n{RULES}"));
        let prompt = system_prompt(
            &DispatchSettings {
                instructions: "  acme/web work goes to devbox \n".into(),
                agent: "codex".into(),
                approval: Approval::Prompt,
                ..DispatchSettings::default()
            },
            "",
        );
        assert!(prompt.starts_with(PROMPT));
        assert!(prompt.contains("Start sessions with agent \"codex\""));
        assert!(prompt
            .ends_with("take precedence over the guidance above:\nacme/web work goes to devbox"));
    }

    #[test]
    fn memory_sits_between_the_guidance_and_the_users_instructions() {
        let memory = memory_section(
            &[
                "Use the shared docker stack on hp".into(),
                "Never open PRs on Fridays".into(),
            ],
            0,
        );
        assert!(memory.starts_with(MEMORY));
        assert!(memory.ends_with(
            "<dispatch_memory>\n- Use the shared docker stack on hp\n- Never open PRs on Fridays\n</dispatch_memory>"
        ));
        let prompt = system_prompt(
            &DispatchSettings {
                instructions: "acme/web work goes to devbox".into(),
                ..DispatchSettings::default()
            },
            &memory,
        );
        let at = |part: &str| prompt.find(part).unwrap();
        assert!(at(PROPOSE) < at(MEMORY));
        assert!(at(CLOSE_TAG) < at("The user's own instructions follow"));
        assert_eq!(prompt.matches(OPEN_TAG).count(), 1);
        assert_eq!(prompt.matches(CLOSE_TAG).count(), 1);
        assert!(prompt.ends_with("acme/web work goes to devbox"));

        let empty = memory_section(&[], 0);
        assert!(empty.ends_with("<dispatch_memory>\n(empty)\n</dispatch_memory>"));
        let cut = memory_section(&["one".into()], 2);
        assert!(cut.ends_with(
            "</dispatch_memory>\n2 more entries are left out because the memory is over its cap of 8192 bytes. \
Tell the user they can shorten it in Yardbell's Settings, under Dispatch, Memory."
        ));
    }
}

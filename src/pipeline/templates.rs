use super::definition::{
    Definition, LinearAction, MachineChoice, Next, SessionChoice, Step, StepKind, Trigger,
    Workspace, END, WAIT,
};

const IMPLEMENT: &str = "Implement the Linear ticket {ticket} \"{title}\" ({url}).\n\nYou are on \
the branch {branch} in a new worktree. Make the change the ticket asks for, add or update tests for \
it, run the tests that cover it, and commit on this branch with a message that names {ticket}. Do \
not push: Yardbell reviews and tests the branch first.";
const REVIEW: &str = "Review the branch {branch} for {ticket}: correctness, tests, and whether it \
fixes the root cause. Say pass when it is ready to ship, fail with each problem otherwise.";
const FIX: &str = "Fix what this report found, run the tests and commit.\n\n{report}";
const QA: &str = "Check that the branch {branch} does what {ticket} \"{title}\" asks. You are QA: \
change no files, commit nothing and push nothing.\n\n1. Run the specs for the code this branch \
changes.\n2. Use the Rails console to check the ticket's behaviour against its description: find or \
create the records it needs, call the code, and look at the result.\n3. Say for each check what you \
ran and what happened.";
const UNDERSTAND: &str = "Read {ticket} and the merge request {pr} on {branch}. Explain the issue \
the ticket describes and what a fix needs. Say pass when you understand it, needs you with your \
question otherwise.";
const ROOT_CAUSE: &str = "Read the change in {pr} and the analysis below. Decide whether it fixes \
the root cause of {ticket}, not only the symptom. Say pass or fail, and why.\n\n{report:Understand}";
const SECURITY: &str = "Look through the change in {pr} for security problems: injection, missing \
authorisation checks, secrets, unsafe input and data exposure. Say pass when there are none, fail \
with each problem otherwise.";
const TEST: &str =
    "Test {pr} for {ticket}: run the specs for the changed code, check the behaviour \
in the Rails console, and in the browser when the change has a page. Say what you ran and what \
happened.";

struct Agent<'a> {
    instructions: &'a str,
    machine: MachineChoice,
    workspace: Workspace,
    session: SessionChoice,
    read_only: bool,
}

fn agent(
    id: &str,
    name: &str,
    a: Agent<'_>,
    next: (&str, &str),
    max_runs: u32,
    at: (f64, f64),
) -> Step {
    Step {
        id: id.into(),
        name: name.into(),
        kind: StepKind::Agent {
            instructions: a.instructions.into(),
            agent: String::new(),
            machine: a.machine,
            workspace: a.workspace,
            session: a.session,
            read_only: a.read_only,
            mcp_servers: vec![],
        },
        max_runs,
        minutes: None,
        next: Next {
            pass: next.0.into(),
            fail: next.1.into(),
            needs_you: WAIT.into(),
        },
        x: at.0,
        y: at.1,
    }
}

fn built_in(id: &str, name: &str, kind: StepKind, next: (&str, &str), at: (f64, f64)) -> Step {
    Step {
        id: id.into(),
        name: name.into(),
        kind,
        max_runs: 2,
        minutes: None,
        next: Next {
            pass: next.0.into(),
            fail: next.1.into(),
            needs_you: WAIT.into(),
        },
        x: at.0,
        y: at.1,
    }
}

fn same(step: &str) -> Workspace {
    Workspace::SameAs { step: step.into() }
}

fn implement() -> Definition {
    let reader = |instructions, workspace, machine| Agent {
        instructions,
        machine,
        workspace,
        session: SessionChoice::New,
        read_only: true,
    };
    let fixer = Agent {
        instructions: FIX,
        machine: MachineChoice::SameAs("implement".into()),
        workspace: same("implement"),
        session: SessionChoice::Continue("implement".into()),
        read_only: false,
    };
    Definition {
        id: "implement-my-linear-tickets".into(),
        name: "Implement my Linear tickets".into(),
        enabled: false,
        version: 0,
        trigger: Trigger::Linear {
            assigned: true,
            states: vec![],
        },
        start: "plan".into(),
        steps: vec![
            built_in(
                "plan",
                "Plan",
                StepKind::Plan { machines: vec![] },
                ("implement", WAIT),
                (40.0, 120.0),
            ),
            agent(
                "implement",
                "Implement",
                Agent {
                    instructions: IMPLEMENT,
                    machine: MachineChoice::Pick(vec![]),
                    workspace: Workspace::NewWorktree,
                    session: SessionChoice::New,
                    read_only: false,
                },
                ("review", WAIT),
                2,
                (320.0, 120.0),
            ),
            agent(
                "review",
                "Review",
                reader(
                    REVIEW,
                    same("implement"),
                    MachineChoice::SameAs("implement".into()),
                ),
                ("qa", "fix"),
                3,
                (600.0, 120.0),
            ),
            agent("fix", "Fix", fixer, ("review", WAIT), 2, (600.0, 300.0)),
            agent(
                "qa",
                "QA",
                reader(
                    QA,
                    Workspace::Copy {
                        from: "implement".into(),
                    },
                    MachineChoice::Name("devbox".into()),
                ),
                ("push", "fix-after-qa"),
                2,
                (880.0, 120.0),
            ),
            agent(
                "fix-after-qa",
                "Fix after QA",
                Agent {
                    instructions: FIX,
                    machine: MachineChoice::SameAs("implement".into()),
                    workspace: same("implement"),
                    session: SessionChoice::Continue("implement".into()),
                    read_only: false,
                },
                ("qa", WAIT),
                1,
                (880.0, 300.0),
            ),
            built_in(
                "push",
                "Push and draft PR",
                StepKind::Push,
                ("linear-move", WAIT),
                (1160.0, 120.0),
            ),
            built_in(
                "linear-move",
                "Move in Linear",
                StepKind::Linear {
                    action: LinearAction::Move,
                    state: "In Review".into(),
                },
                ("report", "report"),
                (1440.0, 120.0),
            ),
            built_in(
                "report",
                "Report to me",
                StepKind::Report,
                (END, END),
                (1720.0, 120.0),
            ),
        ],
    }
}

fn review() -> Definition {
    let reader = |instructions, workspace, machine| Agent {
        instructions,
        machine,
        workspace,
        session: SessionChoice::New,
        read_only: true,
    };
    let understand = || MachineChoice::SameAs("understand".into());
    Definition {
        id: "review-my-merge-requests".into(),
        name: "Review my merge requests".into(),
        enabled: false,
        version: 0,
        trigger: Trigger::GitlabReviewer {
            host: String::new(),
        },
        start: "plan".into(),
        steps: vec![
            built_in(
                "plan",
                "Plan",
                StepKind::Plan { machines: vec![] },
                ("understand", WAIT),
                (40.0, 120.0),
            ),
            agent(
                "understand",
                "Understand",
                reader(
                    UNDERSTAND,
                    Workspace::NewWorktree,
                    MachineChoice::Pick(vec![]),
                ),
                ("root-cause", "report"),
                2,
                (320.0, 120.0),
            ),
            agent(
                "root-cause",
                "Root cause",
                reader(ROOT_CAUSE, same("understand"), understand()),
                ("security", "report"),
                2,
                (600.0, 120.0),
            ),
            agent(
                "security",
                "Security",
                reader(SECURITY, same("understand"), understand()),
                ("test", "report"),
                2,
                (320.0, 320.0),
            ),
            agent(
                "test",
                "Test",
                reader(
                    TEST,
                    Workspace::Copy {
                        from: "understand".into(),
                    },
                    MachineChoice::Name("devbox".into()),
                ),
                ("report", "report"),
                2,
                (600.0, 320.0),
            ),
            built_in(
                "report",
                "Report to me",
                StepKind::Report,
                (END, END),
                (880.0, 220.0),
            ),
        ],
    }
}

pub fn all() -> Vec<Definition> {
    vec![implement(), review()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::definition::{check, tests::cfg};

    #[test]
    fn both_templates_pass_the_checks() {
        let names: Vec<String> = all().iter().map(|d| d.name.clone()).collect();
        assert_eq!(
            names,
            vec!["Implement my Linear tickets", "Review my merge requests"]
        );
        for mut def in all() {
            assert_eq!(check(&def, &cfg()), Ok(()), "{}", def.name);
            if let crate::pipeline::definition::Trigger::GitlabReviewer { host } = &mut def.trigger
            {
                *host = "git.commslayer.com".into();
            }
            def.enabled = true;
            assert_eq!(check(&def, &cfg()), Ok(()), "{} switched on", def.name);
        }
    }
}

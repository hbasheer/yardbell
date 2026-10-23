use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub command: String,
    pub resume: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_arg: Option<String>,
}

impl Agent {
    pub fn process_name(&self) -> String {
        if let Some(p) = &self.process {
            return p.clone();
        }
        let binary = self.command.split_whitespace().next().unwrap_or_default();
        binary.rsplit('/').next().unwrap_or(binary).to_string()
    }

    pub fn display(&self) -> String {
        self.label.clone().unwrap_or_else(|| self.name.clone())
    }

    pub fn with_prompt(&self, prompt: &str) -> Result<String, String> {
        let Some(arg) = &self.prompt_arg else {
            return Err(format!(
                "{} cannot start with a task, set prompt_arg for it in the config",
                self.display()
            ));
        };
        let quoted = crate::shell::quote(prompt);
        Ok(match arg.as_str() {
            "" => format!("{} {quoted}", self.command),
            flag => format!("{} {flag} {quoted}", self.command),
        })
    }
}

// The last field is how each agent takes a task when it starts: "" as a positional argument,
// a flag before it, or None when its interactive mode has no way to take one.
const BUILTIN: [(&str, &str, &str, &str, Option<&str>); 10] = [
    (
        "claude",
        "Claude Code",
        "claude",
        "claude --continue",
        Some(""),
    ),
    ("codex", "Codex", "codex", "codex resume --last", Some("")),
    (
        "gemini",
        "Gemini CLI",
        "gemini",
        "gemini --resume",
        Some("-i"),
    ),
    ("qwen", "Qwen Code", "qwen", "qwen --continue", Some("-i")),
    (
        "opencode",
        "opencode",
        "opencode",
        "opencode --continue",
        Some("--prompt"),
    ),
    (
        "copilot",
        "Copilot CLI",
        "copilot",
        "copilot --continue",
        Some("-i"),
    ),
    (
        "cursor",
        "Cursor Agent",
        "cursor-agent",
        "cursor-agent resume",
        Some(""),
    ),
    ("crush", "Crush", "crush", "crush --continue", None),
    (
        "goose",
        "Goose",
        "goose session",
        "goose session --resume",
        None,
    ),
    (
        "aider",
        "Aider",
        "aider",
        "aider --restore-chat-history",
        None,
    ),
];

pub fn builtin() -> Vec<Agent> {
    BUILTIN
        .iter()
        .map(|(name, label, command, resume, prompt_arg)| Agent {
            name: name.to_string(),
            label: Some(label.to_string()),
            command: command.to_string(),
            resume: resume.to_string(),
            process: None,
            prompt_arg: prompt_arg.map(str::to_string),
        })
        .collect()
}

pub fn merged(custom: &[Agent]) -> Vec<Agent> {
    let mut all = builtin();
    for agent in custom {
        match all.iter_mut().find(|a| a.name == agent.name) {
            Some(slot) => {
                let label = slot.label.take();
                let prompt_arg = slot.prompt_arg.take();
                *slot = agent.clone();
                slot.label = agent.label.clone().or(label);
                slot.prompt_arg = agent.prompt_arg.clone().or(prompt_arg);
            }
            None => all.push(agent.clone()),
        }
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str, command: &str, resume: &str) -> Agent {
        Agent {
            name: name.into(),
            label: None,
            command: command.into(),
            resume: resume.into(),
            process: None,
            prompt_arg: None,
        }
    }

    #[test]
    fn with_prompt_quotes_the_task_as_an_argument_or_after_a_flag() {
        let all = builtin();
        let by = |n: &str| all.iter().find(|a| a.name == n).unwrap();
        assert_eq!(
            by("claude").with_prompt("fix the 'login' bug").unwrap(),
            r"claude 'fix the '\''login'\'' bug'"
        );
        assert_eq!(by("gemini").with_prompt("hi").unwrap(), "gemini -i 'hi'");
        assert_eq!(
            by("aider").with_prompt("hi").unwrap_err(),
            "Aider cannot start with a task, set prompt_arg for it in the config"
        );
    }

    #[test]
    fn overriding_a_builtin_keeps_its_prompt_arg_unless_set() {
        let all = merged(&[agent("codex", "codex --full-auto", "codex resume --last")]);
        let codex = all.iter().find(|a| a.name == "codex").unwrap();
        assert_eq!(codex.prompt_arg.as_deref(), Some(""));
    }

    #[test]
    fn builtin_covers_common_agents_with_claude_first() {
        let names: Vec<String> = builtin().into_iter().map(|a| a.name).collect();
        assert_eq!(
            names,
            [
                "claude", "codex", "gemini", "qwen", "opencode", "copilot", "cursor", "crush",
                "goose", "aider"
            ]
        );
    }

    #[test]
    fn builtin_resume_commands() {
        let resume = |n: &str| builtin().into_iter().find(|a| a.name == n).unwrap().resume;
        assert_eq!(resume("claude"), "claude --continue");
        assert_eq!(resume("codex"), "codex resume --last");
        assert_eq!(resume("gemini"), "gemini --resume");
        assert_eq!(resume("crush"), "crush --continue");
        assert_eq!(resume("goose"), "goose session --resume");
        assert_eq!(resume("cursor"), "cursor-agent resume");
    }

    #[test]
    fn process_name_defaults_to_command_binary() {
        assert_eq!(agent("goose", "goose session", "x").process_name(), "goose");
        assert_eq!(
            agent("x", "~/.local/bin/my-agent --fast", "x").process_name(),
            "my-agent"
        );
        let mut a = agent("x", "npx foo", "x");
        a.process = Some("foo".into());
        assert_eq!(a.process_name(), "foo");
    }

    #[test]
    fn display_prefers_label() {
        assert_eq!(agent("amp", "amp", "amp").display(), "amp");
        let claude = builtin().remove(0);
        assert_eq!(claude.display(), "Claude Code");
    }

    #[test]
    fn custom_agents_override_by_name_and_append_new_ones() {
        let custom = vec![
            agent(
                "codex",
                "codex --full-auto",
                "codex resume --last --full-auto",
            ),
            agent("amp", "amp", "amp threads continue"),
        ];
        let all = merged(&custom);
        assert_eq!(all.len(), builtin().len() + 1);
        let codex = all.iter().find(|a| a.name == "codex").unwrap();
        assert_eq!(codex.command, "codex --full-auto");
        assert_eq!(all.last().unwrap().name, "amp");
    }
}

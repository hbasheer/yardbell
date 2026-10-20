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
}

const BUILTIN: [(&str, &str, &str, &str); 10] = [
    ("claude", "Claude Code", "claude", "claude --continue"),
    ("codex", "Codex", "codex", "codex resume --last"),
    ("gemini", "Gemini CLI", "gemini", "gemini --resume"),
    ("qwen", "Qwen Code", "qwen", "qwen --continue"),
    ("opencode", "opencode", "opencode", "opencode --continue"),
    ("copilot", "Copilot CLI", "copilot", "copilot --continue"),
    (
        "cursor",
        "Cursor Agent",
        "cursor-agent",
        "cursor-agent resume",
    ),
    ("crush", "Crush", "crush", "crush --continue"),
    ("goose", "Goose", "goose session", "goose session --resume"),
    ("aider", "Aider", "aider", "aider --restore-chat-history"),
];

pub fn builtin() -> Vec<Agent> {
    BUILTIN
        .iter()
        .map(|(name, label, command, resume)| Agent {
            name: name.to_string(),
            label: Some(label.to_string()),
            command: command.to_string(),
            resume: resume.to_string(),
            process: None,
        })
        .collect()
}

pub fn merged(custom: &[Agent]) -> Vec<Agent> {
    let mut all = builtin();
    for agent in custom {
        match all.iter_mut().find(|a| a.name == agent.name) {
            Some(slot) => {
                let label = slot.label.take();
                *slot = agent.clone();
                slot.label = agent.label.clone().or(label);
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
        }
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

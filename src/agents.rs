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

    // The same agent started on a chosen model and effort, for the agents whose flags for them are
    // known. An empty choice keeps whatever the agent's own command and settings pick.
    pub fn with_choice(mut self, model: &str, effort: &str) -> Result<Agent, String> {
        let (model, effort) = (model.trim(), effort.trim());
        if model.is_empty() && effort.is_empty() {
            return Ok(self);
        }
        for (what, value) in [("model", model), ("effort", effort)] {
            let fine = value.len() <= 64
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-:[]".contains(c));
            if !fine {
                return Err(format!("{value:?} is not a {what} name"));
            }
        }
        let mut flags = Vec::new();
        match self.process_name().as_str() {
            "claude" => {
                if !model.is_empty() {
                    flags.push(format!("--model '{model}'"));
                }
                if !effort.is_empty() {
                    flags.push(format!("--effort '{effort}'"));
                }
            }
            "codex" => {
                if !model.is_empty() {
                    flags.push(format!("-m '{model}'"));
                }
                if !effort.is_empty() {
                    flags.push(format!("-c 'model_reasoning_effort=\"{effort}\"'"));
                }
            }
            _ => {
                return Err(format!(
                    "{} has no known way to pick a model or effort",
                    self.display()
                ))
            }
        }
        let flags = flags.join(" ");
        self.command = format!("{} {flags}", self.command);
        if !self.resume.trim().is_empty() {
            self.resume = format!("{} {flags}", self.resume);
        }
        Ok(self)
    }

    // What makes a reviewer or scanner unable to edit files, for the agents that have a way:
    // Claude Code without its file editing tools, Codex in its read-only sandbox. Anything else is
    // read-only only because its prompt says so.
    pub fn read_only_flags(&self) -> Option<&'static str> {
        match self.process_name().as_str() {
            "claude" => Some("--disallowed-tools 'Edit,Write,NotebookEdit'"),
            "codex" => Some("--sandbox read-only"),
            _ => None,
        }
    }

    // Whether this agent can save a step's result inside .git without stopping at a prompt. Claude
    // Code asks before any write to .git unless permissions are bypassed, whatever its allow rules
    // say, and Codex's sandboxes keep it inside the workspace, so those two are only asked when
    // their command turns that off. A read-only Codex is never asked to go beyond its sandbox.
    pub fn saves_result_file(&self, read_only: bool) -> bool {
        let has = |flags: &[&str]| self.command.split_whitespace().any(|w| flags.contains(&w));
        match self.process_name().as_str() {
            "claude" => has(&[
                "--dangerously-skip-permissions",
                "bypassPermissions",
                "--permission-mode=bypassPermissions",
            ]),
            "codex" => {
                !read_only
                    && has(&[
                        "--dangerously-bypass-approvals-and-sandbox",
                        "--yolo",
                        "danger-full-access",
                        "--sandbox=danger-full-access",
                    ])
            }
            _ => true,
        }
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

// The fifth field is how each agent takes a task when it starts: "" as a positional argument,
// a flag before it, or None when its interactive mode has no way to take one. The sixth names the
// process to look for when it differs from the command's first word. Agents with no way to
// continue their last conversation resume by starting again in the same folder.
type BuiltinAgent = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
);

const BUILTIN: [BuiltinAgent; 47] = [
    (
        "claude",
        "Claude Code",
        "claude",
        "claude --continue",
        Some(""),
        None,
    ),
    (
        "codex",
        "Codex",
        "codex",
        "codex resume --last",
        Some(""),
        None,
    ),
    (
        "gemini",
        "Gemini CLI",
        "gemini",
        "gemini --resume",
        Some("-i"),
        None,
    ),
    (
        "qwen",
        "Qwen Code",
        "qwen",
        "qwen --continue",
        Some("-i"),
        None,
    ),
    (
        "opencode",
        "opencode",
        "opencode",
        "opencode --continue",
        Some("--prompt"),
        None,
    ),
    (
        "copilot",
        "Copilot CLI",
        "copilot",
        "copilot --continue",
        Some("-i"),
        None,
    ),
    (
        "cursor",
        "Cursor Agent",
        "cursor-agent",
        "cursor-agent resume",
        Some(""),
        None,
    ),
    ("crush", "Crush", "crush", "crush --continue", None, None),
    (
        "goose",
        "Goose",
        "goose session",
        "goose session --resume",
        None,
        None,
    ),
    (
        "aider",
        "Aider",
        "aider",
        "aider --restore-chat-history",
        None,
        None,
    ),
    (
        "openclaude",
        "OpenClaude",
        "openclaude",
        "openclaude",
        Some(""),
        None,
    ),
    (
        "codebuddy",
        "CodeBuddy",
        "codebuddy",
        "codebuddy",
        Some(""),
        None,
    ),
    ("devin", "Devin", "devin", "devin", Some("--"), None),
    ("droid", "Droid", "droid", "droid", Some(""), None),
    ("grok", "Grok", "grok", "grok", Some("--"), None),
    (
        "antigravity",
        "Antigravity",
        "agy",
        "agy",
        Some("--prompt-interactive"),
        None,
    ),
    (
        "qoder",
        "Qoder CLI",
        "qodercli",
        "qodercli",
        Some("--prompt-interactive"),
        None,
    ),
    (
        "qoder-cn",
        "Qoder CLI China",
        "qoderclicn",
        "qoderclicn",
        Some("--prompt-interactive"),
        None,
    ),
    (
        "opencode2",
        "OpenCode 2",
        "opencode2 --standalone",
        "opencode2 --standalone",
        Some("--prompt"),
        None,
    ),
    (
        "mimo-code",
        "MiMo Code",
        "mimo",
        "mimo",
        Some("--prompt"),
        None,
    ),
    ("pi", "Pi", "pi", "pi", Some(""), None),
    ("omp", "OMP", "omp", "omp", Some(""), None),
    (
        "prime-agent",
        "Prime Agent",
        "prime-agent",
        "prime-agent",
        Some("--"),
        None,
    ),
    ("trae", "Trae", "traecli", "traecli", Some("--"), None),
    (
        "command-code",
        "Command Code",
        "command-code --trust",
        "command-code --trust",
        Some(""),
        None,
    ),
    ("amp", "Amp", "amp", "amp", None, None),
    ("kilo", "Kilocode", "kilo", "kilo", None, None),
    (
        "kiro",
        "Kiro",
        "kiro-cli chat --tui",
        "kiro-cli chat --tui",
        None,
        None,
    ),
    ("aug", "Auggie", "auggie", "auggie", None, None),
    ("cline", "Cline", "cline", "cline", None, None),
    ("codebuff", "Codebuff", "codebuff", "codebuff", None, None),
    ("freebuff", "Freebuff", "freebuff", "freebuff", None, None),
    ("continue", "Continue", "cn", "cn", None, None),
    ("kimi", "Kimi", "kimi", "kimi", None, None),
    ("mistral-vibe", "Mistral Vibe", "vibe", "vibe", None, None),
    (
        "rovo",
        "Rovo Dev",
        "acli rovodev run",
        "acli rovodev run",
        None,
        None,
    ),
    (
        "hermes",
        "Hermes",
        "hermes --tui",
        "hermes --tui",
        None,
        None,
    ),
    ("openclaw", "OpenClaw", "openclaw", "openclaw", None, None),
    ("ante", "Ante", "ante", "ante", None, None),
    (
        "autohand",
        "Autohand Code",
        "autohand",
        "autohand",
        None,
        None,
    ),
    (
        "muse",
        "Muse",
        "muse --trust-workspace",
        "muse --trust-workspace",
        None,
        None,
    ),
    (
        "dsh",
        "DeepSeek Harness",
        "dsh-tui .",
        "dsh-tui .",
        None,
        Some("dsh"),
    ),
    ("zcode", "ZCode", "zcode", "zcode", None, Some("zcode-cli")),
    ("jcode", "Jcode", "jcode", "jcode", None, None),
    (
        "openhands",
        "OpenHands",
        "openhands",
        "openhands",
        None,
        None,
    ),
    ("plandex", "Plandex", "plandex", "plandex", None, None),
    (
        "interpreter",
        "Open Interpreter",
        "interpreter",
        "interpreter",
        None,
        None,
    ),
];

pub struct Guide {
    pub install: Option<&'static str>,
    pub homepage: &'static str,
    pub open_source: bool,
}

// How each built-in agent is installed, from its own docs. Only these commands ever run: the page
// names an agent and a machine, never a command. Agents with no single install command get their
// guide.
const GUIDES: &[(&str, Option<&str>, &str, bool)] = &[
    ("claude", Some("npm install -g @anthropic-ai/claude-code"), "https://code.claude.com/docs", false),
    ("codex", Some("npm install -g @openai/codex"), "https://github.com/openai/codex", true),
    ("gemini", Some("npm install -g @google/gemini-cli"), "https://github.com/google-gemini/gemini-cli", true),
    ("qwen", Some("npm install -g @qwen-code/qwen-code"), "https://github.com/QwenLM/qwen-code", true),
    ("opencode", Some("npm install -g opencode-ai"), "https://opencode.ai/docs/cli/", true),
    ("opencode2", Some("npm install -g @opencode/cli"), "https://opencode.ai/v2/docs/", true),
    ("copilot", Some("npm install -g @github/copilot"), "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli", false),
    ("cursor", Some("curl https://cursor.com/install -fsS | bash"), "https://cursor.com/cli", false),
    ("crush", Some("npm install -g @charmland/crush"), "https://github.com/charmbracelet/crush", false),
    ("goose", Some("curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash"), "https://goose-docs.ai/docs/quickstart/", true),
    ("aider", Some("python3 -m pip install aider-install && aider-install"), "https://aider.chat/docs/", true),
    ("openclaude", None, "https://openclaude.gitlawb.com/", true),
    ("codebuddy", Some("npm install -g @tencent-ai/codebuddy-code"), "https://www.codebuddy.ai/cli", false),
    ("devin", None, "https://devin.ai/cli", false),
    ("droid", Some("curl -fsSL https://app.factory.ai/cli | sh"), "https://docs.factory.ai/cli/getting-started/quickstart", false),
    ("grok", Some("npm install -g @xai-official/grok"), "https://x.ai/cli", false),
    ("antigravity", None, "https://antigravity.google/docs/cli-overview", false),
    ("qoder", None, "https://docs.qoder.com/cli/overview", false),
    ("qoder-cn", None, "https://docs.qoder.cn/cli/overview", false),
    ("mimo-code", Some("npm install -g @mimo-ai/cli"), "https://mimo.xiaomi.com/coder", false),
    ("pi", None, "https://pi.dev", false),
    ("omp", Some("npm install -g @oh-my-pi/pi-coding-agent"), "https://omp.sh", false),
    ("prime-agent", None, "https://github.com/PrimeIntellect-ai/prime-agent", true),
    ("trae", None, "https://docs.trae.cn/cli_get-started-with-trae-cli", false),
    ("command-code", None, "https://commandcode.ai/docs/quickstart", false),
    ("amp", Some("npm install -g @sourcegraph/amp"), "https://ampcode.com/manual#install", false),
    ("kilo", Some("npm install -g @kilocode/cli"), "https://kilo.ai/docs/cli", true),
    ("kiro", None, "https://kiro.dev/docs/cli/", false),
    ("aug", Some("npm install -g @augmentcode/auggie"), "https://docs.augmentcode.com/cli/overview", false),
    ("cline", Some("npm install -g cline"), "https://docs.cline.bot/cline-cli/overview", true),
    ("codebuff", Some("npm install -g codebuff"), "https://www.codebuff.com/docs/help/quick-start", false),
    ("freebuff", None, "https://freebuff.com/cli", false),
    ("continue", Some("npm install -g @continuedev/cli"), "https://docs.continue.dev/cli/quickstart", true),
    ("kimi", Some("npm install -g @moonshot-ai/kimi-code"), "https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html", false),
    ("mistral-vibe", None, "https://github.com/mistralai/mistral-vibe", true),
    ("rovo", None, "https://developer.atlassian.com/cloud/acli/guides/install-acli/", false),
    ("hermes", None, "https://hermes-agent.nousresearch.com/docs/", true),
    ("openclaw", None, "https://github.com/openclaw/openclaw", true),
    ("ante", None, "https://github.com/AntigmaLabs/ante-preview", false),
    ("autohand", None, "https://github.com/autohandai/code-cli", true),
    ("muse", None, "https://dev.meta.ai/docs/muse-code", false),
    ("dsh", None, "https://github.com/ccch1mneyyy/dsh-TUI#quick-start", true),
    ("zcode", None, "https://zcode.z.ai/en/docs", false),
    ("jcode", None, "https://github.com/1jehuang/jcode", true),
    ("openhands", Some("python3 -m pip install openhands-ai"), "https://docs.all-hands.dev/usage/how-to/cli-mode", true),
    ("plandex", Some("curl -sL https://plandex.ai/install.sh | bash"), "https://docs.plandex.ai/install", true),
    ("interpreter", Some("python3 -m pip install open-interpreter"), "https://docs.openinterpreter.com/getting-started/setup", true),
];

pub fn guide(name: &str) -> Option<Guide> {
    GUIDES
        .iter()
        .find(|(n, ..)| *n == name)
        .map(|(_, install, homepage, open_source)| Guide {
            install: *install,
            homepage,
            open_source: *open_source,
        })
}

pub fn builtin() -> Vec<Agent> {
    BUILTIN
        .iter()
        .map(
            |(name, label, command, resume, prompt_arg, process)| Agent {
                name: name.to_string(),
                label: Some(label.to_string()),
                command: command.to_string(),
                resume: resume.to_string(),
                process: process.map(str::to_string),
                prompt_arg: prompt_arg.map(str::to_string),
            },
        )
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

    #[test]
    fn a_chosen_model_and_effort_become_the_agents_own_flags() {
        let claude = agent("claude", "claude", "claude --continue")
            .with_choice("opus", "high")
            .unwrap();
        assert_eq!(claude.command, "claude --model 'opus' --effort 'high'");
        assert_eq!(
            claude.resume,
            "claude --continue --model 'opus' --effort 'high'"
        );
        let codex = agent("codex", "codex", "codex resume --last")
            .with_choice("gpt-5.5", "xhigh")
            .unwrap();
        assert_eq!(
            codex.command,
            "codex -m 'gpt-5.5' -c 'model_reasoning_effort=\"xhigh\"'"
        );
        let only_model = agent("claude", "claude", "")
            .with_choice("sonnet", "")
            .unwrap();
        assert_eq!(only_model.command, "claude --model 'sonnet'");
        assert_eq!(only_model.resume, "");
    }

    #[test]
    fn no_choice_leaves_the_agent_alone_and_bad_choices_are_refused() {
        let plain = agent("amp", "amp", "amp threads continue");
        assert_eq!(plain.clone().with_choice("", " ").unwrap().command, "amp");
        assert!(plain
            .with_choice("big", "")
            .unwrap_err()
            .contains("no known way"));
        let claude = agent("claude", "claude", "");
        assert!(claude.clone().with_choice("opus; rm -rf ~", "").is_err());
        assert!(claude.clone().with_choice("opus", "high'").is_err());
        assert!(claude.with_choice(&"x".repeat(65), "").is_err());
    }

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
            names[..10],
            [
                "claude", "codex", "gemini", "qwen", "opencode", "copilot", "cursor", "crush",
                "goose", "aider"
            ]
        );
        assert!(names.contains(&"grok".to_string()) && names.contains(&"amp".to_string()));
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
    fn only_claude_and_codex_can_be_made_read_only() {
        let flags = |n: &str| {
            builtin()
                .into_iter()
                .find(|a| a.name == n)
                .unwrap()
                .read_only_flags()
        };
        assert_eq!(
            flags("claude"),
            Some("--disallowed-tools 'Edit,Write,NotebookEdit'")
        );
        assert_eq!(flags("codex"), Some("--sandbox read-only"));
        assert_eq!(flags("gemini"), None);
        let custom = agent("codex", "/opt/bin/codex --full-auto", "codex resume --last");
        assert_eq!(custom.read_only_flags(), Some("--sandbox read-only"));
    }

    #[test]
    fn a_result_file_is_only_asked_of_an_agent_that_will_not_stop_for_it() {
        let saves =
            |command: &str, read_only: bool| agent("x", command, "x").saves_result_file(read_only);
        assert!(!saves("claude", false));
        assert!(!saves("claude", true));
        assert!(!saves("claude --allow-dangerously-skip-permissions", true));
        assert!(saves("claude --dangerously-skip-permissions", true));
        assert!(saves("claude --permission-mode bypassPermissions", false));
        assert!(!saves("codex", false));
        assert!(!saves("codex --full-auto", false));
        assert!(saves("codex --sandbox danger-full-access", false));
        assert!(!saves("codex --yolo", true));
        assert!(saves("gemini", true));
        assert!(saves("aider", false));
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
            agent("house-agent", "house-agent", "house-agent --continue"),
        ];
        let all = merged(&custom);
        assert_eq!(all.len(), builtin().len() + 1);
        let codex = all.iter().find(|a| a.name == "codex").unwrap();
        assert_eq!(codex.command, "codex --full-auto");
        assert_eq!(all.last().unwrap().name, "house-agent");
    }
}

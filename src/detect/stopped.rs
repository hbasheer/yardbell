// Unlike the herdr rules beside it, this is Yardbell's own: what an agent prints when a turn ends
// on an error rather than an answer. The words come from the agents themselves (Claude Code
// 2.1.319, Codex 0.165.0); an agent not listed here is never said to have stopped on one.

const LINE_CHARS: usize = 160;

struct Signs {
    errors: &'static [&'static str],
    not_errors: &'static [&'static str],
    replies: &'static [&'static str],
}

const CLAUDE: Signs = Signs {
    errors: &[
        "API Error",
        "You've hit your",
        "You've reached your",
        "You're out of usage credits",
        "Your org is out of usage",
    ],
    not_errors: &["Retrying in"],
    replies: &["⏺", "●"],
};

// Codex marks every error with a square, and pressing Esc prints one too.
const CODEX: Signs = Signs {
    errors: &["■ "],
    not_errors: &["■ Conversation interrupted"],
    replies: &["•"],
};

fn signs(agent: &str) -> Option<&'static Signs> {
    match agent {
        "claude" | "claude-code" => Some(&CLAUDE),
        "codex" => Some(&CODEX),
        _ => None,
    }
}

fn said(line: &str) -> &str {
    line.trim_start().trim_start_matches('⎿').trim_start()
}

/// The error line an idle agent's last turn ended on, when nothing it wrote since answers it.
pub fn stopped(agent: &str, screen: &str) -> Option<String> {
    let signs = signs(agent)?;
    let lines: Vec<&str> = screen.lines().map(said).collect();
    let at = lines.iter().rposition(|line| {
        signs.errors.iter().any(|e| line.starts_with(e))
            && !signs.not_errors.iter().any(|n| line.contains(n))
    })?;
    let answered = lines[at + 1..]
        .iter()
        .any(|line| signs.replies.iter().any(|r| line.starts_with(r)));
    if answered {
        return None;
    }
    let line = lines[at].trim_start_matches("■ ").trim_end();
    Some(clip(line))
}

fn clip(line: &str) -> String {
    if line.chars().count() <= LINE_CHARS {
        return line.to_string();
    }
    let mut cut: String = line.chars().take(LINE_CHARS).collect();
    cut.push('…');
    cut
}

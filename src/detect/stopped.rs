// Unlike the herdr rules beside it, this is Yardbell's own: what an agent prints when a turn ends
// on an error rather than an answer. The words come from the agents themselves (Claude Code
// 2.1.319, Codex 0.165.0); an agent not listed here is never said to have stopped on one.

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveTime, TimeZone};

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

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

// Claude Code says "resets 3pm" or "resets Nov 12, 3pm", Codex "Try again at 3:00 PM." or
// "Try again at Nov 12th, 2026 3:00 PM.", both in the machine's own time. A time without a date is
// the one nearest to now, so a reset that passed while Yardbell was not looking is not put a day on.
pub fn resets(line: &str, now: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
    let lower = line.to_lowercase();
    let at = ["resets ", "try again at "]
        .iter()
        .find_map(|word| lower.find(word).map(|i| i + word.len()))?;
    let words: Vec<&str> = lower[at..]
        .split(|c: char| c.is_whitespace() || c == ',' || c == '(')
        .filter(|w| !w.is_empty())
        .collect();
    let (date, rest) = date_of(&words, now);
    let time = time_of(rest)?;
    let zone = now.timezone();
    let on = |day: NaiveDate| zone.from_local_datetime(&day.and_time(time)).single();
    if let Some(day) = date {
        return on(day);
    }
    let today = now.date_naive();
    [today.pred_opt()?, today, today.succ_opt()?]
        .into_iter()
        .filter_map(on)
        .min_by_key(|t| (*t - now).num_seconds().abs())
}

fn date_of<'a>(
    words: &'a [&'a str],
    now: DateTime<FixedOffset>,
) -> (Option<NaiveDate>, &'a [&'a str]) {
    let month = words
        .first()
        .and_then(|w| MONTHS.iter().position(|m| w.starts_with(m)));
    let day = words.get(1).and_then(|w| {
        w.trim_end_matches(|c: char| c.is_ascii_alphabetic())
            .parse::<u32>()
            .ok()
    });
    let (Some(month), Some(day)) = (month, day) else {
        return (None, words);
    };
    let (year, used) = match words.get(2).and_then(|w| w.parse::<i32>().ok()) {
        Some(year) if year > 2000 => (Some(year), 3),
        _ => (None, 2),
    };
    let month = month as u32 + 1;
    let date = match year {
        Some(year) => NaiveDate::from_ymd_opt(year, month, day),
        None => [now.year(), now.year() + 1]
            .into_iter()
            .filter_map(|y| NaiveDate::from_ymd_opt(y, month, day))
            .find(|d| *d >= now.date_naive() - chrono::Duration::days(1)),
    };
    (date, &words[used.min(words.len())..])
}

fn time_of(words: &[&str]) -> Option<NaiveTime> {
    let first = words.first()?.trim_end_matches('.');
    let (clock, half) = match first
        .strip_suffix("am")
        .or_else(|| first.strip_suffix("pm"))
    {
        Some(clock) => (clock, first.ends_with("pm")),
        None => {
            let half = words.get(1).map(|w| w.trim_end_matches('.'))?;
            if half != "am" && half != "pm" {
                return None;
            }
            (first, half == "pm")
        }
    };
    let (hour, minute) = match clock.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (clock.parse::<u32>().ok()?, 0),
    };
    if !(1..=12).contains(&hour) {
        return None;
    }
    let hour = match (hour, half) {
        (12, false) => 0,
        (12, true) => 12,
        (h, true) => h + 12,
        (h, false) => h,
    };
    NaiveTime::from_hms_opt(hour, minute, 0)
}

fn clip(line: &str) -> String {
    if line.chars().count() <= LINE_CHARS {
        return line.to_string();
    }
    let mut cut: String = line.chars().take(LINE_CHARS).collect();
    cut.push('…');
    cut
}

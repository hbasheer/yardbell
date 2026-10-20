use crate::windows;

pub const EVENT: &str = "shortcut";

#[derive(Debug, PartialEq)]
pub enum Action {
    Close,
    Quit,
}

pub fn action(payload: &str, focused: &str) -> Option<Action> {
    if focused != windows::MAIN && !focused.starts_with(windows::TERMINAL) {
        return None;
    }
    match serde_json::from_str::<String>(payload).ok()?.as_str() {
        "close" => Some(Action::Close),
        "quit" => Some(Action::Quit),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOSE: &str = "\"close\"";
    const QUIT: &str = "\"quit\"";

    #[test]
    fn close_acts_on_the_focused_main_or_terminal_window() {
        let terminal = windows::terminal_label("mini", "api-1");
        assert_eq!(action(CLOSE, windows::MAIN), Some(Action::Close));
        assert_eq!(action(CLOSE, &terminal), Some(Action::Close));
    }

    #[test]
    fn quit_needs_a_focused_main_or_terminal_window() {
        let terminal = windows::terminal_label("mini", "api-1");
        assert_eq!(action(QUIT, windows::MAIN), Some(Action::Quit));
        assert_eq!(action(QUIT, &terminal), Some(Action::Quit));
    }

    #[test]
    fn other_windows_ignore_shortcuts() {
        for label in [windows::CONNECT, "termx", "term", "settings", ""] {
            assert_eq!(action(CLOSE, label), None, "{label}");
            assert_eq!(action(QUIT, label), None, "{label}");
        }
    }

    #[test]
    fn unknown_payloads_do_nothing() {
        for payload in [
            "\"hide\"",
            "\"Close\"",
            "close",
            "null",
            "",
            "{\"action\":\"close\"}",
            "[\"quit\"]",
        ] {
            assert_eq!(action(payload, windows::MAIN), None, "{payload}");
        }
    }
}

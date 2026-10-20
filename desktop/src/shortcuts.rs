use crate::windows;

pub const EVENT: &str = "shortcut";

#[derive(Debug, PartialEq)]
pub enum Action {
    Close,
    Quit,
    Select(usize),
    Next,
    Prev,
}

pub fn action(payload: &str, focused: &str) -> Option<Action> {
    if focused != windows::MAIN {
        return None;
    }
    let payload = serde_json::from_str::<String>(payload).ok()?;
    match payload.as_str() {
        "close" => Some(Action::Close),
        "quit" => Some(Action::Quit),
        "tab-next" => Some(Action::Next),
        "tab-prev" => Some(Action::Prev),
        _ => position(&payload).map(Action::Select),
    }
}

fn position(payload: &str) -> Option<usize> {
    let digits = payload.strip_prefix("tab-")?;
    if digits.len() != 1 {
        return None;
    }
    digits.parse().ok().filter(|position| *position != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOSE: &str = "\"close\"";
    const QUIT: &str = "\"quit\"";

    #[test]
    fn close_acts_on_the_focused_main_window() {
        assert_eq!(action(CLOSE, windows::MAIN), Some(Action::Close));
    }

    #[test]
    fn quit_needs_a_focused_main_window() {
        assert_eq!(action(QUIT, windows::MAIN), Some(Action::Quit));
    }

    #[test]
    fn tab_keys_map_to_actions() {
        for position in 1..=9 {
            let payload = format!("\"tab-{position}\"");
            assert_eq!(
                action(&payload, windows::MAIN),
                Some(Action::Select(position)),
                "{payload}"
            );
        }
        assert_eq!(action("\"tab-next\"", windows::MAIN), Some(Action::Next));
        assert_eq!(action("\"tab-prev\"", windows::MAIN), Some(Action::Prev));
        for payload in [
            "\"tab-0\"",
            "\"tab-10\"",
            "\"tab-\"",
            "\"tab-+1\"",
            "\"tab-a\"",
        ] {
            assert_eq!(action(payload, windows::MAIN), None, "{payload}");
        }
    }

    #[test]
    fn connect_ignores_tab_keys() {
        for payload in ["\"tab-1\"", "\"tab-9\"", "\"tab-next\"", "\"tab-prev\""] {
            assert_eq!(action(payload, windows::CONNECT), None, "{payload}");
        }
    }

    #[test]
    fn other_windows_ignore_shortcuts() {
        let terminal = windows::terminal_label("mini", "api-1");
        for label in [
            windows::CONNECT,
            &terminal,
            "dashboard",
            "tabs",
            "termx",
            "term",
            "settings",
            "",
        ] {
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

use serde::Serialize;
use yardbell::state::StateView;

use crate::windows;

pub const DASHBOARD: &str = "dashboard";
const LAST_POSITION: usize = 9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tab {
    Dashboard,
    Session {
        machine: String,
        tmux: String,
        label: String,
    },
}

impl Tab {
    pub fn label(&self) -> &str {
        match self {
            Tab::Dashboard => DASHBOARD,
            Tab::Session { label, .. } => label,
        }
    }

    fn closable(&self) -> bool {
        matches!(self, Tab::Session { .. })
    }

    fn is_session(&self, machine: &str, tmux: &str) -> bool {
        matches!(self, Tab::Session { machine: m, tmux: t, .. } if m == machine && t == tmux)
    }

    fn title(&self, state: Option<&StateView>) -> String {
        let Tab::Session { machine, tmux, .. } = self else {
            return "Dashboard".to_string();
        };
        let folder = state
            .and_then(|state| {
                state.sessions.iter().find(|session| {
                    &session.machine == machine && session.tmux.as_deref() == Some(tmux.as_str())
                })
            })
            .map(|session| session.folder.as_str())
            .unwrap_or_default();
        session_title(folder, tmux, machine)
    }
}

pub fn session_title(folder: &str, tmux: &str, machine: &str) -> String {
    let name = if folder.is_empty() { tmux } else { folder };
    format!("{name} · {machine}")
}

#[derive(Debug, PartialEq, Eq)]
pub enum Change {
    Nothing,
    Selected,
    Opened(String),
    Closed(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TabView {
    pub label: String,
    pub title: String,
    pub selected: bool,
    pub closable: bool,
}

pub struct Tabs {
    tabs: Vec<Tab>,
    selected: usize,
}

impl Tabs {
    pub fn new() -> Tabs {
        Tabs {
            tabs: vec![Tab::Dashboard],
            selected: 0,
        }
    }

    pub fn open(&mut self, machine: &str, tmux: &str) -> Change {
        let open = self
            .tabs
            .iter()
            .position(|tab| tab.is_session(machine, tmux));
        if let Some(index) = open {
            self.selected = index;
            return Change::Selected;
        }
        let label = self.free_label(windows::terminal_label(machine, tmux));
        self.tabs.push(Tab::Session {
            machine: machine.to_string(),
            tmux: tmux.to_string(),
            label: label.clone(),
        });
        self.selected = self.tabs.len() - 1;
        Change::Opened(label)
    }

    pub fn close(&mut self, label: &str) -> Change {
        let Some(index) = self.index_of(label) else {
            return Change::Nothing;
        };
        if !self.tabs[index].closable() {
            return Change::Nothing;
        }
        self.tabs.remove(index);
        if index < self.selected {
            self.selected -= 1;
        } else if index == self.selected {
            self.selected = index.min(self.tabs.len() - 1);
        }
        Change::Closed(label.to_string())
    }

    pub fn select_label(&mut self, label: &str) -> Change {
        match self.index_of(label) {
            Some(index) => self.select_index(index),
            None => Change::Nothing,
        }
    }

    pub fn select_position(&mut self, position: usize) -> Change {
        let position = if position == LAST_POSITION {
            self.tabs.len()
        } else {
            position
        };
        if position == 0 || position > self.tabs.len() {
            return Change::Nothing;
        }
        self.select_index(position - 1)
    }

    pub fn next(&mut self) -> Change {
        self.select_index((self.selected + 1) % self.tabs.len())
    }

    pub fn prev(&mut self) -> Change {
        self.select_index((self.selected + self.tabs.len() - 1) % self.tabs.len())
    }

    pub fn reset(&mut self) -> Vec<String> {
        self.selected = 0;
        self.tabs
            .drain(1..)
            .map(|tab| tab.label().to_string())
            .collect()
    }

    pub fn selected(&self) -> &Tab {
        &self.tabs[self.selected]
    }

    pub fn tabs(&self) -> &[Tab] {
        &self.tabs
    }

    pub fn views(&self, state: Option<&StateView>) -> Vec<TabView> {
        self.tabs
            .iter()
            .enumerate()
            .map(|(index, tab)| TabView {
                label: tab.label().to_string(),
                title: tab.title(state),
                selected: index == self.selected,
                closable: tab.closable(),
            })
            .collect()
    }

    fn index_of(&self, label: &str) -> Option<usize> {
        self.tabs.iter().position(|tab| tab.label() == label)
    }

    fn select_index(&mut self, index: usize) -> Change {
        if index == self.selected {
            return Change::Nothing;
        }
        self.selected = index;
        Change::Selected
    }

    fn free_label(&self, base: String) -> String {
        let mut label = base.clone();
        let mut n = 1;
        while self.index_of(&label).is_some() {
            n += 1;
            label = format!("{base}-{n}");
        }
        label
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yardbell::config::HostTerminal;
    use yardbell::snapshot::Activity;
    use yardbell::state::SessionView;

    fn labels(tabs: &Tabs) -> Vec<&str> {
        tabs.tabs().iter().map(Tab::label).collect()
    }

    fn titles(views: &[TabView]) -> Vec<&str> {
        views.iter().map(|view| view.title.as_str()).collect()
    }

    fn with_sessions(names: &[&str]) -> Tabs {
        let mut tabs = Tabs::new();
        for name in names {
            tabs.open("mini", name);
        }
        tabs
    }

    fn tab_view(label: &str, title: &str, selected: bool, closable: bool) -> TabView {
        TabView {
            label: label.into(),
            title: title.into(),
            selected,
            closable,
        }
    }

    fn session(machine: &str, tmux: Option<&str>, folder: &str) -> SessionView {
        SessionView {
            pull_why: None,
            id: "s1".into(),
            machine: machine.into(),
            agent: "claude".into(),
            pid: 1,
            folder: folder.into(),
            ticket: String::new(),
            branch: String::new(),
            activity: Activity::Idle,
            attachable: true,
            tmux: tmux.map(str::to_string),
            stale: false,
            ports: vec![],
            pull: None,
            path: String::new(),
            worktree: false,
            setup: None,
        }
    }

    fn view(sessions: Vec<SessionView>) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines: vec![],
            folders: vec![],
            sessions,
            ended: vec![],
            host_terminal: HostTerminal::None,
            mesh: None,
            server: None,
            proposals: 0,
        }
    }

    #[test]
    fn starts_with_the_dashboard_selected() {
        let tabs = Tabs::new();
        assert_eq!(tabs.tabs(), [Tab::Dashboard]);
        assert_eq!(tabs.selected(), &Tab::Dashboard);
        assert_eq!(tabs.selected().label(), DASHBOARD);
        assert_eq!(
            tabs.views(None),
            [tab_view("dashboard", "Dashboard", true, false)]
        );
    }

    #[test]
    fn opening_appends_and_selects() {
        let mut tabs = Tabs::new();
        assert_eq!(
            tabs.open("mini", "api-1"),
            Change::Opened("term-mini-api-1".into())
        );
        assert_eq!(labels(&tabs), ["dashboard", "term-mini-api-1"]);
        assert_eq!(
            tabs.selected(),
            &Tab::Session {
                machine: "mini".into(),
                tmux: "api-1".into(),
                label: "term-mini-api-1".into()
            }
        );
        assert_eq!(tabs.open("hp", "web"), Change::Opened("term-hp-web".into()));
        assert_eq!(
            labels(&tabs),
            ["dashboard", "term-mini-api-1", "term-hp-web"]
        );
        assert_eq!(tabs.selected().label(), "term-hp-web");
    }

    #[test]
    fn opening_an_open_session_selects_it() {
        let mut tabs = Tabs::new();
        tabs.open("mini", "api-1");
        assert_eq!(tabs.open("mini", "api-1"), Change::Selected);
        assert_eq!(labels(&tabs), ["dashboard", "term-mini-api-1"]);

        tabs.open("mini", "api-2");
        tabs.select_label(DASHBOARD);
        assert_eq!(tabs.open("mini", "api-1"), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-api-1");
        assert_eq!(
            labels(&tabs),
            ["dashboard", "term-mini-api-1", "term-mini-api-2"]
        );
    }

    #[test]
    fn the_same_tmux_name_on_two_machines_gets_two_tabs() {
        let mut tabs = Tabs::new();
        assert_eq!(
            tabs.open("mini", "main"),
            Change::Opened("term-mini-main".into())
        );
        assert_eq!(
            tabs.open("hp", "main"),
            Change::Opened("term-hp-main".into())
        );
        assert_eq!(tabs.open("mini", "main"), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-main");
        assert_eq!(
            labels(&tabs),
            ["dashboard", "term-mini-main", "term-hp-main"]
        );
    }

    #[test]
    fn colliding_names_get_their_own_tabs() {
        let mut tabs = Tabs::new();
        assert_eq!(
            tabs.open("mini", "a b"),
            Change::Opened("term-mini-a_b".into())
        );
        assert_eq!(
            tabs.open("mini", "a_b"),
            Change::Opened("term-mini-a_b-2".into())
        );
        assert_eq!(
            tabs.open("mini", "a.b"),
            Change::Opened("term-mini-a_b-3".into())
        );
        assert_eq!(tabs.open("mini", "a b"), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-a_b");
        assert_eq!(tabs.open("mini", "a_b"), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-a_b-2");
        assert_eq!(tabs.tabs().len(), 4);
    }

    #[test]
    fn a_numbered_label_skips_labels_other_tabs_hold() {
        let mut tabs = Tabs::new();
        tabs.open("mini", "a b");
        tabs.open("mini", "a_b");
        assert_eq!(
            tabs.open("mini", "a_b-2"),
            Change::Opened("term-mini-a_b-2-2".into())
        );

        let mut tabs = Tabs::new();
        tabs.open("mini", "a_b-2");
        tabs.open("mini", "a b");
        assert_eq!(
            tabs.open("mini", "a_b"),
            Change::Opened("term-mini-a_b-3".into())
        );
    }

    #[test]
    fn a_closed_tab_frees_its_label_and_the_others_keep_theirs() {
        let mut tabs = Tabs::new();
        tabs.open("mini", "a b");
        tabs.open("mini", "a_b");
        tabs.close("term-mini-a_b");
        assert_eq!(labels(&tabs), ["dashboard", "term-mini-a_b-2"]);
        assert_eq!(
            tabs.open("mini", "a.b"),
            Change::Opened("term-mini-a_b".into())
        );
        assert_eq!(
            labels(&tabs),
            ["dashboard", "term-mini-a_b-2", "term-mini-a_b"]
        );
    }

    #[test]
    fn closing_picks_a_neighbor_and_keeps_background_selection() {
        let mut tabs = with_sessions(&["a", "b", "c"]);
        assert_eq!(
            tabs.close("term-mini-c"),
            Change::Closed("term-mini-c".into())
        );
        assert_eq!(tabs.selected().label(), "term-mini-b");
        assert_eq!(labels(&tabs), ["dashboard", "term-mini-a", "term-mini-b"]);

        let mut tabs = with_sessions(&["a", "b", "c"]);
        tabs.select_label("term-mini-a");
        assert_eq!(
            tabs.close("term-mini-c"),
            Change::Closed("term-mini-c".into())
        );
        assert_eq!(tabs.selected().label(), "term-mini-a");

        let mut tabs = with_sessions(&["a", "b", "c"]);
        tabs.select_label("term-mini-a");
        assert_eq!(
            tabs.close("term-mini-a"),
            Change::Closed("term-mini-a".into())
        );
        assert_eq!(tabs.selected().label(), "term-mini-b");
        assert_eq!(labels(&tabs), ["dashboard", "term-mini-b", "term-mini-c"]);

        let mut tabs = with_sessions(&["a", "b", "c"]);
        tabs.select_label("term-mini-b");
        tabs.close("term-mini-b");
        assert_eq!(tabs.selected().label(), "term-mini-c");
    }

    #[test]
    fn closing_a_tab_before_the_selection_keeps_the_selected_tab() {
        let mut tabs = with_sessions(&["a", "b", "c"]);
        assert_eq!(
            tabs.close("term-mini-a"),
            Change::Closed("term-mini-a".into())
        );
        assert_eq!(tabs.selected().label(), "term-mini-c");
        assert_eq!(labels(&tabs), ["dashboard", "term-mini-b", "term-mini-c"]);
    }

    #[test]
    fn closing_the_only_session_returns_to_the_dashboard() {
        let mut tabs = with_sessions(&["a"]);
        assert_eq!(
            tabs.close("term-mini-a"),
            Change::Closed("term-mini-a".into())
        );
        assert_eq!(tabs.selected(), &Tab::Dashboard);
        assert_eq!(tabs.tabs(), [Tab::Dashboard]);
    }

    #[test]
    fn the_dashboard_cannot_close() {
        let mut tabs = with_sessions(&["a"]);
        tabs.select_label(DASHBOARD);
        assert_eq!(tabs.close(DASHBOARD), Change::Nothing);
        assert_eq!(labels(&tabs), ["dashboard", "term-mini-a"]);
        assert_eq!(tabs.selected(), &Tab::Dashboard);

        let mut alone = Tabs::new();
        assert_eq!(alone.close(DASHBOARD), Change::Nothing);
        assert_eq!(alone.tabs(), [Tab::Dashboard]);
    }

    #[test]
    fn closing_an_unknown_tab_changes_nothing() {
        let mut tabs = with_sessions(&["a", "b"]);
        assert_eq!(tabs.close("term-mini-zzz"), Change::Nothing);
        assert_eq!(tabs.close(""), Change::Nothing);
        assert_eq!(labels(&tabs), ["dashboard", "term-mini-a", "term-mini-b"]);
        assert_eq!(tabs.selected().label(), "term-mini-b");
    }

    #[test]
    fn selecting_a_label_changes_the_selection_only_for_another_open_tab() {
        let mut tabs = with_sessions(&["a", "b"]);
        assert_eq!(tabs.select_label("term-mini-b"), Change::Nothing);
        assert_eq!(tabs.select_label("term-mini-zzz"), Change::Nothing);
        assert_eq!(tabs.selected().label(), "term-mini-b");
        assert_eq!(tabs.select_label("term-mini-a"), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-a");
        assert_eq!(tabs.select_label(DASHBOARD), Change::Selected);
        assert_eq!(tabs.selected(), &Tab::Dashboard);
    }

    #[test]
    fn a_failed_open_is_undone_by_closing_it_and_selecting_the_previous_tab() {
        for previous in [DASHBOARD, "term-mini-a", "term-mini-b"] {
            let mut tabs = with_sessions(&["a", "b"]);
            tabs.select_label(previous);
            assert_eq!(tabs.open("mini", "c"), Change::Opened("term-mini-c".into()));
            assert_eq!(
                tabs.close("term-mini-c"),
                Change::Closed("term-mini-c".into())
            );
            tabs.select_label(previous);
            assert_eq!(tabs.selected().label(), previous);
            assert_eq!(labels(&tabs), ["dashboard", "term-mini-a", "term-mini-b"]);
        }
    }

    #[test]
    fn select_by_position() {
        let mut tabs = with_sessions(&["a", "b"]);
        assert_eq!(tabs.select_position(1), Change::Selected);
        assert_eq!(tabs.selected(), &Tab::Dashboard);
        assert_eq!(tabs.select_position(2), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-a");
        assert_eq!(tabs.select_position(9), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-b");
        assert_eq!(tabs.select_position(5), Change::Nothing);
        assert_eq!(tabs.select_position(0), Change::Nothing);
        assert_eq!(tabs.select_position(3), Change::Nothing);
        assert_eq!(tabs.selected().label(), "term-mini-b");
    }

    #[test]
    fn position_nine_is_the_last_tab_even_past_nine_tabs() {
        let mut tabs = Tabs::new();
        for n in 1..=11 {
            tabs.open("mini", &format!("s{n}"));
        }
        tabs.select_position(1);
        assert_eq!(tabs.select_position(9), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-s11");
        assert_eq!(tabs.select_position(8), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-s7");
    }

    #[test]
    fn position_nine_with_only_the_dashboard_is_the_dashboard() {
        let mut tabs = Tabs::new();
        assert_eq!(tabs.select_position(9), Change::Nothing);
        assert_eq!(tabs.selected(), &Tab::Dashboard);
    }

    #[test]
    fn next_and_prev_wrap() {
        let mut tabs = with_sessions(&["a", "b"]);
        assert_eq!(tabs.next(), Change::Selected);
        assert_eq!(tabs.selected(), &Tab::Dashboard);
        assert_eq!(tabs.next(), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-a");
        assert_eq!(tabs.prev(), Change::Selected);
        assert_eq!(tabs.selected(), &Tab::Dashboard);
        assert_eq!(tabs.prev(), Change::Selected);
        assert_eq!(tabs.selected().label(), "term-mini-b");
    }

    #[test]
    fn next_and_prev_do_nothing_with_only_the_dashboard() {
        let mut tabs = Tabs::new();
        assert_eq!(tabs.next(), Change::Nothing);
        assert_eq!(tabs.prev(), Change::Nothing);
        assert_eq!(tabs.selected(), &Tab::Dashboard);
    }

    #[test]
    fn reset_leaves_only_the_dashboard() {
        let mut tabs = with_sessions(&["a", "b", "c"]);
        tabs.select_label("term-mini-b");
        assert_eq!(tabs.reset(), ["term-mini-a", "term-mini-b", "term-mini-c"]);
        assert_eq!(tabs.tabs(), [Tab::Dashboard]);
        assert_eq!(tabs.selected(), &Tab::Dashboard);
        assert!(tabs.reset().is_empty());
        assert_eq!(tabs.open("mini", "a"), Change::Opened("term-mini-a".into()));
    }

    #[test]
    fn titles_use_the_folder_when_known() {
        let mut tabs = Tabs::new();
        tabs.open("mini", "api-1");
        tabs.open("hp", "web");
        tabs.select_label("term-mini-api-1");
        let state = view(vec![session("mini", Some("api-1"), "acme/api")]);
        assert_eq!(
            tabs.views(Some(&state)),
            [
                tab_view("dashboard", "Dashboard", false, false),
                tab_view("term-mini-api-1", "acme/api · mini", true, true),
                tab_view("term-hp-web", "web · hp", false, true),
            ]
        );
        assert_eq!(
            titles(&tabs.views(None)),
            ["Dashboard", "api-1 · mini", "web · hp"]
        );
    }

    #[test]
    fn a_session_matches_the_state_by_machine_and_tmux_name() {
        let mut tabs = Tabs::new();
        tabs.open("mini", "api-1");
        let state = view(vec![
            session("hp", Some("api-1"), "acme/web"),
            session("mini", Some("api-2"), "acme/docs"),
            session("mini", None, "acme/bare"),
        ]);
        assert_eq!(
            titles(&tabs.views(Some(&state))),
            ["Dashboard", "api-1 · mini"]
        );
    }

    #[test]
    fn an_empty_folder_falls_back_to_the_tmux_name() {
        let mut tabs = Tabs::new();
        tabs.open("mini", "api-1");
        let state = view(vec![session("mini", Some("api-1"), "")]);
        assert_eq!(
            titles(&tabs.views(Some(&state))),
            ["Dashboard", "api-1 · mini"]
        );
    }

    #[test]
    fn views_serialize_with_the_fields_the_tab_bar_reads() {
        let mut tabs = Tabs::new();
        tabs.open("mini", "api-1");
        assert_eq!(
            serde_json::to_value(tabs.views(None)).unwrap(),
            serde_json::json!([
                {
                    "label": "dashboard",
                    "title": "Dashboard",
                    "selected": false,
                    "closable": false
                },
                {
                    "label": "term-mini-api-1",
                    "title": "api-1 · mini",
                    "selected": true,
                    "closable": true
                },
            ])
        );
    }
}

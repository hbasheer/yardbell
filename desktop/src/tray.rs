use std::sync::Mutex;

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Wry};
use url::Url;
use yardbell::snapshot::Activity;
use yardbell::state::{MachineView, StateView};

use crate::main_window;
use crate::panel;
use crate::settings::Switches;
use crate::tabs::{self, DASHBOARD};
use crate::windows;

const TRAY_ID: &str = "yardbell";
const MEMORY_WARNING_PERCENT: u64 = 85;
const UNREACHABLE: &str = "Can't reach server";
const MACHINES_TITLE: &str = "Machines";
const SESSIONS_TITLE: &str = "Sessions";
const NEW_SESSION_EVENT: &str = "new-session";
const MENU_SESSION_LIMIT: usize = 15;
const WORKING: &str = " · working";

const OPEN: &str = "open";
const NEW_SESSION: &str = "new-session";
const ALL_SESSIONS: &str = "all-sessions";
const SERVER_STATUS: &str = "server-status";
const MACHINE_PREFIX: &str = "machine:";
const SESSION_PREFIX: &str = "session:";
const SESSION_SEPARATOR: char = '\u{1f}';
const NOTIFY_AGENT_IDLE: &str = "notify-agent-idle";
const NOTIFY_SESSION_ENDED: &str = "notify-session-ended";
const NOTIFY_MACHINE: &str = "notify-machine";
const NOTIFY_MEMORY: &str = "notify-memory";
const AUTOSTART: &str = "autostart";
const DISCONNECT: &str = "disconnect";
const QUIT: &str = "quit";

const GREEN: &[u8] = include_bytes!("../icons/tray-green.png");
const AMBER: &[u8] = include_bytes!("../icons/tray-amber.png");
const RED: &[u8] = include_bytes!("../icons/tray-red.png");
const GRAY: &[u8] = include_bytes!("../icons/tray-gray.png");
const MAC_PLAIN: &[u8] = include_bytes!("../icons/tray-mac.png");
const MAC_DOT: &[u8] = include_bytes!("../icons/tray-mac-dot.png");
const MAC_DIM: &[u8] = include_bytes!("../icons/tray-mac-dim.png");

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrayState {
    Green,
    Amber,
    Red,
    Gray,
}

#[derive(Debug, PartialEq)]
pub enum LeftClick {
    Panel,
    Reveal,
}

pub fn left_click(macos: bool) -> LeftClick {
    if macos {
        LeftClick::Panel
    } else {
        LeftClick::Reveal
    }
}

pub fn mac_icon(state: TrayState) -> &'static [u8] {
    match state {
        TrayState::Green => MAC_PLAIN,
        TrayState::Amber | TrayState::Red => MAC_DOT,
        TrayState::Gray => MAC_DIM,
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Status {
    Pending,
    Unreachable,
    Machines(Vec<MachineLine>),
}

#[derive(Debug, Clone, PartialEq)]
struct MachineLine {
    name: String,
    label: String,
}

impl Status {
    fn of(view: Option<&StateView>) -> Status {
        match view {
            None => Status::Unreachable,
            Some(view) => Status::Machines(
                view.machines
                    .iter()
                    .map(|m| MachineLine {
                        name: m.name.clone(),
                        label: machine_label(m),
                    })
                    .collect(),
            ),
        }
    }

    #[cfg(test)]
    fn lines(&self) -> Vec<&str> {
        match self {
            Status::Pending => Vec::new(),
            Status::Unreachable => vec![UNREACHABLE],
            Status::Machines(lines) => lines.iter().map(|line| line.label.as_str()).collect(),
        }
    }
}

#[derive(Debug, PartialEq)]
enum Entry {
    Header(&'static str),
    Item { id: String, text: String },
    Separator,
}

fn entries(status: &Status, sessions: &[MenuSession]) -> Vec<Entry> {
    let mut entries = Vec::new();
    match status {
        Status::Pending => {}
        Status::Unreachable => {
            entries.push(Entry::Item {
                id: SERVER_STATUS.into(),
                text: UNREACHABLE.into(),
            });
            entries.push(Entry::Separator);
        }
        Status::Machines(lines) if !lines.is_empty() => {
            entries.push(Entry::Header(MACHINES_TITLE));
            entries.extend(lines.iter().map(|line| Entry::Item {
                id: machine_id(&line.name),
                text: menu_text(&line.label),
            }));
            entries.push(Entry::Separator);
        }
        Status::Machines(_) => {}
    }
    let (listed, more) = listed_sessions(sessions);
    if listed.is_empty() {
        return entries;
    }
    entries.push(Entry::Header(SESSIONS_TITLE));
    entries.extend(listed.iter().map(|session| Entry::Item {
        id: session_id(&session.machine, &session.tmux),
        text: session_text(session),
    }));
    if more {
        entries.push(Entry::Item {
            id: ALL_SESSIONS.into(),
            text: "All sessions…".into(),
        });
    }
    entries.push(Entry::Separator);
    entries
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MenuSession {
    machine: String,
    tmux: String,
    label: String,
    working: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct Shown {
    icon: TrayState,
    status: Status,
    sessions: Vec<MenuSession>,
    switches: Switches,
}

impl Shown {
    fn of(view: Option<&StateView>, switches: &Switches) -> Shown {
        Shown {
            icon: tray_state(view),
            status: Status::of(view),
            sessions: menu_sessions(view),
            switches: *switches,
        }
    }

    fn pending(switches: &Switches) -> Shown {
        Shown {
            icon: TrayState::Gray,
            status: Status::Pending,
            sessions: Vec::new(),
            switches: *switches,
        }
    }
}

struct Current(Mutex<Shown>);

pub fn tray_state(view: Option<&StateView>) -> TrayState {
    let Some(view) = view else {
        return TrayState::Gray;
    };
    if view.machines.iter().any(|m| !m.up) {
        return TrayState::Red;
    }
    let warned = view
        .machines
        .iter()
        .filter_map(memory_percent)
        .any(|percent| percent >= MEMORY_WARNING_PERCENT);
    if warned {
        TrayState::Amber
    } else {
        TrayState::Green
    }
}

pub fn machine_label(m: &MachineView) -> String {
    if !m.up {
        return match m.reason.as_deref().filter(|reason| !reason.is_empty()) {
            Some(reason) => format!("{} · down ({reason})", m.name),
            None => format!("{} · down", m.name),
        };
    }
    match memory_percent(m) {
        Some(percent) => format!("{} · up · {percent}% memory", m.name),
        None => format!("{} · up", m.name),
    }
}

pub fn memory_percent(m: &MachineView) -> Option<u64> {
    let health = m.health.filter(|health| health.mem_total_kb > 0)?;
    let used = health.mem_used_kb as f64 / health.mem_total_kb as f64;
    Some((used * 100.0).round() as u64)
}

pub fn menu_sessions(view: Option<&StateView>) -> Vec<MenuSession> {
    let Some(view) = view else {
        return Vec::new();
    };
    let rank = |machine: &str| {
        view.machines
            .iter()
            .position(|m| m.name == machine)
            .unwrap_or(view.machines.len())
    };
    let mut sessions: Vec<MenuSession> = view
        .sessions
        .iter()
        .filter(|s| s.attachable && !s.stale)
        .filter_map(|s| {
            let tmux = s.tmux.as_deref()?;
            Some(MenuSession {
                machine: s.machine.clone(),
                tmux: tmux.to_string(),
                label: tabs::session_title(&s.folder, tmux, &s.machine),
                working: s.activity == Activity::Active,
            })
        })
        .collect();
    sessions.sort_by_key(|s| rank(&s.machine));
    sessions
}

fn listed_sessions(sessions: &[MenuSession]) -> (&[MenuSession], bool) {
    let listed = &sessions[..sessions.len().min(MENU_SESSION_LIMIT)];
    (listed, sessions.len() > MENU_SESSION_LIMIT)
}

fn session_text(session: &MenuSession) -> String {
    let text = menu_text(&session.label);
    if session.working {
        format!("{text}{WORKING}")
    } else {
        text
    }
}

fn session_id(machine: &str, tmux: &str) -> String {
    format!("{SESSION_PREFIX}{machine}{SESSION_SEPARATOR}{tmux}")
}

fn session_target(id: &str) -> Option<(&str, &str)> {
    id.strip_prefix(SESSION_PREFIX)?
        .split_once(SESSION_SEPARATOR)
}

fn machine_id(name: &str) -> String {
    format!("{MACHINE_PREFIX}{name}")
}

fn machine_target(id: &str) -> Option<&str> {
    id.strip_prefix(MACHINE_PREFIX)
}

fn machine_url(server: &str, name: &str) -> Option<String> {
    let mut url = Url::parse(server).ok()?;
    url.set_path("/");
    url.query_pairs_mut().clear().append_pair("machine", name);
    Some(url.into())
}

pub fn toggled(id: &str, switches: Switches) -> Option<Switches> {
    let mut next = switches;
    let switch = match id {
        NOTIFY_AGENT_IDLE => &mut next.agent_idle,
        NOTIFY_SESSION_ENDED => &mut next.session_ended,
        NOTIFY_MACHINE => &mut next.machine,
        NOTIFY_MEMORY => &mut next.memory,
        AUTOSTART => &mut next.autostart,
        _ => return None,
    };
    *switch = !*switch;
    Some(next)
}

pub fn build_menu(
    app: &AppHandle,
    view: Option<&StateView>,
    switches: &Switches,
) -> tauri::Result<Menu<Wry>> {
    menu(app, &Status::of(view), &menu_sessions(view), switches)
}

pub fn init(app: &AppHandle, switches: &Switches) -> tauri::Result<()> {
    let shown = Shown::pending(switches);
    app.manage(Current(Mutex::new(shown.clone())));
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(shown.icon)?)
        .tooltip("Yardbell")
        .menu(&menu(app, &shown.status, &shown.sessions, switches)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event)
        .build(app)?;
    Ok(())
}

pub fn update_tray(app: &AppHandle, view: Option<&StateView>, switches: &Switches) {
    let next = Shown::of(view, switches);
    if !changed(app, &next) {
        return;
    }
    present(app, next, build_menu(app, view, switches));
}

pub fn reset_tray(app: &AppHandle, switches: &Switches) {
    let next = Shown::pending(switches);
    let menu = menu(app, &next.status, &next.sessions, switches);
    present(app, next, menu);
}

pub fn show_switches(app: &AppHandle, switches: &Switches) {
    let mut next = app.state::<Current>().0.lock().unwrap().clone();
    next.switches = *switches;
    let menu = menu(app, &next.status, &next.sessions, switches);
    present(app, next, menu);
}

fn changed(app: &AppHandle, next: &Shown) -> bool {
    *app.state::<Current>().0.lock().unwrap() != *next
}

// apply holds the cache lock across tray calls that block on the main
// thread unless they already run there, so it must only ever run there.
fn present(app: &AppHandle, next: Shown, menu: tauri::Result<Menu<Wry>>) {
    let handle = app.clone();
    let queued = menu.and_then(|menu| app.run_on_main_thread(move || apply(&handle, next, menu)));
    if let Err(e) = queued {
        eprintln!("yardbell: can't update the tray: {e}");
    }
}

fn apply(app: &AppHandle, next: Shown, menu: Menu<Wry>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let current = app.state::<Current>();
    let mut shown = current.0.lock().unwrap();
    match set(&tray, &shown, &next, menu) {
        Ok(()) => *shown = next,
        Err(e) => eprintln!("yardbell: can't update the tray: {e}"),
    }
}

fn set(tray: &TrayIcon, shown: &Shown, next: &Shown, menu: Menu<Wry>) -> tauri::Result<()> {
    if shown.icon != next.icon {
        tray.set_icon_with_as_template(Some(icon(next.icon)?), cfg!(target_os = "macos"))?;
    }
    tray.set_menu(Some(menu))
}

fn menu(
    app: &AppHandle,
    status: &Status,
    sessions: &[MenuSession],
    switches: &Switches,
) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for entry in entries(status, sessions) {
        match entry {
            Entry::Header(title) => {
                menu.append(&MenuItem::new(app, title, false, None::<&str>)?)?
            }
            Entry::Item { id, text } => {
                menu.append(&MenuItem::with_id(app, id, text, true, None::<&str>)?)?
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    menu.append(&MenuItem::with_id(
        app,
        OPEN,
        "Open Yardbell",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        NEW_SESSION,
        "New session",
        true,
        None::<&str>,
    )?)?;
    menu.append(&notifications(app, switches)?)?;
    let (id, label, checked) = autostart_switch(switches);
    menu.append(&CheckMenuItem::with_id(
        app,
        id,
        label,
        true,
        checked,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        DISCONNECT,
        "Disconnect",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn notification_switches(switches: &Switches) -> [(&'static str, &'static str, bool); 4] {
    [
        (
            NOTIFY_AGENT_IDLE,
            "Agent finished or waiting",
            switches.agent_idle,
        ),
        (
            NOTIFY_SESSION_ENDED,
            "Session ended",
            switches.session_ended,
        ),
        (NOTIFY_MACHINE, "Machine down or back", switches.machine),
        (NOTIFY_MEMORY, "Memory almost full", switches.memory),
    ]
}

pub fn autostart_switch(switches: &Switches) -> (&'static str, &'static str, bool) {
    (AUTOSTART, "Start at login", switches.autostart)
}

fn notifications(app: &AppHandle, switches: &Switches) -> tauri::Result<Submenu<Wry>> {
    let submenu = Submenu::new(app, "Notifications", true)?;
    for (id, label, checked) in notification_switches(switches) {
        submenu.append(&CheckMenuItem::with_id(
            app,
            id,
            label,
            true,
            checked,
            None::<&str>,
        )?)?;
    }
    Ok(submenu)
}

fn menu_text(label: &str) -> String {
    label.replace('&', "&&")
}

fn icon(state: TrayState) -> tauri::Result<Image<'static>> {
    if cfg!(target_os = "macos") {
        return Image::from_bytes(mac_icon(state));
    }
    Image::from_bytes(dot_icon(state))
}

fn dot_icon(state: TrayState) -> &'static [u8] {
    match state {
        TrayState::Green => GREEN,
        TrayState::Amber => AMBER,
        TrayState::Red => RED,
        TrayState::Gray => GRAY,
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        OPEN => report("show the window", main_window::reveal(app)),
        NEW_SESSION => new_session(app),
        DISCONNECT => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { crate::sign_out(&app, None).await });
        }
        QUIT => crate::quit(app),
        SERVER_STATUS => report("show the window", main_window::reveal(app)),
        ALL_SESSIONS => {
            report("show the window", main_window::reveal(app));
            main_window::select(app, DASHBOARD);
        }
        id => {
            if let Some((machine, tmux)) = session_target(id) {
                open_session(app, machine, tmux);
            } else if let Some(name) = machine_target(id) {
                open_machine(app, name);
            } else {
                crate::toggle_switch(app, id);
            }
        }
    }
}

fn on_tray_icon_event(tray: &TrayIcon, event: TrayIconEvent) {
    let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        rect,
        ..
    } = event
    else {
        return;
    };
    match left_click(cfg!(target_os = "macos")) {
        LeftClick::Panel => panel::toggle(tray.app_handle(), rect),
        LeftClick::Reveal => report("show the window", main_window::reveal(tray.app_handle())),
    }
}

pub fn new_session(app: &AppHandle) {
    report("show the window", main_window::reveal(app));
    main_window::select(app, DASHBOARD);
    report(
        "ask the dashboard for a new session",
        app.emit_to(EventTarget::webview(DASHBOARD), NEW_SESSION_EVENT, ()),
    );
}

pub fn open_session(app: &AppHandle, machine: &str, tmux: &str) {
    let opened = match windows::live_server(app) {
        Some(server) => main_window::open_session(app, &server, machine, tmux),
        None => main_window::reveal(app),
    };
    report("open the session", opened);
}

pub fn open_machine(app: &AppHandle, name: &str) {
    report("show the window", main_window::reveal(app));
    let Some(url) = windows::live_server(app).and_then(|server| machine_url(&server, name)) else {
        return;
    };
    if let Err(e) = main_window::navigate_dashboard(app, &url) {
        eprintln!("yardbell: can't open {url}: {e}");
    }
}

fn report(action: &str, result: tauri::Result<()>) {
    if let Err(e) = result {
        eprintln!("yardbell: can't {action}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yardbell::config::HostTerminal;
    use yardbell::snapshot::Health;
    use yardbell::state::SessionView;

    fn health(used_kb: u64, total_kb: u64) -> Health {
        Health {
            mem_total_kb: total_kb,
            mem_used_kb: used_kb,
            agent_kb: 0,
            load1: 0.0,
            cpus: 4,
        }
    }

    fn machine(name: &str, up: bool, reason: Option<&str>, memory: Option<u64>) -> MachineView {
        MachineView {
            name: name.into(),
            up,
            reason: reason.map(str::to_string),
            last_seen: None,
            local: false,
            health: memory.map(|percent| health(percent * 10, 1000)),
            mesh_on: None,
        }
    }

    fn view(machines: Vec<MachineView>) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines,
            folders: vec![],
            sessions: vec![],
            ended: vec![],
            host_terminal: HostTerminal::None,
            mesh: None,
        }
    }

    #[test]
    fn tray_state_priority() {
        assert_eq!(tray_state(None), TrayState::Gray);

        let down_and_hot = view(vec![
            machine("devbox", true, None, Some(90)),
            machine("laptop", false, Some("ssh timeout"), None),
        ]);
        assert_eq!(tray_state(Some(&down_and_hot)), TrayState::Red);

        let hot = view(vec![
            machine("devbox", true, None, Some(85)),
            machine("studio", true, None, Some(59)),
        ]);
        assert_eq!(tray_state(Some(&hot)), TrayState::Amber);

        let fine = view(vec![
            machine("devbox", true, None, Some(84)),
            machine("studio", true, None, None),
        ]);
        assert_eq!(tray_state(Some(&fine)), TrayState::Green);

        assert_eq!(tray_state(Some(&view(vec![]))), TrayState::Green);
    }

    #[test]
    fn tray_state_rounds_memory_like_the_dashboard() {
        let mut hot = machine("devbox", true, None, None);
        hot.health = Some(health(846, 1000));
        assert_eq!(tray_state(Some(&view(vec![hot]))), TrayState::Amber);

        let mut fine = machine("devbox", true, None, None);
        fine.health = Some(health(844, 1000));
        assert_eq!(tray_state(Some(&view(vec![fine]))), TrayState::Green);
    }

    #[test]
    fn tray_state_ignores_health_without_total_memory() {
        let mut m = machine("devbox", true, None, None);
        m.health = Some(health(500, 0));
        assert_eq!(tray_state(Some(&view(vec![m]))), TrayState::Green);
    }

    #[test]
    fn machine_labels() {
        assert_eq!(
            machine_label(&machine("devbox", true, None, Some(88))),
            "devbox · up · 88% memory"
        );
        assert_eq!(
            machine_label(&machine("devbox", true, None, None)),
            "devbox · up"
        );
        assert_eq!(
            machine_label(&machine("laptop", false, Some("ssh timeout"), None)),
            "laptop · down (ssh timeout)"
        );
        assert_eq!(
            machine_label(&machine("laptop", false, None, None)),
            "laptop · down"
        );
    }

    #[test]
    fn machine_label_edge_cases() {
        assert_eq!(
            machine_label(&machine("laptop", false, Some(""), None)),
            "laptop · down"
        );
        assert_eq!(
            machine_label(&machine("laptop", false, Some("no mesh"), Some(90))),
            "laptop · down (no mesh)"
        );
        let mut m = machine("devbox", true, None, None);
        m.health = Some(health(500, 0));
        assert_eq!(machine_label(&m), "devbox · up");
        m.health = Some(health(846, 1000));
        assert_eq!(machine_label(&m), "devbox · up · 85% memory");
    }

    #[test]
    fn status_lines() {
        assert!(Status::Pending.lines().is_empty());
        assert_eq!(Status::of(None).lines(), vec!["Can't reach server"]);

        let listed = view(vec![
            machine("devbox", true, None, Some(88)),
            machine("laptop", false, Some("ssh timeout"), None),
            machine("studio", true, None, Some(59)),
        ]);
        assert_eq!(
            Status::of(Some(&listed)).lines(),
            vec![
                "devbox · up · 88% memory",
                "laptop · down (ssh timeout)",
                "studio · up · 59% memory"
            ]
        );

        assert!(Status::of(Some(&view(vec![]))).lines().is_empty());
    }

    #[test]
    fn identical_views_render_once() {
        let switches = Switches::default();
        let steady = |percent| view(vec![machine("devbox", true, None, Some(percent))]);
        assert_eq!(
            Shown::of(Some(&steady(60)), &switches),
            Shown::of(Some(&steady(60)), &switches)
        );
        assert_ne!(
            Shown::of(Some(&steady(60)), &switches),
            Shown::of(Some(&steady(61)), &switches)
        );
        assert_ne!(Shown::of(None, &switches), Shown::pending(&switches));
        let quiet = Switches {
            memory: false,
            ..switches
        };
        assert_ne!(
            Shown::of(Some(&steady(60)), &switches),
            Shown::of(Some(&steady(60)), &quiet)
        );
    }

    #[test]
    fn each_switch_item_flips_only_its_own_switch() {
        let on = Switches::default();
        assert_eq!(
            toggled(NOTIFY_AGENT_IDLE, on),
            Some(Switches {
                agent_idle: false,
                ..on
            })
        );
        assert_eq!(
            toggled(NOTIFY_SESSION_ENDED, on),
            Some(Switches {
                session_ended: false,
                ..on
            })
        );
        assert_eq!(
            toggled(NOTIFY_MACHINE, on),
            Some(Switches {
                machine: false,
                ..on
            })
        );
        assert_eq!(
            toggled(NOTIFY_MEMORY, on),
            Some(Switches {
                memory: false,
                ..on
            })
        );
        assert_eq!(
            toggled(AUTOSTART, on),
            Some(Switches {
                autostart: true,
                ..on
            })
        );
        let off = toggled(NOTIFY_MEMORY, on).unwrap();
        assert_eq!(toggled(NOTIFY_MEMORY, off), Some(on));
        for id in [OPEN, NEW_SESSION, DISCONNECT, QUIT, "devbox"] {
            assert_eq!(toggled(id, on), None, "{id}");
        }
    }

    #[test]
    fn menu_text_escapes_ampersands() {
        assert_eq!(menu_text("a&b · up"), "a&&b · up");
        assert_eq!(menu_text("devbox · up"), "devbox · up");
    }

    #[test]
    fn every_state_has_a_32px_icon() {
        for state in [
            TrayState::Green,
            TrayState::Amber,
            TrayState::Red,
            TrayState::Gray,
        ] {
            let image = Image::from_bytes(dot_icon(state)).unwrap();
            assert_eq!((image.width(), image.height()), (32, 32), "{state:?}");
        }
    }

    #[test]
    fn every_state_has_a_mac_template_icon() {
        for state in [
            TrayState::Green,
            TrayState::Amber,
            TrayState::Red,
            TrayState::Gray,
        ] {
            let image = Image::from_bytes(mac_icon(state)).unwrap();
            assert_eq!((image.width(), image.height()), (36, 36), "{state:?}");
            let pixels = image.rgba();
            assert!(
                pixels.chunks(4).all(|p| p[..3] == [0, 0, 0]),
                "{state:?} is not black"
            );
            let strongest = pixels.chunks(4).map(|p| p[3]).max().unwrap();
            if state == TrayState::Gray {
                assert!(strongest <= 120, "{state:?} is too strong: {strongest}");
            } else {
                assert!(strongest > 200, "{state:?} is too faint: {strongest}");
            }
        }
    }

    #[test]
    fn mac_states_map_to_plain_dot_and_dim() {
        assert_eq!(mac_icon(TrayState::Green), MAC_PLAIN);
        assert_eq!(mac_icon(TrayState::Amber), MAC_DOT);
        assert_eq!(mac_icon(TrayState::Red), MAC_DOT);
        assert_eq!(mac_icon(TrayState::Gray), MAC_DIM);
        assert_ne!(MAC_PLAIN, MAC_DOT);
        assert_ne!(MAC_PLAIN, MAC_DIM);
    }

    #[test]
    fn left_click_opens_the_panel_on_macos() {
        assert_eq!(left_click(true), LeftClick::Panel);
        assert_eq!(left_click(false), LeftClick::Reveal);
    }

    fn session(machine: &str, tmux: Option<&str>, folder: &str, activity: Activity) -> SessionView {
        SessionView {
            id: format!("{machine}-{}", tmux.unwrap_or("loose")),
            machine: machine.into(),
            agent: "claude".into(),
            pid: 1,
            folder: folder.into(),
            ticket: String::new(),
            branch: String::new(),
            activity,
            attachable: tmux.is_some(),
            tmux: tmux.map(str::to_string),
            stale: false,
            ports: vec![],
        }
    }

    fn menu_session(machine: &str, tmux: &str, label: &str, working: bool) -> MenuSession {
        MenuSession {
            machine: machine.into(),
            tmux: tmux.into(),
            label: label.into(),
            working,
        }
    }

    #[test]
    fn menu_sessions_follow_the_machine_order_and_skip_unopenable_ones() {
        let mut state = view(vec![
            machine("devbox", true, None, None),
            machine("laptop", true, None, None),
        ]);
        let mut stale = session("devbox", Some("old"), "acme/old", Activity::Idle);
        stale.stale = true;
        state.sessions = vec![
            session("laptop", Some("web"), "acme/web", Activity::Active),
            session("devbox", None, "acme/loose", Activity::Idle),
            session("devbox", Some("api"), "acme/api", Activity::Idle),
            stale,
            session("studio", Some("docs"), "", Activity::Active),
        ];

        assert_eq!(
            menu_sessions(Some(&state)),
            vec![
                menu_session("devbox", "api", "acme/api · devbox", false),
                menu_session("laptop", "web", "acme/web · laptop", true),
                menu_session("studio", "docs", "docs · studio", true),
            ]
        );
        assert!(menu_sessions(None).is_empty());
    }

    #[test]
    fn working_sessions_say_so_in_the_menu() {
        assert_eq!(
            session_text(&menu_session("devbox", "api", "acme/api · devbox", true)),
            "acme/api · devbox · working"
        );
        assert_eq!(
            session_text(&menu_session("devbox", "a&b", "a&b · devbox", false)),
            "a&&b · devbox"
        );
    }

    #[test]
    fn the_menu_lists_at_most_fifteen_sessions() {
        let many: Vec<MenuSession> = (0..17)
            .map(|n| menu_session("devbox", &format!("s{n}"), &format!("s{n} · devbox"), false))
            .collect();
        let (listed, more) = listed_sessions(&many);
        assert_eq!(listed.len(), 15);
        assert_eq!(listed[14].tmux, "s14");
        assert!(more);

        let (listed, more) = listed_sessions(&many[..15]);
        assert_eq!(listed.len(), 15);
        assert!(!more);
    }

    fn item(id: &str, text: &str) -> Entry {
        Entry::Item {
            id: id.into(),
            text: text.into(),
        }
    }

    #[test]
    fn the_menu_titles_its_machine_and_session_sections() {
        let mut state = view(vec![
            machine("devbox", true, None, Some(40)),
            machine("laptop", false, None, None),
        ]);
        state.sessions = vec![session("devbox", Some("api"), "acme/api", Activity::Active)];
        let shown = Shown::of(Some(&state), &Switches::default());

        assert_eq!(
            entries(&shown.status, &shown.sessions),
            vec![
                Entry::Header("Machines"),
                item("machine:devbox", "devbox · up · 40% memory"),
                item("machine:laptop", "laptop · down"),
                Entry::Separator,
                Entry::Header("Sessions"),
                item(&session_id("devbox", "api"), "acme/api · devbox · working"),
                Entry::Separator,
            ]
        );
    }

    #[test]
    fn the_menu_top_without_machines_or_sessions() {
        assert!(entries(&Status::Pending, &[]).is_empty());
        assert_eq!(
            entries(&Status::of(None), &[]),
            vec![item(SERVER_STATUS, "Can't reach server"), Entry::Separator]
        );
        assert!(entries(&Status::of(Some(&view(vec![]))), &[]).is_empty());
    }

    #[test]
    fn the_menu_points_past_fifteen_sessions_to_the_dashboard() {
        let many: Vec<MenuSession> = (0..16)
            .map(|n| menu_session("devbox", &format!("s{n}"), &format!("s{n} · devbox"), false))
            .collect();
        let top = entries(&Status::Pending, &many);
        assert_eq!(top.len(), 18);
        assert_eq!(top[16], item(ALL_SESSIONS, "All sessions…"));
    }

    #[test]
    fn a_machine_menu_id_names_its_machine() {
        assert_eq!(machine_target(&machine_id("dev box")), Some("dev box"));
        assert_eq!(machine_target(OPEN), None);
    }

    #[test]
    fn a_machine_opens_the_dashboard_on_that_machine() {
        assert_eq!(
            machine_url("http://100.64.0.1:4100", "dev box").as_deref(),
            Some("http://100.64.0.1:4100/?machine=dev+box")
        );
        assert_eq!(machine_url("not a url", "devbox"), None);
    }

    #[test]
    fn a_session_menu_id_names_its_session() {
        let id = session_id("devbox", "acme api:1");
        assert_eq!(session_target(&id), Some(("devbox", "acme api:1")));
        assert_eq!(session_target(OPEN), None);
        assert_eq!(session_target(ALL_SESSIONS), None);
    }
}

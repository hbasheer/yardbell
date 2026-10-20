use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Wry};
use yardbell::state::{MachineView, StateView};

use crate::settings::Switches;
use crate::windows;

const TRAY_ID: &str = "yardbell";
const MEMORY_WARNING_PERCENT: u64 = 85;
const UNREACHABLE: &str = "Can't reach server";
const NEW_SESSION_EVENT: &str = "new-session";

const OPEN: &str = "open";
const NEW_SESSION: &str = "new-session";
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrayState {
    Green,
    Amber,
    Red,
    Gray,
}

#[derive(Debug, Clone, PartialEq)]
enum Status {
    Pending,
    Unreachable,
    Machines(Vec<String>),
}

impl Status {
    fn of(view: Option<&StateView>) -> Status {
        match view {
            None => Status::Unreachable,
            Some(view) => Status::Machines(view.machines.iter().map(machine_label).collect()),
        }
    }

    fn lines(&self) -> Vec<&str> {
        match self {
            Status::Pending => Vec::new(),
            Status::Unreachable => vec![UNREACHABLE],
            Status::Machines(lines) => lines.iter().map(String::as_str).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Shown {
    icon: TrayState,
    status: Status,
    switches: Switches,
}

impl Shown {
    fn of(view: Option<&StateView>, switches: &Switches) -> Shown {
        Shown {
            icon: tray_state(view),
            status: Status::of(view),
            switches: *switches,
        }
    }

    fn pending(switches: &Switches) -> Shown {
        Shown {
            icon: TrayState::Gray,
            status: Status::Pending,
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

fn memory_percent(m: &MachineView) -> Option<u64> {
    let health = m.health.filter(|health| health.mem_total_kb > 0)?;
    let used = health.mem_used_kb as f64 / health.mem_total_kb as f64;
    Some((used * 100.0).round() as u64)
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
    menu(app, &Status::of(view), switches)
}

pub fn init(app: &AppHandle, switches: &Switches) -> tauri::Result<()> {
    let shown = Shown::pending(switches);
    app.manage(Current(Mutex::new(shown.clone())));
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(shown.icon)?)
        .tooltip("Yardbell")
        .menu(&menu(app, &shown.status, switches)?)
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
    let menu = menu(app, &next.status, switches);
    present(app, next, menu);
}

pub fn show_switches(app: &AppHandle, switches: &Switches) {
    let mut next = app.state::<Current>().0.lock().unwrap().clone();
    next.switches = *switches;
    let menu = menu(app, &next.status, switches);
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
        tray.set_icon(Some(icon(next.icon)?))?;
    }
    tray.set_menu(Some(menu))
}

fn menu(app: &AppHandle, status: &Status, switches: &Switches) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let lines = status.lines();
    for line in &lines {
        menu.append(&MenuItem::new(app, menu_text(line), false, None::<&str>)?)?;
    }
    if !lines.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
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
    menu.append(&CheckMenuItem::with_id(
        app,
        AUTOSTART,
        "Start at login",
        true,
        switches.autostart,
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

fn notifications(app: &AppHandle, switches: &Switches) -> tauri::Result<Submenu<Wry>> {
    let submenu = Submenu::new(app, "Notifications", true)?;
    for (id, label, checked) in [
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
    ] {
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
    Image::from_bytes(match state {
        TrayState::Green => GREEN,
        TrayState::Amber => AMBER,
        TrayState::Red => RED,
        TrayState::Gray => GRAY,
    })
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        OPEN => report("show the window", windows::reveal(app)),
        NEW_SESSION => {
            report("show the window", windows::reveal(app));
            report(
                "ask the dashboard for a new session",
                app.emit_to(
                    EventTarget::webview_window(windows::MAIN),
                    NEW_SESSION_EVENT,
                    (),
                ),
            );
        }
        DISCONNECT => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { crate::sign_out(&app, None).await });
        }
        QUIT => crate::quit(app),
        id => crate::toggle_switch(app, id),
    }
}

fn on_tray_icon_event(tray: &TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        report("show the window", windows::reveal(tray.app_handle()));
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
            let image = icon(state).unwrap();
            assert_eq!((image.width(), image.height()), (32, 32), "{state:?}");
        }
    }
}

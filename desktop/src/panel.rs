use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalSize, Manager, PhysicalPosition, Rect, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use yardbell::state::StateView;

use crate::main_window;
use crate::settings::{Settings, Switches};
use crate::tray::{self, MenuSession};

pub const PANEL: &str = "panel";
const PAGE: &str = "panel.html";
const EVENT: &str = "panel";
const SWITCHES_EVENT: &str = "panel-switches";
const WIDTH: f64 = 340.0;
const MAX_HEIGHT: f64 = 600.0;
const SCREEN_MARGIN: f64 = 8.0;
const ICON_GAP: f64 = 4.0;
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum PanelView {
    Pending,
    Unreachable,
    Ready {
        machines: Vec<PanelMachine>,
        sessions: Vec<MenuSession>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelMachine {
    name: String,
    up: bool,
    reason: Option<String>,
    memory: Option<Memory>,
    cpu: Option<Cpu>,
    disk: Option<Disk>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Disk {
    percent: u64,
    used_kb: u64,
    total_kb: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cpu {
    percent: u64,
    load1: f64,
    cpus: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SwitchView {
    id: &'static str,
    label: &'static str,
    on: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Memory {
    percent: u64,
    used_kb: u64,
    total_kb: u64,
    agent_kb: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub struct Panel {
    view: Mutex<PanelView>,
    closed_at: Mutex<Option<Instant>>,
}

impl Default for Panel {
    fn default() -> Panel {
        Panel {
            view: Mutex::new(PanelView::Pending),
            closed_at: Mutex::new(None),
        }
    }
}

fn view(state: Option<&StateView>) -> PanelView {
    let Some(state) = state else {
        return PanelView::Unreachable;
    };
    let machines =
        state
            .machines
            .iter()
            .map(|m| PanelMachine {
                name: m.name.clone(),
                up: m.up,
                reason: m.reason.clone().filter(|reason| !reason.is_empty()),
                memory: m
                    .health
                    .filter(|health| m.up && health.mem_total_kb > 0)
                    .zip(tray::memory_percent(m))
                    .map(|(health, percent)| Memory {
                        percent,
                        used_kb: health.mem_used_kb,
                        total_kb: health.mem_total_kb,
                        agent_kb: health.agent_kb,
                    }),
                cpu: m.health.filter(|_| m.up).zip(tray::cpu_percent(m)).map(
                    |(health, percent)| Cpu {
                        percent,
                        load1: health.load1,
                        cpus: health.cpus,
                    },
                ),
                disk: m
                    .health
                    .filter(|health| m.up && health.disk_total_kb > 0)
                    .map(|health| Disk {
                        percent: (health.disk_used_kb * 100 + health.disk_total_kb / 2)
                            / health.disk_total_kb,
                        used_kb: health.disk_used_kb,
                        total_kb: health.disk_total_kb,
                    }),
            })
            .collect();
    PanelView::Ready {
        machines,
        sessions: tray::menu_sessions(Some(state)),
    }
}

fn switch_views(switches: &Switches) -> Vec<SwitchView> {
    tray::notification_switches(switches)
        .into_iter()
        .chain([tray::autostart_switch(switches)])
        .map(|(id, label, on)| SwitchView { id, label, on })
        .collect()
}

fn place(icon: Bounds, width: f64, screen: Bounds, margin: f64, gap: f64) -> (f64, f64) {
    let centered = icon.x + icon.width / 2.0 - width / 2.0;
    let min = screen.x + margin;
    let max = (screen.x + screen.width - width - margin).max(min);
    (centered.clamp(min, max), icon.y + icon.height + gap)
}

fn reopens(closed_at: Option<Instant>, now: Instant) -> bool {
    closed_at.is_none_or(|at| now.duration_since(at) >= REOPEN_GUARD)
}

pub fn init(app: &AppHandle) {
    app.manage(Panel::default());
    if !cfg!(target_os = "macos") {
        return;
    }
    if let Err(e) = build(app) {
        eprintln!("yardbell: can't prepare the menu bar panel: {e}");
    }
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App(PAGE.into()))
        .title("Yardbell")
        .inner_size(WIDTH, 240.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .build()
}

pub fn toggle(app: &AppHandle, icon: Rect) {
    let window = app.get_webview_window(PANEL);
    if window
        .as_ref()
        .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
        hide(app);
        return;
    }
    if !reopens(
        *app.state::<Panel>().closed_at.lock().unwrap(),
        Instant::now(),
    ) {
        return;
    }
    let shown = match window {
        Some(window) => show(app, &window, icon),
        None => build(app).and_then(|window| show(app, &window, icon)),
    };
    if let Err(e) = shown {
        eprintln!("yardbell: can't open the menu bar panel: {e}");
    }
}

fn show(app: &AppHandle, window: &WebviewWindow, icon: Rect) -> tauri::Result<()> {
    let scale = window.scale_factor()?;
    let at = icon.position.to_physical::<f64>(scale);
    let size = icon.size.to_physical::<f64>(scale);
    let monitor = match app.monitor_from_point(at.x, at.y)? {
        Some(monitor) => Some(monitor),
        None => app.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        let (position, extent) = (monitor.position(), monitor.size());
        let screen = Bounds {
            x: position.x as f64,
            y: position.y as f64,
            width: extent.width as f64,
            height: extent.height as f64,
        };
        let icon = Bounds {
            x: at.x,
            y: at.y,
            width: size.width,
            height: size.height,
        };
        let (x, y) = place(
            icon,
            WIDTH * scale,
            screen,
            SCREEN_MARGIN * scale,
            ICON_GAP * scale,
        );
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    window.show()?;
    window.set_focus()
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL) {
        if let Err(e) = window.hide() {
            eprintln!("yardbell: can't close the menu bar panel: {e}");
        }
    }
}

pub fn closed_by_blur(app: &AppHandle) {
    *app.state::<Panel>().closed_at.lock().unwrap() = Some(Instant::now());
    hide(app);
}

pub fn publish(app: &AppHandle, state: Option<&StateView>) {
    set(app, view(state));
}

pub fn reset(app: &AppHandle) {
    set(app, PanelView::Pending);
}

fn set(app: &AppHandle, next: PanelView) {
    let panel = app.state::<Panel>();
    let mut current = panel.view.lock().unwrap();
    if *current == next {
        return;
    }
    *current = next;
    if let Err(e) = app.emit_to(EventTarget::webview_window(PANEL), EVENT, &*current) {
        eprintln!("yardbell: can't update the menu bar panel: {e}");
    }
}

pub fn show_switches(app: &AppHandle, switches: &Switches) {
    let views = switch_views(switches);
    if let Err(e) = app.emit_to(EventTarget::webview_window(PANEL), SWITCHES_EVENT, views) {
        eprintln!("yardbell: can't update the menu bar panel: {e}");
    }
}

#[tauri::command]
pub fn panel_switches(app: AppHandle) -> Vec<SwitchView> {
    switch_views(&app.state::<Settings>().switches())
}

#[tauri::command]
pub fn panel_toggle(app: AppHandle, id: String) {
    crate::toggle_switch(&app, &id);
}

#[tauri::command]
pub fn panel_quit(app: AppHandle) {
    hide(&app);
    crate::quit(&app);
}

#[tauri::command]
pub async fn panel_disconnect(app: AppHandle) {
    hide(&app);
    crate::sign_out_by_user(&app).await;
}

#[tauri::command]
pub fn panel_state(app: AppHandle) -> PanelView {
    app.state::<Panel>().view.lock().unwrap().clone()
}

#[tauri::command]
pub fn panel_resize(app: AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(PANEL) else {
        return;
    };
    let size = LogicalSize::new(WIDTH, height.clamp(1.0, MAX_HEIGHT));
    if let Err(e) = window.set_size(size) {
        eprintln!("yardbell: can't size the menu bar panel: {e}");
    }
}

#[tauri::command]
pub fn panel_close(app: AppHandle) {
    hide(&app);
}

#[tauri::command]
pub fn panel_open_session(app: AppHandle, machine: String, tmux: String) {
    hide(&app);
    tray::open_session(&app, &machine, &tmux);
}

#[tauri::command]
pub fn panel_open_machine(app: AppHandle, name: String) {
    hide(&app);
    tray::open_machine(&app, &name);
}

#[tauri::command]
pub fn panel_open_app(app: AppHandle) {
    hide(&app);
    if let Err(e) = main_window::reveal(&app) {
        eprintln!("yardbell: can't show the window: {e}");
    }
}

#[tauri::command]
pub fn panel_new_session(app: AppHandle) {
    hide(&app);
    tray::new_session(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Switches;
    use yardbell::config::HostTerminal;
    use yardbell::snapshot::{Activity, Health};
    use yardbell::state::{MachineView, SessionView};

    fn machine(name: &str, up: bool, health: Option<Health>) -> MachineView {
        MachineView {
            name: name.into(),
            up,
            reason: (!up).then(|| "ssh timeout".to_string()),
            last_seen: None,
            local: false,
            health,
            accounts: Vec::new(),
            mesh_on: None,
        }
    }

    fn health(used_kb: u64, total_kb: u64, agent_kb: u64) -> Health {
        Health {
            mem_total_kb: total_kb,
            mem_used_kb: used_kb,
            agent_kb,
            user_kb: 0,
            limit_kb: 0,
            limit_used_kb: 0,
            load1: 0.0,
            cpus: 4,
            disk_total_kb: 0,
            disk_used_kb: 0,
        }
    }

    fn session(machine: &str, tmux: &str, activity: Activity) -> SessionView {
        SessionView {
            id: format!("{machine}-{tmux}"),
            machine: machine.into(),
            agent: "claude".into(),
            pid: 1,
            folder: format!("acme/{tmux}"),
            ticket: String::new(),
            branch: String::new(),
            activity,
            attachable: true,
            tmux: Some(tmux.into()),
            stale: false,
            ports: vec![],
            pull: None,
            path: String::new(),
            worktree: false,
            setup: None,
        }
    }

    fn state(machines: Vec<MachineView>, sessions: Vec<SessionView>) -> StateView {
        StateView {
            agents: vec![],
            default_agent: "claude".into(),
            machines,
            folders: vec![],
            sessions,
            ended: vec![],
            host_terminal: HostTerminal::None,
            mesh: None,
            server: None,
        }
    }

    #[test]
    fn the_panel_shows_each_machine_with_its_memory() {
        let view = view(Some(&state(
            vec![
                machine("devbox", true, Some(health(400, 1000, 100))),
                machine("laptop", false, None),
                machine("studio", true, Some(health(5, 0, 0))),
            ],
            vec![session("devbox", "api", Activity::Active)],
        )));
        let PanelView::Ready { machines, sessions } = view else {
            panic!("expected a ready panel, got {view:?}");
        };
        assert_eq!(
            machines,
            vec![
                PanelMachine {
                    name: "devbox".into(),
                    up: true,
                    reason: None,
                    memory: Some(Memory {
                        percent: 40,
                        used_kb: 400,
                        total_kb: 1000,
                        agent_kb: 100,
                    }),
                    cpu: Some(Cpu {
                        percent: 0,
                        load1: 0.0,
                        cpus: 4,
                    }),
                    disk: None,
                },
                PanelMachine {
                    name: "laptop".into(),
                    up: false,
                    reason: Some("ssh timeout".into()),
                    memory: None,
                    cpu: None,
                    disk: None,
                },
                PanelMachine {
                    name: "studio".into(),
                    up: true,
                    reason: None,
                    memory: None,
                    cpu: Some(Cpu {
                        percent: 0,
                        load1: 0.0,
                        cpus: 4,
                    }),
                    disk: None,
                },
            ]
        );
        assert_eq!(
            serde_json::to_value(&sessions).unwrap(),
            serde_json::json!([{
                "machine": "devbox",
                "tmux": "api",
                "label": "acme/api · devbox",
                "working": true,
            }])
        );
    }

    fn cpu_of(load1: f64, cpus: u32) -> Option<Cpu> {
        let mut health = health(400, 1000, 0);
        health.load1 = load1;
        health.cpus = cpus;
        let PanelView::Ready { machines, .. } = view(Some(&state(
            vec![machine("devbox", true, Some(health))],
            vec![],
        ))) else {
            panic!("expected a ready panel");
        };
        machines[0].cpu.clone()
    }

    #[test]
    fn the_panel_shows_cpu_as_load_per_core() {
        assert_eq!(
            cpu_of(1.2, 8),
            Some(Cpu {
                percent: 15,
                load1: 1.2,
                cpus: 8,
            })
        );
        assert_eq!(cpu_of(12.0, 8).map(|cpu| cpu.percent), Some(100));
        assert_eq!(cpu_of(1.2, 0), None);
    }

    #[test]
    fn the_panel_shows_disk_use() {
        let disk_of = |used_kb: u64, total_kb: u64| {
            let health = Health {
                disk_total_kb: total_kb,
                disk_used_kb: used_kb,
                ..health(400, 1000, 0)
            };
            let PanelView::Ready { machines, .. } = view(Some(&state(
                vec![machine("devbox", true, Some(health))],
                vec![],
            ))) else {
                panic!("expected a ready panel");
            };
            machines[0].disk.clone()
        };
        assert_eq!(
            disk_of(625, 1000),
            Some(Disk {
                percent: 63,
                used_kb: 625,
                total_kb: 1000,
            })
        );
        assert_eq!(disk_of(0, 0), None);
    }

    #[test]
    fn the_panel_offers_the_menu_switches() {
        let switches = Switches {
            agent_idle: false,
            session_ended: true,
            machine: true,
            memory: false,
            autostart: true,
        };
        let listed: Vec<(&str, &str, bool)> = switch_views(&switches)
            .iter()
            .map(|s| (s.id, s.label, s.on))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("notify-agent-idle", "Agent finished or waiting", false),
                ("notify-session-ended", "Session ended", true),
                ("notify-machine", "Machine down or back", true),
                ("notify-memory", "Memory almost full", false),
                ("autostart", "Start at login", true),
            ]
        );
        for view in switch_views(&switches) {
            assert!(
                tray::toggled(view.id, switches).is_some(),
                "{} is not a switch",
                view.id
            );
        }
    }

    #[test]
    fn the_panel_says_when_the_server_is_unreachable() {
        assert_eq!(view(None), PanelView::Unreachable);
    }

    #[test]
    fn the_panel_view_is_tagged_for_the_page() {
        let json = serde_json::to_value(view(Some(&state(vec![], vec![])))).unwrap();
        assert_eq!(json["state"], "ready");
        assert_eq!(
            serde_json::to_value(PanelView::Pending).unwrap()["state"],
            "pending"
        );
    }

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn the_panel_opens_centered_under_its_icon() {
        let screen = bounds(0.0, 0.0, 3000.0, 2000.0);
        let icon = bounds(1500.0, 0.0, 44.0, 48.0);
        assert_eq!(place(icon, 680.0, screen, 16.0, 8.0), (1182.0, 56.0));
    }

    #[test]
    fn the_panel_stays_on_screen_near_its_edges() {
        let screen = bounds(1000.0, 0.0, 2000.0, 1200.0);
        let right = bounds(2960.0, 0.0, 40.0, 48.0);
        assert_eq!(place(right, 680.0, screen, 16.0, 8.0), (2304.0, 56.0));
        let left = bounds(1000.0, 0.0, 40.0, 48.0);
        assert_eq!(place(left, 680.0, screen, 16.0, 8.0), (1016.0, 56.0));
        let narrow = bounds(0.0, 0.0, 600.0, 800.0);
        assert_eq!(place(left, 680.0, narrow, 16.0, 8.0), (16.0, 56.0));
    }

    #[test]
    fn a_click_that_just_closed_the_panel_does_not_reopen_it() {
        let now = Instant::now();
        assert!(reopens(None, now));
        assert!(!reopens(Some(now - Duration::from_millis(100)), now));
        assert!(reopens(Some(now - Duration::from_millis(400)), now));
    }
}

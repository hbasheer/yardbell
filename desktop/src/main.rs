mod capability;
mod client;
mod creds;
mod launch;
mod local;
mod main_window;
mod notify;
mod panel;
mod poller;
mod settings;
mod shortcuts;
mod tabs;
mod tray;
mod windows;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, EventTarget, Listener, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::AutoLaunchManager;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tokio::sync::{Notify, RwLock};
use yardbell::events::{Event, Tracker};
use yardbell::state::StateView;

use client::Client;
use creds::{Keychain, Store};
use launch::Startup;
use main_window::OpenTabs;
use notify::Target;
use poller::{Generation, Outcome, Poller};
use settings::Settings;
use shortcuts::Action;
use tabs::{Tab, TabView, Tabs, DASHBOARD};

const WINDOW_STATE: StateFlags = StateFlags::all().difference(StateFlags::VISIBLE);
const CONNECTING: &str = "connecting";
const UNREACHABLE: &str = "unreachable";

static QUITTING: AtomicBool = AtomicBool::new(false);

pub struct Session {
    client: RwLock<Option<Client>>,
    generation: Generation,
    poller: Mutex<Option<JoinHandle<()>>>,
    poll_now: Notify,
    store: Arc<dyn Store>,
    message: Mutex<Option<String>>,
    view: Mutex<Option<StateView>>,
}

#[tauri::command]
async fn connect(
    app: AppHandle,
    session: State<'_, Session>,
    server: String,
    passcode: String,
) -> Result<(), String> {
    let server = client::normalize_address(&server).map_err(|e| e.to_string())?;
    let cookie = Client::new(&server, None)
        .login(&passcode)
        .await
        .map_err(|e| e.to_string())?;
    session.store.save(&server, &cookie)?;
    begin_session(&app, Client::new(&server, Some(&cookie))).await;
    *session.message.lock().unwrap() = None;
    main_window::open(&app, &server).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window(windows::CONNECT) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn local_server_status() -> yardbell::local_server::Status {
    yardbell::local_server::status(&yardbell::cli::default_config_path())
}

#[tauri::command]
async fn set_up_local_server(
    app: AppHandle,
    session: State<'_, Session>,
    passcode: String,
) -> Result<(), String> {
    use yardbell::local_server::Status;
    let path = yardbell::cli::default_config_path();
    let port = match yardbell::local_server::status(&path) {
        Status::Ready { port } => port,
        Status::Broken { error } => return Err(error),
        Status::Missing | Status::NoPasscode { .. } => {
            let runner = yardbell::shell::RealRunner::default();
            let mesh = yardbell::mesh::detect(&runner).await;
            yardbell::local_server::set_up(&path, &passcode, mesh)?
        }
    };
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    local::enable(&dir).map_err(|e| format!("cannot save the setting: {e}"))?;
    local::start();
    local::wait_until_up(port).await?;
    connect(app, session, local::address(port), passcode).await
}

#[tauri::command]
fn connect_message(session: State<'_, Session>) -> Option<String> {
    session.message.lock().unwrap().clone()
}

#[tauri::command]
async fn connect_server(session: State<'_, Session>) -> Result<Option<String>, String> {
    let client = session.client.read().await;
    Ok(client.as_ref().map(|client| client.server().to_string()))
}

#[tauri::command]
async fn retry_connect(app: AppHandle) {
    open_dashboard(&app).await;
}

#[tauri::command]
fn select_tab(app: AppHandle, label: String) {
    main_window::select(&app, &label);
}

#[tauri::command]
fn close_tab(app: AppHandle, label: String) {
    main_window::close(&app, &label);
}

#[tauri::command]
fn tab_list(app: AppHandle) -> Vec<TabView> {
    main_window::views(&app)
}

#[tauri::command]
async fn change_server(app: AppHandle) -> Result<(), String> {
    windows::show_connect(&app, None).map_err(|e| e.to_string())?;
    windows::close_all_but_connect(&app);
    Ok(())
}

async fn open_dashboard(app: &AppHandle) {
    let session = app.state::<Session>();
    let current = {
        let slot = session.client.read().await;
        slot.clone()
            .map(|client| (client, session.generation.current()))
    };
    let Some((client, generation)) = current else {
        if let Err(e) = windows::show_connect(app, None) {
            eprintln!("yardbell: can't show the connect window: {e}");
        }
        windows::close_all_but_connect(app);
        return;
    };
    let server = client.server().to_string();
    tell_launch(app, CONNECTING, &server);
    let result = client.handoff().await;
    if !session.generation.is_current(generation) {
        return;
    }
    if let Err(e) = &result {
        eprintln!("yardbell: can't open the dashboard: {e}");
    }
    match launch::startup(&server, result) {
        Startup::Open { url } => match main_window::navigate_dashboard(app, &url) {
            Ok(true) => session.poll_now.notify_one(),
            Ok(false) => {}
            Err(e) => eprintln!("yardbell: can't open the dashboard: {e}"),
        },
        Startup::Retry { server } => tell_launch(app, UNREACHABLE, &server),
        Startup::Connect { message } => {
            sign_out_session(app, generation, message.as_deref()).await;
        }
    }
}

fn tell_launch(app: &AppHandle, event: &str, server: &str) {
    if let Err(e) = app.emit_to(EventTarget::webview(DASHBOARD), event, server) {
        eprintln!("yardbell: can't update the launch screen: {e}");
    }
}

async fn begin_session(app: &AppHandle, client: Client) {
    capability::grant_server_pages(app, client.server());
    let session = app.state::<Session>();
    *session.view.lock().unwrap() = None;
    let mut slot = session.client.write().await;
    let generation = session.generation.bump();
    *slot = Some(client.clone());
    tray::reset_tray(app, &app.state::<Settings>().switches());
    panel::reset(app);
    let poller = tauri::async_runtime::spawn(poll(app.clone(), client, generation));
    let previous = session.poller.lock().unwrap().replace(poller);
    if let Some(previous) = previous {
        previous.abort();
    }
}

async fn poll(app: AppHandle, client: Client, generation: u64) {
    let session = app.state::<Session>();
    let mut poller = Poller::default();
    let mut tracker = Tracker::new();
    let mut failing = false;
    loop {
        let result = client.state().await;
        if !session.generation.is_current(generation) {
            return;
        }
        match &result {
            Err(e) if !failing => eprintln!("yardbell: can't read the server state: {e}"),
            _ => {}
        }
        failing = result.is_err();
        match poller.on_result(&mut tracker, result, Instant::now()) {
            Outcome::View(view, events) => {
                deliver(&app, generation, client.server(), Some(*view), events)
            }
            Outcome::Unreachable => deliver(&app, generation, client.server(), None, Vec::new()),
            Outcome::SignedOut => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    sign_out_session(&app, generation, Some(launch::SIGNED_OUT)).await;
                });
                return;
            }
            Outcome::Waiting => {}
        }
        tokio::select! {
            _ = tokio::time::sleep(poller::INTERVAL) => {}
            _ = session.poll_now.notified() => {}
        }
    }
}

fn deliver(
    app: &AppHandle,
    generation: u64,
    server: &str,
    view: Option<StateView>,
    events: Vec<Event>,
) {
    let (handle, server) = (app.clone(), server.to_string());
    // Sign-out queues its tray reset on the main thread after moving to the next
    // generation, so checking here, not on the poll task, keeps a poll that raced
    // it from repainting the tray or notifying after the reset.
    let queued = app.run_on_main_thread(move || {
        if !handle.state::<Session>().generation.is_current(generation) {
            return;
        }
        let switches = handle.state::<Settings>().switches();
        tray::update_tray(&handle, view.as_ref(), &switches);
        panel::publish(&handle, view.as_ref());
        let Some(view) = view else {
            return;
        };
        for event in events
            .iter()
            .filter(|event| notify::allowed(event, &switches))
        {
            let (app, server) = (handle.clone(), server.clone());
            notify::show(notify::note_for(event, &view), move |target| {
                open_target(&app, generation, &server, target)
            });
        }
        *handle.state::<Session>().view.lock().unwrap() = Some(view);
        main_window::publish(&handle);
    });
    if let Err(e) = queued {
        eprintln!("yardbell: can't update the tray: {e}");
    }
}

fn open_target(app: &AppHandle, generation: u64, server: &str, target: Target) {
    let current = app.state::<Session>().generation.is_current(generation);
    let opened = match target {
        Target::Terminal { machine, tmux } if current => {
            main_window::open_session(app, server, &machine, &tmux)
        }
        _ => main_window::reveal(app),
    };
    if let Err(e) = opened {
        eprintln!("yardbell: can't open the window for a notification: {e}");
    }
}

fn toggle_switch(app: &AppHandle, id: &str) {
    let settings = app.state::<Settings>();
    let current = settings.switches();
    let Some(next) = tray::toggled(id, current) else {
        return;
    };
    if next.autostart != current.autostart {
        if let Err(e) = set_autostart(app, next.autostart) {
            eprintln!("yardbell: can't change Start at login: {e}");
            tray::show_switches(app, &current);
            panel::show_switches(app, &current);
            return;
        }
    }
    if let Err(e) = settings.set(next) {
        eprintln!("yardbell: can't save the settings: {e}");
    }
    tray::show_switches(app, &next);
    panel::show_switches(app, &next);
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let autostart = app
        .try_state::<AutoLaunchManager>()
        .ok_or("the autostart plugin isn't running")?;
    let changed = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
    changed.map_err(|e| e.to_string())
}

fn autostart_enabled(app: &AppHandle) -> Option<bool> {
    let autostart = app.try_state::<AutoLaunchManager>()?;
    match autostart.is_enabled() {
        Ok(enabled) => Some(enabled),
        Err(e) => {
            eprintln!("yardbell: can't read Start at login: {e}");
            None
        }
    }
}

fn quit(app: &AppHandle) {
    let Some(window) = app.get_window(windows::MAIN) else {
        exit(app);
        return;
    };
    // The window-state plugin records maximized and fullscreen only on CloseRequested,
    // and the close is queued on the event loop, so exit has to queue up behind it.
    QUITTING.store(true, Ordering::Relaxed);
    if let Err(e) = window.close() {
        eprintln!("yardbell: can't record the window state: {e}");
        exit(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let handle = app.clone();
        if let Err(e) = app.run_on_main_thread(move || exit(&handle)) {
            eprintln!("yardbell: can't quit on the main thread: {e}");
            exit(&app);
        }
    });
}

fn exit(app: &AppHandle) {
    if let Err(e) = app.save_window_state(WINDOW_STATE) {
        eprintln!("yardbell: can't save the window state: {e}");
    }
    app.exit(0);
}

fn keep_running(code: Option<i32>, has_session: bool) -> bool {
    code.is_none() && has_session
}

fn has_session(app: &AppHandle) -> bool {
    let session = app.state::<Session>();
    let live = match session.client.try_read() {
        Ok(client) => client.is_some(),
        Err(_) => true,
    };
    live || session.store.server().is_some()
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { code, api, .. } if keep_running(code, has_session(app)) => {
            api.prevent_exit();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Err(e) = main_window::reveal(app) {
                eprintln!("yardbell: can't show the window: {e}");
            }
        }
        _ => {}
    }
}

fn selected_session(app: &AppHandle) -> Option<String> {
    let state = app.state::<OpenTabs>();
    let tabs = state.0.lock().unwrap();
    match tabs.selected() {
        Tab::Dashboard => None,
        Tab::Session { label, .. } => Some(label.clone()),
    }
}

fn on_shortcut(app: &AppHandle, payload: String) {
    let handle = app.clone();
    let queued = app.run_on_main_thread(move || {
        let Some(window) = windows::focused(&handle) else {
            return;
        };
        match shortcuts::action(&payload, window.label()) {
            Some(Action::Close) => match selected_session(&handle) {
                Some(label) => main_window::close(&handle, &label),
                None => {
                    if let Err(e) = window.close() {
                        eprintln!("yardbell: can't close the {} window: {e}", window.label());
                    }
                }
            },
            Some(Action::Quit) => quit(&handle),
            Some(Action::Select(position)) => {
                main_window::update(&handle, |tabs| tabs.select_position(position))
            }
            Some(Action::Next) => main_window::update(&handle, Tabs::next),
            Some(Action::Prev) => main_window::update(&handle, Tabs::prev),
            None => {}
        }
    });
    if let Err(e) = queued {
        eprintln!("yardbell: can't handle a shortcut: {e}");
    }
}

// Signing out on purpose is a reset: a server this app runs stops and no longer starts with the
// app, so the connect screen offers both choices again. Its config and passcode stay.
async fn sign_out_by_user(app: &AppHandle) {
    local::stop();
    match app.path().app_config_dir() {
        Ok(dir) => {
            if let Err(e) = local::disable(&dir) {
                eprintln!("yardbell: can't turn off the server on this machine: {e}");
            }
        }
        Err(e) => eprintln!("yardbell: can't find the settings folder: {e}"),
    }
    sign_out(app, None).await;
}

#[tauri::command]
async fn sign_out_now(app: AppHandle) {
    sign_out_by_user(&app).await;
}

async fn sign_out(app: &AppHandle, message: Option<&str>) {
    end_session(app, None, message).await;
}

async fn sign_out_session(app: &AppHandle, generation: u64, message: Option<&str>) {
    end_session(app, Some(generation), message).await;
}

async fn end_session(app: &AppHandle, generation: Option<u64>, message: Option<&str>) {
    let session = app.state::<Session>();
    {
        let mut slot = session.client.write().await;
        let ended = match generation {
            Some(generation) => session.generation.bump_from(generation),
            None => {
                session.generation.bump();
                true
            }
        };
        if !ended {
            return;
        }
        *slot = None;
        if let Some(poller) = session.poller.lock().unwrap().take() {
            poller.abort();
        }
    }
    session.store.clear();
    tray::reset_tray(app, &app.state::<Settings>().switches());
    panel::reset(app);
    if let Err(e) = windows::show_connect(app, message) {
        eprintln!("yardbell: can't show the connect window: {e}");
    }
    windows::close_all_but_connect(app);
}

async fn start(app: AppHandle) {
    let runs_server = app
        .path()
        .app_config_dir()
        .is_ok_and(|dir| local::enabled(&dir));
    if let Some(port) = local::ready_port().filter(|_| runs_server) {
        local::start();
        if let Err(e) = local::wait_until_up(port).await {
            eprintln!("yardbell: {e}");
        }
    }
    let session = app.state::<Session>();
    let Some((server, cookie)) = session.store.load() else {
        if let Err(e) = windows::show_connect(&app, None) {
            eprintln!("yardbell: can't show the connect window: {e}");
        }
        return;
    };
    begin_session(&app, Client::new(&server, Some(&cookie))).await;
    if let Err(e) = main_window::open(&app, &server) {
        eprintln!("yardbell: can't open the main window: {e}");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(e) = main_window::reveal(app) {
                eprintln!("yardbell: can't show the window: {e}");
            }
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE)
                .with_filter(|label| label == windows::MAIN)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            connect,
            local_server_status,
            set_up_local_server,
            connect_message,
            connect_server,
            retry_connect,
            change_server,
            sign_out_now,
            select_tab,
            close_tab,
            tab_list,
            panel::panel_state,
            panel::panel_resize,
            panel::panel_close,
            panel::panel_open_session,
            panel::panel_open_machine,
            panel::panel_open_app,
            panel::panel_new_session,
            panel::panel_switches,
            panel::panel_toggle,
            panel::panel_quit,
            panel::panel_disconnect
        ])
        .on_window_event(|window, event| {
            if window.label() == panel::PANEL {
                if let WindowEvent::Focused(false) = event {
                    panel::closed_by_blur(window.app_handle());
                }
                return;
            }
            if window.label() != windows::MAIN {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    // Listener order is a HashMap's, so a quitting window stays visible
                    // while the window-state plugin reads maximized and fullscreen.
                    if !QUITTING.load(Ordering::Relaxed) {
                        let _ = window.hide();
                    }
                }
                WindowEvent::Resized(_) => {
                    if let Err(e) = main_window::fit(window.app_handle()) {
                        eprintln!("yardbell: can't lay out the window: {e}");
                    }
                }
                WindowEvent::Destroyed => {
                    window.state::<OpenTabs>().0.lock().unwrap().reset();
                }
                _ => {}
            }
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let mut switches = settings::load_switches(&config_dir);
            if let Some(enabled) = autostart_enabled(app.handle()) {
                switches.autostart = enabled;
            }
            app.manage(Settings::new(config_dir.clone(), switches));
            app.manage(Session {
                client: RwLock::new(None),
                generation: Generation::default(),
                poller: Mutex::new(None),
                poll_now: Notify::new(),
                store: Arc::new(Keychain::new(config_dir)),
                message: Mutex::new(None),
                view: Mutex::new(None),
            });
            app.manage(OpenTabs(Mutex::new(Tabs::new())));
            app.manage(capability::Granted::default());
            let handle = app.handle().clone();
            app.listen_any(shortcuts::EVENT, move |event| {
                on_shortcut(&handle, event.payload().to_string())
            });
            #[cfg(target_os = "macos")]
            notify::send_as(&app.config().identifier);
            panel::init(app.handle());
            if let Err(e) = tray::init(app.handle(), &switches) {
                eprintln!("yardbell: can't create the tray icon: {e}");
            }
            tauri::async_runtime::spawn(start(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Yardbell desktop")
        .run(on_run_event);
}

#[cfg(test)]
mod tests {
    use super::keep_running;

    #[test]
    fn closing_the_last_window_keeps_a_signed_in_app_in_the_tray() {
        assert!(keep_running(None, true));
        assert!(!keep_running(None, false));
    }

    #[test]
    fn quit_from_the_tray_or_the_keyboard_always_exits() {
        assert!(!keep_running(Some(0), true));
        assert!(!keep_running(Some(0), false));
        assert!(!keep_running(Some(1), true));
    }
}

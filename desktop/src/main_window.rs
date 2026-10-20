use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri::webview::{PageLoadEvent, Webview, WebviewBuilder};
use tauri::window::{Window, WindowBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, Theme,
    WebviewUrl, Wry,
};

use crate::tabs::{Change, TabView, Tabs, DASHBOARD};
use crate::windows::{self, Backdrop, CONNECT, MAIN};
use crate::Session;

pub const BAR: &str = "tabs";
pub const BAR_HEIGHT: f64 = 36.0;
const BAR_PAGE: &str = "tabs.html";
const LAUNCH_PAGE: &str = "launch.html";
const TABS_EVENT: &str = "tabs";

pub struct OpenTabs(pub Mutex<Tabs>);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Area {
    fn position(self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x, self.y)
    }

    fn size(self) -> LogicalSize<f64> {
        LogicalSize::new(self.width, self.height)
    }

    fn rect(self) -> Rect {
        Rect {
            position: self.position().into(),
            size: self.size().into(),
        }
    }
}

pub fn areas(width: f64, height: f64) -> (Area, Area) {
    let bar = Area {
        x: 0.0,
        y: 0.0,
        width,
        height: BAR_HEIGHT,
    };
    let content = Area {
        x: 0.0,
        y: BAR_HEIGHT,
        width,
        height: (height - BAR_HEIGHT).max(0.0),
    };
    (bar, content)
}

pub fn open(app: &AppHandle, server: &str) -> tauri::Result<()> {
    if let Some(window) = app.get_window(MAIN) {
        window.show()?;
        return window.set_focus();
    }
    build(app, server).map(drop)
}

fn build(app: &AppHandle, server: &str) -> tauri::Result<Window> {
    let builder = WindowBuilder::new(app, MAIN)
        .title("Yardbell")
        .inner_size(1280.0, 820.0)
        .visible(false);
    // Tauri's default macOS style extends the content view under the title bar, and child
    // webviews are placed from the top of that view, so the tab bar would sit behind it.
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Transparent);
    let window = builder.build()?;
    if let Err(e) = add_bar_and_dashboard(app, &window, server) {
        let _ = window.destroy();
        return Err(e);
    }
    publish(app);
    Ok(window)
}

fn add_bar_and_dashboard(app: &AppHandle, window: &Window, server: &str) -> tauri::Result<()> {
    let theme = theme(window);
    if let Some(color) = Backdrop::Paper.color(theme) {
        if let Err(e) = window.set_background_color(Some(color)) {
            eprintln!("yardbell: can't set the main window background: {e}");
        }
    }
    let (bar, content) = window_areas(window)?;
    let tab_bar = WebviewBuilder::new(BAR, WebviewUrl::App(BAR_PAGE.into()));
    let tab_bar = window.add_child(
        painted(tab_bar, Backdrop::Rail, theme),
        bar.position(),
        bar.size(),
    )?;
    pin_bar_height(&tab_bar)?;
    let shown = Arc::new(AtomicBool::new(false));
    let on_load = shown.clone();
    let dashboard = windows::routed(
        app,
        DASHBOARD,
        WebviewUrl::App(LAUNCH_PAGE.into()),
        server,
        None,
    )
    .on_page_load(move |webview, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            windows::show_once(&webview.window(), &on_load);
        }
    });
    window.add_child(
        painted(dashboard, Backdrop::Paper, theme),
        content.position(),
        content.size(),
    )?;
    // WKWebView reports no finished load for a page that fails, and a stalled
    // subresource holds it back, so the window must not wait on it forever.
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(windows::SHOW_AT_THE_LATEST).await;
        windows::show_once(&window, &shown);
    });
    Ok(())
}

pub fn open_session(app: &AppHandle, server: &str, machine: &str, tmux: &str) -> tauri::Result<()> {
    let window = match app.get_window(MAIN) {
        Some(window) => window,
        None => build(app, server)?,
    };
    let (previous, change) = {
        let state = app.state::<OpenTabs>();
        let mut tabs = state.0.lock().unwrap();
        let previous = tabs.selected().label().to_string();
        (previous, tabs.open(machine, tmux))
    };
    if let Change::Opened(label) = change {
        if let Err(e) = add_session(app, &window, server, &label, machine, tmux) {
            update(app, |tabs| {
                let closed = tabs.close(&label);
                tabs.select_label(&previous);
                closed
            });
            return Err(e);
        }
    }
    show(&window)?;
    refresh(app);
    Ok(())
}

fn add_session(
    app: &AppHandle,
    window: &Window,
    server: &str,
    label: &str,
    machine: &str,
    tmux: &str,
) -> tauri::Result<()> {
    let url = windows::parse(&windows::terminal_url(server, machine, tmux))?;
    let (_, content) = window_areas(window)?;
    let session = Some((machine.to_string(), tmux.to_string()));
    let terminal = windows::routed(app, label, WebviewUrl::External(url), server, session);
    window.add_child(
        painted(terminal, Backdrop::Terminal, theme(window)),
        content.position(),
        content.size(),
    )?;
    Ok(())
}

pub fn navigate_dashboard(app: &AppHandle, url: &str) -> tauri::Result<bool> {
    let Some(dashboard) = app.get_webview(DASHBOARD) else {
        return Ok(false);
    };
    dashboard.navigate(windows::parse(url)?)?;
    select(app, DASHBOARD);
    Ok(true)
}

pub fn select(app: &AppHandle, label: &str) {
    update(app, |tabs| match tabs.select_label(label) {
        Change::Nothing if tabs.selected().label() == label => Change::Selected,
        change => change,
    });
}

pub fn close(app: &AppHandle, label: &str) {
    update(app, |tabs| tabs.close(label));
}

pub fn update(app: &AppHandle, change: impl FnOnce(&mut Tabs) -> Change) {
    {
        let state = app.state::<OpenTabs>();
        let mut tabs = state.0.lock().unwrap();
        match change(&mut tabs) {
            Change::Nothing => return,
            Change::Closed(label) => close_webview(app, &label),
            Change::Selected | Change::Opened(_) => {}
        }
        show_selected(app, &tabs);
    }
    publish(app);
}

fn refresh(app: &AppHandle) {
    {
        let state = app.state::<OpenTabs>();
        let tabs = state.0.lock().unwrap();
        show_selected(app, &tabs);
    }
    publish(app);
}

fn close_webview(app: &AppHandle, label: &str) {
    let Some(webview) = app.get_webview(label) else {
        return;
    };
    if let Err(e) = webview.close() {
        eprintln!("yardbell: can't close the {label} tab: {e}");
    }
}

fn show_selected(app: &AppHandle, tabs: &Tabs) {
    let selected = tabs.selected().label();
    if let Some(webview) = app.get_webview(selected) {
        if let Err(e) = webview.show().and_then(|()| webview.set_focus()) {
            eprintln!("yardbell: can't show the {selected} tab: {e}");
        }
    }
    for tab in tabs.tabs().iter().filter(|tab| tab.label() != selected) {
        let Some(webview) = app.get_webview(tab.label()) else {
            continue;
        };
        if let Err(e) = webview.hide() {
            eprintln!("yardbell: can't hide the {} tab: {e}", tab.label());
        }
    }
}

pub fn reveal(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_window(MAIN).or_else(|| app.get_window(CONNECT)) else {
        return match windows::live_server(app) {
            Some(server) => open(app, &server),
            None => windows::show_connect(app, None),
        };
    };
    show(&window)
}

fn show(window: &Window) -> tauri::Result<()> {
    window.show()?;
    window.unminimize()?;
    window.set_focus()
}

pub fn fit(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_window(MAIN) else {
        return Ok(());
    };
    let (bar, content) = window_areas(&window)?;
    for webview in window.webviews() {
        let area = if webview.label() == BAR { bar } else { content };
        webview.set_bounds(area.rect())?;
    }
    Ok(())
}

pub fn views(app: &AppHandle) -> Vec<TabView> {
    let state = app.state::<OpenTabs>();
    let tabs = state.0.lock().unwrap();
    let session = app.state::<Session>();
    let view = session.view.lock().unwrap();
    tabs.views(view.as_ref())
}

pub fn publish(app: &AppHandle) {
    if let Err(e) = app.emit_to(EventTarget::webview(BAR), TABS_EVENT, views(app)) {
        eprintln!("yardbell: can't update the tab bar: {e}");
    }
}

fn window_areas(window: &Window) -> tauri::Result<(Area, Area)> {
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    Ok(areas(size.width, size.height))
}

// wry packs every child webview into the window's GtkBox with expand and fill, and set_bounds does nothing there.
#[cfg(target_os = "linux")]
fn pin_bar_height(bar: &Webview) -> tauri::Result<()> {
    use gtk::prelude::*;

    let (done, packed) = std::sync::mpsc::channel();
    bar.with_webview(move |webview| {
        let widget: gtk::Widget = webview.inner().upcast();
        widget.set_size_request(-1, BAR_HEIGHT as i32);
        if let Some(parent) = widget.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) {
            parent.set_child_packing(&widget, false, false, 0, gtk::PackType::Start);
        }
        let _ = done.send(());
    })?;
    let _ = packed.recv();
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn pin_bar_height(_bar: &Webview) -> tauri::Result<()> {
    Ok(())
}

fn theme(window: &Window) -> Theme {
    window.theme().unwrap_or(Theme::Light)
}

fn painted(builder: WebviewBuilder<Wry>, backdrop: Backdrop, theme: Theme) -> WebviewBuilder<Wry> {
    match backdrop.color(theme) {
        Some(color) => builder.background_color(color),
        None => builder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn areas_fill_the_window() {
        assert_eq!(
            areas(1280.0, 820.0),
            (
                Area {
                    x: 0.0,
                    y: 0.0,
                    width: 1280.0,
                    height: 36.0
                },
                Area {
                    x: 0.0,
                    y: 36.0,
                    width: 1280.0,
                    height: 784.0
                }
            )
        );
        assert_eq!(
            areas(300.0, 20.0),
            (
                Area {
                    x: 0.0,
                    y: 0.0,
                    width: 300.0,
                    height: 36.0
                },
                Area {
                    x: 0.0,
                    y: 36.0,
                    width: 300.0,
                    height: 0.0
                }
            )
        );
    }
}

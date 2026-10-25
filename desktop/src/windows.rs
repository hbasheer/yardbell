use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::{Color, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::window::Window;
use tauri::{AppHandle, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::main_window;
use crate::tabs::DASHBOARD;
use crate::Session;

#[derive(Debug, PartialEq)]
pub enum Link {
    Terminal { machine: String, tmux: String },
    Page,
    Bundled,
    External,
    Other,
}

#[derive(Debug, PartialEq)]
pub enum Action {
    Allow,
    Deny,
    Terminal { machine: String, tmux: String },
    Main,
    Browser,
}

#[derive(Clone, Copy)]
pub enum Backdrop {
    Paper,
    Rail,
    Terminal,
}

impl Backdrop {
    // A light theme is also what tao reports when it cannot tell, and a light
    // backdrop behind a dark page would flash, so only a known dark theme paints.
    pub fn color(self, theme: Theme) -> Option<Color> {
        match (self, theme) {
            (Backdrop::Terminal, _) => Some(Color(0x0a, 0x0a, 0x0b, 0xff)),
            (Backdrop::Paper, Theme::Dark) => Some(Color(0x11, 0x13, 0x15, 0xff)),
            (Backdrop::Rail, Theme::Dark) => Some(Color(0x0c, 0x0e, 0x10, 0xff)),
            _ => None,
        }
    }
}

pub const MAIN: &str = "main";
pub const CONNECT: &str = "connect";
pub const TERMINAL: &str = "term-";
pub const SHOW_AT_THE_LATEST: Duration = Duration::from_secs(2);

pub fn live_server(app: &AppHandle) -> Option<String> {
    let session = app.state::<Session>();
    let client = session.client.try_read().ok()?;
    client.as_ref().map(|client| client.server().to_string())
}

pub fn focused(app: &AppHandle) -> Option<Window> {
    app.get_focused_window()
}

pub fn show_connect(app: &AppHandle, message: Option<&str>) -> tauri::Result<()> {
    *app.state::<Session>().message.lock().unwrap() = message.map(str::to_string);
    if let Some(window) = app.get_webview_window(CONNECT) {
        window.eval("location.reload()")?;
        window.show()?;
        return window.set_focus();
    }
    build_hidden(
        WebviewWindowBuilder::new(app, CONNECT, WebviewUrl::App("connect.html".into()))
            .title("Yardbell")
            .inner_size(480.0, 560.0),
        Backdrop::Rail,
    )
}

pub fn close_all_but_connect(app: &AppHandle) {
    for (label, window) in app.windows() {
        if label != CONNECT {
            let _ = window.destroy();
        }
    }
}

fn build_hidden(
    builder: WebviewWindowBuilder<'_, Wry, AppHandle>,
    backdrop: Backdrop,
) -> tauri::Result<()> {
    let shown = Arc::new(AtomicBool::new(false));
    let on_load = shown.clone();
    let window = builder
        .visible(false)
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                show_once(&window.as_ref().window(), &on_load);
            }
        })
        .build()?;
    if let Err(e) = paint(&window, backdrop) {
        eprintln!(
            "yardbell: can't set the {} window background: {e}",
            window.label()
        );
    }
    // WKWebView reports no finished load for a page that fails, and a stalled
    // subresource holds it back, so the window must not wait on it forever.
    let window = window.as_ref().window();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_AT_THE_LATEST).await;
        show_once(&window, &shown);
    });
    Ok(())
}

fn paint(window: &WebviewWindow, backdrop: Backdrop) -> tauri::Result<()> {
    match backdrop.color(window.theme()?) {
        Some(color) => window.set_background_color(Some(color)),
        None => Ok(()),
    }
}

pub fn show_once(window: &Window, shown: &AtomicBool) {
    if shown.swap(true, Ordering::Relaxed) {
        return;
    }
    if let Err(e) = window.show() {
        eprintln!("yardbell: can't show the {} window: {e}", window.label());
    }
}

pub fn parse(url: &str) -> tauri::Result<Url> {
    Url::parse(url).map_err(tauri::Error::InvalidUrl)
}

pub fn routed(
    app: &AppHandle,
    label: &str,
    url: WebviewUrl,
    server: &str,
    session: Option<(String, String)>,
) -> WebviewBuilder<Wry> {
    let (nav_app, nav_server, nav_label) = (app.clone(), server.to_string(), label.to_string());
    let (new_app, new_server) = (app.clone(), server.to_string());
    WebviewBuilder::new(label, url)
        .on_navigation(move |url| {
            let session = session
                .as_ref()
                .map(|(machine, tmux)| (machine.as_str(), tmux.as_str()));
            match on_navigation(&nav_server, url, &nav_label, session) {
                Action::Allow => true,
                action => {
                    perform(&nav_app, &nav_server, action, url);
                    false
                }
            }
        })
        .on_new_window(move |url, _| {
            perform(
                &new_app,
                &new_server,
                on_new_window(&new_server, &url),
                &url,
            );
            NewWindowResponse::Deny
        })
}

fn perform(app: &AppHandle, server: &str, action: Action, url: &Url) {
    let (app, server, url) = (app.clone(), server.to_string(), url.clone());
    tauri::async_runtime::spawn(async move {
        let result = match action {
            Action::Allow | Action::Deny => Ok(()),
            Action::Terminal { machine, tmux } => {
                main_window::open_session(&app, &server, &machine, &tmux).map_err(|e| e.to_string())
            }
            Action::Main => main_window::navigate_dashboard(&app, url.as_str())
                .map(|_| ())
                .map_err(|e| e.to_string()),
            Action::Browser => app
                .opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|e| e.to_string()),
        };
        if let Err(e) = result {
            eprintln!("yardbell: can't open {url}: {e}");
        }
    });
}

pub fn classify(server: &str, url: &Url) -> Link {
    match url.scheme() {
        "http" | "https" => {}
        "mailto" => return Link::External,
        "tauri" if url.host_str() == Some("localhost") => return Link::Bundled,
        _ => return Link::Other,
    }
    let same_origin = Url::parse(server).is_ok_and(|server| server.origin() == url.origin());
    if !same_origin {
        return Link::External;
    }
    terminal_link(url).unwrap_or(Link::Page)
}

fn terminal_link(url: &Url) -> Option<Link> {
    let mut segments = url.path_segments()?;
    if segments.next()? != "term" {
        return None;
    }
    let machine = decode(segments.next()?)?;
    let tmux = decode(segments.next()?)?;
    if segments.next().is_some() || machine.is_empty() || tmux.is_empty() {
        return None;
    }
    Some(Link::Terminal { machine, tmux })
}

fn decode(segment: &str) -> Option<String> {
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .ok()
        .map(|s| s.into_owned())
}

pub fn terminal_label(machine: &str, tmux: &str) -> String {
    format!("{TERMINAL}{}-{}", sanitize(machine), sanitize(tmux))
}

fn sanitize(part: &str) -> String {
    part.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn handoff_url(server: &str, code: &str) -> String {
    format!("{server}/app/handoff/{code}")
}

pub fn terminal_url(server: &str, machine: &str, tmux: &str) -> String {
    let mut url = Url::parse(server).expect("normalized server address");
    url.path_segments_mut()
        .expect("http server address")
        .clear()
        .push("term")
        .push(machine)
        .push(tmux);
    url.to_string()
}

pub fn on_navigation(
    server: &str,
    url: &Url,
    label: &str,
    session: Option<(&str, &str)>,
) -> Action {
    match classify(server, url) {
        Link::Terminal { machine, tmux } if session == Some((machine.as_str(), tmux.as_str())) => {
            Action::Allow
        }
        // WebKit asks about iframe loads too, and the Workspace page shows terminals in iframes.
        Link::Terminal { .. } if label == DASHBOARD && embedded(url) => Action::Allow,
        Link::Terminal { machine, tmux } => Action::Terminal { machine, tmux },
        Link::Page | Link::Bundled if label == DASHBOARD => Action::Allow,
        Link::Page => Action::Main,
        Link::External => Action::Browser,
        Link::Other if url.scheme() == "about" => Action::Allow,
        Link::Bundled | Link::Other => Action::Deny,
    }
}

fn embedded(url: &Url) -> bool {
    url.query_pairs().any(|(key, _)| key == "embed")
}

pub fn on_new_window(server: &str, url: &Url) -> Action {
    match classify(server, url) {
        Link::Terminal { machine, tmux } => Action::Terminal { machine, tmux },
        Link::Page => Action::Main,
        Link::External => Action::Browser,
        Link::Bundled | Link::Other => Action::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "http://100.101.7.20:4100";

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn terminal(machine: &str, tmux: &str) -> Link {
        Link::Terminal {
            machine: machine.into(),
            tmux: tmux.into(),
        }
    }

    #[test]
    fn classifies_terminal_links_on_the_server() {
        assert_eq!(
            classify(SERVER, &url("http://100.101.7.20:4100/term/mini/api-1")),
            terminal("mini", "api-1")
        );
        assert_eq!(
            classify(
                SERVER,
                &url("http://100.101.7.20:4100/term/my%20box/a%2Fb%3Ac?x=1")
            ),
            terminal("my box", "a/b:c")
        );
    }

    #[test]
    fn malformed_terminal_paths_are_pages() {
        for path in [
            "/term",
            "/term/",
            "/term/mini",
            "/term/mini/",
            "/term/a/b/ws",
        ] {
            assert_eq!(
                classify(SERVER, &url(&format!("{SERVER}{path}"))),
                Link::Page,
                "{path}"
            );
        }
    }

    #[test]
    fn classifies_same_origin_pages() {
        for path in ["/", "/settings", "/app/handoff/abc", "/termx/a/b"] {
            assert_eq!(
                classify(SERVER, &url(&format!("{SERVER}{path}"))),
                Link::Page,
                "{path}"
            );
        }
    }

    #[test]
    fn other_origins_are_external() {
        for link in [
            "http://100.101.7.20:5173/",
            "https://100.101.7.20:4100/term/a/b",
            "http://localhost:4100/term/a/b",
            "https://github.com/hbasheer/yardbell#making-every-session-openable",
            "mailto:me@example.com",
        ] {
            assert_eq!(classify(SERVER, &url(link)), Link::External, "{link}");
        }
    }

    #[test]
    fn default_ports_match_the_server_origin() {
        assert_eq!(
            classify(
                "https://box.ts.net",
                &url("https://box.ts.net:443/term/a/b")
            ),
            terminal("a", "b")
        );
    }

    #[test]
    fn non_web_schemes_are_other() {
        for link in [
            "about:blank",
            "data:text/html,hi",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert_eq!(classify(SERVER, &url(link)), Link::Other, "{link}");
        }
    }

    #[test]
    fn bundled_pages_are_classified() {
        assert_eq!(
            classify(SERVER, &url("tauri://localhost/launch.html")),
            Link::Bundled
        );
        assert_eq!(
            classify(SERVER, &url("tauri://elsewhere/launch.html")),
            Link::Other
        );
    }

    #[test]
    fn backdrops_match_the_page_until_it_paints() {
        let near_black = Some(Color(0x0a, 0x0a, 0x0b, 0xff));
        assert_eq!(
            Backdrop::Paper.color(Theme::Dark),
            Some(Color(0x11, 0x13, 0x15, 0xff))
        );
        assert_eq!(
            Backdrop::Rail.color(Theme::Dark),
            Some(Color(0x0c, 0x0e, 0x10, 0xff))
        );
        assert_eq!(Backdrop::Terminal.color(Theme::Dark), near_black);
        assert_eq!(Backdrop::Terminal.color(Theme::Light), near_black);
        assert_eq!(Backdrop::Paper.color(Theme::Light), None);
        assert_eq!(Backdrop::Rail.color(Theme::Light), None);
    }

    #[test]
    fn terminal_labels_are_sanitized() {
        assert_eq!(terminal_label("mini", "api-1"), "term-mini-api-1");
        assert_eq!(terminal_label("my box", "a/b:c.d"), "term-my_box-a_b_c_d");
        assert_eq!(terminal_label("hp_2", "x"), "term-hp_2-x");
    }

    #[test]
    fn builds_urls() {
        assert_eq!(
            handoff_url(SERVER, "c0de"),
            format!("{SERVER}/app/handoff/c0de")
        );
        assert_eq!(
            terminal_url(SERVER, "my box", "a/b"),
            format!("{SERVER}/term/my%20box/a%2Fb")
        );
    }

    #[test]
    fn terminal_url_round_trips_through_classify() {
        let link = terminal_url(SERVER, "m?#%", "t 1/2");
        assert_eq!(classify(SERVER, &url(&link)), terminal("m?#%", "t 1/2"));
    }

    #[test]
    fn dashboard_navigation() {
        let at = |path: &str| url(&format!("{SERVER}{path}"));
        let dashboard = |link: &Url| on_navigation(SERVER, link, DASHBOARD, None);
        assert_eq!(dashboard(&at("/app/handoff/x")), Action::Allow);
        assert_eq!(dashboard(&at("/")), Action::Allow);
        assert_eq!(dashboard(&url("about:blank")), Action::Allow);
        assert_eq!(
            dashboard(&url("tauri://localhost/launch.html")),
            Action::Allow
        );
        assert_eq!(
            dashboard(&at("/term/mini/s1")),
            Action::Terminal {
                machine: "mini".into(),
                tmux: "s1".into()
            }
        );
        assert_eq!(
            dashboard(&url("http://100.101.7.20:3000/")),
            Action::Browser
        );
        assert_eq!(dashboard(&url("file:///etc/passwd")), Action::Deny);
    }

    #[test]
    fn workspace_terminals_load_inside_the_dashboard() {
        let embedded = url(&format!("{SERVER}/term/mini/s1?embed=1"));
        assert_eq!(
            on_navigation(SERVER, &embedded, DASHBOARD, None),
            Action::Allow
        );
        assert_eq!(
            on_navigation(
                SERVER,
                &embedded,
                &terminal_label("mini", "s2"),
                Some(("mini", "s2"))
            ),
            Action::Terminal {
                machine: "mini".into(),
                tmux: "s1".into()
            }
        );
    }

    #[test]
    fn session_tab_navigation() {
        let label = terminal_label("mini", "s1");
        let session = Some(("mini", "s1"));
        let at = |path: &str| url(&format!("{SERVER}{path}"));
        assert_eq!(
            on_navigation(SERVER, &at("/term/mini/s1"), &label, session),
            Action::Allow
        );
        assert_eq!(
            on_navigation(SERVER, &at("/term/mini/s2"), &label, session),
            Action::Terminal {
                machine: "mini".into(),
                tmux: "s2".into()
            }
        );
        assert_eq!(
            on_navigation(SERVER, &at("/"), &label, session),
            Action::Main
        );
        assert_eq!(
            on_navigation(SERVER, &url("https://example.com/"), &label, session),
            Action::Browser
        );
        assert_eq!(
            on_navigation(
                SERVER,
                &url("tauri://localhost/launch.html"),
                &label,
                session
            ),
            Action::Deny
        );
    }

    #[test]
    fn a_session_tab_loads_its_own_terminal() {
        let session = Some(("mini", "a b"));
        let own = url(&format!("{SERVER}/term/mini/a%20b"));
        let other = url(&format!("{SERVER}/term/mini/other"));
        for label in ["term-mini-a_b", "term-mini-a_b-2", "term-mini-a_b-3"] {
            assert_eq!(
                on_navigation(SERVER, &own, label, session),
                Action::Allow,
                "{label}"
            );
            assert_eq!(
                on_navigation(SERVER, &other, label, session),
                Action::Terminal {
                    machine: "mini".into(),
                    tmux: "other".into()
                },
                "{label}"
            );
        }
        assert_eq!(
            on_navigation(SERVER, &own, "term-mini-a_b", Some(("hp", "a b"))),
            Action::Terminal {
                machine: "mini".into(),
                tmux: "a b".into()
            }
        );
    }

    #[test]
    fn new_window_requests() {
        let at = |path: &str| url(&format!("{SERVER}{path}"));
        assert_eq!(
            on_new_window(SERVER, &at("/term/hp/api")),
            Action::Terminal {
                machine: "hp".into(),
                tmux: "api".into()
            }
        );
        assert_eq!(
            on_new_window(SERVER, &url("http://100.101.7.20:5173/")),
            Action::Browser
        );
        assert_eq!(on_new_window(SERVER, &at("/settings")), Action::Main);
        assert_eq!(on_new_window(SERVER, &url("about:blank")), Action::Deny);
        assert_eq!(
            on_new_window(SERVER, &url("tauri://localhost/connect.html")),
            Action::Deny
        );
    }

    #[test]
    fn the_mac_web_view_may_open_http_servers() {
        let plist: String = include_str!("../Info.plist").split_whitespace().collect();
        assert!(plist.contains("<key>NSAllowsArbitraryLoadsInWebContent</key><true/>"));
    }
}

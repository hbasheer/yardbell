mod client;
mod forward;
mod store;

use client::{Client, ClientError};
use store::{Server, Store};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager};

struct ActiveForward(std::sync::Mutex<Option<forward::Forward>>);

fn store(app: &AppHandle) -> Result<Store, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(Store::new(&dir))
}

// The page loads from a local port relaying to the server, so the WebView sees
// a secure context and lets the Dispatch microphone work.
async fn page_url(app: &AppHandle, server: &str, url: String) -> String {
    let forwards = &app.state::<ActiveForward>().0;
    let Some(target) = forward::page_target(server) else {
        forwards.lock().unwrap().take();
        return url;
    };
    let pages = {
        let held = forwards.lock().unwrap();
        held.as_ref()
            .filter(|f| f.serves(&target))
            .map(|f| f.url().to_string())
    };
    let pages = match pages {
        Some(pages) => pages,
        None => match forward::start(target).await {
            Ok(started) => {
                let pages = started.url().to_string();
                forwards.lock().unwrap().replace(started);
                pages
            }
            Err(e) => {
                eprintln!("yardbell: can't give the server a local page address: {e}");
                return url;
            }
        },
    };
    match url.strip_prefix(server) {
        Some(path) => format!("{pages}{path}"),
        None => url,
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

async fn sign_in(app: &AppHandle, server: String, cookie: String) -> Result<String, String> {
    let url = Client::new(&server, Some(&cookie))
        .handoff()
        .await
        .map_err(|e| e.to_string())?;
    let store = store(app)?;
    store.remember(std::slice::from_ref(&server))?;
    store.put(Server {
        server: server.clone(),
        cookie: Some(cookie),
        last_used: now(),
    })?;
    Ok(page_url(app, &server, url).await)
}

#[derive(serde::Serialize)]
struct Listed {
    server: String,
    signed_in: bool,
}

#[tauri::command]
fn servers(app: AppHandle) -> Result<Vec<Listed>, String> {
    Ok(store(&app)?
        .all()
        .into_iter()
        .map(|s| Listed {
            signed_in: s.cookie.is_some(),
            server: s.server,
        })
        .collect())
}

#[tauri::command]
async fn pair(app: AppHandle, link: String) -> Result<String, String> {
    let pairing = client::parse_pairing(&link)?;
    let cookie = Client::new(&pairing.server, None)
        .pair(&pairing.code)
        .await
        .map_err(|e| e.to_string())?;
    sign_in(&app, pairing.server, cookie).await
}

#[tauri::command]
async fn connect(app: AppHandle, server: String, passcode: String) -> Result<String, String> {
    let server = client::normalize_address(&server)?;
    let cookie = Client::new(&server, None)
        .login(&passcode)
        .await
        .map_err(|e| e.to_string())?;
    sign_in(&app, server, cookie).await
}

#[tauri::command]
async fn open(app: AppHandle, server: String) -> Result<String, String> {
    let store = store(&app)?;
    let saved = store
        .get(&server)
        .ok_or("that server is not saved on this phone")?;
    let Some(cookie) = saved.cookie else {
        return Err(ClientError::SignedOut.to_string());
    };
    match Client::new(&server, Some(&cookie)).handoff().await {
        Ok(url) => {
            store.put(Server {
                server: server.clone(),
                cookie: Some(cookie),
                last_used: now(),
            })?;
            Ok(page_url(&app, &server, url).await)
        }
        Err(ClientError::SignedOut) => {
            store.put(Server {
                server,
                cookie: None,
                last_used: saved.last_used,
            })?;
            Err(ClientError::SignedOut.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Found {
    machine: String,
    address: String,
}

// A phone cannot list the mesh, so it asks the servers it knows which other servers they found.
#[tauri::command]
async fn discover(app: AppHandle) -> Result<Vec<Found>, String> {
    let store = store(&app)?;
    let saved = store.all();
    let mut ask: Vec<String> = saved.iter().map(|s| s.server.clone()).collect();
    for server in store.seen() {
        if !ask.contains(&server) {
            ask.push(server);
        }
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut found: Vec<Found> = Vec::new();
    for server in &ask {
        let url = format!("{}/app/servers", server.trim_end_matches('/'));
        let Ok(res) = http.get(url).send().await else {
            continue;
        };
        for f in res.json::<Vec<Found>>().await.unwrap_or_default() {
            if !found.iter().any(|known| known.address == f.address) {
                found.push(f);
            }
        }
    }
    let heard: Vec<String> = found
        .iter()
        .map(|f| format!("http://{}", f.address))
        .collect();
    store.remember(&heard)?;
    let signed_in = |f: &Found| {
        saved
            .iter()
            .any(|s| s.cookie.is_some() && s.server.trim_end_matches('/').ends_with(&f.address))
    };
    found.retain(|f| !signed_in(f));
    Ok(found)
}

#[tauri::command]
fn forget(app: AppHandle, server: String) -> Result<(), String> {
    store(&app)?.forget(&server)
}

fn permission(label: &str, kind: PermissionKind) -> PermissionResponse {
    if kind == PermissionKind::Microphone && label == "main" {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Default
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .manage(ActiveForward(std::sync::Mutex::new(None)))
        .on_permission_request(|webview, kind| permission(webview.label(), kind))
        .invoke_handler(tauri::generate_handler![
            servers, pair, connect, open, forget, discover
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .initialization_script(include_str!("single_view.js"))
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Yardbell");
}

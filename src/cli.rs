use crate::config::{expand_tilde, Config};
use crate::onboarding::ssh_config::SshConfig;
use crate::onboarding::Onboarding;
use crate::phone::{base_url, Phone};
use crate::poller::{AfterTick, Hook, Poller};
use crate::probe::{MachineStatus, Probe};
use crate::sessions::Sessions;
use crate::shell::{RealRunner, Runner};
use crate::ssh::Ssh;
use crate::state::State;
use crate::tunnels::Tunnels;
use crate::web::{router, AppState, Services};
use anyhow::{bail, Context, Result};
use base64::Engine;
use clap::{Parser, Subcommand};
use rand::RngCore;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(
    name = "yardbell",
    version,
    about = "One page for AI coding agent sessions across your machines"
)]
struct Cli {
    #[arg(
        long,
        global = true,
        env = "YARDBELL_CONFIG",
        help = "Config file [default: ~/.config/yardbell/yardbell.yml]"
    )]
    config: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    #[command(about = "Start the web UI (the default when no command is given)")]
    Serve {
        #[arg(long, help = "Do not open a browser window")]
        no_open: bool,
    },
    #[command(about = "Set or change the login passcode")]
    Passcode,
    #[command(about = "Start Yardbell at login (launchd on macOS, systemd user unit on Linux)")]
    InstallAgent,
    #[command(about = "Remove the login service installed by install-agent")]
    UninstallAgent,
    #[command(about = "Check config, passcode, mesh VPN, every machine, sleep and firewall")]
    Doctor,
}

fn config_path(cli: &Cli) -> PathBuf {
    cli.config.clone().unwrap_or_else(default_config_path)
}

pub fn state_dir() -> PathBuf {
    std::env::var("YARDBELL_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| expand_tilde("~/.local/state/yardbell"))
}

pub async fn run() -> Result<()> {
    let cli = Cli::parse();
    let path = config_path(&cli);
    match cli.cmd {
        None => serve(path, false, shutdown_signal()).await,
        Some(Cmd::Serve { no_open }) => serve(path, no_open, shutdown_signal()).await,
        Some(Cmd::Passcode) => passcode(path),
        Some(Cmd::InstallAgent) => crate::service::install(&path),
        Some(Cmd::UninstallAgent) => crate::service::uninstall(),
        Some(Cmd::Doctor) => crate::doctor::run(&path, state_dir()).await,
    }
}

fn passcode(path: PathBuf) -> Result<()> {
    let mut cfg = Config::load(&path)?;
    let first = rpassword::prompt_password("New passcode: ")?;
    if first.len() < 6 {
        bail!("use at least 6 characters");
    }
    let second = rpassword::prompt_password("Repeat it: ")?;
    if first != second {
        bail!("the two entries do not match");
    }
    let mut key = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut key);
    cfg.passcode_hash = Some(crate::auth::hash(&first));
    cfg.cookie_key = Some(base64::engine::general_purpose::STANDARD.encode(key));
    cfg.save(&path)?;
    println!("Passcode saved to {}", path.display());
    Ok(())
}

pub fn default_config_path() -> PathBuf {
    expand_tilde("~/.config/yardbell/yardbell.yml")
}

pub async fn serve(
    path: PathBuf,
    no_open: bool,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<()> {
    let cfg = Config::load(&path)?;
    if cfg.passcode_hash.is_none() {
        bail!("no passcode set, run `yardbell passcode` first");
    }
    let dir = state_dir();
    let runner: Arc<dyn Runner> = Arc::new(RealRunner::default());
    let ssh = Ssh::new(dir.clone());
    let state = State::default();
    let binds = cfg.bind_addresses();
    let tunnels = Arc::new(Tunnels::new(
        runner.clone(),
        binds.clone(),
        dir.join("logs"),
        Arc::new(Instant::now),
    ));

    let hook_state = state.clone();
    let hook_tunnels = tunnels.clone();
    let hook: Hook = Arc::new(move |cfg: &Config, st: &MachineStatus| {
        let names: Vec<String> = cfg.remote_machines().map(|m| m.name.clone()).collect();
        hook_tunnels.retain(&names);
        let Some(m) = cfg.machine(&st.name).filter(|m| !m.is_local()) else {
            return;
        };
        if st.up {
            hook_tunnels.sync(m, &hook_state.ports(&m.name));
        }
    });
    let phone = Arc::new(Phone::default());
    let dispatch = Arc::new(crate::dispatch::Dispatch::new(
        runner.clone(),
        dir.join("dispatch"),
    ));
    let after_dispatch = dispatch.clone();
    let after_sessions = Arc::new(Sessions::new(runner.clone(), ssh.clone()));
    let after_state = state.clone();
    let after_tunnels = tunnels.clone();
    let after_phone = phone.clone();
    let after: AfterTick = Arc::new(move |cfg: &Config| {
        let base = base_url(cfg);
        let host = base
            .as_deref()
            .and_then(|text| reqwest::Url::parse(text).ok())
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| "localhost".into());
        let view = after_state.view(cfg, after_tunnels.as_ref(), &host);
        let pushes = after_phone.observe(
            &cfg.phone_notifications,
            &view,
            base.as_deref(),
            Instant::now(),
        );
        after_phone.inbox.add(&pushes);
        for change in after_dispatch.observe(&view) {
            let Some(m) = cfg.machine(&change.machine).cloned() else {
                continue;
            };
            let (dispatch, sessions) = (after_dispatch.clone(), after_sessions.clone());
            tokio::spawn(async move {
                let screen = sessions
                    .read(&m, &change.name, 60)
                    .await
                    .unwrap_or_default();
                dispatch.report(&change, &screen);
            });
        }
    });
    let poller = Arc::new(Poller::new(
        path.clone(),
        Arc::new(Probe::new(runner.clone(), ssh.clone())),
        state.clone(),
        hook,
        after,
    ));
    poller.clone().start(Duration::from_secs(cfg.poll_seconds));

    let onboarding = Arc::new(Onboarding::new(
        runner.clone(),
        ssh.clone(),
        path.clone(),
        SshConfig::new(expand_tilde("~/.ssh/config"), Arc::new(chrono::Local::now)),
        tunnels.clone(),
        state.clone(),
        expand_tilde("~/.ssh/id_ed25519"),
    ));
    let services = Services {
        state,
        ports: tunnels.clone(),
        sessions: Sessions::new(runner.clone(), ssh.clone()),
        onboarding,
        host_mesh: crate::mesh::HostMesh::new(runner.clone()),
        folders: crate::folders::Folders::new(runner.clone(), ssh.clone()),
        settings: crate::settings::Settings::new(
            path.clone(),
            expand_tilde("~/.ssh/config"),
            Arc::new(chrono::Local::now),
        ),
        phone,
        dispatch,
        refresh: Arc::new(move || {
            let poller = poller.clone();
            Box::pin(async move {
                poller.tick().await;
            })
        }),
    };
    let app = Arc::new(AppState::new(path, services, &cfg, Arc::new(Instant::now)));
    let mut servers = Vec::new();
    for ip in &binds {
        let addr: SocketAddr = format!("{ip}:{}", cfg.port)
            .parse()
            .with_context(|| format!("bad listen address {ip}"))?;
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            // The mesh address only exists while the VPN is on; localhost keeps working.
            Err(e)
                if e.kind() == std::io::ErrorKind::AddrNotAvailable && !addr.ip().is_loopback() =>
            {
                tracing::warn!(
                    "{addr} is not on this machine right now, is the mesh VPN off? Serving on localhost only until Yardbell restarts"
                );
                continue;
            }
            Err(e) => return Err(e).with_context(|| format!("cannot listen on {addr}")),
        };
        tracing::info!("listening on http://{addr}");
        let svc = router(app.clone()).into_make_service_with_connect_info::<SocketAddr>();
        servers.push(tokio::spawn(
            async move { axum::serve(listener, svc).await },
        ));
    }
    if !no_open {
        open_browser(&format!("http://localhost:{}", cfg.port));
    }
    shutdown.await;
    tunnels.shutdown();
    for s in servers {
        s.abort();
    }
    Ok(())
}

fn open_browser(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    if let Err(e) = std::process::Command::new(opener).arg(url).spawn() {
        tracing::warn!(error = %e, "could not open the browser, visit {url}");
    }
}

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

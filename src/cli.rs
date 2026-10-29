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
use clap::{Parser, Subcommand};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const USAGE_EVERY: Duration = Duration::from_secs(5 * 60);

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
    cfg.passcode_hash = Some(crate::auth::hash(&first));
    crate::local_server::new_cookie_key(&mut cfg, &path).map_err(anyhow::Error::msg)?;
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
    let secrets = crate::secrets::Secrets::for_config(&path)?;
    cfg.cookie_key(&secrets).map_err(anyhow::Error::msg)?;
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
    let insights = Arc::new(crate::insights::Insights::load(dir.join("insights.json")));
    let hook_insights = insights.clone();
    let hook: Hook = Arc::new(move |cfg: &Config, st: &MachineStatus| {
        if let Some(snap) = &st.snapshot {
            hook_insights.observe(&st.name, snap, st.checked_at);
        }
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
    let usage_dispatch = dispatch.clone();
    tokio::spawn(async move {
        let http = reqwest::Client::new();
        let mut every = tokio::time::interval(USAGE_EVERY);
        loop {
            every.tick().await;
            if let Err(e) = usage_dispatch.refresh_usage(&http).await {
                tracing::debug!(error = %e, "Claude usage not refreshed from the account");
            }
        }
    });
    let after_dispatch = dispatch.clone();
    let after_sessions = Arc::new(Sessions::new(runner.clone(), ssh.clone()));
    let after_folders = Arc::new(crate::folders::Folders::new(runner.clone(), ssh.clone()));
    let after_state = state.clone();
    let after_tunnels = tunnels.clone();
    let after_phone = phone.clone();
    let after_path = path.clone();
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
            let (dispatch, sessions, folders, state) = (
                after_dispatch.clone(),
                after_sessions.clone(),
                after_folders.clone(),
                after_state.clone(),
            );
            // A reviewer's report can run long, and it is read from the screen.
            let lines = if change.review.is_some() { 400 } else { 60 };
            tokio::spawn(async move {
                let screen = sessions
                    .read(&m, &change.name, lines)
                    .await
                    .unwrap_or_default();
                dispatch.report_from(&change, &screen, &folders, &m).await;
                // The session card lands after the check that found the change, so open
                // Dispatch pages are told again.
                state.touch();
            });
        }
        for due in after_dispatch.due(&view) {
            let (dispatch, sessions, state) = (
                after_dispatch.clone(),
                after_sessions.clone(),
                after_state.clone(),
            );
            let (cfg, path) = (cfg.clone(), after_path.clone());
            tokio::spawn(async move {
                let mut screens = Vec::new();
                for child in &due.children {
                    screens.push(match cfg.machine(&child.machine) {
                        Some(m) if child.live => sessions.read(m, &child.name, 400).await.ok(),
                        _ => None,
                    });
                }
                let follow = dispatch.gathered(&due, &screens);
                state.touch();
                if !follow {
                    return;
                }
                let extra = match (crate::secrets::Secrets::for_config(&path), cfg.host()) {
                    (Ok(s), Some(m)) => cfg.mcp_config_for(&m.name, &s),
                    (Err(e), Some(_)) if !cfg.mcp_servers.is_empty() => Err(e.to_string()),
                    _ => Ok(None),
                };
                let started = match extra {
                    Ok(extra) => {
                        dispatch
                            .follow_up(
                                &due.conversation,
                                &due.group,
                                cfg.port,
                                &cfg.dispatch,
                                extra.as_deref(),
                            )
                            .await
                    }
                    Err(e) => Err(e),
                };
                if let Err(e) = started {
                    tracing::warn!(error = %e, "Dispatch did not follow up on a gathered group");
                }
                state.touch();
            });
        }
    });
    Arc::new(
        crate::pulls::Pulls::new(
            Arc::new(crate::pulls::GitHub::new(runner.clone(), ssh.clone())),
            Arc::new(crate::pulls::GitLab::new()),
            crate::pulls::Remotes::new(runner.clone(), ssh.clone()),
            dir.join("pulls.json"),
        )
        .with_insights(insights.clone()),
    )
    .start(path.clone(), state.clone(), dispatch.clone());
    let pipeline = Arc::new(crate::pipeline::Pipeline::new(dir.join("pipeline.json")));
    let triggers = Arc::new(crate::triggers::Triggers::new(
        Arc::new(crate::triggers::Live::new(runner.clone())),
        dir.join("triggers.json"),
    ));
    triggers
        .clone()
        .start_loop(path.clone(), state.clone(), dispatch.clone());
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
        worktrees: crate::worktrees::Worktrees::new(runner.clone(), ssh.clone()),
        settings: crate::settings::Settings::new(
            path.clone(),
            expand_tilde("~/.ssh/config"),
            Arc::new(chrono::Local::now),
        ),
        phone,
        dispatch,
        triggers,
        insights,
        pipeline: pipeline.clone(),
        releases: crate::about::github(),
        refresh: Arc::new(move |machine: Option<String>| {
            let poller = poller.clone();
            Box::pin(async move {
                match machine {
                    Some(name) => poller.check_machine(&name).await,
                    None => {
                        poller.tick().await;
                    }
                }
            })
        }),
    };
    let app = Arc::new(AppState::new(path, services, &cfg, Arc::new(Instant::now)));
    pipeline.clone().start_loop(
        app.clone(),
        crate::pipeline::forge::Forge::new(runner.clone(), ssh.clone()),
    );
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

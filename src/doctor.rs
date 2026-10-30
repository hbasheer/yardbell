use crate::config::Config;
use crate::pipeline::definition::{Definition, MachineChoice, StepKind, Trigger};
use crate::probe::Probe;
use crate::service::in_docker;
use crate::shell::{RealRunner, Runner};
use crate::ssh::Ssh;
use std::path::Path;
use std::sync::Arc;

pub fn pmset_never_sleeps(output: &str) -> bool {
    output.lines().any(|line| {
        let mut words = line.split_whitespace();
        words.next() == Some("sleep") && words.next() == Some("0")
    })
}

pub fn ufw_hints(cfg: &Config) -> Vec<String> {
    let rule =
        |ports: String| format!("sudo ufw allow in on nordlynx to any port {ports} proto tcp");
    let mut out = vec![rule(cfg.port.to_string())];
    let mut prefixes: Vec<u8> = cfg
        .remote_machines()
        .filter_map(|m| m.port_prefix)
        .collect();
    prefixes.sort_unstable();
    for p in prefixes {
        let start = p as u32 * 10000;
        out.push(rule(format!("{start}:{}", (start + 9999).min(65535))));
    }
    out
}

pub fn gitlab_line(host: &str, found: &Result<String, String>) -> (bool, String) {
    match found {
        Ok(name) => (true, format!("{host}: signed in as {name}")),
        Err(problem) => (false, format!("{host}: {problem}")),
    }
}

// The machines a pipeline may use: those it names, or every machine when Dispatch picks freely.
fn machines_of(cfg: &Config, def: &Definition) -> Vec<String> {
    let mut named = Vec::new();
    let mut any = false;
    for step in &def.steps {
        match &step.kind {
            StepKind::Agent {
                machine: MachineChoice::Name(m),
                ..
            } => named.push(m.clone()),
            StepKind::Agent {
                machine: MachineChoice::Pick(list),
                ..
            }
            | StepKind::Plan { machines: list } => {
                any |= list.is_empty();
                named.extend(list.iter().cloned());
            }
            _ => {}
        }
    }
    cfg.machines
        .iter()
        .map(|m| m.name.clone())
        .filter(|m| any || named.contains(m))
        .collect()
}

pub fn pipelines_lines(
    cfg: &Config,
    defs: &[Definition],
    linear: &Option<Result<usize, String>>,
    gh: &[(String, bool)],
    gitlab: &[(String, Result<String, String>)],
    up: &[(String, bool)],
) -> Vec<(bool, String)> {
    let mut lines = Vec::new();
    for def in defs.iter().filter(|d| d.enabled) {
        let name = &def.name;
        let machines = machines_of(cfg, def);
        let uses_linear = matches!(&def.trigger, Trigger::Linear { .. })
            || matches!(&def.trigger, Trigger::Schedule { state, .. } if !state.trim().is_empty())
            || def
                .steps
                .iter()
                .any(|s| matches!(s.kind, StepKind::Linear { .. }));
        if uses_linear {
            match linear {
                Some(Ok(n)) => lines.push((
                    true,
                    format!("{name}: Linear answers, {n} open tickets are yours"),
                )),
                Some(Err(e)) => lines.push((false, format!("{name}: {e}"))),
                None => {}
            }
        }
        if let Trigger::GitlabReviewer { host } = &def.trigger {
            match gitlab.iter().find(|(h, _)| h.eq_ignore_ascii_case(host)) {
                Some((_, Ok(user))) => {
                    lines.push((true, format!("{name}: signed in to {host} as {user}")))
                }
                Some((_, Err(e))) => lines.push((false, format!("{name}: {host}: {e}"))),
                None => lines.push((
                    false,
                    format!("{name}: {host} was not checked; add it under pull_requests.gitlab"),
                )),
            }
        }
        let uses_gh = matches!(def.trigger, Trigger::GithubReview)
            || def.steps.iter().any(|s| matches!(s.kind, StepKind::Push));
        if uses_gh {
            let out: Vec<&str> = gh
                .iter()
                .filter(|(m, ok)| !ok && machines.contains(m))
                .map(|(m, _)| m.as_str())
                .collect();
            for m in &out {
                lines.push((false, format!("{name}: gh is not logged in on {m}, so draft GitHub pull requests cannot be opened there (run gh auth login on {m})")));
            }
            if out.is_empty() && !machines.is_empty() {
                lines.push((
                    true,
                    format!("{name}: gh is logged in on {}", machines.join(", ")),
                ));
            }
        }
        let down: Vec<&String> = machines
            .iter()
            .filter(|m| up.iter().any(|(n, ok)| n == *m && !ok))
            .collect();
        for m in &down {
            lines.push((false, format!("{name}: {m} is not reachable")));
        }
        if down.is_empty() && !machines.is_empty() && !up.is_empty() {
            lines.push((
                true,
                format!("{name}: {} are reachable", machines.join(", ")),
            ));
        }
    }
    lines
}

fn line(ok: bool, text: &str) {
    println!("{} {text}", if ok { "✓" } else { "✗" });
}

pub async fn run(path: &Path, state_dir: std::path::PathBuf) -> anyhow::Result<()> {
    let cfg = match Config::load(path) {
        Ok(cfg) => {
            line(true, &format!("config {}", path.display()));
            cfg
        }
        Err(e) => {
            line(false, &e.to_string());
            return Ok(());
        }
    };
    line(
        cfg.passcode_hash.is_some(),
        "passcode set (run `yardbell passcode` if not)",
    );
    let runner: Arc<dyn Runner> = Arc::new(RealRunner::default());
    let mesh = crate::mesh::HostMesh::new(runner.clone()).check(&cfg).await;
    match mesh.on {
        Some(on) => line(
            on,
            &format!(
                "{} is {} on this machine",
                mesh.label,
                if on { "on" } else { "off" }
            ),
        ),
        None => println!(
            "  {}: status unknown (no command line and no mesh address found)",
            mesh.label
        ),
    }
    if let Some(hint) = &mesh.hint {
        println!("  fix: {hint}");
    }
    let defs = crate::pipeline::library::Library::load(state_dir.join("pipelines")).list();
    let ssh = Ssh::new(state_dir);
    let probe = Probe::new(runner.clone(), ssh.clone());
    let mut up = Vec::new();
    for m in &cfg.machines {
        let st = probe.check(&cfg, m).await;
        let detail = match (&st.reason, &st.snapshot) {
            (Some(reason), _) => reason.to_string(),
            (None, Some(snap)) => format!(
                "{} agent sessions, {} folders",
                snap.sessions.len(),
                snap.folders.len()
            ),
            (None, None) => "ok".into(),
        };
        line(st.up, &format!("{}: {detail}", m.name));
        up.push((m.name.clone(), st.up));
    }
    let mut signed_in = Vec::new();
    if !cfg.pull_requests.gitlab.is_empty() {
        let secrets = crate::secrets::Secrets::for_config(path).map_err(|e| e.to_string());
        let gitlab = crate::pulls::GitLab::new();
        for access in crate::pulls::accesses(&cfg.pull_requests, &secrets) {
            let found = gitlab.whoami(&access).await;
            let (ok, text) = gitlab_line(&access.host, &found);
            line(ok, &text);
            signed_in.push((access.host.clone(), found));
        }
    }
    if defs.iter().any(|d| d.enabled) {
        let linear = match crate::secrets::Secrets::for_config(path) {
            Ok(secrets) => match secrets.get(crate::triggers::LINEAR_SECRET) {
                Some(key) => Some(
                    crate::pipeline::linear::Linear::new()
                        .open(key)
                        .await
                        .map(|t| t.len()),
                ),
                None => Some(Err(
                    "the secret linear is not set, so Linear tickets cannot be read".to_string(),
                )),
            },
            Err(e) => Some(Err(e.to_string())),
        };
        let mut gh = Vec::new();
        for m in &cfg.machines {
            if !up.iter().any(|(n, ok)| n == &m.name && *ok) {
                continue;
            }
            let out = runner
                .run(
                    ssh.command(m, "gh auth status >/dev/null 2>&1"),
                    None,
                    std::time::Duration::from_secs(15),
                )
                .await;
            gh.push((m.name.clone(), out.ok()));
        }
        for (ok, text) in pipelines_lines(&cfg, &defs, &linear, &gh, &signed_in, &up) {
            line(ok, &text);
        }
    }
    if in_docker() {
        println!("  running inside Docker: the host machine is reached over ssh like any other");
    }
    if cfg!(target_os = "macos") {
        let out = runner
            .run(
                vec!["pmset".into(), "-g".into()],
                None,
                std::time::Duration::from_secs(3),
            )
            .await;
        let ok = pmset_never_sleeps(&out.stdout);
        line(ok, "this Mac never sleeps");
        if !ok {
            println!("  fix: sudo pmset -a sleep 0");
        }
    } else {
        let ufw = runner
            .run(
                vec!["bash".into(), "-c".into(), "command -v ufw".into()],
                None,
                std::time::Duration::from_secs(3),
            )
            .await;
        if ufw.ok() {
            println!("  ufw is installed. If it is active, other devices need these rules to reach Yardbell and its tunnels:");
            for hint in ufw_hints(&cfg) {
                println!("    {hint}");
            }
        } else {
            println!("  firewall: not macOS, ufw not found, nothing to check");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn gitlab_lines_name_the_account_or_the_problem() {
        assert_eq!(
            gitlab_line("git.commslayer.com", &Ok("hbasheer".into())),
            (true, "git.commslayer.com: signed in as hbasheer".into())
        );
        assert_eq!(
            gitlab_line(
                "git.commslayer.com",
                &Err("the secret gitlab is not set".into())
            ),
            (
                false,
                "git.commslayer.com: the secret gitlab is not set".into()
            )
        );
    }

    #[test]
    fn the_pipelines_lines_name_what_each_trigger_needs() {
        use crate::pipeline::templates;
        let cfg = crate::pipeline::definition::tests::cfg();
        let mut implement = templates::all().remove(0);
        implement.enabled = true;
        let mut review = templates::all().remove(1);
        review.enabled = true;
        review.trigger = crate::pipeline::definition::Trigger::GitlabReviewer {
            host: "git.commslayer.com".into(),
        };
        let mut off = templates::all().remove(1);
        off.name = "Off".into();
        let lines = pipelines_lines(
            &cfg,
            &[implement.clone(), review.clone(), off],
            &Some(Err("Linear refused the API key in the secret linear".into())),
            &[
                ("hp".into(), true),
                ("mini".into(), false),
                ("devbox".into(), true),
            ],
            &[("git.commslayer.com".into(), Ok("hbasheer".into()))],
            &[
                ("hp".into(), true),
                ("mini".into(), true),
                ("devbox".into(), false),
            ],
        );
        assert_eq!(
            lines,
            vec![
                (false, "Implement my Linear tickets: Linear refused the API key in the secret linear".into()),
                (false, "Implement my Linear tickets: gh is not logged in on mini, so draft GitHub pull requests cannot be opened there (run gh auth login on mini)".into()),
                (false, "Implement my Linear tickets: devbox is not reachable".into()),
                (true, "Review my merge requests: signed in to git.commslayer.com as hbasheer".into()),
                (false, "Review my merge requests: devbox is not reachable".into()),
            ]
        );
        let ok = pipelines_lines(
            &cfg,
            &[implement],
            &Some(Ok(3)),
            &[
                ("hp".into(), true),
                ("mini".into(), true),
                ("devbox".into(), true),
            ],
            &[],
            &[
                ("hp".into(), true),
                ("mini".into(), true),
                ("devbox".into(), true),
            ],
        );
        assert_eq!(
            ok,
            vec![
                (
                    true,
                    "Implement my Linear tickets: Linear answers, 3 open tickets are yours".into()
                ),
                (
                    true,
                    "Implement my Linear tickets: gh is logged in on hp, mini, devbox".into()
                ),
                (
                    true,
                    "Implement my Linear tickets: hp, mini, devbox are reachable".into()
                ),
            ]
        );
        let missing = pipelines_lines(&cfg, &[review], &None, &[], &[], &[]);
        assert_eq!(
            missing[0],
            (false, "Review my merge requests: git.commslayer.com was not checked; add it under pull_requests.gitlab".into())
        );
    }

    #[test]
    fn pmset_sleep_zero() {
        assert!(pmset_never_sleeps("System-wide power settings:\n Currently in use:\n standby              0\n sleep                0 (sleep prevented by powerd)\n displaysleep         10\n"));
        assert!(!pmset_never_sleeps(
            " Currently in use:\n sleep                1\n displaysleep         0\n"
        ));
        assert!(!pmset_never_sleeps(" displaysleep         0\n"));
    }

    #[test]
    fn ufw_hints_cover_port_and_prefixes() {
        let cfg = Config::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/yardbell.yml"
        )))
        .unwrap();
        let hints = ufw_hints(&cfg);
        assert_eq!(
            hints[0],
            "sudo ufw allow in on nordlynx to any port 4000 proto tcp"
        );
        assert!(hints.contains(
            &"sudo ufw allow in on nordlynx to any port 10000:19999 proto tcp".to_string()
        ));
        assert!(hints.contains(
            &"sudo ufw allow in on nordlynx to any port 20000:29999 proto tcp".to_string()
        ));
        assert_eq!(hints.len(), 3);
    }
}

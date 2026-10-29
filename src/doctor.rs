use crate::config::Config;
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
    let probe = Probe::new(runner.clone(), Ssh::new(state_dir));
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
    }
    if !cfg.pull_requests.gitlab.is_empty() {
        let secrets = crate::secrets::Secrets::for_config(path).map_err(|e| e.to_string());
        let gitlab = crate::pulls::GitLab::new();
        for access in crate::pulls::accesses(&cfg.pull_requests, &secrets) {
            let (ok, text) = gitlab_line(&access.host, &gitlab.whoami(&access).await);
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
